use std::{collections::BTreeSet, sync::Arc};

use doper_abi::{
    FRAME_DIAGNOSTICS_DIRTY_HIT_NODES_INDEX, FRAME_DIAGNOSTICS_DIRTY_LAYOUT_NODES_INDEX,
    FRAME_DIAGNOSTICS_DIRTY_PAINT_NODES_INDEX, FRAME_DIAGNOSTICS_DIRTY_PAINT_SELF_NODES_INDEX,
    FRAME_DIAGNOSTICS_DIRTY_SEMANTICS_NODES_INDEX, FRAME_DIAGNOSTICS_DISPLAY_COMMANDS_INDEX,
    FRAME_DIAGNOSTICS_FRAME_SEQ_INDEX, FRAME_DIAGNOSTICS_LAYOUT_CHANGED_NODES_INDEX,
    FRAME_DIAGNOSTICS_LAYOUT_VISITED_NODES_INDEX, FRAME_DIAGNOSTICS_OVER_INVALIDATED_FRAMES_INDEX,
    FRAME_DIAGNOSTICS_PAINT_REBUILT_INDEX, FRAME_DIAGNOSTICS_PICTURE_BUILDS_INDEX,
    FRAME_DIAGNOSTICS_PICTURE_CACHE_HITS_INDEX, FRAME_DIAGNOSTICS_PICTURE_HASH_HIGH_INDEX,
    FRAME_DIAGNOSTICS_PICTURE_HASH_LOW_INDEX, FRAME_DIAGNOSTICS_PICTURE_SUBTREE_BUILDS_INDEX,
    FRAME_DIAGNOSTICS_PICTURE_SUBTREE_CACHE_HITS_INDEX, FRAME_DIAGNOSTICS_SCENE_NODES_INDEX,
    FRAME_DIAGNOSTICS_VERSION, FRAME_DIAGNOSTICS_VERSION_INDEX, FRAME_DIAGNOSTICS_WORDS,
    InputBatch, Mutation, MutationBatch, ResourceKind, TEXT_STYLE_FONT_SIZE_OFFSET,
    TEXT_STYLE_LINE_HEIGHT_OFFSET,
};
use doper_layout::{BoxConstraints, IntrinsicMeasurer, LayoutEngine, Size};
use doper_paint::{PaintEngine, PaintMetrics};
use doper_scene::{BitSet, DirtyDomain, NodeId, Scene, SceneMetrics};

use crate::{CoreError, CoreScrollMetrics, scroll::ScrollController};

/// Cumulative top-level frame and failure counters.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CoreMetrics {
    /// Frames whose Scene, layout and paint phases all committed.
    pub committed_frames: u64,
    /// Mutation byte streams rejected before Scene access.
    pub abi_rejections: u64,
    /// Transactions rejected atomically by Scene.
    pub scene_rejections: u64,
    /// Derived-state failures that poisoned the instance.
    pub fatal_derivation_failures: u64,
    /// Input Stream batches accepted by Core-owned subsystems.
    pub accepted_input_batches: u64,
    /// Input Stream batches rejected atomically.
    pub input_rejections: u64,
    /// Worker clock frames that changed a Core-owned scroll position.
    pub scroll_frames: u64,
}

/// Deterministic work and invalidation diagnostics for one accepted frame.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FrameDiagnostics {
    /// Sequence encoded in the Mutation Stream Commit instruction.
    pub frame_seq: u32,
    /// Scene nodes present after the transaction committed.
    pub scene_nodes: usize,
    /// Nodes entering layout dirty.
    pub dirty_layout_nodes: usize,
    /// Nodes entering subtree paint dirty.
    pub dirty_paint_nodes: usize,
    /// Nodes entering node-local paint dirty.
    pub dirty_paint_self_nodes: usize,
    /// Nodes entering hit-test dirty.
    pub dirty_hit_nodes: usize,
    /// Nodes entering semantics dirty.
    pub dirty_semantics_nodes: usize,
    /// Nodes whose committed geometry changed.
    pub layout_changed_nodes: usize,
    /// Nodes visited by the layout phase.
    pub layout_visited_nodes: usize,
    /// Drawing commands in the active immutable Picture.
    pub display_commands: usize,
    /// Whether paint rebuilt the Picture instead of reusing it.
    pub paint_rebuilt: bool,
    /// Cumulative immutable Picture builds.
    pub picture_builds: u64,
    /// Cumulative clean-frame Picture cache hits.
    pub picture_cache_hits: u64,
    /// Cumulative immutable subtree Picture builds.
    pub picture_subtree_builds: u64,
    /// Cumulative unchanged sibling subtree reuse.
    pub picture_subtree_cache_hits: u64,
    /// Cumulative dirty frames whose rebuilt bytes did not change.
    pub over_invalidated_frames: u64,
    /// Deterministic FNV-1a hash of the active Picture bytes.
    pub picture_hash: u64,
}

impl FrameDiagnostics {
    /// Encodes the generated, versioned host diagnostics word layout.
    #[must_use]
    pub fn to_words(self) -> [u32; FRAME_DIAGNOSTICS_WORDS] {
        let mut words = [0; FRAME_DIAGNOSTICS_WORDS];
        words[FRAME_DIAGNOSTICS_VERSION_INDEX] = FRAME_DIAGNOSTICS_VERSION;
        words[FRAME_DIAGNOSTICS_FRAME_SEQ_INDEX] = self.frame_seq;
        words[FRAME_DIAGNOSTICS_SCENE_NODES_INDEX] = count_word(self.scene_nodes);
        words[FRAME_DIAGNOSTICS_DIRTY_LAYOUT_NODES_INDEX] = count_word(self.dirty_layout_nodes);
        words[FRAME_DIAGNOSTICS_DIRTY_PAINT_NODES_INDEX] = count_word(self.dirty_paint_nodes);
        words[FRAME_DIAGNOSTICS_DIRTY_PAINT_SELF_NODES_INDEX] =
            count_word(self.dirty_paint_self_nodes);
        words[FRAME_DIAGNOSTICS_DIRTY_HIT_NODES_INDEX] = count_word(self.dirty_hit_nodes);
        words[FRAME_DIAGNOSTICS_DIRTY_SEMANTICS_NODES_INDEX] =
            count_word(self.dirty_semantics_nodes);
        words[FRAME_DIAGNOSTICS_LAYOUT_CHANGED_NODES_INDEX] = count_word(self.layout_changed_nodes);
        words[FRAME_DIAGNOSTICS_LAYOUT_VISITED_NODES_INDEX] = count_word(self.layout_visited_nodes);
        words[FRAME_DIAGNOSTICS_DISPLAY_COMMANDS_INDEX] = count_word(self.display_commands);
        words[FRAME_DIAGNOSTICS_PAINT_REBUILT_INDEX] = u32::from(self.paint_rebuilt);
        words[FRAME_DIAGNOSTICS_PICTURE_BUILDS_INDEX] = count_u64_word(self.picture_builds);
        words[FRAME_DIAGNOSTICS_PICTURE_CACHE_HITS_INDEX] = count_u64_word(self.picture_cache_hits);
        words[FRAME_DIAGNOSTICS_PICTURE_SUBTREE_BUILDS_INDEX] =
            count_u64_word(self.picture_subtree_builds);
        words[FRAME_DIAGNOSTICS_PICTURE_SUBTREE_CACHE_HITS_INDEX] =
            count_u64_word(self.picture_subtree_cache_hits);
        words[FRAME_DIAGNOSTICS_OVER_INVALIDATED_FRAMES_INDEX] =
            count_u64_word(self.over_invalidated_frames);
        let hash = self.picture_hash.to_le_bytes();
        words[FRAME_DIAGNOSTICS_PICTURE_HASH_LOW_INDEX] =
            u32::from_le_bytes([hash[0], hash[1], hash[2], hash[3]]);
        words[FRAME_DIAGNOSTICS_PICTURE_HASH_HIGH_INDEX] =
            u32::from_le_bytes([hash[4], hash[5], hash[6], hash[7]]);
        words
    }
}

/// Immutable output of one accepted single-threaded frame.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FrameOutput {
    /// Sequence encoded in the accepted Mutation Stream commit instruction.
    pub frame_seq: u32,
    /// Flat binary `DisplayList` ready for a backend replay loop.
    pub display_list: Arc<[u8]>,
    /// Whether paint rebuilt instead of reusing its immutable Picture.
    pub rebuilt: bool,
    /// Deterministic per-phase work, dirty-domain, and Picture diagnostics.
    pub diagnostics: FrameDiagnostics,
}

/// Deterministic M1 orchestration of decode, Scene, layout and paint.
pub struct CoreEngine {
    scene: Scene,
    layout: LayoutEngine,
    paint: PaintEngine,
    scroll: ScrollController,
    constraints: BoxConstraints,
    metrics: CoreMetrics,
    last_frame_seq: Option<u32>,
    poisoned: bool,
}

impl CoreEngine {
    /// Creates an empty Core with finite logical-pixel viewport bounds.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::InvalidViewport`] for negative or non-finite bounds.
    pub fn new(width: f32, height: f32) -> Result<Self, CoreError> {
        let constraints = viewport_constraints(width, height)?;
        Ok(Self {
            scene: Scene::new(),
            layout: LayoutEngine::new(),
            paint: PaintEngine::new(),
            scroll: ScrollController::default(),
            constraints,
            metrics: CoreMetrics::default(),
            last_frame_seq: None,
            poisoned: false,
        })
    }

    /// Decodes and commits one complete frame, returning backend-ready bytes.
    ///
    /// # Errors
    ///
    /// Returns a trust-boundary or Scene validation error without poisoning the
    /// instance. A layout or paint invariant failure poisons the instance and
    /// all later calls return [`CoreError::Poisoned`].
    pub fn commit(&mut self, bytes: &[u8]) -> Result<FrameOutput, CoreError> {
        if self.poisoned {
            return Err(CoreError::Poisoned);
        }
        let batch = match MutationBatch::decode(bytes) {
            Ok(batch) => batch,
            Err(error) => {
                self.metrics.abi_rejections += 1;
                return Err(CoreError::Abi(error));
            }
        };
        let frame_seq = batch.frame_seq;
        let programmatic_scrolls: BTreeSet<u32> = batch
            .instructions
            .iter()
            .filter_map(|instruction| match instruction.mutation {
                Mutation::ScrollTo { node_id, .. } => Some(node_id),
                _ => None,
            })
            .collect();
        if let Err(error) = self.scene.commit(batch) {
            self.metrics.scene_rejections += 1;
            return Err(CoreError::Scene(error));
        }

        let mut measurer = FallbackTextMeasurer;
        let mut geometry = match self.layout.layout_with_virtual(
            &self.scene,
            self.constraints,
            &mut measurer,
            &self.scroll,
        ) {
            Ok(outcome) => outcome,
            Err(error) => return self.poison(CoreError::Layout(error)),
        };
        let corrected = match self.scroll.synchronize(
            &mut self.scene,
            self.layout.snapshot(),
            &programmatic_scrolls,
        ) {
            Ok(corrected) => corrected,
            Err(error) => return self.poison(error),
        };
        if !corrected.is_empty() {
            self.layout.mark_virtual_measurements_changed(&corrected);
            let corrected_geometry = match self.layout.layout_with_virtual(
                &self.scene,
                self.constraints,
                &mut measurer,
                &self.scroll,
            ) {
                Ok(outcome) => outcome,
                Err(error) => return self.poison(CoreError::Layout(error)),
            };
            for index in corrected_geometry.changed.iter_ones() {
                geometry.changed.insert(index);
            }
            geometry.visited = geometry.visited.saturating_add(corrected_geometry.visited);
        }
        let output = self.paint_frame(frame_seq, &geometry.changed, geometry.visited)?;
        self.metrics.committed_frames += 1;
        self.last_frame_seq = Some(frame_seq);
        Ok(output)
    }

    /// Atomically applies one Input Stream transaction to Core-owned scrolling.
    ///
    /// Returns a new `DisplayList` only when direct manipulation changed pixels.
    /// Editing commands are accepted by the editing subsystem in M3-B and are
    /// rejected here until that state is integrated.
    ///
    /// # Errors
    ///
    /// Returns an ABI, sequence, target, or scroll validation error without
    /// partially applying the input batch.
    pub fn input(&mut self, bytes: &[u8]) -> Result<Option<FrameOutput>, CoreError> {
        if self.poisoned {
            return Err(CoreError::Poisoned);
        }
        let batch = match InputBatch::decode(bytes) {
            Ok(batch) => batch,
            Err(error) => {
                self.metrics.input_rejections = self.metrics.input_rejections.saturating_add(1);
                return Err(CoreError::Abi(error));
            }
        };
        let outcome = match self.scroll.apply_input(&mut self.scene, &batch) {
            Ok(outcome) => outcome,
            Err(error) => {
                self.metrics.input_rejections = self.metrics.input_rejections.saturating_add(1);
                return Err(error);
            }
        };
        if let Err(error) = self.scroll.plan_virtual_frames() {
            return self.poison(error);
        }
        self.metrics.accepted_input_batches = self.metrics.accepted_input_batches.saturating_add(1);
        if !outcome.changed {
            return Ok(None);
        }
        let frame_seq = self
            .last_frame_seq
            .ok_or(CoreError::MissingCommittedFrame)?;
        let output = self.paint_frame(frame_seq, &BitSet::with_len(self.scene.len()), 0)?;
        Ok(Some(output))
    }

    /// Advances Core-owned animation from an injectable Worker clock delta.
    ///
    /// Returns a `DisplayList` only while the frame changed a scroll position.
    /// Catch-up work is capped and sub-stepped to remain stable after stalls.
    ///
    /// # Errors
    ///
    /// Returns a frame-delta or scroll invariant error; derived paint failures
    /// poison the Core instance.
    pub fn advance(&mut self, elapsed_seconds: f64) -> Result<Option<FrameOutput>, CoreError> {
        if self.poisoned {
            return Err(CoreError::Poisoned);
        }
        let outcome = self.scroll.advance(&mut self.scene, elapsed_seconds)?;
        if let Err(error) = self.scroll.plan_virtual_frames() {
            return self.poison(error);
        }
        if !outcome.changed {
            return Ok(None);
        }
        let frame_seq = self
            .last_frame_seq
            .ok_or(CoreError::MissingCommittedFrame)?;
        let output = self.paint_frame(frame_seq, &BitSet::with_len(self.scene.len()), 0)?;
        self.metrics.scroll_frames = self.metrics.scroll_frames.saturating_add(1);
        Ok(Some(output))
    }

    /// Changes viewport constraints for the next accepted mutation frame.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::InvalidViewport`] for invalid bounds or
    /// [`CoreError::Poisoned`] when the instance must be replaced.
    pub fn set_viewport(&mut self, width: f32, height: f32) -> Result<(), CoreError> {
        if self.poisoned {
            return Err(CoreError::Poisoned);
        }
        self.constraints = viewport_constraints(width, height)?;
        Ok(())
    }

    /// Returns whether a derived-state failure requires creating a new instance.
    #[must_use]
    pub const fn is_poisoned(&self) -> bool {
        self.poisoned
    }

    /// Returns the committed Scene for diagnostics and headless assertions.
    #[must_use]
    pub const fn scene(&self) -> &Scene {
        &self.scene
    }

    /// Returns top-level acceptance and rejection counters.
    #[must_use]
    pub const fn metrics(&self) -> CoreMetrics {
        self.metrics
    }

    /// Returns Scene counters without exposing mutable subsystem state.
    #[must_use]
    pub const fn scene_metrics(&self) -> SceneMetrics {
        self.scene.metrics()
    }

    /// Returns paint cache and invalidation counters.
    #[must_use]
    pub const fn paint_metrics(&self) -> PaintMetrics {
        self.paint.metrics()
    }

    /// Returns Core-owned scroll input, catch-up, and physics counters.
    #[must_use]
    pub const fn scroll_metrics(&self) -> CoreScrollMetrics {
        self.scroll.metrics()
    }

    /// Drains coalesced virtual-list refill requests produced by accepted frames.
    ///
    /// Requests are emitted after rendering and never invoke Shell code from the
    /// Core frame loop. An empty vector means no new range needs materialization.
    pub fn take_virtual_refills(&mut self) -> Vec<crate::VirtualRefillRequest> {
        self.scroll.take_refills()
    }

    fn paint_frame(
        &mut self,
        frame_seq: u32,
        geometry_changed: &BitSet,
        layout_visited_nodes: usize,
    ) -> Result<FrameOutput, CoreError> {
        let scene_nodes = self.scene.len();
        let dirty_layout_nodes = dirty_count(&self.scene, DirtyDomain::Layout);
        let dirty_paint_nodes = dirty_count(&self.scene, DirtyDomain::Paint);
        let dirty_paint_self_nodes = dirty_count(&self.scene, DirtyDomain::PaintSelf);
        let dirty_hit_nodes = dirty_count(&self.scene, DirtyDomain::Hit);
        let dirty_semantics_nodes = dirty_count(&self.scene, DirtyDomain::Semantics);
        let painted =
            match self
                .paint
                .paint(&self.scene, self.layout.snapshot(), geometry_changed, false)
            {
                Ok(outcome) => outcome,
                Err(error) => return self.poison(CoreError::Paint(error)),
            };
        let paint_metrics = self.paint.metrics();
        let diagnostics = FrameDiagnostics {
            frame_seq,
            scene_nodes,
            dirty_layout_nodes,
            dirty_paint_nodes,
            dirty_paint_self_nodes,
            dirty_hit_nodes,
            dirty_semantics_nodes,
            layout_changed_nodes: geometry_changed.iter_ones().count(),
            layout_visited_nodes,
            display_commands: paint_metrics.last_command_count,
            paint_rebuilt: painted.rebuilt,
            picture_builds: paint_metrics.builds,
            picture_cache_hits: paint_metrics.cache_hits,
            picture_subtree_builds: paint_metrics.subtree_builds,
            picture_subtree_cache_hits: paint_metrics.subtree_cache_hits,
            over_invalidated_frames: paint_metrics.over_invalidated_frames,
            picture_hash: painted.picture.hash(),
        };
        self.scene.clear_dirty();
        Ok(FrameOutput {
            frame_seq,
            display_list: Arc::from(painted.picture.bytes()),
            rebuilt: painted.rebuilt,
            diagnostics,
        })
    }

    fn poison<T>(&mut self, error: CoreError) -> Result<T, CoreError> {
        self.poisoned = true;
        self.metrics.fatal_derivation_failures += 1;
        Err(error)
    }
}

fn dirty_count(scene: &Scene, domain: DirtyDomain) -> usize {
    scene.dirty(domain).iter_ones().count()
}

fn count_word(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn count_u64_word(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn viewport_constraints(width: f32, height: f32) -> Result<BoxConstraints, CoreError> {
    if !width.is_finite() || !height.is_finite() || width < 0.0 || height < 0.0 {
        return Err(CoreError::InvalidViewport { width, height });
    }
    BoxConstraints::new(0.0, width, 0.0, height)
        .map_err(|_| CoreError::InvalidViewport { width, height })
}

struct FallbackTextMeasurer;

impl IntrinsicMeasurer for FallbackTextMeasurer {
    fn measure(&mut self, scene: &Scene, node: NodeId, constraints: BoxConstraints) -> Size {
        let Some(run) = scene.text_run(node) else {
            return Size::ZERO;
        };
        let Some(string) = scene
            .resource(run.string_id)
            .filter(|resource| resource.kind == ResourceKind::Utf8String)
            .and_then(|resource| std::str::from_utf8(&resource.bytes).ok())
        else {
            return Size::ZERO;
        };
        let Some(style) = scene
            .resource(run.style_id)
            .filter(|resource| resource.kind == ResourceKind::TextStyle)
        else {
            return Size::ZERO;
        };
        let font_size = read_f32(&style.bytes, TEXT_STYLE_FONT_SIZE_OFFSET).unwrap_or(0.0);
        let line_height = read_f32(&style.bytes, TEXT_STYLE_LINE_HEIGHT_OFFSET).unwrap_or(0.0);
        let mut line_count = 0_usize;
        let mut longest_line = 0_usize;
        for line in string.split('\n') {
            line_count += 1;
            longest_line = longest_line.max(line.chars().count());
        }
        let width = usize_to_f32(longest_line) * font_size * 0.6;
        let height = usize_to_f32(line_count) * line_height;
        constraints.constrain(Size::new(width, height))
    }
}

fn read_f32(bytes: &[u8], offset: usize) -> Option<f32> {
    let field = bytes.get(offset..offset.checked_add(4)?)?;
    Some(f32::from_le_bytes(field.try_into().ok()?))
}

#[allow(clippy::cast_precision_loss)]
fn usize_to_f32(value: usize) -> f32 {
    // Resource limits keep normal input below this exact-integer boundary. The
    // clamp also makes hostile platform-sized values deterministic.
    value.min(1 << f32::MANTISSA_DIGITS) as f32
}

#[cfg(test)]
mod tests {
    use doper_abi::{
        DisplayCommand, DisplayList, InputBatch, InputCommand, InputInstruction, Mutation,
        MutationBatch, MutationInstruction, NULL_NODE_ID, NodeKind, Prop, ReplayRecord,
        ReplayRecording, ResourceKind,
    };
    use doper_edit::{EditConfig, EditSession, Selection};
    use doper_headless::HeadlessRenderer;
    use doper_paint::SolidPaint;
    use doper_scene::NodeId;

    use super::CoreEngine;
    use crate::CoreError;

    fn id(index: u32) -> u32 {
        NodeId::new(index, 1).expect("test node id").raw()
    }

    fn instruction(mutation: Mutation) -> MutationInstruction {
        MutationInstruction { flags: 0, mutation }
    }

    fn frame(frame_seq: u32, mutations: Vec<Mutation>) -> Vec<u8> {
        MutationBatch {
            frame_seq,
            instructions: mutations.into_iter().map(instruction).collect(),
        }
        .encode()
        .expect("encode frame")
    }

    fn painted_tree() -> Vec<u8> {
        frame(
            1,
            vec![
                Mutation::CreateNode {
                    node_id: id(0),
                    kind: NodeKind::Root,
                    parent: NULL_NODE_ID,
                    before_sibling: NULL_NODE_ID,
                },
                Mutation::CreateNode {
                    node_id: id(1),
                    kind: NodeKind::Container,
                    parent: id(0),
                    before_sibling: NULL_NODE_ID,
                },
                Mutation::SetF32 {
                    node_id: id(1),
                    prop: Prop::Width,
                    value: 80.0,
                },
                Mutation::SetF32 {
                    node_id: id(1),
                    prop: Prop::Height,
                    value: 40.0,
                },
                Mutation::DefineResource {
                    resource_id: 1,
                    kind: ResourceKind::Paint,
                    bytes: SolidPaint {
                        red: 12,
                        green: 34,
                        blue: 56,
                        alpha: 255,
                    }
                    .encode()
                    .to_vec(),
                },
                Mutation::SetRef {
                    node_id: id(1),
                    prop: Prop::BackgroundColor,
                    resource_id: 1,
                },
            ],
        )
    }

    fn scroll_tree() -> Vec<u8> {
        frame(
            1,
            vec![
                Mutation::CreateNode {
                    node_id: id(0),
                    kind: NodeKind::Root,
                    parent: NULL_NODE_ID,
                    before_sibling: NULL_NODE_ID,
                },
                Mutation::CreateNode {
                    node_id: id(1),
                    kind: NodeKind::Scroll,
                    parent: id(0),
                    before_sibling: NULL_NODE_ID,
                },
                Mutation::CreateNode {
                    node_id: id(2),
                    kind: NodeKind::Container,
                    parent: id(1),
                    before_sibling: NULL_NODE_ID,
                },
                Mutation::SetF32 {
                    node_id: id(1),
                    prop: Prop::Width,
                    value: 100.0,
                },
                Mutation::SetF32 {
                    node_id: id(1),
                    prop: Prop::Height,
                    value: 100.0,
                },
                Mutation::SetF32 {
                    node_id: id(2),
                    prop: Prop::Width,
                    value: 500.0,
                },
                Mutation::SetF32 {
                    node_id: id(2),
                    prop: Prop::Height,
                    value: 1_000.0,
                },
            ],
        )
    }

    fn virtual_list_tree() -> Vec<u8> {
        frame(
            1,
            vec![
                Mutation::CreateNode {
                    node_id: id(0),
                    kind: NodeKind::Root,
                    parent: NULL_NODE_ID,
                    before_sibling: NULL_NODE_ID,
                },
                Mutation::CreateNode {
                    node_id: id(1),
                    kind: NodeKind::Scroll,
                    parent: id(0),
                    before_sibling: NULL_NODE_ID,
                },
                Mutation::SetF32 {
                    node_id: id(1),
                    prop: Prop::Width,
                    value: 100.0,
                },
                Mutation::SetF32 {
                    node_id: id(1),
                    prop: Prop::Height,
                    value: 100.0,
                },
                Mutation::ConfigureVirtualList {
                    node_id: id(1),
                    item_count: 1_000_000,
                    estimated_item_height: 20.0,
                    base_overscan_viewports: 1.0,
                    velocity_horizon_seconds: 0.25,
                    maximum_ahead_viewports: 4.0,
                },
            ],
        )
    }

    fn input(frame_seq: u32, commands: Vec<InputCommand>) -> Vec<u8> {
        InputBatch {
            frame_seq,
            instructions: commands
                .into_iter()
                .map(|command| InputInstruction { flags: 0, command })
                .collect(),
        }
        .encode()
        .expect("input frame")
    }

    #[test]
    fn executes_the_complete_single_threaded_frame_pipeline() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        let output = engine.commit(&painted_tree()).expect("frame");
        let display = DisplayList::decode(&output.display_list).expect("DisplayList");

        assert_eq!(output.frame_seq, 1);
        assert!(output.rebuilt);
        assert_eq!(output.diagnostics.frame_seq, 1);
        assert_eq!(output.diagnostics.scene_nodes, 2);
        assert_eq!(output.diagnostics.dirty_layout_nodes, 2);
        assert_eq!(output.diagnostics.layout_changed_nodes, 2);
        assert!(output.diagnostics.display_commands > 0);
        assert_ne!(output.diagnostics.picture_hash, 0);
        assert_eq!(output.diagnostics.to_words().len(), 19);
        assert_eq!(output.diagnostics.picture_builds, 1);
        assert_eq!(output.diagnostics.picture_cache_hits, 0);
        assert_eq!(output.diagnostics.picture_subtree_builds, 2);
        assert_eq!(output.diagnostics.picture_subtree_cache_hits, 0);
        assert_eq!(output.diagnostics.over_invalidated_frames, 0);
        assert!(display.instructions.iter().any(|instruction| matches!(
            instruction.command,
            DisplayCommand::FillRect {
                rect: [0.0, 0.0, 80.0, 40.0],
                paint_id: 1
            }
        )));
        assert_eq!(engine.metrics().committed_frames, 1);
        assert!(
            engine
                .scene()
                .dirty(doper_scene::DirtyDomain::Paint)
                .iter_ones()
                .next()
                .is_none()
        );
        let image = HeadlessRenderer::new()
            .render(&output.display_list, engine.scene(), 100, 80)
            .expect("headless pixels");
        let filled = (10 * 100 + 10) * 4;
        assert_eq!(&image.pixels()[filled..filled + 4], &[12, 34, 56, 255]);
    }

    #[test]
    fn identical_engines_produce_exact_display_bytes() {
        let bytes = painted_tree();
        let mut first = CoreEngine::new(320.0, 240.0).expect("first");
        let mut second = CoreEngine::new(320.0, 240.0).expect("second");

        let first = first.commit(&bytes).expect("first output");
        let second = second.commit(&bytes).expect("second output");
        assert_eq!(first, second);
    }

    #[test]
    fn clean_frame_reuses_picture_and_reports_zero_derived_work() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        let first = engine.commit(&painted_tree()).expect("first frame");
        let second = engine.commit(&frame(2, Vec::new())).expect("clean frame");

        assert!(!second.rebuilt);
        assert_eq!(second.display_list, first.display_list);
        assert_eq!(
            second.diagnostics.picture_hash,
            first.diagnostics.picture_hash
        );
        assert_eq!(second.diagnostics.dirty_layout_nodes, 0);
        assert_eq!(second.diagnostics.dirty_paint_nodes, 0);
        assert_eq!(second.diagnostics.layout_changed_nodes, 0);
        assert_eq!(second.diagnostics.layout_visited_nodes, 0);
        assert!(!second.diagnostics.paint_rebuilt);
        assert_eq!(second.diagnostics.picture_builds, 1);
        assert_eq!(second.diagnostics.picture_cache_hits, 1);
        assert_eq!(second.diagnostics.picture_subtree_builds, 2);
        assert_eq!(second.diagnostics.picture_subtree_cache_hits, 0);
    }

    #[test]
    fn scroll_input_and_worker_ticks_repaint_without_shell_commits() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine.commit(&scroll_tree()).expect("initial frame");
        assert_eq!(
            engine.input(&input(
                1,
                vec![InputCommand::ScrollBegin { node_id: id(1) }]
            )),
            Ok(None)
        );
        let dragged = engine
            .input(&input(
                2,
                vec![InputCommand::ScrollDelta {
                    node_id: id(1),
                    delta_x: 5.0,
                    delta_y: 50.0,
                    elapsed_micros: 16_667,
                }],
            ))
            .expect("drag")
            .expect("changed frame");
        assert_eq!(
            engine
                .scene()
                .scroll_position(NodeId::from_raw(id(1)).expect("id")),
            Some([5.0, 50.0])
        );
        let display = DisplayList::decode(&dragged.display_list).expect("DisplayList");
        assert!(display.instructions.iter().any(|instruction| matches!(
            instruction.command,
            DisplayCommand::Transform([1.0, 0.0, 0.0, 1.0, -5.0, -50.0])
        )));

        assert_eq!(
            engine.input(&input(3, vec![InputCommand::ScrollEnd { node_id: id(1) }])),
            Ok(None)
        );
        let coasted = engine
            .advance(1.0 / 60.0)
            .expect("tick")
            .expect("coast frame");
        assert!(coasted.rebuilt);
        let [_, coast_y] = engine
            .scene()
            .scroll_position(NodeId::from_raw(id(1)).expect("id"))
            .expect("position");
        assert!(coast_y > 50.0);
        assert_eq!(engine.metrics().committed_frames, 1);
        assert_eq!(engine.metrics().accepted_input_batches, 3);
        assert_eq!(engine.metrics().scroll_frames, 1);
        assert_eq!(engine.scroll_metrics().input_commands, 3);
    }

    #[test]
    fn scroll_input_is_atomic_sequence_checked_and_programmatic_scroll_wins() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine.commit(&scroll_tree()).expect("initial frame");
        engine
            .input(&input(
                10,
                vec![
                    InputCommand::ScrollBegin { node_id: id(1) },
                    InputCommand::ScrollDelta {
                        node_id: id(1),
                        delta_x: 0.0,
                        delta_y: 75.0,
                        elapsed_micros: 20_000,
                    },
                ],
            ))
            .expect("valid input");
        let scroll = NodeId::from_raw(id(1)).expect("id");
        let before = engine.scene().scroll_position(scroll);
        assert!(matches!(
            engine.input(&input(
                10,
                vec![InputCommand::ScrollDelta {
                    node_id: id(1),
                    delta_x: 0.0,
                    delta_y: 10.0,
                    elapsed_micros: 10_000,
                }]
            )),
            Err(CoreError::InputSequenceNotNewer { .. })
        ));
        assert_eq!(engine.scene().scroll_position(scroll), before);

        assert!(matches!(
            engine.input(&input(
                11,
                vec![
                    InputCommand::ScrollDelta {
                        node_id: id(1),
                        delta_x: 0.0,
                        delta_y: 10.0,
                        elapsed_micros: 10_000,
                    },
                    InputCommand::ScrollBegin { node_id: id(2) },
                ]
            )),
            Err(CoreError::InvalidScrollTarget { .. })
        ));
        assert_eq!(engine.scene().scroll_position(scroll), before);

        engine
            .commit(&frame(
                2,
                vec![Mutation::ScrollTo {
                    node_id: id(1),
                    x: 2.0,
                    y: 10.0,
                    behavior: 0,
                }],
            ))
            .expect("programmatic position");
        assert_eq!(engine.scene().scroll_position(scroll), Some([2.0, 10.0]));
        assert_eq!(engine.advance(0.1), Ok(None));
    }

    #[test]
    fn scroll_tick_caps_stall_work_and_rejects_invalid_delta() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine.commit(&scroll_tree()).expect("initial frame");
        assert!(matches!(
            engine.advance(f64::NAN),
            Err(CoreError::InvalidFrameDelta(value)) if value.is_nan()
        ));
        engine.advance(10.0).expect("bounded catch-up");
        assert_eq!(engine.scroll_metrics().clamped_catch_up_frames, 1);
        assert!(engine.scroll_metrics().physics_frames <= 30);
    }

    #[test]
    fn virtual_list_plans_refill_after_frames_without_calling_shell() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine.commit(&virtual_list_tree()).expect("initial frame");
        assert_eq!(
            engine.take_virtual_refills(),
            vec![crate::VirtualRefillRequest {
                node_id: id(1),
                start: 0,
                end: 15,
            }]
        );
        assert!(engine.take_virtual_refills().is_empty());
        assert_eq!(engine.scroll_metrics().virtual_frames, 1);
        assert_eq!(engine.scroll_metrics().virtual_placeholders, 5);
        assert_eq!(engine.scroll_metrics().virtual_refill_requests, 1);
        assert_eq!(engine.scroll_metrics().virtual_refill_items, 15);

        engine
            .input(&input(
                1,
                vec![InputCommand::ScrollDelta {
                    node_id: id(1),
                    delta_x: 0.0,
                    delta_y: 200.0,
                    elapsed_micros: 16_667,
                }],
            ))
            .expect("scroll input");
        let requests = engine.take_virtual_refills();
        assert!(!requests.is_empty());
        assert!(requests.iter().all(|request| request.node_id == id(1)));
        assert!(requests.iter().all(|request| request.start < request.end));
    }

    #[test]
    fn virtual_item_measurements_relayout_global_offsets_in_the_same_commit() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine.commit(&virtual_list_tree()).expect("initial frame");
        let output = engine
            .commit(&frame(
                2,
                vec![
                    Mutation::CreateNode {
                        node_id: id(2),
                        kind: NodeKind::Container,
                        parent: id(1),
                        before_sibling: NULL_NODE_ID,
                    },
                    Mutation::CreateNode {
                        node_id: id(3),
                        kind: NodeKind::Container,
                        parent: id(1),
                        before_sibling: NULL_NODE_ID,
                    },
                    Mutation::CreateNode {
                        node_id: id(4),
                        kind: NodeKind::Container,
                        parent: id(1),
                        before_sibling: NULL_NODE_ID,
                    },
                    Mutation::SetF32 {
                        node_id: id(2),
                        prop: Prop::Height,
                        value: 30.0,
                    },
                    Mutation::SetF32 {
                        node_id: id(3),
                        prop: Prop::Height,
                        value: 40.0,
                    },
                    Mutation::SetF32 {
                        node_id: id(4),
                        prop: Prop::Height,
                        value: 20.0,
                    },
                    Mutation::SetVirtualItem {
                        node_id: id(2),
                        item_index: 0,
                    },
                    Mutation::SetVirtualItem {
                        node_id: id(3),
                        item_index: 1,
                    },
                    Mutation::SetVirtualItem {
                        node_id: id(4),
                        item_index: 2,
                    },
                ],
            ))
            .expect("materialized frame");

        assert_eq!(output.diagnostics.layout_visited_nodes, 9);

        assert_eq!(
            engine
                .layout
                .snapshot()
                .geometry(NodeId::from_raw(id(2)).expect("id")),
            Some((
                doper_layout::Point::new(0.0, 0.0),
                doper_layout::Size::new(0.0, 30.0),
            ))
        );
        assert_eq!(
            engine
                .layout
                .snapshot()
                .geometry(NodeId::from_raw(id(3)).expect("id")),
            Some((
                doper_layout::Point::new(0.0, 30.0),
                doper_layout::Size::new(0.0, 40.0),
            ))
        );
        assert_eq!(
            engine
                .layout
                .snapshot()
                .geometry(NodeId::from_raw(id(4)).expect("id")),
            Some((
                doper_layout::Point::new(0.0, 70.0),
                doper_layout::Size::new(0.0, 20.0),
            ))
        );
    }

    #[test]
    fn replay_archive_runs_mutation_and_input_streams_deterministically_headless() {
        let input = InputBatch {
            frame_seq: 2,
            instructions: vec![InputInstruction {
                flags: 0,
                command: InputCommand::Insert {
                    node_id: 7,
                    base_revision: 10,
                    text: "你好".to_owned(),
                },
            }],
        }
        .encode()
        .expect("input");
        let archive = ReplayRecording {
            records: vec![
                ReplayRecord::Mutation(painted_tree()),
                ReplayRecord::Input(input),
                ReplayRecord::Mutation(frame(3, Vec::new())),
            ],
        }
        .encode()
        .expect("archive");

        let replay = || {
            let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
            let mut editor = EditSession::new(
                String::new(),
                Selection::collapsed(0),
                10,
                EditConfig::default(),
            )
            .expect("editor");
            let recording = ReplayRecording::decode(&archive).expect("validated archive");
            let mut picture_hashes = Vec::new();
            for record in recording.records {
                match record {
                    ReplayRecord::Mutation(bytes) => picture_hashes.push(
                        engine
                            .commit(&bytes)
                            .expect("recorded frame")
                            .diagnostics
                            .picture_hash,
                    ),
                    ReplayRecord::Input(bytes) => {
                        editor.replay_input(7, &bytes).expect("recorded input");
                    }
                }
            }
            (picture_hashes, editor.text().to_owned(), editor.revision())
        };

        let first = replay();
        let second = replay();
        assert_eq!(first, second);
        assert_eq!(first.1, "你好");
        assert_eq!(first.2, 11);
        assert_eq!(first.0.len(), 2);
        assert_eq!(first.0[0], first.0[1]);
    }

    #[test]
    fn malformed_and_scene_rejected_input_leave_the_instance_usable() {
        let mut engine = CoreEngine::new(100.0, 100.0).expect("Core");
        assert!(matches!(engine.commit(&[1, 2, 3]), Err(CoreError::Abi(_))));
        assert!(engine.scene().is_empty());
        assert!(!engine.is_poisoned());

        let missing_parent = frame(
            1,
            vec![Mutation::CreateNode {
                node_id: id(1),
                kind: NodeKind::Container,
                parent: id(0),
                before_sibling: NULL_NODE_ID,
            }],
        );
        assert!(matches!(
            engine.commit(&missing_parent),
            Err(CoreError::Scene(_))
        ));
        assert!(engine.scene().is_empty());
        assert!(!engine.is_poisoned());
        assert!(engine.commit(&painted_tree()).is_ok());
    }

    #[test]
    fn derived_failure_poisoning_prevents_partially_derived_followup_frames() {
        let invalid_style = frame(
            1,
            vec![
                Mutation::CreateNode {
                    node_id: id(0),
                    kind: NodeKind::Root,
                    parent: NULL_NODE_ID,
                    before_sibling: NULL_NODE_ID,
                },
                Mutation::SetF32 {
                    node_id: id(0),
                    prop: Prop::Width,
                    value: -1.0,
                },
            ],
        );
        let mut engine = CoreEngine::new(100.0, 100.0).expect("Core");

        assert!(matches!(
            engine.commit(&invalid_style),
            Err(CoreError::Layout(_))
        ));
        assert!(engine.is_poisoned());
        assert_eq!(engine.metrics().fatal_derivation_failures, 1);
        assert_eq!(engine.commit(&painted_tree()), Err(CoreError::Poisoned));
    }
}
