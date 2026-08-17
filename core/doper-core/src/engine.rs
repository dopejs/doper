use std::{
    collections::{BTreeSet, HashSet},
    sync::Arc,
};

use doper_abi::{
    CaretDirection, CaretGranularity, EDITING_GEOMETRY_CHARACTER_WORDS,
    EDITING_GEOMETRY_HEADER_WORDS, EDITING_GEOMETRY_RECT_WORDS, EDITING_GEOMETRY_VERSION,
    EVENT_FLAG_PRECISE_WHEEL, EventTransactionBatch, EventTransactionRecord,
    FRAME_DIAGNOSTICS_DIRTY_HIT_NODES_INDEX, FRAME_DIAGNOSTICS_DIRTY_LAYOUT_NODES_INDEX,
    FRAME_DIAGNOSTICS_DIRTY_PAINT_NODES_INDEX, FRAME_DIAGNOSTICS_DIRTY_PAINT_SELF_NODES_INDEX,
    FRAME_DIAGNOSTICS_DIRTY_SEMANTICS_NODES_INDEX, FRAME_DIAGNOSTICS_DISPLAY_COMMANDS_INDEX,
    FRAME_DIAGNOSTICS_FRAME_SEQ_INDEX, FRAME_DIAGNOSTICS_LAYOUT_CHANGED_NODES_INDEX,
    FRAME_DIAGNOSTICS_LAYOUT_VISITED_NODES_INDEX, FRAME_DIAGNOSTICS_OVER_INVALIDATED_FRAMES_INDEX,
    FRAME_DIAGNOSTICS_PAINT_REBUILT_INDEX, FRAME_DIAGNOSTICS_PICTURE_BUILDS_INDEX,
    FRAME_DIAGNOSTICS_PICTURE_CACHE_HITS_INDEX, FRAME_DIAGNOSTICS_PICTURE_HASH_HIGH_INDEX,
    FRAME_DIAGNOSTICS_PICTURE_HASH_LOW_INDEX, FRAME_DIAGNOSTICS_PICTURE_SUBTREE_BUILDS_INDEX,
    FRAME_DIAGNOSTICS_PICTURE_SUBTREE_CACHE_HITS_INDEX, FRAME_DIAGNOSTICS_SCENE_NODES_INDEX,
    FRAME_DIAGNOSTICS_VERSION, FRAME_DIAGNOSTICS_VERSION_INDEX,
    FRAME_DIAGNOSTICS_VISIBLE_PLACEHOLDERS_INDEX, FRAME_DIAGNOSTICS_WORDS, InputAffinity,
    InputBatch, InputCommand, InputEventKind, InputPosition, InputSelection, Mutation,
    MutationBatch, NON_PASSIVE_REGION_VERSION, NULL_NODE_ID, NodeKind, Prop, ResourceKind,
    SEMANTICS_VERSION, SystemTextMetricBatch,
};
use doper_hit::{HitIndex, HitPoint, WorldGeometry, WorldRect};
use doper_layout::{BoxConstraints, LayoutEngine};
use doper_paint::{PaintEngine, PaintMetrics};
use doper_scene::{BitSet, DirtyDomain, NodeId, Scene, SceneMetrics};

use crate::{
    CoreError, CoreScrollMetrics, CoreTextMetrics,
    editing::{EditableConfiguration, EditingController},
    scroll::{ScrollAdvance, ScrollController},
    text::CoreTextSystem,
};

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
    /// Visible virtual items still drawn as skeletons this frame.
    ///
    /// A steady non-zero value means the Shell never caught up: the viewport is
    /// showing placeholders instead of content, which is a defect rather than a
    /// transient.
    pub visible_placeholders: usize,
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
        words[FRAME_DIAGNOSTICS_VISIBLE_PLACEHOLDERS_INDEX] = count_word(self.visible_placeholders);
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
    text: CoreTextSystem,
    editing: EditingController,
    hit: HitIndex,
    pending_events: Vec<u8>,
    pointer_gesture: Option<PointerGesture>,
    caret_desired_x: Option<(NodeId, f32)>,
    requested_character_range: Option<(NodeId, [u32; 2])>,
    constraints: BoxConstraints,
    metrics: CoreMetrics,
    last_frame_seq: Option<u32>,
    last_input_sequence: Option<u32>,
    caret_elapsed_seconds: f64,
    caret_visible: bool,
    poisoned: bool,
}

#[derive(Clone, Copy)]
struct PointerGesture {
    pointer_id: u32,
    scroll_node: NodeId,
    last_position: [f32; 2],
}

#[derive(Clone, Copy)]
struct EventCommand {
    event_id: u32,
    kind: InputEventKind,
    flags: u16,
    position: [f32; 2],
    delta: [f32; 2],
    buttons: u32,
    modifiers: u32,
    pointer_id: u32,
    elapsed_micros: u32,
}

fn collect_editable_configurations(batch: &MutationBatch) -> Vec<EditableConfiguration> {
    batch
        .instructions
        .iter()
        .filter_map(|instruction| match instruction.mutation {
            Mutation::ConfigureEditable {
                node_id,
                revision,
                flags,
                max_graphemes,
            } => Some(EditableConfiguration {
                node_id,
                revision,
                flags,
                max_graphemes,
            }),
            _ => None,
        })
        .collect()
}

fn collect_programmatic_scrolls(batch: &MutationBatch) -> BTreeSet<u32> {
    batch
        .instructions
        .iter()
        .filter_map(|instruction| match instruction.mutation {
            Mutation::ScrollTo { node_id, .. } => Some(node_id),
            _ => None,
        })
        .collect()
}

fn collect_geometry_requests(batch: &InputBatch) -> Vec<(u32, u32, u32)> {
    batch
        .instructions
        .iter()
        .filter_map(|instruction| match instruction.command {
            InputCommand::RequestCharacterBounds {
                node_id,
                start,
                end,
            } => Some((node_id, start, end)),
            _ => None,
        })
        .collect()
}

fn collect_event_commands(batch: &InputBatch) -> Vec<EventCommand> {
    batch
        .instructions
        .iter()
        .filter_map(|instruction| match &instruction.command {
            InputCommand::DispatchEvent {
                event_id,
                kind,
                flags,
                position,
                delta,
                buttons,
                modifiers,
                pointer_id,
                elapsed_micros,
            } => Some(EventCommand {
                event_id: *event_id,
                kind: *kind,
                flags: *flags,
                position: *position,
                delta: *delta,
                buttons: *buttons,
                modifiers: *modifiers,
                pointer_id: *pointer_id,
                elapsed_micros: *elapsed_micros,
            }),
            _ => None,
        })
        .collect()
}

/// Finds the caret stop matching a UTF-16 offset, or the nearest one.
fn caret_stop_at(carets: &[doper_text::CaretStop], offset: u32) -> Option<&doper_text::CaretStop> {
    carets
        .iter()
        .min_by_key(|caret| caret.utf16_offset.abs_diff(offset))
}

/// Picks the caret stop on one visual line whose X is nearest to a column.
fn nearest_offset_in_line(
    carets: &[doper_text::CaretStop],
    line: usize,
    column: f32,
) -> Option<u32> {
    carets
        .iter()
        .filter(|caret| caret.line == line)
        .min_by(|left, right| (left.x - column).abs().total_cmp(&(right.x - column).abs()))
        .map(|caret| caret.utf16_offset)
}

/// Picks the caret stop nearest to a local point: best line first, then X.
fn nearest_caret_offset(carets: &[doper_text::CaretStop], local: HitPoint) -> u32 {
    let line_distance = |caret: &doper_text::CaretStop| -> f32 {
        if local.y >= caret.y && local.y < caret.y + caret.height {
            0.0
        } else if local.y < caret.y {
            caret.y - local.y
        } else {
            local.y - (caret.y + caret.height)
        }
    };
    let mut best: Option<(&doper_text::CaretStop, f32, f32)> = None;
    for caret in carets {
        let vertical = line_distance(caret);
        let horizontal = (caret.x - local.x).abs();
        let better = match best {
            None => true,
            Some((_, best_vertical, best_horizontal)) => {
                vertical < best_vertical
                    || (vertical <= best_vertical && horizontal < best_horizontal)
            }
        };
        if better {
            best = Some((caret, vertical, horizontal));
        }
    }
    best.map_or(0, |(caret, _, _)| caret.utf16_offset)
}

/// Feeds one hit-tested event into candidate scroll state; returns pixel change.
fn apply_event_scroll(
    candidate_scene: &mut Scene,
    candidate_scroll: &mut ScrollController,
    candidate_gesture: &mut Option<PointerGesture>,
    command: &EventCommand,
    wheel_scroll_node: Option<NodeId>,
    drag_scroll_node: Option<NodeId>,
) -> Result<bool, CoreError> {
    let mut scroll_changed = false;
    match command.kind {
        InputEventKind::Wheel => {
            if let Some(scroll_node) = wheel_scroll_node {
                scroll_changed |= candidate_scroll
                    .apply_wheel(
                        candidate_scene,
                        scroll_node,
                        command.delta,
                        command.elapsed_micros,
                        command.flags & EVENT_FLAG_PRECISE_WHEEL != 0,
                    )?
                    .changed;
            }
        }
        InputEventKind::PointerDown if command.buttons & 1 != 0 => {
            if let Some(previous) = candidate_gesture.take() {
                candidate_scroll.end_direct(previous.scroll_node, false)?;
            }
            if let Some(scroll_node) = drag_scroll_node {
                candidate_scroll.begin_direct(scroll_node)?;
                *candidate_gesture = Some(PointerGesture {
                    pointer_id: command.pointer_id,
                    scroll_node,
                    last_position: command.position,
                });
            }
        }
        InputEventKind::PointerMove => {
            if let Some(mut gesture) = *candidate_gesture
                && gesture.pointer_id == command.pointer_id
            {
                let drag_delta = [
                    gesture.last_position[0] - command.position[0],
                    gesture.last_position[1] - command.position[1],
                ];
                scroll_changed |= candidate_scroll
                    .direct_delta(
                        candidate_scene,
                        gesture.scroll_node,
                        drag_delta,
                        command.elapsed_micros,
                    )?
                    .changed;
                gesture.last_position = command.position;
                *candidate_gesture = Some(gesture);
            }
        }
        InputEventKind::PointerUp | InputEventKind::PointerCancel => {
            if let Some(gesture) = *candidate_gesture
                && gesture.pointer_id == command.pointer_id
            {
                candidate_scroll.end_direct(
                    gesture.scroll_node,
                    command.kind == InputEventKind::PointerUp,
                )?;
                *candidate_gesture = None;
            }
        }
        _ => {}
    }
    Ok(scroll_changed)
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
            text: CoreTextSystem::default(),
            editing: EditingController::default(),
            hit: HitIndex::default(),
            pending_events: Vec::new(),
            pointer_gesture: None,
            caret_desired_x: None,
            requested_character_range: None,
            constraints,
            metrics: CoreMetrics::default(),
            last_frame_seq: None,
            last_input_sequence: None,
            caret_elapsed_seconds: 0.0,
            caret_visible: true,
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
        self.commit_with_system_text_metrics(bytes, None)
    }

    /// Atomically commits mutations and an optional Host-measured system-text cache delta.
    ///
    /// Both streams are fully decoded before Scene state changes. Metric state is
    /// installed only after Scene accepts the mutation transaction and before layout.
    ///
    /// # Errors
    ///
    /// Returns the same failures as [`Self::commit`], plus metric ABI or cache-state errors.
    pub fn commit_with_system_text_metrics(
        &mut self,
        bytes: &[u8],
        system_text_metrics: Option<&[u8]>,
    ) -> Result<FrameOutput, CoreError> {
        self.ensure_reverse_streams_drained()?;
        let batch = match MutationBatch::decode(bytes) {
            Ok(batch) => batch,
            Err(error) => {
                self.metrics.abi_rejections += 1;
                return Err(CoreError::Abi(error));
            }
        };
        let metric_batch = self.decode_metric_batch(system_text_metrics)?;
        if let Some(metric_batch) = &metric_batch {
            self.text
                .validate_system_metrics(metric_batch)
                .map_err(CoreError::SystemTextMetricsState)?;
        }
        let frame_seq = batch.frame_seq;
        let editable_configurations = collect_editable_configurations(&batch);
        let programmatic_scrolls = collect_programmatic_scrolls(&batch);
        if let Err(error) = self.scene.commit(batch) {
            self.metrics.scene_rejections += 1;
            return Err(CoreError::Scene(error));
        }

        let editing_changed = match self
            .editing
            .synchronize(&self.scene, &editable_configurations)
        {
            Ok(changed) => changed,
            Err(error) => return self.poison(error),
        };
        if let Err(error) = self.editing.encode_pending() {
            return self.poison(CoreError::EditTransactions(error));
        }
        self.text
            .set_edit_overrides(self.editing.display_overrides());
        if !editing_changed.is_empty() {
            self.layout.mark_text_measurements_changed(&editing_changed);
        }

        if let Some(metric_batch) = metric_batch {
            let changed_pairs = self.text.apply_system_metrics(metric_batch);
            let changed_nodes = system_text_nodes(&self.scene, &changed_pairs);
            if !changed_nodes.is_empty() {
                self.layout.mark_text_measurements_changed(&changed_nodes);
            }
        }

        self.text.begin_frame();
        let mut geometry = match self.layout.layout_with_virtual(
            &self.scene,
            self.constraints,
            &mut self.text,
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
                &mut self.text,
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
        let fallback_nodes = self.text.prepare_resources(&self.scene);
        self.relayout_text_fallbacks(
            &fallback_nodes,
            &mut geometry.changed,
            &mut geometry.visited,
        )?;
        let text_changed = self.text.has_staged_changes();
        let output =
            self.paint_frame(frame_seq, &geometry.changed, geometry.visited, text_changed)?;
        if let Err(error) = self.text.commit_frame() {
            return self.poison(CoreError::GlyphResources(error));
        }
        self.metrics.committed_frames += 1;
        self.last_frame_seq = Some(frame_seq);
        Ok(output)
    }

    /// Refreshes active system-font metrics after browser font availability changes.
    ///
    /// Returns a replacement frame only when a changed active pair affected layout.
    ///
    /// # Errors
    ///
    /// Rejects malformed or inconsistent metric deltas atomically. Derived layout,
    /// scroll, paint, or glyph-resource failures poison the instance.
    pub fn set_system_text_metrics(
        &mut self,
        bytes: &[u8],
    ) -> Result<Option<FrameOutput>, CoreError> {
        self.ensure_reverse_streams_drained()?;
        let batch = SystemTextMetricBatch::decode(bytes).map_err(|error| {
            self.metrics.abi_rejections = self.metrics.abi_rejections.saturating_add(1);
            CoreError::Abi(error)
        })?;
        self.text
            .validate_system_metrics(&batch)
            .map_err(CoreError::SystemTextMetricsState)?;
        let changed_pairs = self.text.apply_system_metrics(batch);
        let changed_nodes = system_text_nodes(&self.scene, &changed_pairs);
        if changed_nodes.is_empty() {
            return Ok(None);
        }
        let frame_seq = self
            .last_frame_seq
            .ok_or(CoreError::MissingCommittedFrame)?;
        self.layout.mark_text_measurements_changed(&changed_nodes);
        self.text.begin_frame();
        let mut geometry = match self.layout.layout_with_virtual(
            &self.scene,
            self.constraints,
            &mut self.text,
            &self.scroll,
        ) {
            Ok(outcome) => outcome,
            Err(error) => return self.poison(CoreError::Layout(error)),
        };
        let fallback_nodes = self.text.prepare_resources(&self.scene);
        self.relayout_text_fallbacks(
            &fallback_nodes,
            &mut geometry.changed,
            &mut geometry.visited,
        )?;
        let text_changed = self.text.has_staged_changes();
        let output =
            self.paint_frame(frame_seq, &geometry.changed, geometry.visited, text_changed)?;
        if let Err(error) = self.text.commit_frame() {
            return self.poison(CoreError::GlyphResources(error));
        }
        Ok(Some(output))
    }

    /// Atomically applies one Input Stream transaction to Core-owned subsystems.
    ///
    /// Returns a new `DisplayList` only when direct manipulation changed pixels.
    /// # Errors
    ///
    /// Returns an ABI, sequence, target, or scroll validation error without
    /// partially applying the input batch.
    pub fn input(&mut self, bytes: &[u8]) -> Result<Option<FrameOutput>, CoreError> {
        self.ensure_reverse_streams_drained()?;
        let batch = match InputBatch::decode(bytes) {
            Ok(batch) => batch,
            Err(error) => {
                self.metrics.input_rejections = self.metrics.input_rejections.saturating_add(1);
                return Err(CoreError::Abi(error));
            }
        };
        if let Some(previous) = self.last_input_sequence
            && !is_newer_sequence(batch.frame_seq, previous)
        {
            self.metrics.input_rejections = self.metrics.input_rejections.saturating_add(1);
            return Err(CoreError::InputSequenceNotNewer {
                previous,
                incoming: batch.frame_seq,
            });
        }
        let geometry_requests = collect_geometry_requests(&batch);
        if !geometry_requests.is_empty() {
            return self.input_character_bounds(&batch, &geometry_requests);
        }
        let event_commands = collect_event_commands(&batch);
        if !event_commands.is_empty() {
            if event_commands.len() != batch.instructions.len() {
                self.metrics.input_rejections = self.metrics.input_rejections.saturating_add(1);
                return Err(CoreError::MixedEventInput);
            }
            return self.input_events(batch.frame_seq, &event_commands);
        }
        self.input_scroll_and_edit(&batch)
    }

    /// Applies one isolated `RequestCharacterBounds` batch to the editing session.
    fn input_character_bounds(
        &mut self,
        batch: &InputBatch,
        requests: &[(u32, u32, u32)],
    ) -> Result<Option<FrameOutput>, CoreError> {
        if requests.len() != 1 || batch.instructions.len() != 1 {
            self.metrics.input_rejections = self.metrics.input_rejections.saturating_add(1);
            return Err(CoreError::MixedEditingGeometryInput);
        }
        let (node_id, start, end) = requests[0];
        let node = NodeId::from_raw(node_id)?;
        if let Err(error) = self.editing.validate_character_range(node, start, end) {
            self.metrics.input_rejections = self.metrics.input_rejections.saturating_add(1);
            return Err(error);
        }
        self.requested_character_range = Some((node, [start, end]));
        self.last_input_sequence = Some(batch.frame_seq);
        self.metrics.accepted_input_batches = self.metrics.accepted_input_batches.saturating_add(1);
        Ok(None)
    }

    /// Resolves a canvas-local caret placement into an authoritative selection.
    fn resolve_place_caret(
        &self,
        node_id: u32,
        position: [f32; 2],
        flags: u32,
    ) -> Result<InputCommand, CoreError> {
        let node = NodeId::from_raw(node_id)?;
        let session = self
            .editing
            .session(node)
            .ok_or(CoreError::InvalidEditableTarget { node })?;
        let geometry = self
            .hit
            .geometry(node)
            .ok_or(CoreError::InvalidEditableTarget { node })?;
        let carets = self
            .text
            .editor_caret_stops(&self.scene, node)
            .filter(|carets| !carets.is_empty())
            .ok_or(CoreError::InvalidEditableTarget { node })?;
        let local = geometry
            .to_local(HitPoint {
                x: position[0],
                y: position[1],
            })
            .ok_or(CoreError::InvalidEditableTarget { node })?;
        let offset = nearest_caret_offset(&carets, local);
        let (anchor, focus) = if flags & 0x02 != 0 {
            doper_edit::word_range_utf16(session.text(), offset).map_err(CoreError::Edit)?
        } else if flags & 0x01 != 0 {
            (session.selection().anchor.offset, offset)
        } else {
            (offset, offset)
        };
        Ok(InputCommand::SetSelection {
            node_id,
            base_revision: session.revision(),
            selection: InputSelection {
                anchor: InputPosition {
                    offset: anchor,
                    affinity: InputAffinity::Downstream,
                },
                focus: InputPosition {
                    offset: focus,
                    affinity: InputAffinity::Downstream,
                },
            },
        })
    }

    /// Computes the minimal ancestor scroll jump revealing the active caret.
    ///
    /// Uses the last committed frame's world geometry; the subsequent relayout
    /// clamps the jump against fresh extents, keeping the frame deterministic.
    fn caret_reveal_target(&self) -> Option<(NodeId, [f32; 2])> {
        let visual = self.editing.active_visual()?;
        let node = visual.node;
        let geometry = self.hit.geometry(node)?;
        let carets = self
            .text
            .editor_caret_stops(&self.scene, node)
            .filter(|carets| !carets.is_empty())?;
        let focus = visual.selection[1];
        let caret = editor_range_rect(&carets, [focus, focus], geometry)?;
        let mut ancestor = self.scene.parent(node);
        while let Some(candidate) = ancestor {
            if self.scene.kind(candidate) == Some(NodeKind::Scroll) {
                break;
            }
            ancestor = self.scene.parent(candidate);
        }
        let scroll_node = ancestor?;
        let viewport = self.hit.geometry(scroll_node)?.aabb;
        let dx = if caret.left < viewport.left {
            caret.left - viewport.left
        } else if caret.right > viewport.right {
            caret.right - viewport.right
        } else {
            0.0
        };
        let dy = if caret.top < viewport.top {
            caret.top - viewport.top
        } else if caret.bottom > viewport.bottom {
            caret.bottom - viewport.bottom
        } else {
            0.0
        };
        if dx.abs() <= f32::EPSILON && dy.abs() <= f32::EPSILON {
            return None;
        }
        let position = self.scene.scroll_position(scroll_node).unwrap_or([0.0; 2]);
        Some((scroll_node, [position[0] + dx, position[1] + dy]))
    }

    /// Resolves caret placement/movement into concrete editing commands.
    fn resolve_edit_commands(
        &self,
        batch: &InputBatch,
        desired_x: &mut Option<(NodeId, f32)>,
    ) -> Result<Vec<InputCommand>, CoreError> {
        let mut edit_commands = Vec::new();
        for instruction in batch
            .instructions
            .iter()
            .filter(|instruction| !is_scroll_command(&instruction.command))
        {
            let resolved = match instruction.command {
                InputCommand::PlaceCaret {
                    node_id,
                    position,
                    flags,
                } => {
                    *desired_x = None;
                    self.resolve_place_caret(node_id, position, flags)?
                }
                InputCommand::MoveCaret {
                    node_id,
                    direction,
                    granularity,
                    extend,
                } => self.resolve_move_caret(node_id, direction, granularity, extend, desired_x)?,
                ref command => {
                    if !matches!(command, InputCommand::RequestCharacterBounds { .. }) {
                        *desired_x = None;
                    }
                    command.clone()
                }
            };
            edit_commands.push(resolved);
        }
        Ok(edit_commands)
    }

    /// Resolves a keyboard caret movement into an authoritative selection.
    fn resolve_move_caret(
        &self,
        node_id: u32,
        direction: CaretDirection,
        granularity: CaretGranularity,
        extend: bool,
        desired_x: &mut Option<(NodeId, f32)>,
    ) -> Result<InputCommand, CoreError> {
        let node = NodeId::from_raw(node_id)?;
        let session = self
            .editing
            .session(node)
            .ok_or(CoreError::InvalidEditableTarget { node })?;
        let carets = self
            .text
            .editor_caret_stops(&self.scene, node)
            .filter(|carets| !carets.is_empty())
            .ok_or(CoreError::InvalidEditableTarget { node })?;
        let selection = session.selection();
        let anchor = selection.anchor.offset;
        let focus = selection.focus.offset;
        let text = session.text();
        let mut vertical_column = None;
        let target = match direction {
            CaretDirection::Backward | CaretDirection::Forward => {
                let forward = direction == CaretDirection::Forward;
                if !extend && anchor != focus && granularity == CaretGranularity::Grapheme {
                    // A plain arrow with a selection collapses to its edge.
                    if forward {
                        anchor.max(focus)
                    } else {
                        anchor.min(focus)
                    }
                } else {
                    match granularity {
                        CaretGranularity::Grapheme => {
                            let index =
                                doper_edit::TextIndex::new(text).map_err(CoreError::Edit)?;
                            if forward {
                                index.next(focus).map_err(CoreError::Edit)?
                            } else {
                                index.previous(focus).map_err(CoreError::Edit)?
                            }
                        }
                        CaretGranularity::Word => {
                            doper_edit::word_boundary_utf16(text, focus, forward)
                                .map_err(CoreError::Edit)?
                        }
                    }
                }
            }
            CaretDirection::Up | CaretDirection::Down => {
                let current = caret_stop_at(&carets, focus)
                    .ok_or(CoreError::InvalidEditableTarget { node })?;
                let column = desired_x
                    .filter(|(desired_node, _)| *desired_node == node)
                    .map_or(current.x, |(_, x)| x);
                vertical_column = Some(column);
                let target_line = if direction == CaretDirection::Up {
                    current.line.checked_sub(1)
                } else {
                    Some(current.line + 1)
                };
                match target_line.and_then(|line| nearest_offset_in_line(&carets, line, column)) {
                    Some(offset) => offset,
                    None if direction == CaretDirection::Up => 0,
                    None => carets.last().map_or(focus, |caret| caret.utf16_offset),
                }
            }
            CaretDirection::LineStart | CaretDirection::LineEnd => {
                let current = caret_stop_at(&carets, focus)
                    .ok_or(CoreError::InvalidEditableTarget { node })?;
                let offsets = carets
                    .iter()
                    .filter(|caret| caret.line == current.line)
                    .map(|caret| caret.utf16_offset);
                if direction == CaretDirection::LineStart {
                    offsets.min().unwrap_or(focus)
                } else {
                    offsets.max().unwrap_or(focus)
                }
            }
        };
        *desired_x = vertical_column.map(|column| (node, column));
        Ok(InputCommand::SetSelection {
            node_id,
            base_revision: session.revision(),
            selection: InputSelection {
                anchor: InputPosition {
                    offset: if extend { anchor } else { target },
                    affinity: InputAffinity::Downstream,
                },
                focus: InputPosition {
                    offset: target,
                    affinity: InputAffinity::Downstream,
                },
            },
        })
    }

    /// Applies one isolated hit-tested event batch against candidate state.
    fn input_events(
        &mut self,
        frame_seq: u32,
        event_commands: &[EventCommand],
    ) -> Result<Option<FrameOutput>, CoreError> {
        let mut candidate_scene = self.scene.clone();
        let mut candidate_scroll = self.scroll.clone();
        let mut candidate_gesture = self.pointer_gesture;
        let mut scroll_changed = false;
        let mut records = Vec::with_capacity(event_commands.len());
        for command in event_commands {
            let hit = self.hit.hit(
                &self.scene,
                HitPoint {
                    x: command.position[0],
                    y: command.position[1],
                },
            );
            let hit_scroll_node = hit.as_ref().and_then(|hit| {
                hit.path
                    .iter()
                    .rev()
                    .copied()
                    .find(|node| self.scene.kind(*node) == Some(NodeKind::Scroll))
            });
            // Text selection wins over scroll dragging when the editable is deeper.
            let editable_is_deeper = hit.as_ref().is_some_and(|hit| {
                let scroll = hit
                    .path
                    .iter()
                    .rposition(|node| self.scene.kind(*node) == Some(NodeKind::Scroll));
                let editable = hit
                    .path
                    .iter()
                    .rposition(|node| self.scene.kind(*node) == Some(NodeKind::EditableText));
                match (scroll, editable) {
                    (Some(scroll), Some(editable)) => editable > scroll,
                    (None, Some(_)) => true,
                    _ => false,
                }
            });
            scroll_changed |= apply_event_scroll(
                &mut candidate_scene,
                &mut candidate_scroll,
                &mut candidate_gesture,
                command,
                hit_scroll_node,
                if editable_is_deeper {
                    None
                } else {
                    hit_scroll_node
                },
            )?;
            let Some(hit) = hit else {
                continue;
            };
            records.push(EventTransactionRecord {
                event_id: command.event_id,
                kind: command.kind,
                target: hit.target.raw(),
                position: command.position,
                delta: command.delta,
                buttons: command.buttons,
                modifiers: command.modifiers,
                pointer_id: command.pointer_id,
                elapsed_micros: command.elapsed_micros,
                path: hit.path.into_iter().map(NodeId::raw).collect(),
            });
        }
        let encoded_events = if records.is_empty() {
            Vec::new()
        } else {
            EventTransactionBatch { records }
                .encode()
                .map_err(CoreError::EventTransactions)?
        };
        if let Err(error) = candidate_scroll.plan_virtual_frames() {
            return self.poison(error);
        }
        self.scene = candidate_scene;
        self.scroll = candidate_scroll;
        self.pointer_gesture = candidate_gesture;
        self.last_input_sequence = Some(frame_seq);
        self.metrics.accepted_input_batches = self.metrics.accepted_input_batches.saturating_add(1);
        let output = if scroll_changed {
            let frame_seq = self
                .last_frame_seq
                .ok_or(CoreError::MissingCommittedFrame)?;
            Some(self.paint_frame(frame_seq, &BitSet::with_len(self.scene.len()), 0, false)?)
        } else {
            None
        };
        self.pending_events = encoded_events;
        Ok(output)
    }

    /// Applies a mixed scroll/edit command batch transactionally.
    fn input_scroll_and_edit(
        &mut self,
        batch: &InputBatch,
    ) -> Result<Option<FrameOutput>, CoreError> {
        let scroll_instructions = batch
            .instructions
            .iter()
            .filter(|instruction| is_scroll_command(&instruction.command))
            .cloned()
            .collect::<Vec<_>>();
        let mut desired_x = self.caret_desired_x;
        let edit_commands = match self.resolve_edit_commands(batch, &mut desired_x) {
            Ok(commands) => commands,
            Err(error) => {
                self.metrics.input_rejections = self.metrics.input_rejections.saturating_add(1);
                return Err(error);
            }
        };
        let mut candidate_scene = self.scene.clone();
        let mut candidate_scroll = self.scroll.clone();
        let mut candidate_editing = self.editing.clone();
        let scroll_outcome = if scroll_instructions.is_empty() {
            ScrollAdvance::default()
        } else {
            let scroll_batch = InputBatch {
                frame_seq: batch.frame_seq,
                instructions: scroll_instructions,
            };
            match candidate_scroll.apply_input(&mut candidate_scene, &scroll_batch) {
                Ok(outcome) => outcome,
                Err(error) => {
                    self.metrics.input_rejections = self.metrics.input_rejections.saturating_add(1);
                    return Err(error);
                }
            }
        };
        let edit_outcome = match candidate_editing.apply_commands(edit_commands) {
            Ok(outcome) => outcome,
            Err(error) => {
                self.metrics.input_rejections = self.metrics.input_rejections.saturating_add(1);
                return Err(error);
            }
        };
        if let Err(error) = candidate_editing.encode_pending() {
            self.metrics.input_rejections = self.metrics.input_rejections.saturating_add(1);
            return Err(CoreError::EditTransactions(error));
        }
        if let Err(error) = candidate_scroll.plan_virtual_frames() {
            return self.poison(error);
        }
        self.scene = candidate_scene;
        self.scroll = candidate_scroll;
        self.editing = candidate_editing;
        self.caret_desired_x = desired_x;
        if edit_outcome.accepted_commands > 0 {
            self.requested_character_range = None;
            self.caret_elapsed_seconds = 0.0;
            self.caret_visible = true;
        }
        self.last_input_sequence = Some(batch.frame_seq);
        self.text
            .set_edit_overrides(self.editing.display_overrides());
        self.metrics.accepted_input_batches = self.metrics.accepted_input_batches.saturating_add(1);
        if edit_outcome.changed_nodes.is_empty() {
            if !scroll_outcome.changed {
                return Ok(None);
            }
            let frame_seq = self
                .last_frame_seq
                .ok_or(CoreError::MissingCommittedFrame)?;
            let output =
                self.paint_frame(frame_seq, &BitSet::with_len(self.scene.len()), 0, false)?;
            return Ok(Some(output));
        }
        let reveal = if edit_outcome.accepted_commands > 0 {
            self.caret_reveal_target()
        } else {
            None
        };
        let output = self.repaint_after_edit(&edit_outcome.changed_nodes, reveal)?;
        Ok(Some(output))
    }

    /// Relays out and repaints after accepted editing commands changed text.
    fn repaint_after_edit(
        &mut self,
        changed_nodes: &[NodeId],
        reveal: Option<(NodeId, [f32; 2])>,
    ) -> Result<FrameOutput, CoreError> {
        let frame_seq = self
            .last_frame_seq
            .ok_or(CoreError::MissingCommittedFrame)?;
        let mut programmatic = BTreeSet::new();
        if let Some((scroll_node, position)) = reveal
            && self
                .scene
                .apply_scroll_position(scroll_node, position)
                .unwrap_or(false)
        {
            programmatic.insert(scroll_node.raw());
        }
        self.layout.mark_text_measurements_changed(changed_nodes);
        self.text.begin_frame();
        let mut geometry = match self.layout.layout_with_virtual(
            &self.scene,
            self.constraints,
            &mut self.text,
            &self.scroll,
        ) {
            Ok(outcome) => outcome,
            Err(error) => return self.poison(CoreError::Layout(error)),
        };
        let corrected =
            match self
                .scroll
                .synchronize(&mut self.scene, self.layout.snapshot(), &programmatic)
            {
                Ok(corrected) => corrected,
                Err(error) => return self.poison(error),
            };
        if !corrected.is_empty() {
            self.layout.mark_virtual_measurements_changed(&corrected);
            let corrected_geometry = match self.layout.layout_with_virtual(
                &self.scene,
                self.constraints,
                &mut self.text,
                &self.scroll,
            ) {
                Ok(outcome) => outcome,
                Err(error) => return self.poison(CoreError::Layout(error)),
            };
            merge_geometry(
                &mut geometry.changed,
                &mut geometry.visited,
                &corrected_geometry.changed,
                corrected_geometry.visited,
            );
        }
        let fallback_nodes = self.text.prepare_resources(&self.scene);
        self.relayout_text_fallbacks(
            &fallback_nodes,
            &mut geometry.changed,
            &mut geometry.visited,
        )?;
        let output = self.paint_frame(frame_seq, &geometry.changed, geometry.visited, true)?;
        if let Err(error) = self.text.commit_frame() {
            return self.poison(CoreError::GlyphResources(error));
        }
        Ok(output)
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
        if self.text.has_pending_resources() {
            return Err(CoreError::GlyphResourcesNotDrained);
        }
        let outcome = self.scroll.advance(&mut self.scene, elapsed_seconds)?;
        if let Err(error) = self.scroll.plan_virtual_frames() {
            return self.poison(error);
        }
        let mut caret_changed = false;
        if self.editing.active_visual().is_some() {
            self.caret_elapsed_seconds += elapsed_seconds;
            while self.caret_elapsed_seconds >= 0.5 {
                self.caret_elapsed_seconds -= 0.5;
                self.caret_visible = !self.caret_visible;
                caret_changed = true;
            }
        }
        if !outcome.changed && !caret_changed {
            return Ok(None);
        }
        let frame_seq = self
            .last_frame_seq
            .ok_or(CoreError::MissingCommittedFrame)?;
        let output = self.paint_frame(
            frame_seq,
            &BitSet::with_len(self.scene.len()),
            0,
            caret_changed,
        )?;
        if outcome.changed {
            self.metrics.scroll_frames = self.metrics.scroll_frames.saturating_add(1);
        }
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
        if self.text.has_pending_resources() {
            return Err(CoreError::GlyphResourcesNotDrained);
        }
        self.constraints = viewport_constraints(width, height)?;
        Ok(())
    }

    /// Updates DPR-sensitive glyph resources and returns a replacement frame when needed.
    ///
    /// # Errors
    ///
    /// Rejects non-positive or non-finite ratios. Derived failures poison the instance.
    pub fn set_device_pixel_ratio(
        &mut self,
        device_pixel_ratio: f32,
    ) -> Result<Option<FrameOutput>, CoreError> {
        if self.poisoned {
            return Err(CoreError::Poisoned);
        }
        if self.text.has_pending_resources() {
            return Err(CoreError::GlyphResourcesNotDrained);
        }
        if !device_pixel_ratio.is_finite() || device_pixel_ratio <= 0.0 {
            return Err(CoreError::InvalidDevicePixelRatio(device_pixel_ratio));
        }
        if !self.text.set_device_pixel_ratio(device_pixel_ratio) {
            return Ok(None);
        }
        let Some(frame_seq) = self.last_frame_seq else {
            return Ok(None);
        };
        self.text.begin_frame();
        let fallback_nodes = self.text.prepare_resources(&self.scene);
        let mut geometry_changed = BitSet::with_len(self.scene.len());
        let mut layout_visited = 0;
        self.relayout_text_fallbacks(&fallback_nodes, &mut geometry_changed, &mut layout_visited)?;
        if !self.text.has_staged_changes() {
            self.text
                .commit_frame()
                .map_err(CoreError::GlyphResources)?;
            return Ok(None);
        }
        let output = self.paint_frame(frame_seq, &geometry_changed, layout_visited, true)?;
        if let Err(error) = self.text.commit_frame() {
            return self.poison(CoreError::GlyphResources(error));
        }
        Ok(Some(output))
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

    /// Returns Core shaping and derived glyph-resource counters.
    #[must_use]
    pub const fn text_metrics(&self) -> CoreTextMetrics {
        self.text.metrics()
    }

    /// Drains the glyph-resource deltas required by the latest `DisplayList`.
    pub fn take_glyph_resources(&mut self) -> Vec<u8> {
        self.text.take_glyph_resources()
    }

    /// Drains the versioned reverse transactions emitted by the latest edit operation.
    ///
    /// # Errors
    ///
    /// Returns an ABI error only if an internal encoding invariant is violated.
    pub fn take_edit_transactions(&mut self) -> Result<Vec<u8>, CoreError> {
        if !self.editing.has_pending_transactions() {
            return Ok(Vec::new());
        }
        let bytes = self
            .editing
            .encode_pending()
            .map_err(CoreError::EditTransactions)?;
        let taken = self.editing.take_transactions();
        debug_assert_eq!(
            taken.records.len(),
            doper_abi::EditTransactionBatch::decode(&bytes).map_or(0, |batch| batch.records.len())
        );
        Ok(bytes)
    }

    /// Drains hit-tested event paths produced by the latest isolated event batch.
    ///
    /// # Errors
    ///
    /// Never fails today; the `Result` keeps the drain contract uniform across
    /// the reverse streams so callers do not special-case this one.
    pub fn take_event_transactions(&mut self) -> Result<Vec<u8>, CoreError> {
        Ok(std::mem::take(&mut self.pending_events))
    }

    /// Returns the latest synchronous browser-default suppression regions.
    #[must_use]
    pub fn non_passive_regions(&self) -> Vec<u32> {
        const WHEEL_AND_TOUCH_FLAGS: u32 = 3;
        let regions = self
            .hit
            .geometries()
            .filter(|(node, geometry)| {
                self.scene.kind(*node) == Some(NodeKind::Scroll)
                    && geometry.aabb.right > geometry.aabb.left
                    && geometry.aabb.bottom > geometry.aabb.top
            })
            .map(|(_, geometry)| geometry.aabb)
            .collect::<Vec<_>>();
        let mut words = Vec::with_capacity(2_usize.saturating_add(regions.len().saturating_mul(5)));
        words.push(NON_PASSIVE_REGION_VERSION);
        words.push(u32::try_from(regions.len()).unwrap_or(u32::MAX));
        for region in regions {
            words.extend_from_slice(&[
                WHEEL_AND_TOUCH_FLAGS,
                region.left.to_bits(),
                region.top.to_bits(),
                region.right.to_bits(),
                region.bottom.to_bits(),
            ]);
        }
        words
    }

    /// Serializes the committed semantic tree for the accessibility mirror.
    ///
    /// Records carry world bounds from the last painted frame plus role,
    /// label, and value strings. Password editors never expose their text.
    #[must_use]
    pub fn semantics(&self) -> Vec<u8> {
        let mut records = 0_u32;
        let mut payload = Vec::new();
        let focused = self.editing.active_visual().map(|visual| visual.node);
        for &node in self.scene.ids() {
            let role = self.semantic_string(node, Prop::SemanticRole);
            let label = self.semantic_string(node, Prop::SemanticLabel);
            let mut value = self.semantic_string(node, Prop::SemanticValue);
            let editable = self.scene.kind(node) == Some(NodeKind::EditableText);
            if role.is_none() && label.is_none() && value.is_none() && !editable {
                continue;
            }
            let Some(geometry) = self.hit.geometry(node) else {
                continue;
            };
            let role = role.or(if editable { Some("textbox") } else { None });
            if editable && value.is_none() {
                let password = self.editing.session_is_password(node).unwrap_or(false);
                if !password {
                    value = self
                        .editing
                        .session(node)
                        .map(doper_edit::EditSession::text);
                }
            }
            let flags = u32::from(editable)
                | (u32::from(focused == Some(node)) << 1)
                | (u32::from(editable && self.editing.session_is_password(node).unwrap_or(false))
                    << 2);
            let rect = geometry.aabb;
            let role_bytes = role.unwrap_or_default().as_bytes();
            let label_bytes = label.unwrap_or_default().as_bytes();
            let value_bytes = value.unwrap_or_default().as_bytes();
            for word in [
                node.raw(),
                flags,
                rect.left.to_bits(),
                rect.top.to_bits(),
                (rect.right - rect.left).max(0.0).to_bits(),
                (rect.bottom - rect.top).max(0.0).to_bits(),
                u32::try_from(role_bytes.len()).unwrap_or(0),
                u32::try_from(label_bytes.len()).unwrap_or(0),
                u32::try_from(value_bytes.len()).unwrap_or(0),
            ] {
                payload.extend_from_slice(&word.to_le_bytes());
            }
            payload.extend_from_slice(role_bytes);
            payload.extend_from_slice(label_bytes);
            payload.extend_from_slice(value_bytes);
            while payload.len() % 4 != 0 {
                payload.push(0);
            }
            records = records.saturating_add(1);
        }
        let mut bytes = Vec::with_capacity(8 + payload.len());
        bytes.extend_from_slice(&SEMANTICS_VERSION.to_le_bytes());
        bytes.extend_from_slice(&records.to_le_bytes());
        bytes.extend_from_slice(&payload);
        bytes
    }

    fn semantic_string(&self, node: NodeId, prop: Prop) -> Option<&str> {
        let resource_id = self.scene.ref_prop(node, prop)?;
        self.scene
            .resource(resource_id)
            .filter(|resource| resource.kind == ResourceKind::Utf8String)
            .and_then(|resource| std::str::from_utf8(&resource.bytes).ok())
    }

    /// Returns the latest active editor, selection, and requested character geometry.
    #[must_use]
    pub fn editing_geometry(&self) -> Vec<u32> {
        let Some(visual) = self.editing.active_visual() else {
            return empty_editing_geometry();
        };
        let Some(geometry) = self.hit.geometry(visual.node) else {
            return empty_editing_geometry();
        };
        let Some(carets) = self.text.editor_caret_stops(&self.scene, visual.node) else {
            return empty_editing_geometry();
        };
        let selection = [
            visual.selection[0].min(visual.selection[1]),
            visual.selection[0].max(visual.selection[1]),
        ];
        let control = geometry.aabb;
        let selection_rect = editor_range_rect(&carets, selection, geometry).unwrap_or(WorldRect {
            left: control.left,
            top: control.top,
            right: control.left,
            bottom: control.top,
        });
        let requested = self
            .requested_character_range
            .filter(|(node, _)| *node == visual.node)
            .map_or([0, 0], |(_, range)| range);
        let characters = editor_character_rects(&carets, requested, geometry);
        let capacity = EDITING_GEOMETRY_HEADER_WORDS
            .saturating_add(EDITING_GEOMETRY_RECT_WORDS.saturating_mul(2))
            .saturating_add(
                characters
                    .len()
                    .saturating_mul(EDITING_GEOMETRY_CHARACTER_WORDS),
            );
        let mut words = Vec::with_capacity(capacity);
        words.extend_from_slice(&[
            EDITING_GEOMETRY_VERSION,
            visual.node.raw(),
            selection[0],
            selection[1],
            u32::try_from(characters.len()).unwrap_or(u32::MAX),
        ]);
        append_geometry_rect(&mut words, control);
        append_geometry_rect(&mut words, selection_rect);
        for (range, rect) in characters {
            words.extend_from_slice(&[range[0], range[1]]);
            append_geometry_rect(&mut words, rect);
        }
        words
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
        force_full_paint: bool,
    ) -> Result<FrameOutput, CoreError> {
        if let Err(error) = self.hit.update(&self.scene, self.layout.snapshot()) {
            return self.poison(CoreError::Hit(error));
        }
        self.text.update_editor_decorations(
            &self.scene,
            self.editing.active_visual(),
            self.caret_visible,
        );
        let scene_nodes = self.scene.len();
        let dirty_layout_nodes = dirty_count(&self.scene, DirtyDomain::Layout);
        let dirty_paint_nodes = dirty_count(&self.scene, DirtyDomain::Paint);
        let dirty_paint_self_nodes = dirty_count(&self.scene, DirtyDomain::PaintSelf);
        let dirty_hit_nodes = dirty_count(&self.scene, DirtyDomain::Hit);
        let dirty_semantics_nodes = dirty_count(&self.scene, DirtyDomain::Semantics);
        let painted = match self.paint.paint_frame(
            &self.scene,
            self.layout.snapshot(),
            geometry_changed,
            force_full_paint,
            &self.text,
            &self.scroll,
        ) {
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
            visible_placeholders: self.scroll.visible_placeholders(),
        };
        self.scene.clear_dirty();
        Ok(FrameOutput {
            frame_seq,
            display_list: Arc::from(painted.picture.bytes()),
            rebuilt: painted.rebuilt,
            diagnostics,
        })
    }

    fn relayout_text_fallbacks(
        &mut self,
        nodes: &[doper_scene::NodeId],
        changed: &mut BitSet,
        visited: &mut usize,
    ) -> Result<(), CoreError> {
        if nodes.is_empty() {
            return Ok(());
        }
        self.layout.mark_text_measurements_changed(nodes);
        let fallback_geometry = match self.layout.layout_with_virtual(
            &self.scene,
            self.constraints,
            &mut self.text,
            &self.scroll,
        ) {
            Ok(outcome) => outcome,
            Err(error) => return self.poison(CoreError::Layout(error)),
        };
        merge_geometry(
            changed,
            visited,
            &fallback_geometry.changed,
            fallback_geometry.visited,
        );
        let corrected =
            match self
                .scroll
                .synchronize(&mut self.scene, self.layout.snapshot(), &BTreeSet::new())
            {
                Ok(corrected) => corrected,
                Err(error) => return self.poison(error),
            };
        if corrected.is_empty() {
            return Ok(());
        }
        self.layout.mark_virtual_measurements_changed(&corrected);
        let corrected_geometry = match self.layout.layout_with_virtual(
            &self.scene,
            self.constraints,
            &mut self.text,
            &self.scroll,
        ) {
            Ok(outcome) => outcome,
            Err(error) => return self.poison(CoreError::Layout(error)),
        };
        merge_geometry(
            changed,
            visited,
            &corrected_geometry.changed,
            corrected_geometry.visited,
        );
        Ok(())
    }

    /// Decodes an optional system-text metric stream, counting rejections.
    fn decode_metric_batch(
        &mut self,
        system_text_metrics: Option<&[u8]>,
    ) -> Result<Option<SystemTextMetricBatch>, CoreError> {
        match system_text_metrics {
            Some(bytes) => match SystemTextMetricBatch::decode(bytes) {
                Ok(batch) => Ok(Some(batch)),
                Err(error) => {
                    self.metrics.abi_rejections = self.metrics.abi_rejections.saturating_add(1);
                    Err(CoreError::Abi(error))
                }
            },
            None => Ok(None),
        }
    }

    /// Rejects new forward work while any reverse stream awaits draining.
    fn ensure_reverse_streams_drained(&self) -> Result<(), CoreError> {
        if self.poisoned {
            return Err(CoreError::Poisoned);
        }
        if self.text.has_pending_resources() {
            return Err(CoreError::GlyphResourcesNotDrained);
        }
        if self.editing.has_pending_transactions() {
            return Err(CoreError::EditTransactionsNotDrained);
        }
        if !self.pending_events.is_empty() {
            return Err(CoreError::EventTransactionsNotDrained);
        }
        Ok(())
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

fn merge_geometry(
    target: &mut BitSet,
    visited: &mut usize,
    source: &BitSet,
    source_visited: usize,
) {
    for index in source.iter_ones() {
        target.insert(index);
    }
    *visited = (*visited).saturating_add(source_visited);
}

fn is_scroll_command(command: &InputCommand) -> bool {
    matches!(
        command,
        InputCommand::ScrollBegin { .. }
            | InputCommand::ScrollDelta { .. }
            | InputCommand::ScrollEnd { .. }
            | InputCommand::ScrollCancel { .. }
    )
}

fn is_newer_sequence(candidate: u32, previous: u32) -> bool {
    let delta = candidate.wrapping_sub(previous);
    delta != 0 && delta < (1_u32 << 31)
}

fn system_text_nodes(scene: &Scene, pairs: &[(u32, u32)]) -> Vec<doper_scene::NodeId> {
    if pairs.is_empty() {
        return Vec::new();
    }
    let pairs = pairs.iter().copied().collect::<HashSet<_>>();
    scene
        .ids()
        .iter()
        .copied()
        .filter(|node| {
            scene
                .text_run(*node)
                .is_some_and(|run| pairs.contains(&(run.string_id, run.style_id)))
        })
        .collect()
}

fn empty_editing_geometry() -> Vec<u32> {
    let mut words =
        Vec::with_capacity(EDITING_GEOMETRY_HEADER_WORDS + EDITING_GEOMETRY_RECT_WORDS * 2);
    words.extend_from_slice(&[EDITING_GEOMETRY_VERSION, NULL_NODE_ID, 0, 0, 0]);
    words.extend_from_slice(&[0; EDITING_GEOMETRY_RECT_WORDS * 2]);
    words
}

fn append_geometry_rect(words: &mut Vec<u32>, rect: WorldRect) {
    words.extend_from_slice(&[
        rect.left.to_bits(),
        rect.top.to_bits(),
        (rect.right - rect.left).max(0.0).to_bits(),
        (rect.bottom - rect.top).max(0.0).to_bits(),
    ]);
}

fn editor_range_rect(
    carets: &[doper_text::CaretStop],
    range: [u32; 2],
    geometry: WorldGeometry,
) -> Option<WorldRect> {
    let first = closest_editor_caret(carets, range[0])?;
    let last = closest_editor_caret(carets, range[1])?;
    if range[0] == range[1] {
        return Some(transform_local_rect(
            geometry,
            [first.x, first.y, 1.5, first.height],
        ));
    }
    let mut result = None;
    for line in first.line.min(last.line)..=first.line.max(last.line) {
        let line_carets = carets
            .iter()
            .filter(|caret| caret.line == line)
            .collect::<Vec<_>>();
        let Some(sample) = line_carets.first() else {
            continue;
        };
        let minimum_x = line_carets
            .iter()
            .map(|caret| caret.x)
            .fold(f32::INFINITY, f32::min);
        let maximum_x = line_carets
            .iter()
            .map(|caret| caret.x)
            .fold(f32::NEG_INFINITY, f32::max);
        let edge_a = if line == first.line {
            first.x
        } else {
            minimum_x
        };
        let edge_b = if line == last.line { last.x } else { maximum_x };
        let local = [
            edge_a.min(edge_b),
            sample.y,
            (edge_b - edge_a).abs().max(1.5),
            sample.height,
        ];
        let world = transform_local_rect(geometry, local);
        result = Some(result.map_or(world, |current: WorldRect| WorldRect {
            left: current.left.min(world.left),
            top: current.top.min(world.top),
            right: current.right.max(world.right),
            bottom: current.bottom.max(world.bottom),
        }));
    }
    result
}

fn editor_character_rects(
    carets: &[doper_text::CaretStop],
    requested: [u32; 2],
    geometry: WorldGeometry,
) -> Vec<([u32; 2], WorldRect)> {
    if requested[0] >= requested[1] {
        return Vec::new();
    }
    let mut result = Vec::new();
    for pair in carets.windows(2) {
        let start = pair[0].utf16_offset.min(pair[1].utf16_offset);
        let end = pair[0].utf16_offset.max(pair[1].utf16_offset);
        if start == end || end <= requested[0] || start >= requested[1] {
            continue;
        }
        let local = if pair[0].line == pair[1].line {
            [
                pair[0].x.min(pair[1].x),
                pair[0].y.min(pair[1].y),
                (pair[1].x - pair[0].x).abs().max(1.5),
                pair[0].height.max(pair[1].height),
            ]
        } else {
            [pair[0].x, pair[0].y, 1.5, pair[0].height]
        };
        result.push(([start, end], transform_local_rect(geometry, local)));
    }
    result
}

fn closest_editor_caret(
    carets: &[doper_text::CaretStop],
    offset: u32,
) -> Option<doper_text::CaretStop> {
    carets
        .iter()
        .copied()
        .min_by_key(|caret| (i64::from(caret.utf16_offset) - i64::from(offset)).unsigned_abs())
}

fn transform_local_rect(geometry: WorldGeometry, rect: [f32; 4]) -> WorldRect {
    let [left, top, width, height] = rect;
    let points = [
        geometry.transform_point(HitPoint { x: left, y: top }),
        geometry.transform_point(HitPoint {
            x: left + width,
            y: top,
        }),
        geometry.transform_point(HitPoint {
            x: left,
            y: top + height,
        }),
        geometry.transform_point(HitPoint {
            x: left + width,
            y: top + height,
        }),
    ];
    WorldRect {
        left: points
            .iter()
            .map(|point| point.x)
            .fold(f32::INFINITY, f32::min),
        top: points
            .iter()
            .map(|point| point.y)
            .fold(f32::INFINITY, f32::min),
        right: points
            .iter()
            .map(|point| point.x)
            .fold(f32::NEG_INFINITY, f32::max),
        bottom: points
            .iter()
            .map(|point| point.y)
            .fold(f32::NEG_INFINITY, f32::max),
    }
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

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use doper_abi::{
        DisplayCommand, DisplayList, EVENT_FLAG_PRECISE_WHEEL, EditTransactionBatch,
        EventTransactionBatch, GlyphResourceBatch, GlyphResourceCommand, InputBatch, InputCommand,
        InputEventKind, InputInstruction, Mutation, MutationBatch, MutationInstruction,
        NON_PASSIVE_REGION_HEADER_REGION_COUNT_INDEX, NON_PASSIVE_REGION_HEADER_VERSION_INDEX,
        NON_PASSIVE_REGION_HEADER_WORDS, NON_PASSIVE_REGION_RECORD_BOTTOM_BITS_INDEX,
        NON_PASSIVE_REGION_RECORD_FLAGS_INDEX, NON_PASSIVE_REGION_RECORD_LEFT_BITS_INDEX,
        NON_PASSIVE_REGION_RECORD_RIGHT_BITS_INDEX, NON_PASSIVE_REGION_RECORD_TOP_BITS_INDEX,
        NON_PASSIVE_REGION_VERSION, NULL_NODE_ID, NodeKind, Prop, RESOURCE_ENCODING_VERSION,
        ReplayRecord, ReplayRecording, ResourceKind, SFNT_FONT_DATA_BYTES_OFFSET,
        SFNT_FONT_DATA_OFFSET, SFNT_FONT_FACE_INDEX_OFFSET, SFNT_FONT_RESOURCE_VARIANT,
        SFNT_FONT_VARIANT_OFFSET, SFNT_FONT_VERSION_OFFSET, SystemTextMetric,
        SystemTextMetricBatch, SystemTextMetricCommand, SystemTextMetricInstruction,
    };
    use doper_edit::{EditConfig, EditSession, Selection};
    use doper_headless::HeadlessRenderer;
    use doper_paint::{SolidPaint, TextStyleResource};
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

    fn explicit_text_tree() -> Vec<u8> {
        let font_bytes = test_font_bytes();
        let font = sfnt_font_resource(&font_bytes);
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
                    kind: NodeKind::Text,
                    parent: id(0),
                    before_sibling: NULL_NODE_ID,
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
                Mutation::DefineResource {
                    resource_id: 2,
                    kind: ResourceKind::TextStyle,
                    bytes: TextStyleResource {
                        paint_id: 1,
                        font_size: 18.0,
                        line_height: 24.0,
                        weight: 400,
                        family: "sans-serif".to_owned(),
                    }
                    .encode()
                    .expect("text style"),
                },
                Mutation::DefineResource {
                    resource_id: 3,
                    kind: ResourceKind::Utf8String,
                    bytes: "\u{ea60}\u{ea61}".as_bytes().to_vec(),
                },
                Mutation::DefineResource {
                    resource_id: 4,
                    kind: ResourceKind::Font,
                    bytes: font,
                },
                Mutation::SetRef {
                    node_id: id(1),
                    prop: Prop::Font,
                    resource_id: 4,
                },
                Mutation::SetTextRun {
                    node_id: id(1),
                    string_id: 3,
                    style_id: 2,
                },
            ],
        )
    }

    fn system_text_tree() -> Vec<u8> {
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
                    kind: NodeKind::Text,
                    parent: id(0),
                    before_sibling: NULL_NODE_ID,
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
                Mutation::DefineResource {
                    resource_id: 2,
                    kind: ResourceKind::TextStyle,
                    bytes: TextStyleResource {
                        paint_id: 1,
                        font_size: 16.0,
                        line_height: 20.0,
                        weight: 400,
                        family: "sans-serif".to_owned(),
                    }
                    .encode()
                    .expect("text style"),
                },
                Mutation::DefineResource {
                    resource_id: 3,
                    kind: ResourceKind::Utf8String,
                    bytes: b"wide\nline".to_vec(),
                },
                Mutation::SetTextRun {
                    node_id: id(1),
                    string_id: 3,
                    style_id: 2,
                },
            ],
        )
    }

    fn editable_text_tree(flags: u32) -> Vec<u8> {
        editable_tree_with_text(flags, "a")
    }

    fn editable_resource_mutations(text: &str) -> Vec<Mutation> {
        vec![
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
            Mutation::DefineResource {
                resource_id: 2,
                kind: ResourceKind::TextStyle,
                bytes: TextStyleResource {
                    paint_id: 1,
                    font_size: 16.0,
                    line_height: 20.0,
                    weight: 400,
                    family: "sans-serif".to_owned(),
                }
                .encode()
                .expect("text style"),
            },
            Mutation::DefineResource {
                resource_id: 3,
                kind: ResourceKind::Utf8String,
                bytes: text.as_bytes().to_vec(),
            },
            Mutation::SetTextRun {
                node_id: id(2),
                string_id: 3,
                style_id: 2,
            },
            Mutation::ConfigureEditable {
                node_id: id(2),
                revision: 0,
                flags: 1,
                max_graphemes: 100,
            },
        ]
    }

    fn editable_tree_with_text(flags: u32, text: &str) -> Vec<u8> {
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
                    kind: NodeKind::EditableText,
                    parent: id(0),
                    before_sibling: NULL_NODE_ID,
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
                Mutation::DefineResource {
                    resource_id: 2,
                    kind: ResourceKind::TextStyle,
                    bytes: TextStyleResource {
                        paint_id: 1,
                        font_size: 16.0,
                        line_height: 20.0,
                        weight: 400,
                        family: "sans-serif".to_owned(),
                    }
                    .encode()
                    .expect("text style"),
                },
                Mutation::DefineResource {
                    resource_id: 3,
                    kind: ResourceKind::Utf8String,
                    bytes: text.as_bytes().to_vec(),
                },
                Mutation::SetTextRun {
                    node_id: id(1),
                    string_id: 3,
                    style_id: 2,
                },
                Mutation::ConfigureEditable {
                    node_id: id(1),
                    revision: 0,
                    flags,
                    max_graphemes: 100,
                },
            ],
        )
    }

    fn system_metrics(command: SystemTextMetricCommand) -> Vec<u8> {
        SystemTextMetricBatch {
            instructions: vec![SystemTextMetricInstruction { flags: 0, command }],
        }
        .encode()
        .expect("system text metrics")
    }

    fn sfnt_font_resource(data: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0_u8; (SFNT_FONT_DATA_OFFSET + data.len()).next_multiple_of(4)];
        bytes[SFNT_FONT_VERSION_OFFSET] = RESOURCE_ENCODING_VERSION;
        bytes[SFNT_FONT_VARIANT_OFFSET] = SFNT_FONT_RESOURCE_VARIANT;
        bytes[SFNT_FONT_FACE_INDEX_OFFSET..SFNT_FONT_FACE_INDEX_OFFSET + 4]
            .copy_from_slice(&0_u32.to_le_bytes());
        bytes[SFNT_FONT_DATA_BYTES_OFFSET..SFNT_FONT_DATA_BYTES_OFFSET + 4].copy_from_slice(
            &u32::try_from(data.len())
                .expect("fixture length")
                .to_le_bytes(),
        );
        bytes[SFNT_FONT_DATA_OFFSET..SFNT_FONT_DATA_OFFSET + data.len()].copy_from_slice(data);
        bytes
    }

    fn test_font_bytes() -> Vec<u8> {
        let store = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../node_modules/.pnpm");
        let package = fs::read_dir(&store)
            .expect("run pnpm install before the Rust suite")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("playwright-core@")
            })
            .max_by_key(std::fs::DirEntry::file_name)
            .expect("playwright-core package");
        let directory = package
            .path()
            .join("node_modules/playwright-core/lib/vite/traceViewer");
        let font = fs::read_dir(directory)
            .expect("trace-viewer assets")
            .filter_map(Result::ok)
            .find(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with("codicon.") && name.ends_with(".ttf")
            })
            .expect("SFNT fixture");
        fs::read(font.path()).expect("read font fixture")
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
        // Compare against the generated layout rather than a literal, so a
        // schema change cannot silently drift from the encoder.
        assert_eq!(
            output.diagnostics.to_words().len(),
            doper_abi::FRAME_DIAGNOSTICS_WORDS
        );
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
    fn hit_tests_events_and_gates_later_work_until_the_path_is_drained() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine.commit(&painted_tree()).expect("frame");

        assert_eq!(
            engine
                .input(&input(
                    1,
                    vec![InputCommand::DispatchEvent {
                        event_id: 41,
                        kind: InputEventKind::PointerDown,
                        flags: 0,
                        position: [12.0, 8.0],
                        delta: [0.0, 0.0],
                        buttons: 1,
                        modifiers: 4,
                        pointer_id: 1,
                        elapsed_micros: 16_667,
                    }],
                ))
                .expect("event"),
            None
        );
        assert_eq!(
            engine.input(&input(2, Vec::new())),
            Err(CoreError::EventTransactionsNotDrained)
        );

        let events = EventTransactionBatch::decode(
            &engine.take_event_transactions().expect("reverse events"),
        )
        .expect("decode reverse events");
        assert_eq!(events.records.len(), 1);
        assert_eq!(events.records[0].event_id, 41);
        assert_eq!(events.records[0].target, id(1));
        assert_eq!(events.records[0].path, vec![id(0), id(1)]);
        assert!(engine.take_event_transactions().expect("empty").is_empty());
        assert_eq!(
            engine.input(&input(2, Vec::new())).expect("next input"),
            None
        );
    }

    #[test]
    fn event_misses_do_not_create_backpressure_and_mixed_batches_are_atomic() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine.commit(&painted_tree()).expect("frame");
        assert_eq!(
            engine
                .input(&input(
                    1,
                    vec![InputCommand::DispatchEvent {
                        event_id: 1,
                        kind: InputEventKind::Click,
                        flags: 0,
                        position: [200.0, 200.0],
                        delta: [0.0, 0.0],
                        buttons: 0,
                        modifiers: 0,
                        pointer_id: 0,
                        elapsed_micros: 16_667,
                    }],
                ))
                .expect("miss"),
            None
        );
        assert!(engine.take_event_transactions().expect("empty").is_empty());

        let mixed = input(
            2,
            vec![
                InputCommand::DispatchEvent {
                    event_id: 2,
                    kind: InputEventKind::Wheel,
                    flags: 0,
                    position: [1.0, 1.0],
                    delta: [0.0, 10.0],
                    buttons: 0,
                    modifiers: 0,
                    pointer_id: 0,
                    elapsed_micros: 16_667,
                },
                InputCommand::FocusEditable { node_id: id(1) },
            ],
        );
        assert_eq!(engine.input(&mixed), Err(CoreError::MixedEventInput));
        assert!(engine.take_event_transactions().expect("empty").is_empty());
        assert_eq!(
            engine
                .input(&input(2, Vec::new()))
                .expect("sequence retained"),
            None
        );
    }

    #[test]
    fn publishes_scroll_bounds_for_synchronous_browser_default_suppression() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine.commit(&scroll_tree()).expect("frame");
        let words = engine.non_passive_regions();
        assert_eq!(
            words[NON_PASSIVE_REGION_HEADER_VERSION_INDEX],
            NON_PASSIVE_REGION_VERSION
        );
        assert_eq!(words[NON_PASSIVE_REGION_HEADER_REGION_COUNT_INDEX], 1);
        let record = NON_PASSIVE_REGION_HEADER_WORDS;
        assert_eq!(words[record + NON_PASSIVE_REGION_RECORD_FLAGS_INDEX], 3);
        assert_eq!(
            words[record + NON_PASSIVE_REGION_RECORD_LEFT_BITS_INDEX],
            0.0f32.to_bits()
        );
        assert_eq!(
            words[record + NON_PASSIVE_REGION_RECORD_TOP_BITS_INDEX],
            0.0f32.to_bits()
        );
        assert_eq!(
            words[record + NON_PASSIVE_REGION_RECORD_RIGHT_BITS_INDEX],
            100.0f32.to_bits()
        );
        assert_eq!(
            words[record + NON_PASSIVE_REGION_RECORD_BOTTOM_BITS_INDEX],
            100.0f32.to_bits()
        );
    }

    #[test]
    fn discrete_wheel_notches_animate_while_precise_deltas_apply_immediately() {
        let scroll = NodeId::from_raw(id(1)).expect("scroll");
        let wheel = |flags: u16, event_id: u32| InputCommand::DispatchEvent {
            event_id,
            kind: InputEventKind::Wheel,
            flags,
            position: [20.0, 20.0],
            delta: [0.0, 60.0],
            buttons: 0,
            modifiers: 0,
            pointer_id: 0,
            elapsed_micros: 16_667,
        };

        let mut precise = CoreEngine::new(320.0, 240.0).expect("Core");
        precise.commit(&scroll_tree()).expect("frame");
        precise
            .input(&input(1, vec![wheel(EVENT_FLAG_PRECISE_WHEEL, 1)]))
            .expect("precise wheel");
        precise.take_event_transactions().expect("events");
        assert_eq!(
            precise.scene().scroll_position(scroll),
            Some([0.0, 60.0]),
            "a trackpad delta already carries platform smoothing and momentum"
        );

        let mut notched = CoreEngine::new(320.0, 240.0).expect("Core");
        notched.commit(&scroll_tree()).expect("frame");
        notched
            .input(&input(1, vec![wheel(0, 1)]))
            .expect("discrete wheel");
        notched.take_event_transactions().expect("events");
        let immediate = notched
            .scene()
            .scroll_position(scroll)
            .expect("scroll position")[1];
        assert!(
            immediate < 60.0,
            "a discrete notch must animate like a browser, not jump: {immediate}"
        );

        for _ in 0..240 {
            notched.advance(1.0 / 120.0).expect("frame");
        }
        assert_eq!(
            notched.scene().scroll_position(scroll),
            Some([0.0, 60.0]),
            "the animation must land on exactly the requested distance"
        );
    }

    #[test]
    fn wheel_events_scroll_the_nearest_hit_ancestor_before_returning_the_path() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine.commit(&scroll_tree()).expect("frame");
        let output = engine
            .input(&input(
                1,
                vec![InputCommand::DispatchEvent {
                    event_id: 3,
                    kind: InputEventKind::Wheel,
                    flags: EVENT_FLAG_PRECISE_WHEEL,
                    position: [20.0, 20.0],
                    delta: [0.0, 30.0],
                    buttons: 0,
                    modifiers: 0,
                    pointer_id: 0,
                    elapsed_micros: 16_667,
                }],
            ))
            .expect("wheel event");
        assert!(output.is_some());
        assert_eq!(
            engine
                .scene()
                .scroll_position(NodeId::from_raw(id(1)).expect("scroll")),
            Some([0.0, 30.0])
        );
        let events =
            EventTransactionBatch::decode(&engine.take_event_transactions().expect("events"))
                .expect("decode");
        assert_eq!(events.records[0].path, vec![id(0), id(1), id(2)]);
    }

    #[test]
    fn pointer_dragging_continues_outside_the_hit_region_and_ends_deterministically() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine.commit(&scroll_tree()).expect("frame");
        let pointer = |kind, position, buttons| InputCommand::DispatchEvent {
            event_id: 10,
            kind,
            flags: 0,
            position,
            delta: [0.0, 0.0],
            buttons,
            modifiers: 0,
            pointer_id: 7,
            elapsed_micros: 16_667,
        };
        assert_eq!(
            engine
                .input(&input(
                    1,
                    vec![pointer(InputEventKind::PointerDown, [20.0, 60.0], 1)],
                ))
                .expect("down"),
            None
        );
        engine.take_event_transactions().expect("down event");
        assert!(
            engine
                .input(&input(
                    2,
                    vec![pointer(InputEventKind::PointerMove, [20.0, -20.0], 1)],
                ))
                .expect("move")
                .is_some()
        );
        engine.take_event_transactions().expect("move event");
        engine
            .input(&input(
                3,
                vec![pointer(InputEventKind::PointerUp, [20.0, -20.0], 0)],
            ))
            .expect("up");
        assert_eq!(
            engine
                .scene()
                .scroll_position(NodeId::from_raw(id(1)).expect("scroll")),
            Some([0.0, 80.0])
        );
    }

    #[test]
    fn editable_input_updates_core_text_and_inline_fallback_without_shell_commit() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        let initial = engine
            .commit(&editable_text_tree(1))
            .expect("editable frame");
        let initial_display = DisplayList::decode(&initial.display_list).expect("DisplayList");
        assert!(
            initial_display
                .instructions
                .iter()
                .any(|instruction| matches!(
                    &instruction.command,
                    DisplayCommand::DrawTextInlineFallback { text, .. } if text == "a"
                ))
        );

        let output = engine
            .input(&input(
                1,
                vec![InputCommand::Insert {
                    node_id: id(1),
                    base_revision: 0,
                    text: "你🙂".to_owned(),
                }],
            ))
            .expect("editing input")
            .expect("changed frame");
        let display = DisplayList::decode(&output.display_list).expect("DisplayList");
        assert!(display.instructions.iter().any(|instruction| matches!(
            &instruction.command,
            DisplayCommand::DrawTextInlineFallback { text, .. } if text == "a你🙂"
        )));
        assert_eq!(
            engine.input(&input(2, vec![])),
            Err(CoreError::EditTransactionsNotDrained)
        );
        let transactions = EditTransactionBatch::decode(
            &engine
                .take_edit_transactions()
                .expect("edit transaction batch"),
        )
        .expect("decode edit transactions");
        assert_eq!(transactions.records.len(), 1);
        assert_eq!(transactions.records[0].node_id, id(1));
        assert_eq!(transactions.records[0].base_revision, 0);
        assert_eq!(transactions.records[0].revision, 1);
        assert_eq!(
            transactions.records[0]
                .delta
                .as_ref()
                .map(|(_, text)| text.as_str()),
            Some("你🙂")
        );
        let node = NodeId::from_raw(id(1)).expect("editable node");
        let session = engine.editing.session(node).expect("editing session");
        assert_eq!(session.text(), "a你🙂");
        assert_eq!(session.revision(), 1);
    }

    #[test]
    fn place_caret_maps_points_to_caret_extension_and_word_selection() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine
            .commit(&editable_tree_with_text(1, "ab cd"))
            .expect("frame");
        engine
            .input(&input(
                1,
                vec![InputCommand::FocusEditable { node_id: id(1) }],
            ))
            .expect("focus");
        engine.take_edit_transactions().expect("drain focus");

        let place = |position: [f32; 2], flags: u32| InputCommand::PlaceCaret {
            node_id: id(1),
            position,
            flags,
        };
        let selection_after = |engine: &mut CoreEngine| -> [u32; 2] {
            let bytes = engine.take_edit_transactions().expect("edit bytes");
            let batch = doper_abi::EditTransactionBatch::decode(&bytes).expect("decode");
            batch.records.last().expect("record").selection
        };

        engine
            .input(&input(2, vec![place([1_000.0, 0.0], 0)]))
            .expect("place far right");
        assert_eq!(selection_after(&mut engine), [5, 5]);

        engine
            .input(&input(3, vec![place([-10.0, 0.0], 1)]))
            .expect("extend to start");
        assert_eq!(selection_after(&mut engine), [5, 0]);

        engine
            .input(&input(4, vec![place([1_000.0, 0.0], 2)]))
            .expect("word at end");
        assert_eq!(selection_after(&mut engine), [3, 5]);

        let missing = engine
            .input(&input(
                5,
                vec![InputCommand::PlaceCaret {
                    node_id: id(9),
                    position: [0.0, 0.0],
                    flags: 0,
                }],
            ))
            .expect_err("unknown editable");
        assert!(matches!(missing, CoreError::InvalidEditableTarget { .. }));
    }

    #[test]
    fn move_caret_navigates_graphemes_words_lines_and_desired_column() {
        use doper_abi::{CaretDirection as D, CaretGranularity as G};
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine
            .commit(&editable_tree_with_text(1, "ab\ncd"))
            .expect("frame");
        engine
            .input(&input(
                1,
                vec![InputCommand::FocusEditable { node_id: id(1) }],
            ))
            .expect("focus");
        engine.take_edit_transactions().expect("drain focus");

        let move_caret = |direction, granularity, extend| InputCommand::MoveCaret {
            node_id: id(1),
            direction,
            granularity,
            extend,
        };
        let mut seq = 1_u32;
        let mut apply = |engine: &mut CoreEngine, command: InputCommand| -> [u32; 2] {
            seq += 1;
            engine.input(&input(seq, vec![command])).expect("move");
            let bytes = engine.take_edit_transactions().expect("edit bytes");
            let batch = doper_abi::EditTransactionBatch::decode(&bytes).expect("decode");
            batch.records.last().expect("record").selection
        };

        assert_eq!(
            apply(
                &mut engine,
                InputCommand::PlaceCaret {
                    node_id: id(1),
                    position: [-10.0, -10.0],
                    flags: 0,
                },
            ),
            [0, 0]
        );
        assert_eq!(
            apply(&mut engine, move_caret(D::Forward, G::Grapheme, false)),
            [1, 1]
        );
        assert_eq!(
            apply(&mut engine, move_caret(D::Down, G::Grapheme, false)),
            [4, 4]
        );
        assert_eq!(
            apply(&mut engine, move_caret(D::LineEnd, G::Grapheme, false)),
            [5, 5]
        );
        assert_eq!(
            apply(&mut engine, move_caret(D::Backward, G::Word, false)),
            [3, 3]
        );
        assert_eq!(
            apply(&mut engine, move_caret(D::LineStart, G::Grapheme, false)),
            [3, 3]
        );
        assert_eq!(
            apply(&mut engine, move_caret(D::Up, G::Grapheme, false)),
            [0, 0]
        );
        assert_eq!(
            apply(&mut engine, move_caret(D::Forward, G::Word, true)),
            [0, 2]
        );
        // A plain arrow collapses an active selection to its edge.
        assert_eq!(
            apply(&mut engine, move_caret(D::Backward, G::Grapheme, false)),
            [0, 0]
        );
        // Up from the first line clamps to the text start; down past the last line to the end.
        assert_eq!(
            apply(&mut engine, move_caret(D::Up, G::Grapheme, false)),
            [0, 0]
        );
    }

    #[test]
    fn semantics_exports_roles_bounds_focus_and_never_password_text() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        let mut mutations = vec![
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
            Mutation::CreateNode {
                node_id: id(2),
                kind: NodeKind::EditableText,
                parent: id(1),
                before_sibling: NULL_NODE_ID,
            },
            Mutation::SetF32 {
                node_id: id(2),
                prop: Prop::Width,
                value: 120.0,
            },
            Mutation::SetF32 {
                node_id: id(2),
                prop: Prop::Height,
                value: 40.0,
            },
            Mutation::DefineResource {
                resource_id: 9,
                kind: ResourceKind::Utf8String,
                bytes: b"Secret".to_vec(),
            },
            Mutation::SetRef {
                node_id: id(2),
                prop: Prop::SemanticLabel,
                resource_id: 9,
            },
        ];
        mutations.extend(editable_resource_mutations("hunter2"));
        // Password flag on the editable configuration.
        if let Some(Mutation::ConfigureEditable { flags, .. }) = mutations
            .iter_mut()
            .find(|mutation| matches!(mutation, Mutation::ConfigureEditable { .. }))
        {
            *flags |= 4;
        }
        engine.commit(&frame(1, mutations)).expect("frame");
        engine
            .input(&input(
                1,
                vec![InputCommand::FocusEditable { node_id: id(2) }],
            ))
            .expect("focus");
        engine.take_edit_transactions().expect("drain focus");

        let bytes = engine.semantics();
        let word = |index: usize| {
            u32::from_le_bytes(bytes[index * 4..index * 4 + 4].try_into().expect("word"))
        };
        assert_eq!(word(0), 1, "semantics version");
        assert_eq!(word(1), 1, "one semantic record");
        assert_eq!(word(2), id(2));
        // focusable + focused + password.
        assert_eq!(word(3), 0b111);
        assert!(f32::from_bits(word(6)) > 0.0, "width");
        let role_len = word(8) as usize;
        let label_len = word(9) as usize;
        let value_len = word(10) as usize;
        assert_eq!(value_len, 0, "password value must never be exported");
        let strings = &bytes[11 * 4..11 * 4 + role_len + label_len];
        assert_eq!(&strings[..role_len], b"textbox");
        assert_eq!(&strings[role_len..], b"Secret");
    }

    #[test]
    fn editing_reveals_the_caret_through_the_nearest_scroll_ancestor() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        let mut mutations = vec![
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
                kind: NodeKind::EditableText,
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
                value: 100.0,
            },
            Mutation::SetF32 {
                node_id: id(2),
                prop: Prop::Height,
                value: 1_000.0,
            },
        ];
        let long_text = (0..25).map(|line| format!("l{line}")).collect::<Vec<_>>();
        mutations.extend(editable_resource_mutations(&long_text.join("\n")));
        engine.commit(&frame(1, mutations)).expect("frame");
        assert_eq!(
            engine
                .scene()
                .scroll_position(NodeId::from_raw(id(1)).expect("scroll")),
            Some([0.0, 0.0])
        );

        // Focusing collapses the caret to the end of the text, far below the
        // 100px viewport; the accepted edit command must reveal it.
        engine
            .input(&input(
                1,
                vec![InputCommand::FocusEditable { node_id: id(2) }],
            ))
            .expect("focus");
        engine.take_edit_transactions().expect("drain focus");
        let scrolled = engine
            .scene()
            .scroll_position(NodeId::from_raw(id(1)).expect("scroll"))
            .expect("position");
        assert!(
            scrolled[1] > 100.0,
            "caret reveal must scroll the viewport, got {scrolled:?}"
        );
    }

    #[test]
    fn pointer_drag_prefers_text_selection_over_scroll_when_editable_is_deeper() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        let mut mutations = vec![
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
                kind: NodeKind::EditableText,
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
                value: 100.0,
            },
            Mutation::SetF32 {
                node_id: id(2),
                prop: Prop::Height,
                value: 1_000.0,
            },
        ];
        mutations.extend(editable_resource_mutations("ab cd"));
        engine.commit(&frame(1, mutations)).expect("frame");

        let pointer = |kind, position, buttons| InputCommand::DispatchEvent {
            event_id: 11,
            kind,
            flags: 0,
            position,
            delta: [0.0, 0.0],
            buttons,
            modifiers: 0,
            pointer_id: 9,
            elapsed_micros: 16_667,
        };
        engine
            .input(&input(
                1,
                vec![pointer(InputEventKind::PointerDown, [20.0, 60.0], 1)],
            ))
            .expect("down");
        engine.take_event_transactions().expect("down event");
        assert!(
            engine
                .input(&input(
                    2,
                    vec![pointer(InputEventKind::PointerMove, [20.0, -20.0], 1)],
                ))
                .expect("move")
                .is_none(),
            "dragging over an editable must not scroll"
        );
        engine.take_event_transactions().expect("move event");
        assert_eq!(
            engine
                .scene()
                .scroll_position(NodeId::from_raw(id(1)).expect("scroll")),
            Some([0.0, 0.0])
        );

        let wheel = InputCommand::DispatchEvent {
            event_id: 12,
            kind: InputEventKind::Wheel,
            flags: EVENT_FLAG_PRECISE_WHEEL,
            position: [20.0, 60.0],
            delta: [0.0, 50.0],
            buttons: 0,
            modifiers: 0,
            pointer_id: 0,
            elapsed_micros: 16_667,
        };
        engine.input(&input(3, vec![wheel])).expect("wheel");
        engine.take_event_transactions().expect("wheel event");
        assert_ne!(
            engine
                .scene()
                .scroll_position(NodeId::from_raw(id(1)).expect("scroll")),
            Some([0.0, 0.0]),
            "wheel over an editable still scrolls the ancestor"
        );
    }

    #[test]
    fn focused_editor_draws_selection_and_worker_clock_driven_caret() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine
            .commit(&editable_text_tree(1))
            .expect("editable frame");

        let focused = engine
            .input(&input(
                1,
                vec![InputCommand::FocusEditable { node_id: id(1) }],
            ))
            .expect("focus input")
            .expect("focus frame");
        let display = DisplayList::decode(&focused.display_list).expect("DisplayList");
        assert!(display.instructions.iter().any(|instruction| matches!(
            instruction.command,
            DisplayCommand::DrawEditorDecoration {
                kind: doper_abi::EditorDecorationKind::Caret,
                ..
            }
        )));

        assert!(
            engine
                .advance(0.25)
                .expect("first caret half-period")
                .is_none()
        );
        let hidden = engine
            .advance(0.25)
            .expect("second caret half-period")
            .expect("caret blink frame");
        let display = DisplayList::decode(&hidden.display_list).expect("DisplayList");
        assert!(!display.instructions.iter().any(|instruction| matches!(
            instruction.command,
            DisplayCommand::DrawEditorDecoration {
                kind: doper_abi::EditorDecorationKind::Caret,
                ..
            }
        )));

        let selected = engine
            .input(&input(
                2,
                vec![InputCommand::SetSelection {
                    node_id: id(1),
                    base_revision: 0,
                    selection: doper_abi::InputSelection {
                        anchor: doper_abi::InputPosition {
                            offset: 0,
                            affinity: doper_abi::InputAffinity::Downstream,
                        },
                        focus: doper_abi::InputPosition {
                            offset: 1,
                            affinity: doper_abi::InputAffinity::Downstream,
                        },
                    },
                }],
            ))
            .expect("selection input")
            .expect("selection frame");
        let display = DisplayList::decode(&selected.display_list).expect("DisplayList");
        assert!(display.instructions.iter().any(|instruction| matches!(
            instruction.command,
            DisplayCommand::DrawEditorDecoration {
                kind: doper_abi::EditorDecorationKind::Selection,
                ..
            }
        )));
    }

    #[test]
    fn editable_batches_are_atomic_and_password_display_never_contains_plaintext() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine
            .commit(&editable_text_tree(1 | 4))
            .expect("password frame");
        let rejected = input(
            1,
            vec![
                InputCommand::Insert {
                    node_id: id(1),
                    base_revision: 0,
                    text: "secret".to_owned(),
                },
                InputCommand::Insert {
                    node_id: id(1),
                    base_revision: 0,
                    text: "stale".to_owned(),
                },
            ],
        );
        assert!(matches!(engine.input(&rejected), Err(CoreError::Edit(_))));
        let node = NodeId::from_raw(id(1)).expect("editable node");
        assert_eq!(engine.editing.session(node).expect("session").text(), "a");

        let output = engine
            .input(&input(
                2,
                vec![InputCommand::Insert {
                    node_id: id(1),
                    base_revision: 0,
                    text: "secret".to_owned(),
                }],
            ))
            .expect("password input")
            .expect("changed frame");
        let display = DisplayList::decode(&output.display_list).expect("DisplayList");
        assert!(display.instructions.iter().any(|instruction| matches!(
            &instruction.command,
            DisplayCommand::DrawTextInlineFallback { text, .. }
                if text == "•••••••" && !text.contains("secret")
        )));
    }

    #[test]
    fn explicit_font_produces_glyph_run_and_transactional_resources() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        let output = engine.commit(&explicit_text_tree()).expect("text frame");
        let display = DisplayList::decode(&output.display_list).expect("DisplayList");
        let glyph_run = display.instructions.iter().find_map(|instruction| {
            if let DisplayCommand::DrawGlyphRun {
                font_id,
                size,
                glyph_span_id,
                ..
            } = instruction.command
            {
                Some((font_id, size, glyph_span_id))
            } else {
                None
            }
        });
        let (font_id, size, glyph_span_id) = glyph_run.expect("shaped glyph run");
        assert_eq!(font_id, 4);
        assert!((size - 18.0).abs() < f32::EPSILON);
        assert!(!display.instructions.iter().any(|instruction| matches!(
            instruction.command,
            DisplayCommand::DrawTextFallback { .. }
        )));

        assert_eq!(
            engine.commit(&frame(2, Vec::new())),
            Err(CoreError::GlyphResourcesNotDrained)
        );

        let resources =
            GlyphResourceBatch::decode(&engine.take_glyph_resources()).expect("glyph resources");
        assert_eq!(resources.instructions.len(), 1);
        let GlyphResourceCommand::Define(span) = &resources.instructions[0].command else {
            panic!("expected span definition");
        };
        assert_eq!(span.span_id, glyph_span_id);
        assert_eq!(span.paint_id, 1);
        assert!(!span.bitmaps.is_empty());
        assert_eq!(span.placements.len(), 2);
        assert_eq!(engine.text_metrics().spans_defined, 1);

        let clean = engine.commit(&frame(2, Vec::new())).expect("clean frame");
        assert!(!clean.rebuilt);
        assert!(engine.take_glyph_resources().is_empty());

        let scaled = engine
            .set_device_pixel_ratio(2.0)
            .expect("valid DPR")
            .expect("replacement frame");
        assert!(scaled.rebuilt);
        let resources = GlyphResourceBatch::decode(&engine.take_glyph_resources())
            .expect("replacement glyph resources");
        assert_eq!(resources.instructions.len(), 2);
        assert!(resources.instructions.iter().any(|instruction| matches!(
            instruction.command,
            GlyphResourceCommand::Release { span_id } if span_id == glyph_span_id
        )));
        let replacement = resources.instructions.iter().find_map(|instruction| {
            if let GlyphResourceCommand::Define(span) = &instruction.command {
                Some(span)
            } else {
                None
            }
        });
        assert!(
            replacement
                .expect("replacement definition")
                .bitmaps
                .iter()
                .all(|bitmap| (bitmap.device_pixel_ratio - 2.0).abs() < f32::EPSILON)
        );
        assert!(matches!(
            engine.set_device_pixel_ratio(0.0),
            Err(CoreError::InvalidDevicePixelRatio(0.0))
        ));
    }

    #[test]
    fn system_text_metrics_commit_atomically_and_refresh_active_layout() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        let initial_metric = SystemTextMetricCommand::Upsert(SystemTextMetric {
            string_id: 3,
            style_id: 2,
            max_line_width: 80.0,
            line_count: 2,
        });
        let output = engine
            .commit_with_system_text_metrics(
                &system_text_tree(),
                Some(&system_metrics(initial_metric)),
            )
            .expect("system text frame");
        assert!(
            DisplayList::decode(&output.display_list)
                .expect("DisplayList")
                .instructions
                .iter()
                .any(|instruction| matches!(
                    instruction.command,
                    DisplayCommand::DrawTextFallback { .. }
                ))
        );
        let text = NodeId::from_raw(id(1)).expect("text id");
        assert_eq!(
            engine
                .layout
                .snapshot()
                .geometry(text)
                .map(|(_, size)| size),
            Some(doper_layout::Size::new(80.0, 40.0))
        );
        assert_eq!(engine.text_metrics().system_metric_hits, 1);

        let refreshed = engine
            .set_system_text_metrics(&system_metrics(SystemTextMetricCommand::Upsert(
                SystemTextMetric {
                    string_id: 3,
                    style_id: 2,
                    max_line_width: 120.0,
                    line_count: 3,
                },
            )))
            .expect("metric refresh")
            .expect("replacement frame");
        assert!(refreshed.diagnostics.layout_visited_nodes > 0);
        assert_eq!(
            engine
                .layout
                .snapshot()
                .geometry(text)
                .map(|(_, size)| size),
            Some(doper_layout::Size::new(120.0, 60.0))
        );
        assert_eq!(engine.text_metrics().system_metric_hits, 2);
        assert_eq!(engine.text_metrics().system_metric_upserts, 2);
    }

    #[test]
    fn system_text_metric_rejection_does_not_commit_scene_or_cache_state() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        let release = system_metrics(SystemTextMetricCommand::Release {
            string_id: 3,
            style_id: 2,
        });
        assert!(matches!(
            engine.commit_with_system_text_metrics(&system_text_tree(), Some(&release)),
            Err(CoreError::SystemTextMetricsState(_))
        ));
        assert!(engine.scene().is_empty());
        assert_eq!(engine.metrics().committed_frames, 0);
        assert_eq!(engine.text_metrics().system_metric_releases, 0);
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
    fn unmaterialized_visible_items_paint_a_skeleton_instead_of_blank_canvas() {
        // Regression: the placeholder path existed only as a metric counter, so
        // a visible item the Shell had not materialized produced no draw at all
        // and the viewport showed blank canvas during fast scrolling.
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        let output = engine.commit(&virtual_list_tree()).expect("initial frame");
        let missing = engine.scroll_metrics().virtual_placeholders;
        assert!(
            missing > 0,
            "the fixture must leave visible items unmaterialized"
        );

        let list = DisplayList::decode(&output.display_list).expect("display list");
        let skeletons: Vec<_> = list
            .instructions
            .iter()
            .filter_map(|instruction| match instruction.command {
                DisplayCommand::FillPlaceholder { rect, rgba } => Some((rect, rgba)),
                _ => None,
            })
            .collect();
        assert_eq!(
            u64::try_from(skeletons.len()).expect("count fits"),
            missing,
            "every counted placeholder must also be drawn"
        );
        for (rect, rgba) in &skeletons {
            assert!(
                rect[2] > 0.0 && rect[3] > 0.0,
                "skeleton must cover area: {rect:?}"
            );
            assert_ne!(*rgba & 0xff, 0, "skeleton must be opaque enough to see");
        }
    }

    #[test]
    fn an_unanswered_refill_is_repeated_until_the_shell_materializes() {
        // Regression: the request was deduplicated on the planned window alone,
        // so if the Shell never answered, Core never asked again and the
        // viewport stayed on skeletons indefinitely -- the scroll looked stuck.
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine.commit(&virtual_list_tree()).expect("initial frame");
        let first = engine.take_virtual_refills();
        assert_eq!(first.len(), 1, "the first frame asks for a window");

        // Advance without materializing anything: the window does not move, but
        // the demand is still outstanding.
        engine.advance(1.0 / 60.0).expect("frame");
        let repeated = engine.take_virtual_refills();
        assert_eq!(
            repeated, first,
            "an unanswered window must be requested again"
        );
        assert!(engine.scroll_metrics().virtual_placeholders > 0);
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
                    ReplayRecord::SystemTextMetrics(bytes) => {
                        let _ = engine
                            .set_system_text_metrics(&bytes)
                            .expect("replay system text metrics");
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
