use std::collections::{BTreeMap, BTreeSet};

use doper_abi::{InputBatch, InputCommand, NodeKind};
use doper_layout::{LayoutSnapshot, VirtualLayoutProvider};
use doper_scene::{NodeId, Scene, VirtualListConfig};
use doper_scroll::{
    HeightIndex, ScrollPhysics, ScrollPhysicsConfig, ScrollPlatform, Virtualizer, VirtualizerConfig,
};

use crate::CoreError;

const MAXIMUM_CATCH_UP_SECONDS: f64 = 0.25;
const PHYSICS_STEP_SECONDS: f64 = 1.0 / 120.0;
const VELOCITY_FILTER_NEW_SAMPLE: f64 = 0.8;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
/// Cumulative Core-owned scroll input and integration counters.
pub struct CoreScrollMetrics {
    /// Input Stream batches accepted by the scroll controller.
    pub accepted_input_batches: u64,
    /// Individual direct-manipulation commands consumed.
    pub input_commands: u64,
    /// Fixed-size physics integration substeps completed.
    pub physics_frames: u64,
    /// Worker frames whose stall gap exceeded the catch-up budget.
    pub clamped_catch_up_frames: u64,
    /// Virtual-list frames whose visibility and preheat ranges were planned.
    pub virtual_frames: u64,
    /// Visible logical items rendered as placeholders while Shell data was absent.
    pub virtual_placeholders: u64,
    /// Coalesced asynchronous refill requests emitted after render work.
    pub virtual_refill_requests: u64,
    /// Logical items covered by emitted refill requests.
    pub virtual_refill_items: u64,
}

/// One complete Shell materialization window emitted after a Core render frame.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VirtualRefillRequest {
    /// Generation-bearing virtual Scroll node identifier.
    pub node_id: u32,
    /// Inclusive first preheated logical item index.
    pub start: u32,
    /// Exclusive trailing preheated logical item index.
    pub end: u32,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ScrollAdvance {
    pub(crate) active: bool,
    pub(crate) changed: bool,
}

#[derive(Clone, Debug)]
struct VirtualAxis {
    planner: Virtualizer,
    source: VirtualListConfig,
    materialized: BTreeSet<u32>,
    planned_window: Option<(u32, u32)>,
}

#[derive(Clone, Debug)]
enum VerticalAxis {
    Plain(ScrollPhysics),
    Virtual(Box<VirtualAxis>),
}

impl VerticalAxis {
    fn physics(&self) -> &ScrollPhysics {
        match self {
            Self::Plain(physics) => physics,
            Self::Virtual(axis) => axis.planner.physics(),
        }
    }

    fn physics_mut(&mut self) -> &mut ScrollPhysics {
        match self {
            Self::Plain(physics) => physics,
            Self::Virtual(axis) => axis.planner.physics_mut(),
        }
    }
}

#[derive(Clone, Debug)]
struct ScrollAxes {
    x: ScrollPhysics,
    y: VerticalAxis,
    estimated_velocity: [f64; 2],
}

impl ScrollAxes {
    fn new(
        content: [f64; 2],
        viewport: [f64; 2],
        position: [f32; 2],
        platform: ScrollPlatform,
        virtual_list: Option<VirtualListConfig>,
    ) -> Result<Self, CoreError> {
        let config = ScrollPhysicsConfig::for_platform(platform);
        let mut result = Self {
            x: ScrollPhysics::new(content[0], viewport[0], config)?,
            y: match virtual_list {
                Some(virtual_list) => VerticalAxis::Virtual(Box::new(create_virtual_axis(
                    virtual_list,
                    viewport[1],
                    platform,
                )?)),
                None => VerticalAxis::Plain(ScrollPhysics::new(content[1], viewport[1], config)?),
            },
            estimated_velocity: [0.0; 2],
        };
        result.jump_to(position)?;
        Ok(result)
    }

    fn set_extents(
        &mut self,
        content: [f64; 2],
        viewport: [f64; 2],
        platform: ScrollPlatform,
        virtual_list: Option<VirtualListConfig>,
    ) -> Result<(), CoreError> {
        self.x.set_extents(content[0], viewport[0])?;
        match (&mut self.y, virtual_list) {
            (VerticalAxis::Virtual(axis), Some(config)) if axis.source == config => {
                axis.planner.set_viewport_extent(viewport[1])?;
            }
            (VerticalAxis::Plain(physics), None) => {
                physics.set_extents(content[1], viewport[1])?;
            }
            (_, Some(config)) => {
                let position = self.y.physics().position();
                let mut axis = create_virtual_axis(config, viewport[1], platform)?;
                axis.planner.physics_mut().jump_to(position)?;
                self.y = VerticalAxis::Virtual(Box::new(axis));
            }
            (_, None) => {
                let position = self.y.physics().position();
                let mut physics = ScrollPhysics::new(
                    content[1],
                    viewport[1],
                    ScrollPhysicsConfig::for_platform(platform),
                )?;
                physics.jump_to(position)?;
                self.y = VerticalAxis::Plain(physics);
            }
        }
        Ok(())
    }

    fn jump_to(&mut self, position: [f32; 2]) -> Result<(), CoreError> {
        self.x.jump_to(f64::from(position[0]))?;
        self.y.physics_mut().jump_to(f64::from(position[1]))?;
        self.estimated_velocity = [0.0; 2];
        Ok(())
    }

    fn begin(&mut self) {
        self.x.begin_drag();
        self.y.physics_mut().begin_drag();
        self.estimated_velocity = [0.0; 2];
    }

    fn delta(
        &mut self,
        delta_x: f32,
        delta_y: f32,
        elapsed_micros: u32,
    ) -> Result<bool, CoreError> {
        let elapsed = f64::from(elapsed_micros) / 1_000_000.0;
        let sample = [f64::from(delta_x) / elapsed, f64::from(delta_y) / elapsed];
        for (estimate, incoming) in self.estimated_velocity.iter_mut().zip(sample) {
            *estimate = *estimate * (1.0 - VELOCITY_FILTER_NEW_SAMPLE)
                + incoming * VELOCITY_FILTER_NEW_SAMPLE;
        }
        let x = self.x.drag_by(f64::from(delta_x))?;
        let y = self.y.physics_mut().drag_by(f64::from(delta_y))?;
        Ok(x.changed || y.changed)
    }

    fn end(&mut self, retain_velocity: bool) -> Result<(), CoreError> {
        let velocity = if retain_velocity {
            self.estimated_velocity
        } else {
            [0.0; 2]
        };
        self.x.end_drag(velocity[0])?;
        self.y.physics_mut().end_drag(velocity[1])?;
        self.estimated_velocity = [0.0; 2];
        Ok(())
    }

    fn advance(&mut self, elapsed: f64) -> Result<ScrollAdvance, CoreError> {
        let x = self.x.advance(elapsed)?;
        let y = self.y.physics_mut().advance(elapsed)?;
        Ok(ScrollAdvance {
            active: x.active || y.active,
            changed: x.changed || y.changed,
        })
    }

    fn position(&self) -> Result<[f32; 2], CoreError> {
        Ok([
            checked_position(self.x.position())?,
            checked_position(self.y.physics().position())?,
        ])
    }

    fn synchronize_virtual_items(
        &mut self,
        scene: &Scene,
        layout: &LayoutSnapshot,
        list: NodeId,
    ) -> Result<bool, CoreError> {
        let VerticalAxis::Virtual(axis) = &mut self.y else {
            return Ok(false);
        };
        let mut next = BTreeSet::new();
        let mut child = scene.first_child(list);
        while let Some(node) = child {
            if let Some(index) = scene.virtual_item_index(node) {
                next.insert(index);
            }
            child = scene.next_sibling(node);
        }
        for &index in axis.materialized.difference(&next) {
            let index = usize::try_from(index)
                .map_err(|_| CoreError::InvalidScrollTarget { node: list })?;
            axis.planner.mark_unavailable(index..index + 1)?;
        }
        for &index in next.difference(&axis.materialized) {
            let index = usize::try_from(index)
                .map_err(|_| CoreError::InvalidScrollTarget { node: list })?;
            axis.planner.mark_available(index..index + 1)?;
        }
        axis.materialized = next;

        let mut corrected = false;
        let mut child = scene.first_child(list);
        while let Some(node) = child {
            if let (Some(item_index), Some((_, size))) =
                (scene.virtual_item_index(node), layout.geometry(node))
            {
                let item_index = usize::try_from(item_index)
                    .map_err(|_| CoreError::InvalidScrollTarget { node: list })?;
                corrected |= axis.planner.update_height(item_index, size.height)? != 0.0;
            }
            child = scene.next_sibling(node);
        }
        Ok(corrected)
    }
}

fn create_virtual_axis(
    source: VirtualListConfig,
    viewport: f64,
    platform: ScrollPlatform,
) -> Result<VirtualAxis, CoreError> {
    let item_count = usize::try_from(source.item_count)
        .map_err(|_| CoreError::InvalidScrollPosition(f64::from(source.item_count)))?;
    let heights = HeightIndex::with_uniform(item_count, source.estimated_item_height)?;
    let planner = Virtualizer::new(
        heights,
        viewport,
        platform,
        VirtualizerConfig {
            base_overscan_viewports: f64::from(source.base_overscan_viewports),
            velocity_horizon_seconds: f64::from(source.velocity_horizon_seconds),
            maximum_ahead_viewports: f64::from(source.maximum_ahead_viewports),
        },
    )?;
    Ok(VirtualAxis {
        planner,
        source,
        materialized: BTreeSet::new(),
        planned_window: None,
    })
}

#[derive(Clone, Debug)]
pub(crate) struct ScrollController {
    states: BTreeMap<NodeId, ScrollAxes>,
    platform: ScrollPlatform,
    last_input_sequence: Option<u32>,
    metrics: CoreScrollMetrics,
    pending_refills: Vec<VirtualRefillRequest>,
}

impl Default for ScrollController {
    fn default() -> Self {
        Self {
            states: BTreeMap::new(),
            platform: ScrollPlatform::Android,
            last_input_sequence: None,
            metrics: CoreScrollMetrics::default(),
            pending_refills: Vec::new(),
        }
    }
}

impl ScrollController {
    pub(crate) fn synchronize(
        &mut self,
        scene: &mut Scene,
        layout: &LayoutSnapshot,
        programmatic: &BTreeSet<u32>,
    ) -> Result<Vec<NodeId>, CoreError> {
        let scroll_nodes: Vec<NodeId> = scene
            .ids()
            .iter()
            .copied()
            .filter(|node| scene.kind(*node) == Some(NodeKind::Scroll))
            .collect();
        let active: BTreeSet<NodeId> = scroll_nodes.iter().copied().collect();
        self.states.retain(|node, _| active.contains(node));
        self.pending_refills
            .retain(|request| active.iter().any(|node| node.raw() == request.node_id));

        let mut corrected = Vec::new();
        for node in scroll_nodes {
            let (content, viewport) = extents(scene, layout, node)?;
            let scene_position = scene.scroll_position(node).unwrap_or([0.0; 2]);
            let state = match self.states.entry(node) {
                std::collections::btree_map::Entry::Vacant(entry) => entry.insert(ScrollAxes::new(
                    content,
                    viewport,
                    scene_position,
                    self.platform,
                    scene.virtual_list(node),
                )?),
                std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
            };
            state.set_extents(content, viewport, self.platform, scene.virtual_list(node))?;
            if state.synchronize_virtual_items(scene, layout, node)? {
                corrected.push(node);
            }
            if programmatic.contains(&node.raw()) {
                state.jump_to(scene_position)?;
            }
            scene.apply_scroll_position(node, state.position()?)?;
        }
        self.plan_virtual_frames()?;
        Ok(corrected)
    }

    pub(crate) fn apply_input(
        &mut self,
        scene: &mut Scene,
        batch: &InputBatch,
    ) -> Result<ScrollAdvance, CoreError> {
        if let Some(previous) = self.last_input_sequence
            && !is_newer_sequence(batch.frame_seq, previous)
        {
            return Err(CoreError::InputSequenceNotNewer {
                previous,
                incoming: batch.frame_seq,
            });
        }
        let mut staged = BTreeMap::new();
        for instruction in &batch.instructions {
            let node = input_node(&instruction.command)?;
            if scene.kind(node) != Some(NodeKind::Scroll) {
                return Err(CoreError::InvalidScrollTarget { node });
            }
            if let std::collections::btree_map::Entry::Vacant(entry) = staged.entry(node) {
                entry.insert(
                    self.states
                        .get(&node)
                        .ok_or(CoreError::InvalidScrollTarget { node })?
                        .clone(),
                );
            }
        }

        let mut changed = false;
        let mut active = false;
        for instruction in &batch.instructions {
            let command = &instruction.command;
            let node = input_node(command)?;
            let state = staged
                .get_mut(&node)
                .ok_or(CoreError::InvalidScrollTarget { node })?;
            match command {
                InputCommand::ScrollBegin { .. } => state.begin(),
                InputCommand::ScrollDelta {
                    delta_x,
                    delta_y,
                    elapsed_micros,
                    ..
                } => changed |= state.delta(*delta_x, *delta_y, *elapsed_micros)?,
                InputCommand::ScrollEnd { .. } => state.end(true)?,
                InputCommand::ScrollCancel { .. } => state.end(false)?,
                _ => return Err(CoreError::UnsupportedInputCommand),
            }
            active |= !state.x.is_dragging()
                && (state.x.velocity().abs() > f64::EPSILON
                    || state.y.physics().velocity().abs() > f64::EPSILON);
        }
        let positions = staged
            .iter()
            .map(|(&node, state)| Ok((node, state.position()?)))
            .collect::<Result<Vec<_>, CoreError>>()?;
        scene.apply_scroll_positions(&positions)?;
        for (node, state) in staged {
            self.states.insert(node, state);
        }
        self.last_input_sequence = Some(batch.frame_seq);
        self.metrics.accepted_input_batches = self.metrics.accepted_input_batches.saturating_add(1);
        self.metrics.input_commands = self
            .metrics
            .input_commands
            .saturating_add(batch.instructions.len() as u64);
        Ok(ScrollAdvance { active, changed })
    }

    pub(crate) fn apply_wheel(
        &mut self,
        scene: &mut Scene,
        node: NodeId,
        delta: [f32; 2],
        elapsed_micros: u32,
    ) -> Result<ScrollAdvance, CoreError> {
        if scene.kind(node) != Some(NodeKind::Scroll) {
            return Err(CoreError::InvalidScrollTarget { node });
        }
        let mut state = self
            .states
            .get(&node)
            .ok_or(CoreError::InvalidScrollTarget { node })?
            .clone();
        state.begin();
        let changed = state.delta(delta[0], delta[1], elapsed_micros)?;
        state.end(false)?;
        scene.apply_scroll_position(node, state.position()?)?;
        self.states.insert(node, state);
        self.metrics.input_commands = self.metrics.input_commands.saturating_add(1);
        Ok(ScrollAdvance {
            active: false,
            changed,
        })
    }

    pub(crate) fn begin_direct(&mut self, node: NodeId) -> Result<(), CoreError> {
        let state = self
            .states
            .get_mut(&node)
            .ok_or(CoreError::InvalidScrollTarget { node })?;
        state.begin();
        self.metrics.input_commands = self.metrics.input_commands.saturating_add(1);
        Ok(())
    }

    pub(crate) fn direct_delta(
        &mut self,
        scene: &mut Scene,
        node: NodeId,
        delta: [f32; 2],
        elapsed_micros: u32,
    ) -> Result<ScrollAdvance, CoreError> {
        let state = self
            .states
            .get_mut(&node)
            .ok_or(CoreError::InvalidScrollTarget { node })?;
        let changed = state.delta(delta[0], delta[1], elapsed_micros)?;
        scene.apply_scroll_position(node, state.position()?)?;
        self.metrics.input_commands = self.metrics.input_commands.saturating_add(1);
        Ok(ScrollAdvance {
            active: false,
            changed,
        })
    }

    pub(crate) fn end_direct(
        &mut self,
        node: NodeId,
        retain_velocity: bool,
    ) -> Result<(), CoreError> {
        let state = self
            .states
            .get_mut(&node)
            .ok_or(CoreError::InvalidScrollTarget { node })?;
        state.end(retain_velocity)?;
        self.metrics.input_commands = self.metrics.input_commands.saturating_add(1);
        Ok(())
    }

    pub(crate) fn advance(
        &mut self,
        scene: &mut Scene,
        elapsed_seconds: f64,
    ) -> Result<ScrollAdvance, CoreError> {
        if !elapsed_seconds.is_finite() || elapsed_seconds < 0.0 {
            return Err(CoreError::InvalidFrameDelta(elapsed_seconds));
        }
        if elapsed_seconds == 0.0 || self.states.is_empty() {
            return Ok(ScrollAdvance::default());
        }
        let elapsed = elapsed_seconds.min(MAXIMUM_CATCH_UP_SECONDS);
        if elapsed_seconds > MAXIMUM_CATCH_UP_SECONDS {
            self.metrics.clamped_catch_up_frames =
                self.metrics.clamped_catch_up_frames.saturating_add(1);
        }
        let mut outcome = ScrollAdvance::default();
        let mut remaining = elapsed;
        while remaining > f64::EPSILON {
            let step = remaining.min(PHYSICS_STEP_SECONDS);
            for state in self.states.values_mut() {
                let frame = state.advance(step)?;
                outcome.active |= frame.active;
                outcome.changed |= frame.changed;
            }
            self.metrics.physics_frames = self.metrics.physics_frames.saturating_add(1);
            remaining = (remaining - step).max(0.0);
        }
        if outcome.changed {
            for (node, state) in &self.states {
                scene.apply_scroll_position(*node, state.position()?)?;
            }
        }
        Ok(outcome)
    }

    pub(crate) const fn metrics(&self) -> CoreScrollMetrics {
        self.metrics
    }

    pub(crate) fn take_refills(&mut self) -> Vec<VirtualRefillRequest> {
        core::mem::take(&mut self.pending_refills)
    }

    pub(crate) fn plan_virtual_frames(&mut self) -> Result<(), CoreError> {
        for (&node, state) in &mut self.states {
            let VerticalAxis::Virtual(axis) = &mut state.y else {
                continue;
            };
            let frame = axis.planner.plan_frame()?;
            let placeholders = u64::try_from(frame.placeholders).unwrap_or(u64::MAX);
            let ranges = frame.refill.to_vec();
            let window_start = u32::try_from(frame.preheat.start)
                .map_err(|_| CoreError::InvalidScrollPosition(f64::MAX))?;
            let window_end = u32::try_from(frame.preheat.end)
                .map_err(|_| CoreError::InvalidScrollPosition(f64::MAX))?;
            self.metrics.virtual_frames = self.metrics.virtual_frames.saturating_add(1);
            self.metrics.virtual_placeholders = self
                .metrics
                .virtual_placeholders
                .saturating_add(placeholders);
            self.metrics.virtual_refill_requests = self
                .metrics
                .virtual_refill_requests
                .saturating_add(u64::try_from(ranges.len()).unwrap_or(u64::MAX));
            for range in ranges {
                let start = u32::try_from(range.start)
                    .map_err(|_| CoreError::InvalidScrollPosition(f64::MAX))?;
                let end = u32::try_from(range.end)
                    .map_err(|_| CoreError::InvalidScrollPosition(f64::MAX))?;
                self.metrics.virtual_refill_items = self
                    .metrics
                    .virtual_refill_items
                    .saturating_add(u64::from(end - start));
            }
            let planned = (window_start, window_end);
            if window_start < window_end && axis.planned_window != Some(planned) {
                axis.planned_window = Some(planned);
                let request = VirtualRefillRequest {
                    node_id: node.raw(),
                    start: window_start,
                    end: window_end,
                };
                if let Some(existing) = self
                    .pending_refills
                    .iter_mut()
                    .find(|existing| existing.node_id == request.node_id)
                {
                    *existing = request;
                } else {
                    self.pending_refills.push(request);
                }
            }
        }
        Ok(())
    }
}

impl VirtualLayoutProvider for ScrollController {
    fn item_offset(&self, list: NodeId, item_index: u32) -> Option<f32> {
        let state = self.states.get(&list)?;
        let VerticalAxis::Virtual(axis) = &state.y else {
            return None;
        };
        let index = usize::try_from(item_index).ok()?;
        virtual_dimension(axis.planner.heights().offset_of(index).ok()?)
    }

    fn content_height(&self, list: NodeId) -> Option<f32> {
        let state = self.states.get(&list)?;
        let VerticalAxis::Virtual(axis) = &state.y else {
            return None;
        };
        virtual_dimension(axis.planner.heights().total_extent())
    }
}

fn input_node(command: &InputCommand) -> Result<NodeId, CoreError> {
    let raw = match command {
        InputCommand::ScrollBegin { node_id }
        | InputCommand::ScrollDelta { node_id, .. }
        | InputCommand::ScrollEnd { node_id }
        | InputCommand::ScrollCancel { node_id } => *node_id,
        _ => return Err(CoreError::UnsupportedInputCommand),
    };
    NodeId::from_raw(raw).map_err(CoreError::Scene)
}

fn extents(
    scene: &Scene,
    layout: &LayoutSnapshot,
    node: NodeId,
) -> Result<([f64; 2], [f64; 2]), CoreError> {
    let (_, viewport_size) = layout
        .geometry(node)
        .ok_or(CoreError::MissingScrollGeometry { node })?;
    let mut content = [0.0_f64; 2];
    let mut child = scene.first_child(node);
    while let Some(current) = child {
        let (offset, size) = layout
            .geometry(current)
            .ok_or(CoreError::MissingScrollGeometry { node: current })?;
        content[0] = content[0].max(f64::from(offset.x + size.width));
        content[1] = content[1].max(f64::from(offset.y + size.height));
        child = scene.next_sibling(current);
    }
    Ok((
        content,
        [
            f64::from(viewport_size.width),
            f64::from(viewport_size.height),
        ],
    ))
}

fn is_newer_sequence(candidate: u32, previous: u32) -> bool {
    let distance = candidate.wrapping_sub(previous);
    distance != 0 && distance < 0x8000_0000
}

fn checked_position(value: f64) -> Result<f32, CoreError> {
    if !value.is_finite() || value.abs() > f64::from(f32::MAX) {
        return Err(CoreError::InvalidScrollPosition(value));
    }
    #[allow(clippy::cast_possible_truncation)]
    // Range and finiteness are checked above; f32 is the versioned Scene ABI.
    let result = value as f32;
    Ok(result)
}

fn virtual_dimension(value: f64) -> Option<f32> {
    if !value.is_finite() || value < 0.0 || value > f64::from(f32::MAX) {
        return None;
    }
    #[allow(clippy::cast_possible_truncation)]
    Some(value as f32)
}
