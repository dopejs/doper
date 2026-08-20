use std::collections::{BTreeMap, BTreeSet};

use pingo_abi::{InputBatch, InputCommand, VirtualAxis};
use pingo_layout::{LayoutSnapshot, VirtualLayoutProvider};
use pingo_paint::{PlaceholderRect, VirtualPaintResolver};
use pingo_scene::{NodeId, Scene, VirtualListConfig};
use pingo_scroll::{
    ExtentIndex, ScrollPhysics, ScrollPhysicsConfig, ScrollPlatform, Virtualizer, VirtualizerConfig,
};

use crate::CoreError;

/// Skeleton colour for an item the Shell has not materialized yet.
///
/// A neutral, low-contrast grey: it has to read as "loading" without competing
/// with real rows, and it must never be mistaken for content.
const PLACEHOLDER_RGBA: u32 = 0xeef1_f5ff;

/// Frames a starved viewport waits before asking for its window again.
///
/// Long enough that an in-flight answer can land first -- materializing a
/// preheat window rebuilds a few hundred nodes -- and short enough that a lost
/// request is recovered well inside a second.
const REFILL_RETRY_FRAMES: u32 = 12;

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
struct VirtualState {
    planner: Virtualizer,
    source: VirtualListConfig,
    materialized: BTreeSet<u32>,
    planned_window: Option<(u32, u32)>,
    /// Whether a refill request is still waiting for the Shell to answer.
    refill_in_flight: bool,
    /// Frames the current window has gone unanswered, for bounded retries.
    unanswered_frames: u32,
    /// Skeletons for this frame, reused across frames without reallocating.
    placeholders: Vec<PlaceholderRect>,
    /// Cross-axis extent used for skeleton rectangles.
    cross_extent: f32,
    /// Item range the viewport intersects, as of the last plan.
    visible: (usize, usize),
}

#[derive(Clone, Debug)]
enum AxisState {
    // Boxed for the same reason the virtual variant is: the physics grew a
    // pending fling and the enum is stored per scroll node.
    Plain(Box<ScrollPhysics>),
    Virtual(Box<VirtualState>),
}

impl AxisState {
    fn new(
        content_extent: f64,
        viewport_extent: f64,
        cross_extent: f64,
        platform: ScrollPlatform,
        virtual_list: Option<VirtualListConfig>,
    ) -> Result<Self, CoreError> {
        match virtual_list {
            Some(config) => {
                let mut state = create_virtual_axis(config, viewport_extent, platform)?;
                state.cross_extent = checked_position(cross_extent)?;
                Ok(Self::Virtual(Box::new(state)))
            }
            None => Ok(Self::Plain(Box::new(ScrollPhysics::new(
                content_extent,
                viewport_extent,
                ScrollPhysicsConfig::for_platform(platform),
            )?))),
        }
    }

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

    fn set_extents(
        &mut self,
        content_extent: f64,
        viewport_extent: f64,
        cross_extent: f64,
        platform: ScrollPlatform,
        virtual_list: Option<VirtualListConfig>,
    ) -> Result<(), CoreError> {
        match (self, virtual_list) {
            (Self::Virtual(state), Some(config)) if state.source == config => {
                state.planner.set_viewport_extent(viewport_extent)?;
                state.cross_extent = checked_position(cross_extent)?;
            }
            (Self::Plain(physics), None) => {
                physics.set_extents(content_extent, viewport_extent)?;
            }
            (state, config) => {
                let position = state.physics().position();
                let mut replacement = Self::new(
                    content_extent,
                    viewport_extent,
                    cross_extent,
                    platform,
                    config,
                )?;
                replacement.physics_mut().jump_to(position)?;
                *state = replacement;
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
struct ScrollAxes {
    x: AxisState,
    y: AxisState,
    estimated_velocity: [f64; 2],
    continuous_velocity: [f64; 2],
}

impl ScrollAxes {
    fn virtual_state(&self) -> Option<&VirtualState> {
        match &self.x {
            AxisState::Virtual(state) => Some(state),
            AxisState::Plain(_) => match &self.y {
                AxisState::Virtual(state) => Some(state),
                AxisState::Plain(_) => None,
            },
        }
    }

    fn virtual_state_mut(&mut self) -> Option<&mut VirtualState> {
        match &mut self.x {
            AxisState::Virtual(state) => Some(state),
            AxisState::Plain(_) => match &mut self.y {
                AxisState::Virtual(state) => Some(state),
                AxisState::Plain(_) => None,
            },
        }
    }

    fn has_continuous_velocity(&self) -> bool {
        self.continuous_velocity
            .iter()
            .any(|velocity| velocity.abs() > f64::EPSILON)
    }

    fn new(
        content: [f64; 2],
        viewport: [f64; 2],
        position: [f32; 2],
        platform: ScrollPlatform,
        virtual_list: Option<VirtualListConfig>,
    ) -> Result<Self, CoreError> {
        let x_virtual = virtual_list.filter(|config| config.axis == VirtualAxis::X);
        let y_virtual = virtual_list.filter(|config| config.axis == VirtualAxis::Y);
        let mut result = Self {
            x: AxisState::new(content[0], viewport[0], viewport[1], platform, x_virtual)?,
            y: AxisState::new(content[1], viewport[1], viewport[0], platform, y_virtual)?,
            estimated_velocity: [0.0; 2],
            continuous_velocity: [0.0; 2],
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
        self.x.set_extents(
            content[0],
            viewport[0],
            viewport[1],
            platform,
            virtual_list.filter(|config| config.axis == VirtualAxis::X),
        )?;
        self.y.set_extents(
            content[1],
            viewport[1],
            viewport[0],
            platform,
            virtual_list.filter(|config| config.axis == VirtualAxis::Y),
        )?;
        Ok(())
    }

    fn jump_to(&mut self, position: [f32; 2]) -> Result<(), CoreError> {
        self.x.physics_mut().jump_to(f64::from(position[0]))?;
        self.y.physics_mut().jump_to(f64::from(position[1]))?;
        self.estimated_velocity = [0.0; 2];
        self.continuous_velocity = [0.0; 2];
        Ok(())
    }

    fn jump_by(&mut self, delta: [f32; 2]) -> Result<bool, CoreError> {
        let before = self.position()?;
        self.jump_to([before[0] + delta[0], before[1] + delta[1]])?;
        Ok(position_changed(self.position()?, before))
    }

    fn begin(&mut self) {
        self.continuous_velocity = [0.0; 2];
        self.x.physics_mut().begin_drag();
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
        // Feed the observed gesture speed to both axes so the virtualizer can
        // preheat ahead of the motion even when no fling velocity is retained.
        self.x
            .physics_mut()
            .note_input_speed(self.estimated_velocity[0]);
        self.y
            .physics_mut()
            .note_input_speed(self.estimated_velocity[1]);
        let x = self.x.physics_mut().drag_by(f64::from(delta_x))?;
        let y = self.y.physics_mut().drag_by(f64::from(delta_y))?;
        Ok(x.changed || y.changed)
    }

    /// Adds a discrete wheel notch to both axes' animated destinations.
    fn wheel_notch(&mut self, delta_x: f32, delta_y: f32) -> Result<bool, CoreError> {
        let x = self.x.physics_mut().wheel_notch_by(f64::from(delta_x))?;
        let y = self.y.physics_mut().wheel_notch_by(f64::from(delta_y))?;
        Ok(x.changed || y.changed)
    }

    /// Returns whether either axis still owes a wheel animation frame.
    fn is_animating(&self) -> bool {
        self.has_continuous_velocity()
            || self.x.physics().is_animating()
            || self.y.physics().is_animating()
    }

    fn set_velocity(&mut self, velocity: [f32; 2]) -> Result<(), CoreError> {
        self.x.physics_mut().begin_drag();
        self.y.physics_mut().begin_drag();
        self.x.physics_mut().end_drag(0.0)?;
        self.y.physics_mut().end_drag(0.0)?;
        self.estimated_velocity = [0.0; 2];
        self.continuous_velocity = velocity.map(f64::from);
        Ok(())
    }

    fn end(&mut self, retain_velocity: bool) -> Result<(), CoreError> {
        let velocity = if retain_velocity {
            self.estimated_velocity
        } else {
            [0.0; 2]
        };
        self.x.physics_mut().end_drag(velocity[0])?;
        self.y.physics_mut().end_drag(velocity[1])?;
        self.estimated_velocity = [0.0; 2];
        Ok(())
    }

    fn advance(&mut self, elapsed: f64) -> Result<ScrollAdvance, CoreError> {
        if self.has_continuous_velocity() {
            let previous = [self.x.physics().position(), self.y.physics().position()];
            let x = (previous[0] + self.continuous_velocity[0] * elapsed)
                .clamp(0.0, self.x.physics().maximum_position());
            let y_maximum = self.y.physics().maximum_position();
            let y = (previous[1] + self.continuous_velocity[1] * elapsed).clamp(0.0, y_maximum);
            self.x.physics_mut().jump_to(x)?;
            self.y.physics_mut().jump_to(y)?;
            let x_changed = (x - previous[0]).abs() > f64::EPSILON;
            let y_changed = (y - previous[1]).abs() > f64::EPSILON;
            if !x_changed && self.continuous_velocity[0].abs() > f64::EPSILON {
                self.continuous_velocity[0] = 0.0;
            }
            if !y_changed && self.continuous_velocity[1].abs() > f64::EPSILON {
                self.continuous_velocity[1] = 0.0;
            }
            return Ok(ScrollAdvance {
                active: self.has_continuous_velocity(),
                changed: x_changed || y_changed,
            });
        }
        let x = self.x.physics_mut().advance(elapsed)?;
        let y = self.y.physics_mut().advance(elapsed)?;
        Ok(ScrollAdvance {
            active: x.active || y.active,
            changed: x.changed || y.changed,
        })
    }

    fn position(&self) -> Result<[f32; 2], CoreError> {
        Ok([
            checked_position(self.x.physics().position())?,
            checked_position(self.y.physics().position())?,
        ])
    }

    fn synchronize_virtual_items(
        &mut self,
        scene: &Scene,
        layout: &LayoutSnapshot,
        list: NodeId,
    ) -> Result<bool, CoreError> {
        let Some(axis) = self.virtual_state_mut() else {
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
        if next != axis.materialized {
            // The Shell answered: whatever it rendered is now in the Scene, so
            // the planner may ask for a different window on the next frame.
            axis.refill_in_flight = false;
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
                let item_size = if axis.source.axis == VirtualAxis::X {
                    size.width
                } else {
                    size.height
                };
                corrected |= axis.planner.update_extent(item_index, item_size)? != 0.0;
            }
            child = scene.next_sibling(node);
        }
        Ok(corrected)
    }
}

impl VirtualPaintResolver for ScrollController {
    fn placeholders(&self, node: NodeId) -> &[PlaceholderRect] {
        Self::placeholders(self, node)
    }
}

fn create_virtual_axis(
    source: VirtualListConfig,
    viewport: f64,
    platform: ScrollPlatform,
) -> Result<VirtualState, CoreError> {
    let item_count = usize::try_from(source.item_count)
        .map_err(|_| CoreError::InvalidScrollPosition(f64::from(source.item_count)))?;
    let extents = ExtentIndex::with_uniform(item_count, source.estimated_item_size)?;
    let planner = Virtualizer::new(
        extents,
        viewport,
        platform,
        VirtualizerConfig {
            base_overscan_viewports: f64::from(source.base_overscan_viewports),
            velocity_horizon_seconds: f64::from(source.velocity_horizon_seconds),
            maximum_ahead_viewports: f64::from(source.maximum_ahead_viewports),
        },
    )?;
    Ok(VirtualState {
        planner,
        source,
        materialized: BTreeSet::new(),
        planned_window: None,
        visible: (0, 0),
        refill_in_flight: false,
        unanswered_frames: 0,
        placeholders: Vec::new(),
        cross_extent: 0.0,
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

impl ScrollController {
    /// Creates a controller whose physics match one platform family.
    pub(crate) fn for_platform(platform: ScrollPlatform) -> Self {
        Self {
            platform,
            ..Self::default()
        }
    }
}

impl Default for ScrollController {
    fn default() -> Self {
        Self {
            states: BTreeMap::new(),
            // Overridden at construction. The default only decides the feel for
            // a caller that never states a platform.
            platform: ScrollPlatform::Ios,
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
            .filter(|node| scene.is_scroll_container(*node) && !scene.excluded_by_display(*node))
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
            if !scene.is_scroll_container(node) || scene.excluded_by_display(node) {
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
                InputCommand::SetScrollVelocity {
                    velocity_x,
                    velocity_y,
                    ..
                } => state.set_velocity([*velocity_x, *velocity_y])?,
                InputCommand::ScrollTo { x, y, .. } => {
                    let before = state.position()?;
                    state.jump_to([*x, *y])?;
                    changed |= position_changed(state.position()?, before);
                }
                InputCommand::ScrollBy {
                    delta_x, delta_y, ..
                } => changed |= state.jump_by([*delta_x, *delta_y])?,
                _ => return Err(CoreError::UnsupportedInputCommand),
            }
            active |= state.is_animating();
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

    /// Applies one wheel sample.
    ///
    /// High-precision deltas (trackpads) already arrive smoothed and already
    /// carry platform momentum, so they move the offset one-to-one. Discrete
    /// notches accumulate into an animated destination instead, which is what
    /// browsers do for mouse wheels.
    pub(crate) fn apply_wheel(
        &mut self,
        scene: &mut Scene,
        node: NodeId,
        delta: [f32; 2],
        elapsed_micros: u32,
        precise: bool,
        allow_overscroll: bool,
    ) -> Result<ScrollAdvance, CoreError> {
        if !scene.is_scroll_container(node) || scene.excluded_by_display(node) {
            return Err(CoreError::InvalidScrollTarget { node });
        }
        let mut state = self
            .states
            .get(&node)
            .ok_or(CoreError::InvalidScrollTarget { node })?
            .clone();
        let previous = state.position()?;
        let changed = if precise {
            state.begin();
            state.delta(delta[0], delta[1], elapsed_micros)?;
            state.end(false)?;
            if !allow_overscroll {
                let position = state.position()?;
                state.jump_to(position)?;
            }
            position_changed(state.position()?, previous)
        } else {
            state.wheel_notch(delta[0], delta[1])?
        };
        let active = state.is_animating();
        scene.apply_scroll_position(node, state.position()?)?;
        self.states.insert(node, state);
        self.metrics.input_commands = self.metrics.input_commands.saturating_add(1);
        Ok(ScrollAdvance { active, changed })
    }

    pub(crate) fn can_scroll_delta(
        &self,
        node: NodeId,
        delta: [f32; 2],
    ) -> Result<bool, CoreError> {
        let state = self
            .states
            .get(&node)
            .ok_or(CoreError::InvalidScrollTarget { node })?;
        let can_axis = |position: f64, maximum: f64, incoming: f32| {
            (incoming < 0.0 && position > 0.0) || (incoming > 0.0 && position < maximum)
        };
        Ok(can_axis(
            state.x.physics().position(),
            state.x.physics().maximum_position(),
            delta[0],
        ) || can_axis(
            state.y.physics().position(),
            state.y.physics().maximum_position(),
            delta[1],
        ))
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
        allow_overscroll: bool,
    ) -> Result<ScrollAdvance, CoreError> {
        let state = self
            .states
            .get_mut(&node)
            .ok_or(CoreError::InvalidScrollTarget { node })?;
        let previous = state.position()?;
        state.delta(delta[0], delta[1], elapsed_micros)?;
        if !allow_overscroll {
            let position = state.position()?;
            state.jump_to(position)?;
        }
        let changed = position_changed(state.position()?, previous);
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

    /// Returns this frame's skeletons for a scroll node, empty when fully materialized.
    /// Returns the viewport's item range, or an empty range without a list.
    pub(crate) fn visible_item_range(&self) -> (usize, usize) {
        self.states
            .values()
            .find_map(|state| state.virtual_state().map(|axis| axis.visible))
            .unwrap_or((0, 0))
    }

    /// Returns the item range the Shell has materialized, empty without a list.
    pub(crate) fn materialized_range(&self) -> (usize, usize) {
        self.states
            .values()
            .find_map(|state| state.virtual_state().map(|axis| axis.materialized.clone()))
            .and_then(|items| {
                let first = *items.first()?;
                let last = *items.last()?;
                Some((first as usize, last as usize + 1))
            })
            .unwrap_or((0, 0))
    }

    /// Returns how many visible items are drawn as skeletons across all lists.
    pub(crate) fn visible_placeholders(&self) -> usize {
        self.states
            .values()
            .map(|state| {
                state
                    .virtual_state()
                    .map_or(0, |axis| axis.placeholders.len())
            })
            .sum()
    }

    pub(crate) fn placeholders(&self, node: NodeId) -> &[PlaceholderRect] {
        self.states
            .get(&node)
            .and_then(ScrollAxes::virtual_state)
            .map_or(&[], |axis| axis.placeholders.as_slice())
    }

    pub(crate) fn take_refills(&mut self) -> Vec<VirtualRefillRequest> {
        core::mem::take(&mut self.pending_refills)
    }

    pub(crate) fn plan_virtual_frames(&mut self) -> Result<(), CoreError> {
        for (&node, state) in &mut self.states {
            let Some(axis) = state.virtual_state_mut() else {
                continue;
            };
            let (missing, visible, ranges, preheat) = {
                let frame = axis.planner.plan_frame()?;
                (
                    frame.placeholders,
                    frame.visible.clone(),
                    frame.refill.to_vec(),
                    frame.preheat.clone(),
                )
            };
            let placeholders = u64::try_from(missing).unwrap_or(u64::MAX);
            // Every visible item the Shell has not materialized becomes a
            // skeleton. Without this the viewport simply renders nothing there,
            // which is the blank canvas users see when a fast gesture outruns
            // the refill round trip.
            let visible_range = visible.clone();
            axis.visible = (visible_range.start, visible_range.end);
            axis.placeholders.clear();
            if missing > 0 {
                let cross_extent = axis.cross_extent;
                for index in visible {
                    if axis.planner.is_available(index) {
                        continue;
                    }
                    let offset = axis.planner.extents().offset_of(index)?;
                    let extent = axis.planner.extents().extent(index).unwrap_or(0.0);
                    let rect = if axis.source.axis == VirtualAxis::X {
                        [checked_position(offset)?, 0.0, extent, cross_extent]
                    } else {
                        [0.0, checked_position(offset)?, cross_extent, extent]
                    };
                    axis.placeholders.push(PlaceholderRect {
                        rect,
                        rgba: PLACEHOLDER_RGBA,
                    });
                }
            }
            let visible_start = u32::try_from(visible_range.start).unwrap_or(u32::MAX);
            let visible_end = u32::try_from(visible_range.end).unwrap_or(u32::MAX);
            let window_start = u32::try_from(preheat.start)
                .map_err(|_| CoreError::InvalidScrollPosition(f64::MAX))?;
            let window_end = u32::try_from(preheat.end)
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
            // Deduplicating purely on the window value meant a request the Shell
            // never answered was never repeated, and the viewport could sit on
            // skeletons forever. Repeating it every frame is the opposite
            // failure: materializing a preheat window is a full rebuild of a few
            // hundred nodes, so asking again before the previous answer lands
            // makes the Shell thrash and never catch up. Retry on a bounded
            // interval instead, and only while the viewport is actually starved.
            if missing > 0 {
                axis.unanswered_frames = axis.unanswered_frames.saturating_add(1);
            } else {
                axis.unanswered_frames = 0;
            }
            // A window that still covers the viewport is not worth rebuilding
            // while the Shell is still working on the last request. Once that
            // answer has landed and the viewport is still short, waiting is
            // pure latency: the answer was for a window the offset has left,
            // and nothing else is coming. Ask again immediately instead. The
            // frame count stays as a backstop for a Shell that answers a
            // request without materializing anything at all.
            let answered = !axis.refill_in_flight;
            let retry = (missing > 0 && answered) || axis.unanswered_frames >= REFILL_RETRY_FRAMES;
            // The projected lead decays smoothly for about a second after a
            // gesture, so the window shrinks by a few items every frame. Asking
            // again for each of those meant the Shell rebuilt the window on
            // every frame of the decay and never converged. Only a materially
            // different window is worth a rebuild -- but a window that no longer
            // covers what the user can see always is.
            let covers_visible = axis
                .planned_window
                .is_some_and(|(start, end)| start <= visible_start && visible_end <= end);
            let moved_materially = axis.planned_window.is_none_or(|(start, end)| {
                let span = end.saturating_sub(start).max(1);
                let drift = start.abs_diff(window_start) + end.abs_diff(window_end);
                drift.saturating_mul(4) >= span
            });
            if window_start < window_end && (!covers_visible || moved_materially || retry) {
                if retry {
                    axis.unanswered_frames = 0;
                }
                axis.refill_in_flight = true;
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

fn position_changed(left: [f32; 2], right: [f32; 2]) -> bool {
    left[0].to_bits() != right[0].to_bits() || left[1].to_bits() != right[1].to_bits()
}

impl VirtualLayoutProvider for ScrollController {
    fn item_offset(&self, list: NodeId, item_index: u32) -> Option<f32> {
        let state = self.states.get(&list)?;
        let axis = state.virtual_state()?;
        let index = usize::try_from(item_index).ok()?;
        virtual_dimension(axis.planner.extents().offset_of(index).ok()?)
    }

    fn content_extent(&self, list: NodeId) -> Option<f32> {
        let state = self.states.get(&list)?;
        let axis = state.virtual_state()?;
        virtual_dimension(axis.planner.extents().total_extent())
    }
}

fn input_node(command: &InputCommand) -> Result<NodeId, CoreError> {
    let raw = match command {
        InputCommand::ScrollBegin { node_id }
        | InputCommand::ScrollDelta { node_id, .. }
        | InputCommand::ScrollEnd { node_id }
        | InputCommand::ScrollCancel { node_id }
        | InputCommand::SetScrollVelocity { node_id, .. }
        | InputCommand::ScrollTo { node_id, .. }
        | InputCommand::ScrollBy { node_id, .. } => *node_id,
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
    // How far the content reaches, not how large the direct children's boxes
    // are. A child with an explicit size still lays its own children out at
    // their natural extent, so content routinely runs past the box that clips
    // it -- a list row wider than the viewport is exactly that -- and scrolling
    // is defined against the reach, the way the DOM defines `scrollWidth`.
    //
    // Computed here rather than stored per node in the layout snapshot: layout
    // stops propagating a size change at a fixed-size ancestor, and reach is
    // the one quantity that has to cross that boundary. Only scroll nodes need
    // it, and only over their materialized subtree.
    let mut content = [0.0_f64; 2];
    let mut stack: Vec<(NodeId, f32, f32)> = Vec::new();
    let mut child = scene.first_child(node);
    while let Some(current) = child {
        stack.push((current, 0.0, 0.0));
        child = scene.next_sibling(current);
    }
    while let Some((current, base_x, base_y)) = stack.pop() {
        let (offset, size) = layout
            .geometry(current)
            .ok_or(CoreError::MissingScrollGeometry { node: current })?;
        let x = base_x + offset.x;
        let y = base_y + offset.y;
        content[0] = content[0].max(f64::from(x + size.width));
        content[1] = content[1].max(f64::from(y + size.height));
        let mut inner = scene.first_child(current);
        while let Some(next) = inner {
            stack.push((next, x, y));
            inner = scene.next_sibling(next);
        }
    }
    let viewport = [
        f64::from(viewport_size.width),
        f64::from(viewport_size.height),
    ];
    if !scene.scrollable_axis(node, true) {
        content[0] = viewport[0];
    }
    if !scene.scrollable_axis(node, false) {
        content[1] = viewport[1];
    }
    Ok((content, viewport))
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
