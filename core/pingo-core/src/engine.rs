use std::{
    collections::{BTreeSet, HashMap, HashSet},
    sync::Arc,
};

use pingo_abi::{
    CaretDirection, CaretGranularity, EDITING_GEOMETRY_CHARACTER_WORDS,
    EDITING_GEOMETRY_HEADER_WORDS, EDITING_GEOMETRY_RECT_WORDS, EDITING_GEOMETRY_VERSION,
    EVENT_FLAG_PRECISE_WHEEL, EventTransactionBatch, EventTransactionRecord,
    FRAME_DIAGNOSTICS_ANIMATION_ACTIVE_INDEX, FRAME_DIAGNOSTICS_ANIMATION_CANCELS_INDEX,
    FRAME_DIAGNOSTICS_ANIMATION_LAYOUT_NODES_INDEX, FRAME_DIAGNOSTICS_ANIMATION_PHASE_ACTIVE_INDEX,
    FRAME_DIAGNOSTICS_ANIMATION_PHASE_AFTER_INDEX, FRAME_DIAGNOSTICS_ANIMATION_PHASE_BEFORE_INDEX,
    FRAME_DIAGNOSTICS_ANIMATION_PRESENTATION_CHANGES_INDEX,
    FRAME_DIAGNOSTICS_ANIMATION_RETAINED_BYTES_INDEX, FRAME_DIAGNOSTICS_ANIMATION_RETARGETS_INDEX,
    FRAME_DIAGNOSTICS_ANIMATION_SAMPLED_FRAMES_INDEX, FRAME_DIAGNOSTICS_ANIMATION_STARTS_INDEX,
    FRAME_DIAGNOSTICS_DIRTY_HIT_NODES_INDEX, FRAME_DIAGNOSTICS_DIRTY_LAYOUT_NODES_INDEX,
    FRAME_DIAGNOSTICS_DIRTY_PAINT_NODES_INDEX, FRAME_DIAGNOSTICS_DIRTY_PAINT_SELF_NODES_INDEX,
    FRAME_DIAGNOSTICS_DIRTY_SEMANTICS_NODES_INDEX, FRAME_DIAGNOSTICS_DISPLAY_COMMANDS_INDEX,
    FRAME_DIAGNOSTICS_FRAME_SEQ_INDEX, FRAME_DIAGNOSTICS_INTERACTION_STATE_CHANGES_INDEX,
    FRAME_DIAGNOSTICS_LAYOUT_CHANGED_NODES_INDEX, FRAME_DIAGNOSTICS_LAYOUT_VISITED_NODES_INDEX,
    FRAME_DIAGNOSTICS_OVER_INVALIDATED_FRAMES_INDEX, FRAME_DIAGNOSTICS_PAINT_REBUILT_INDEX,
    FRAME_DIAGNOSTICS_PICTURE_BUDGET_FALLBACKS_INDEX, FRAME_DIAGNOSTICS_PICTURE_BUILDS_INDEX,
    FRAME_DIAGNOSTICS_PICTURE_CACHE_HITS_INDEX, FRAME_DIAGNOSTICS_PICTURE_DEFINES_INDEX,
    FRAME_DIAGNOSTICS_PICTURE_HASH_HIGH_INDEX, FRAME_DIAGNOSTICS_PICTURE_HASH_LOW_INDEX,
    FRAME_DIAGNOSTICS_PICTURE_RELEASES_INDEX, FRAME_DIAGNOSTICS_PICTURE_RESIDENT_BYTES_INDEX,
    FRAME_DIAGNOSTICS_PICTURE_RESIDENT_COUNT_INDEX, FRAME_DIAGNOSTICS_PICTURE_RESOURCE_BYTES_INDEX,
    FRAME_DIAGNOSTICS_PICTURE_SUBTREE_BUILDS_INDEX,
    FRAME_DIAGNOSTICS_PICTURE_SUBTREE_CACHE_HITS_INDEX,
    FRAME_DIAGNOSTICS_PRODUCER_ABI_VERSION_INDEX, FRAME_DIAGNOSTICS_SCENE_NODES_INDEX,
    FRAME_DIAGNOSTICS_SKIPPED_INSTRUCTIONS_INDEX, FRAME_DIAGNOSTICS_VERSION,
    FRAME_DIAGNOSTICS_VERSION_INDEX, FRAME_DIAGNOSTICS_VIRTUAL_MATERIALIZED_END_INDEX,
    FRAME_DIAGNOSTICS_VIRTUAL_MATERIALIZED_START_INDEX,
    FRAME_DIAGNOSTICS_VIRTUAL_VISIBLE_END_INDEX, FRAME_DIAGNOSTICS_VIRTUAL_VISIBLE_START_INDEX,
    FRAME_DIAGNOSTICS_VISIBLE_PLACEHOLDERS_INDEX, FRAME_DIAGNOSTICS_WORDS, InputAffinity,
    InputBatch, InputCommand, InputEventKind, InputPointerType, InputPosition, InputSelection,
    Mutation, MutationBatch, NON_PASSIVE_REGION_VERSION, NULL_NODE_ID, NodeKind, Prop,
    ResourceKind, SEMANTICS_VERSION, StyleKeyword, StyleProperty, SystemTextMetricBatch,
};
use pingo_hit::{HitIndex, HitPoint, WorldGeometry, WorldRect};
use pingo_layout::{BoxConstraints, LayoutEngine};
use pingo_paint::{PaintEngine, PaintMetrics};
use pingo_scene::{BitSet, DirtyDomain, NodeId, Scene, SceneMetrics};
use pingo_scroll::ScrollPlatform;

use crate::{
    CoreError, CoreScrollMetrics, CoreTextMetrics,
    animation::AnimationController,
    editing::{EditableConfiguration, EditingController},
    interaction::{InteractionCommand, InteractionController, KeyEventInput, PointerEventInput},
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
    /// Nodes whose Core-owned hover/active/focus state mask changed.
    pub interaction_state_changes: u64,
    /// Worker clock frames that changed a Core-owned scroll position.
    pub scroll_frames: u64,
    /// Instructions stepped over because this build does not know the opcode.
    ///
    /// Non-zero means a producer newer than this Core is driving it and some of
    /// what it sent was dropped. That is the defined downgrade, but it has to be
    /// visible: silently rendering less than was asked for is indistinguishable
    /// from a decoder that lost data.
    pub skipped_instructions: u64,
    /// Highest ABI version observed on an accepted stream.
    pub producer_abi_version: u32,
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
    /// First and last-plus-one virtual item the viewport intersects.
    ///
    /// Together with `virtual_materialized` this says whether the Shell is
    /// answering the window Core is actually looking at. Without it, a viewport
    /// stuck on skeletons is indistinguishable from one whose Shell is simply
    /// slow, because both look like a steady placeholder count.
    pub virtual_visible: (usize, usize),
    /// Item range the Shell has actually materialized, as Core sees it.
    pub virtual_materialized: (usize, usize),
    /// Instructions this build stepped over, cumulative across the session.
    ///
    /// Non-zero means a newer producer is driving this Core and some of what it
    /// sent was dropped. That downgrade is defined, but it has to be visible.
    pub skipped_instructions: u64,
    /// Highest ABI version observed on an accepted stream.
    pub producer_abi_version: u32,
    /// Cumulative nodes whose Core-owned interaction mask changed.
    pub interaction_state_changes: u64,
    /// Timelines that can change on a future logical clock tick.
    pub animation_active: u64,
    /// Configured timelines currently before their active interval.
    pub animation_phase_before: u64,
    /// Configured timelines currently inside their active interval.
    pub animation_phase_active: u64,
    /// Configured timelines currently after their active interval.
    pub animation_phase_after: u64,
    /// Cumulative transition/keyframe starts.
    pub animation_starts: u64,
    /// Cumulative transition retargets from current presentation.
    pub animation_retargets: u64,
    /// Cumulative timelines cancelled by configuration or lifecycle changes.
    pub animation_cancels: u64,
    /// Cumulative frames whose sampled presentation changed.
    pub animation_sampled_frames: u64,
    /// Presentation values changed by animation while producing this frame.
    pub animation_presentation_changes: u64,
    /// Layout nodes visited specifically for animation; always zero in M7.
    pub animation_layout_nodes: u64,
    /// Bounded estimated animation payload and controller bytes retained by Core.
    pub animation_retained_bytes: u64,
    /// Cumulative immutable Picture definitions published by Core.
    pub picture_defines: u64,
    /// Cumulative immutable Picture releases published by Core.
    pub picture_releases: u64,
    /// Live Picture count after this frame.
    pub picture_resident_count: usize,
    /// Live Picture payload bytes after this frame.
    pub picture_resident_bytes: usize,
    /// Picture resource batch bytes emitted for this frame.
    pub picture_resource_bytes: usize,
    /// Cumulative resident-budget fallbacks to the inline reference path.
    pub picture_budget_fallbacks: u64,
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
        words[FRAME_DIAGNOSTICS_VIRTUAL_VISIBLE_START_INDEX] = count_word(self.virtual_visible.0);
        words[FRAME_DIAGNOSTICS_VIRTUAL_VISIBLE_END_INDEX] = count_word(self.virtual_visible.1);
        words[FRAME_DIAGNOSTICS_VIRTUAL_MATERIALIZED_START_INDEX] =
            count_word(self.virtual_materialized.0);
        words[FRAME_DIAGNOSTICS_VIRTUAL_MATERIALIZED_END_INDEX] =
            count_word(self.virtual_materialized.1);
        words[FRAME_DIAGNOSTICS_SKIPPED_INSTRUCTIONS_INDEX] =
            count_u64_word(self.skipped_instructions);
        words[FRAME_DIAGNOSTICS_PRODUCER_ABI_VERSION_INDEX] = self.producer_abi_version;
        words[FRAME_DIAGNOSTICS_INTERACTION_STATE_CHANGES_INDEX] =
            count_u64_word(self.interaction_state_changes);
        words[FRAME_DIAGNOSTICS_ANIMATION_ACTIVE_INDEX] = count_u64_word(self.animation_active);
        words[FRAME_DIAGNOSTICS_ANIMATION_PHASE_BEFORE_INDEX] =
            count_u64_word(self.animation_phase_before);
        words[FRAME_DIAGNOSTICS_ANIMATION_PHASE_ACTIVE_INDEX] =
            count_u64_word(self.animation_phase_active);
        words[FRAME_DIAGNOSTICS_ANIMATION_PHASE_AFTER_INDEX] =
            count_u64_word(self.animation_phase_after);
        words[FRAME_DIAGNOSTICS_ANIMATION_STARTS_INDEX] = count_u64_word(self.animation_starts);
        words[FRAME_DIAGNOSTICS_ANIMATION_RETARGETS_INDEX] =
            count_u64_word(self.animation_retargets);
        words[FRAME_DIAGNOSTICS_ANIMATION_CANCELS_INDEX] = count_u64_word(self.animation_cancels);
        words[FRAME_DIAGNOSTICS_ANIMATION_SAMPLED_FRAMES_INDEX] =
            count_u64_word(self.animation_sampled_frames);
        words[FRAME_DIAGNOSTICS_ANIMATION_PRESENTATION_CHANGES_INDEX] =
            count_u64_word(self.animation_presentation_changes);
        words[FRAME_DIAGNOSTICS_ANIMATION_LAYOUT_NODES_INDEX] =
            count_u64_word(self.animation_layout_nodes);
        words[FRAME_DIAGNOSTICS_ANIMATION_RETAINED_BYTES_INDEX] =
            count_u64_word(self.animation_retained_bytes);
        words[FRAME_DIAGNOSTICS_PICTURE_DEFINES_INDEX] = count_u64_word(self.picture_defines);
        words[FRAME_DIAGNOSTICS_PICTURE_RELEASES_INDEX] = count_u64_word(self.picture_releases);
        words[FRAME_DIAGNOSTICS_PICTURE_RESIDENT_COUNT_INDEX] =
            count_word(self.picture_resident_count);
        words[FRAME_DIAGNOSTICS_PICTURE_RESIDENT_BYTES_INDEX] =
            count_word(self.picture_resident_bytes);
        words[FRAME_DIAGNOSTICS_PICTURE_RESOURCE_BYTES_INDEX] =
            count_word(self.picture_resource_bytes);
        words[FRAME_DIAGNOSTICS_PICTURE_BUDGET_FALLBACKS_INDEX] =
            count_u64_word(self.picture_budget_fallbacks);
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
    animation: AnimationController,
    text: CoreTextSystem,
    editing: EditingController,
    hit: HitIndex,
    pending_events: Vec<u8>,
    pending_picture_resources: Arc<[u8]>,
    pending_picture_frame_seq: Option<u32>,
    pointer_gesture: Option<PointerGesture>,
    interaction: InteractionController,
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
    allowed_axes: [bool; 2],
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

/// Reads one already-validated key command into its routing input.
fn key_input(command: &InputCommand) -> KeyEventInput {
    let InputCommand::DispatchKeyEvent {
        event_id,
        kind,
        flags,
        key_code,
        key_name,
        key_text,
        modifiers,
        elapsed_micros,
    } = command
    else {
        unreachable!("caller matched a key command")
    };
    KeyEventInput {
        event_id: *event_id,
        kind: *kind,
        flags: *flags,
        key_code: *key_code,
        key_name: *key_name,
        key_text: *key_text,
        modifiers: *modifiers,
        elapsed_micros: *elapsed_micros,
    }
}

fn collect_event_commands(batch: &InputBatch) -> Result<Vec<InteractionCommand>, CoreError> {
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
                pointer_type,
                is_primary,
                pressure,
                tilt,
                contact_size,
            } => Some(Ok(InteractionCommand::Dispatch(PointerEventInput {
                event_id: *event_id,
                kind: *kind,
                flags: *flags,
                position: *position,
                delta: *delta,
                buttons: *buttons,
                modifiers: *modifiers,
                pointer_id: *pointer_id,
                elapsed_micros: *elapsed_micros,
                pointer_type: *pointer_type,
                is_primary: *is_primary,
                pressure: *pressure,
                tilt: *tilt,
                contact_size: *contact_size,
            }))),
            InputCommand::DispatchKeyEvent { .. } => Some(Ok(InteractionCommand::DispatchKey(
                key_input(&instruction.command),
            ))),
            InputCommand::SetPointerCapture {
                event_id,
                pointer_id,
                node_id,
            } => Some(NodeId::from_raw(*node_id).map_or_else(
                |error| Err(CoreError::Scene(error)),
                |node| {
                    Ok(InteractionCommand::SetPointerCapture {
                        event_id: *event_id,
                        pointer_id: *pointer_id,
                        node,
                    })
                },
            )),
            InputCommand::ReleasePointerCapture {
                event_id,
                pointer_id,
                node_id,
            } => Some(NodeId::from_raw(*node_id).map_or_else(
                |error| Err(CoreError::Scene(error)),
                |node| {
                    Ok(InteractionCommand::ReleasePointerCapture {
                        event_id: *event_id,
                        pointer_id: *pointer_id,
                        node,
                    })
                },
            )),
            InputCommand::FocusNode {
                event_id,
                node_id,
                origin,
            } => Some(NodeId::from_raw(*node_id).map_or_else(
                |error| Err(CoreError::Scene(error)),
                |node| {
                    Ok(InteractionCommand::Focus {
                        event_id: *event_id,
                        node,
                        origin: *origin,
                    })
                },
            )),
            InputCommand::BlurNode { event_id, node_id } => {
                Some(NodeId::from_raw(*node_id).map_or_else(
                    |error| Err(CoreError::Scene(error)),
                    |node| {
                        Ok(InteractionCommand::Blur {
                            event_id: *event_id,
                            node,
                        })
                    },
                ))
            }
            InputCommand::ResetInteraction { event_id, reason } => {
                Some(Ok(InteractionCommand::Reset {
                    event_id: *event_id,
                    reason: *reason,
                }))
            }
            _ => None,
        })
        .collect()
}

/// Finds the caret stop matching a UTF-16 offset, or the nearest one.
fn caret_stop_at(carets: &[pingo_text::CaretStop], offset: u32) -> Option<&pingo_text::CaretStop> {
    carets
        .iter()
        .min_by_key(|caret| caret.utf16_offset.abs_diff(offset))
}

/// Picks the caret stop on one visual line whose X is nearest to a column.
fn nearest_offset_in_line(
    carets: &[pingo_text::CaretStop],
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
fn nearest_caret_offset(carets: &[pingo_text::CaretStop], local: HitPoint) -> u32 {
    let line_distance = |caret: &pingo_text::CaretStop| -> f32 {
        if local.y >= caret.y && local.y < caret.y + caret.height {
            0.0
        } else if local.y < caret.y {
            caret.y - local.y
        } else {
            local.y - (caret.y + caret.height)
        }
    };
    let mut best: Option<(&pingo_text::CaretStop, f32, f32)> = None;
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
    command: &PointerEventInput,
    wheel_scroll_nodes: &[NodeId],
    drag_scroll_node: Option<NodeId>,
    touch_action: StyleKeyword,
) -> Result<bool, CoreError> {
    let mut scroll_changed = false;
    match command.kind {
        InputEventKind::Wheel => {
            for (index, scroll_node) in wheel_scroll_nodes.iter().copied().enumerate() {
                let behavior = candidate_scene
                    .presented_style_keyword(scroll_node, StyleProperty::OverscrollBehavior)
                    .unwrap_or(StyleKeyword::Auto);
                let can_scroll = candidate_scroll.can_scroll_delta(scroll_node, command.delta)?;
                let terminal = index + 1 == wheel_scroll_nodes.len();
                if !can_scroll && behavior == StyleKeyword::Auto && !terminal {
                    continue;
                }
                if !can_scroll && behavior == StyleKeyword::None {
                    break;
                }
                scroll_changed |= candidate_scroll
                    .apply_wheel(
                        candidate_scene,
                        scroll_node,
                        command.delta,
                        command.elapsed_micros,
                        command.flags & EVENT_FLAG_PRECISE_WHEEL != 0,
                        behavior != StyleKeyword::None,
                    )?
                    .changed;
                break;
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
                    allowed_axes: default_scroll_axes(command.pointer_type, touch_action),
                });
            }
        }
        InputEventKind::PointerMove => {
            scroll_changed |= apply_pointer_move_scroll(
                candidate_scene,
                candidate_scroll,
                candidate_gesture,
                command,
            )?;
        }
        InputEventKind::PointerUp
        | InputEventKind::PointerCancel
        | InputEventKind::PointerLeave => {
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

fn apply_pointer_move_scroll(
    scene: &mut Scene,
    scroll: &mut ScrollController,
    candidate_gesture: &mut Option<PointerGesture>,
    command: &PointerEventInput,
) -> Result<bool, CoreError> {
    let Some(mut gesture) = *candidate_gesture else {
        return Ok(false);
    };
    if gesture.pointer_id != command.pointer_id {
        return Ok(false);
    }
    let raw_delta = [
        gesture.last_position[0] - command.position[0],
        gesture.last_position[1] - command.position[1],
    ];
    let drag_delta = [
        if gesture.allowed_axes[0] {
            raw_delta[0]
        } else {
            0.0
        },
        if gesture.allowed_axes[1] {
            raw_delta[1]
        } else {
            0.0
        },
    ];
    let mut behavior = scene
        .presented_style_keyword(gesture.scroll_node, StyleProperty::OverscrollBehavior)
        .unwrap_or(StyleKeyword::Auto);
    if behavior == StyleKeyword::Auto
        && !scroll.can_scroll_delta(gesture.scroll_node, drag_delta)?
        && let Some(ancestor) = scroll_ancestor(scene, gesture.scroll_node)
    {
        scroll.end_direct(gesture.scroll_node, false)?;
        scroll.begin_direct(ancestor)?;
        gesture.scroll_node = ancestor;
        behavior = scene
            .presented_style_keyword(ancestor, StyleProperty::OverscrollBehavior)
            .unwrap_or(StyleKeyword::Auto);
    }
    let changed = scroll
        .direct_delta(
            scene,
            gesture.scroll_node,
            drag_delta,
            command.elapsed_micros,
            behavior != StyleKeyword::None,
        )?
        .changed;
    gesture.last_position = command.position;
    *candidate_gesture = Some(gesture);
    Ok(changed)
}

fn scroll_ancestor(scene: &Scene, node: NodeId) -> Option<NodeId> {
    let mut current = scene.parent(node);
    while let Some(candidate) = current {
        if scene.is_scroll_container(candidate) {
            return Some(candidate);
        }
        current = scene.parent(candidate);
    }
    None
}

fn default_scroll_axes(pointer_type: InputPointerType, touch_action: StyleKeyword) -> [bool; 2] {
    if pointer_type != InputPointerType::Touch {
        return [true, true];
    }
    match touch_action {
        StyleKeyword::None => [false, false],
        StyleKeyword::PanX => [true, false],
        StyleKeyword::PanY => [false, true],
        _ => [true, true],
    }
}

impl CoreEngine {
    /// Creates an empty Core with finite logical-pixel viewport bounds.
    ///
    /// # Errors
    ///
    /// Returns [`CoreError::InvalidViewport`] for negative or non-finite bounds.
    pub fn new(width: f32, height: f32) -> Result<Self, CoreError> {
        Self::for_platform(width, height, ScrollPlatform::Ios)
    }

    /// Creates an engine whose scroll physics match one platform family.
    ///
    /// The family decides coast distance and edge response, which is the most
    /// visible part of "feels native": the same release velocity travels about
    /// three times further on iOS than on Android. The host picks it from the
    /// device rather than the engine assuming one.
    ///
    /// # Errors
    ///
    /// Returns a viewport validation error for a non-positive or non-finite
    /// dimension.
    pub fn for_platform(
        width: f32,
        height: f32,
        platform: ScrollPlatform,
    ) -> Result<Self, CoreError> {
        let constraints = viewport_constraints(width, height)?;
        Ok(Self {
            scene: Scene::new(),
            layout: LayoutEngine::new(),
            paint: PaintEngine::new(),
            scroll: ScrollController::for_platform(platform),
            animation: AnimationController::default(),
            text: CoreTextSystem::default(),
            editing: EditingController::default(),
            hit: HitIndex::default(),
            pending_events: Vec::new(),
            pending_picture_resources: Arc::from([]),
            pending_picture_frame_seq: None,
            pointer_gesture: None,
            interaction: InteractionController::default(),
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
        let (batch, report) = match MutationBatch::decode_with_report(bytes) {
            Ok(decoded) => decoded,
            Err(error) => {
                self.metrics.abi_rejections += 1;
                return Err(CoreError::Abi(error));
            }
        };
        self.note_decode_report(report);
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
        self.reconcile_interaction_after_commit()?;

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
        self.text
            .set_non_wrapping(self.editing.non_wrapping_nodes());
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
        self.synchronize_animations()?;
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

    fn synchronize_animations(&mut self) -> Result<(), CoreError> {
        self.animation.begin_frame();
        if let Err(error) = self
            .animation
            .synchronize(&mut self.scene, self.layout.snapshot())
        {
            return self.poison(error);
        }
        if let Err(error) = self.animation.advance(&mut self.scene, 0.0) {
            return self.poison(error);
        }
        Ok(())
    }

    /// Overrides the host reduced-motion preference for deterministic testing
    /// and accessibility changes.
    ///
    /// # Errors
    ///
    /// Returns a paint failure after the first committed frame, or a poisoned
    /// instance error after a prior derived-state failure.
    pub fn set_reduced_motion(&mut self, reduced: bool) -> Result<Option<FrameOutput>, CoreError> {
        if self.poisoned {
            return Err(CoreError::Poisoned);
        }
        self.animation.begin_frame();
        self.animation.set_reduced_motion(reduced);
        let (changed, _) = self.animation.advance(&mut self.scene, 0.0)?;
        if !changed {
            return Ok(None);
        }
        let frame_seq = self
            .last_frame_seq
            .ok_or(CoreError::MissingCommittedFrame)?;
        self.paint_frame(frame_seq, &BitSet::with_len(self.scene.len()), 0, false)
            .map(Some)
    }

    fn reconcile_interaction_after_commit(&mut self) -> Result<(), CoreError> {
        let interaction = self.interaction.reconcile_scene(&mut self.scene);
        if interaction.records.is_empty() {
            return Ok(());
        }
        self.pending_events = EventTransactionBatch {
            records: interaction.records,
        }
        .encode()
        .map_err(CoreError::EventTransactions)?;
        Ok(())
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

    /// Records what a decoder had to tolerate to read a stream.
    fn note_decode_report(&mut self, report: pingo_abi::DecodeReport) {
        self.metrics.skipped_instructions = self
            .metrics
            .skipped_instructions
            .saturating_add(u64::from(report.skipped_instructions));
        self.metrics.producer_abi_version = self
            .metrics
            .producer_abi_version
            .max(u32::from(report.producer_abi_version));
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
        let (batch, report) = match InputBatch::decode_with_report(bytes) {
            Ok(decoded) => decoded,
            Err(error) => {
                self.metrics.input_rejections = self.metrics.input_rejections.saturating_add(1);
                return Err(CoreError::Abi(error));
            }
        };
        self.note_decode_report(report);
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
        let event_commands = match collect_event_commands(&batch) {
            Ok(commands) => commands,
            Err(error) => {
                self.metrics.input_rejections = self.metrics.input_rejections.saturating_add(1);
                return Err(error);
            }
        };
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
        boundaries: &HashMap<NodeId, Vec<u32>>,
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
        let mut local = geometry
            .to_local(HitPoint {
                x: position[0],
                y: position[1],
            })
            .ok_or(CoreError::InvalidEditableTarget { node })?;
        // The value is painted shifted by minus the editor's own scroll, so a
        // canvas point maps back into content space by adding it.
        let [scroll_x, scroll_y] = self.editing.scroll_offset(node);
        local.x += scroll_x;
        local.y += scroll_y;
        let offset = nearest_caret_offset(&carets, local);
        let (anchor, focus) = if flags & 0x02 != 0 {
            // UAX #29 has no dictionary, so it makes every Han ideograph its own
            // word and a double click selects one character. Use the Host's
            // segmentation when it describes this exact revision.
            match boundaries.get(&node).and_then(|offsets| {
                word_range_from_boundaries(offsets, offset, session.text_index().utf16_len())
            }) {
                Some(range) => range,
                None => {
                    pingo_edit::word_range_utf16(session.text(), offset).map_err(CoreError::Edit)?
                }
            }
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

    /// Keeps the active caret inside the editor's own box.
    ///
    /// An editable clips to its box and the fallback text path does not wrap, so
    /// a value wider than the field would put the caret outside the clip and
    /// make typing invisible. This is the field's own scroll, applied inside the
    /// clip; `caret_reveal_target` is the separate job of bringing the whole
    /// field into an ancestor viewport.
    ///
    /// Runs against the layout the frame is about to paint, so the offset never
    /// describes a box the caret has already left.
    fn reveal_caret_in_editor(&mut self) -> bool {
        let Some(visual) = self.editing.active_visual() else {
            return false;
        };
        let node = visual.node;
        let Some((_, size)) = self.layout.snapshot().geometry(node) else {
            return false;
        };
        let Some(carets) = self
            .text
            .editor_caret_stops(&self.scene, node)
            .filter(|carets| !carets.is_empty())
        else {
            return false;
        };
        let Some(caret) = closest_editor_caret(&carets, visual.selection[1]) else {
            return false;
        };
        let [mut offset_x, mut offset_y] = visual.scroll_offset;
        // The caret is one and a half logical pixels wide and is drawn from its
        // stop, so the right edge has to fit as well as the left.
        let caret_right = caret.x + CARET_WIDTH;
        if caret_right - offset_x > size.width {
            offset_x = caret_right - size.width;
        }
        if caret.x - offset_x < 0.0 {
            offset_x = caret.x;
        }
        let caret_bottom = caret.y + caret.height;
        if caret_bottom - offset_y > size.height {
            offset_y = caret_bottom - size.height;
        }
        if caret.y - offset_y < 0.0 {
            offset_y = caret.y;
        }
        // Never scroll past the start: an empty or short value must sit flush.
        offset_x = offset_x.max(0.0);
        offset_y = offset_y.max(0.0);
        self.editing.set_scroll_offset(node, [offset_x, offset_y])
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
        let caret = editor_range_rect(
            &carets,
            [focus, focus],
            geometry,
            self.editing.scroll_offset(node),
        )?;
        let mut ancestor = self.scene.parent(node);
        while let Some(candidate) = ancestor {
            if self.scene.is_scroll_container(candidate) {
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
        // Collected up front and used only within this batch. The Host sends
        // them with the operation that needs them, so there is no stored table
        // to go stale between batches.
        let boundaries = self.collect_word_boundaries(batch);
        let mut edit_commands = Vec::new();
        for instruction in batch.instructions.iter().filter(|instruction| {
            !is_scroll_command(&instruction.command)
                && !matches!(instruction.command, InputCommand::SetWordBoundaries { .. })
        }) {
            let resolved = match instruction.command {
                InputCommand::PlaceCaret {
                    node_id,
                    position,
                    flags,
                } => {
                    *desired_x = None;
                    self.resolve_place_caret(node_id, position, flags, &boundaries)?
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

    /// Reads the batch's dictionary word boundaries, dropping any that are stale.
    ///
    /// The Host segments its own copy of the value, which can be a revision
    /// behind the session. Applying those would select against text the user has
    /// already changed, so a mismatch falls back to UAX #29 instead.
    fn collect_word_boundaries(&self, batch: &InputBatch) -> HashMap<NodeId, Vec<u32>> {
        let mut collected = HashMap::new();
        for instruction in &batch.instructions {
            let InputCommand::SetWordBoundaries {
                node_id,
                base_revision,
                ref boundaries,
            } = instruction.command
            else {
                continue;
            };
            let Ok(node) = NodeId::from_raw(node_id) else {
                continue;
            };
            // Segmentation depends only on the text, so it stays valid across
            // selection and composition revisions: gating on the full revision
            // made every boundary batch racing an unacknowledged caret click
            // stale, and the fallback then selected a single ideograph.
            if self.editing.session(node).is_some_and(|session| {
                base_revision >= session.text_revision() && base_revision <= session.revision()
            }) {
                collected.insert(node, boundaries.clone());
            }
        }
        collected
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
                                pingo_edit::TextIndex::new(text).map_err(CoreError::Edit)?;
                            if forward {
                                index.next(focus).map_err(CoreError::Edit)?
                            } else {
                                index.previous(focus).map_err(CoreError::Edit)?
                            }
                        }
                        CaretGranularity::Word => {
                            pingo_edit::word_boundary_utf16(text, focus, forward)
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
        event_commands: &[InteractionCommand],
    ) -> Result<Option<FrameOutput>, CoreError> {
        let mut candidate_scene = self.scene.clone();
        let mut candidate_scroll = self.scroll.clone();
        let mut candidate_gesture = self.pointer_gesture;
        let mut candidate_interaction = self.interaction.clone();
        let mut candidate_animation = self.animation.clone();
        let mut scroll_changed = false;
        let mut state_changes = 0_usize;
        let mut records = Vec::with_capacity(event_commands.len());
        for command in event_commands {
            let InteractionCommand::Dispatch(input) = command else {
                let mut result = candidate_interaction.apply(&mut candidate_scene, *command, None);
                annotate_event_cursors(&candidate_scene, &mut result.records);
                state_changes = state_changes.saturating_add(result.state_changes);
                records.extend(result.records);
                continue;
            };
            let (hit_path, hit_scroll_nodes, editable_is_deeper) = self.event_hit_context(input);
            let hit_scroll_node = hit_scroll_nodes.first().copied();
            let touch_action = hit_path
                .as_ref()
                .and_then(|path| path.last())
                .and_then(|node| {
                    candidate_scene.presented_style_keyword(*node, StyleProperty::TouchAction)
                })
                .unwrap_or(StyleKeyword::Auto);
            scroll_changed |= apply_event_scroll(
                &mut candidate_scene,
                &mut candidate_scroll,
                &mut candidate_gesture,
                input,
                &hit_scroll_nodes,
                if editable_is_deeper {
                    None
                } else {
                    hit_scroll_node
                },
                touch_action,
            )?;
            let mut result = candidate_interaction.apply(
                &mut candidate_scene,
                InteractionCommand::Dispatch(*input),
                hit_path,
            );
            annotate_event_cursors(&candidate_scene, &mut result.records);
            state_changes = state_changes.saturating_add(result.state_changes);
            records.extend(result.records);
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
        candidate_animation.begin_frame();
        if let Err(error) =
            candidate_animation.synchronize(&mut candidate_scene, self.layout.snapshot())
        {
            return self.poison(error);
        }
        if let Err(error) = candidate_animation.advance(&mut candidate_scene, 0.0) {
            return self.poison(error);
        }
        let interaction_render_changed = interaction_render_changed(&candidate_scene);
        self.scene = candidate_scene;
        self.scroll = candidate_scroll;
        self.pointer_gesture = candidate_gesture;
        self.interaction = candidate_interaction;
        self.animation = candidate_animation;
        self.last_input_sequence = Some(frame_seq);
        self.metrics.accepted_input_batches = self.metrics.accepted_input_batches.saturating_add(1);
        self.metrics.interaction_state_changes = self
            .metrics
            .interaction_state_changes
            .saturating_add(u64::try_from(state_changes).unwrap_or(u64::MAX));
        let output = if scroll_changed || interaction_render_changed {
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

    fn event_hit_context(
        &self,
        input: &PointerEventInput,
    ) -> (Option<Vec<NodeId>>, Vec<NodeId>, bool) {
        let hit = self.hit.hit(
            &self.scene,
            HitPoint {
                x: input.position[0],
                y: input.position[1],
            },
        );
        let scroll_nodes = hit.as_ref().map_or_else(Vec::new, |result| {
            result
                .path
                .iter()
                .rev()
                .copied()
                .filter(|node| self.scene.is_scroll_container(*node))
                .collect()
        });
        let editable_is_deeper = hit.as_ref().is_some_and(|result| {
            let scroll = result
                .path
                .iter()
                .rposition(|node| self.scene.is_scroll_container(*node));
            let editable = result
                .path
                .iter()
                .rposition(|node| self.scene.kind(*node) == Some(NodeKind::EditableText));
            matches!((scroll, editable), (Some(scroll), Some(editable)) if editable > scroll)
                || matches!((scroll, editable), (None, Some(_)))
        });
        (
            hit.map(|result| result.path),
            scroll_nodes,
            editable_is_deeper,
        )
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
        self.text
            .set_non_wrapping(self.editing.non_wrapping_nodes());
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
        self.animation.begin_frame();
        let outcome = self.scroll.advance(&mut self.scene, elapsed_seconds)?;
        let (animation_changed, _animation_active) =
            match self.animation.advance(&mut self.scene, elapsed_seconds) {
                Ok(outcome) => outcome,
                Err(error) => return self.poison(error),
            };
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
        if !outcome.changed && !caret_changed && !animation_changed {
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
    pub fn set_viewport(
        &mut self,
        width: f32,
        height: f32,
    ) -> Result<Option<FrameOutput>, CoreError> {
        if self.poisoned {
            return Err(CoreError::Poisoned);
        }
        if self.text.has_pending_resources() {
            return Err(CoreError::GlyphResourcesNotDrained);
        }
        let next = viewport_constraints(width, height)?;
        if next == self.constraints {
            return Ok(None);
        }
        self.constraints = next;
        // Constraints alone change nothing on screen. Layout has to run again
        // against them and the frame has to be rebuilt, or the canvas keeps
        // showing content measured for the old box -- clipped at the new one
        // rather than reflowed into it.
        let Some(frame_seq) = self.last_frame_seq else {
            return Ok(None);
        };
        self.text.begin_frame();
        let geometry = match self.layout.layout_with_virtual(
            &self.scene,
            self.constraints,
            &mut self.text,
            &self.scroll,
        ) {
            Ok(outcome) => outcome,
            Err(error) => return self.poison(CoreError::Layout(error)),
        };
        let output = self.paint_frame(frame_seq, &geometry.changed, geometry.visited, true)?;
        if let Err(error) = self.text.commit_frame() {
            return self.poison(CoreError::GlyphResources(error));
        }
        Ok(Some(output))
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

    /// Selects incremental Picture resources or the inline rollback builder.
    ///
    /// # Errors
    ///
    /// Refuses a path change while a previous Picture transaction awaits Host
    /// acknowledgement, preserving publish/release ordering.
    pub fn set_incremental_pictures_enabled(&mut self, enabled: bool) -> Result<(), CoreError> {
        if !self.pending_picture_resources.is_empty() {
            return Err(CoreError::PictureResourcesNotAcknowledged);
        }
        self.paint.set_incremental_pictures_enabled(enabled);
        Ok(())
    }

    /// Returns the pending Picture resource transaction without acknowledging it.
    #[must_use]
    pub fn take_picture_resources(&self) -> Vec<u8> {
        self.pending_picture_resources.to_vec()
    }

    /// Acknowledges successful backend installation of the pending Picture transaction.
    ///
    /// # Errors
    ///
    /// Rejects absent or stale frame sequences so delayed acknowledgements cannot
    /// release a newer generation.
    pub fn acknowledge_picture_resources(&mut self, frame_seq: u32) -> Result<(), CoreError> {
        if self.pending_picture_frame_seq != Some(frame_seq) {
            return Err(CoreError::PictureResourceAcknowledgementMismatch);
        }
        self.pending_picture_resources = Arc::from([]);
        self.pending_picture_frame_seq = None;
        Ok(())
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
            pingo_abi::EditTransactionBatch::decode(&bytes).map_or(0, |batch| batch.records.len())
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
                self.scene.is_scroll_container(*node)
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
        let editing_focused = self.editing.active_visual().map(|visual| visual.node);
        for &node in self.scene.ids() {
            if self.scene.excluded_by_display(node) || !self.scene.visible(node) {
                continue;
            }
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
            let focusable = editable || role == Some("button");
            let focused = editing_focused == Some(node)
                || self.scene.interaction_state(node) & pingo_abi::STYLE_INTERACTION_FOCUS != 0;
            if editable && value.is_none() {
                let password = self.editing.session_is_password(node).unwrap_or(false);
                if !password {
                    value = self
                        .editing
                        .session(node)
                        .map(pingo_edit::EditSession::text);
                }
            }
            let flags = u32::from(focusable)
                | (u32::from(focused) << 1)
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
        let scroll = self.editing.scroll_offset(visual.node);
        let selection_rect =
            editor_range_rect(&carets, selection, geometry, scroll).unwrap_or(WorldRect {
                left: control.left,
                top: control.top,
                right: control.left,
                bottom: control.top,
            });
        let requested = self
            .requested_character_range
            .filter(|(node, _)| *node == visual.node)
            .map_or([0, 0], |(_, range)| range);
        let characters = editor_character_rects(&carets, requested, geometry, scroll);
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
        // Scrolling the value inside its own box moves every glyph in the node,
        // so the subtree cache cannot be trusted for that frame.
        let force_full_paint = force_full_paint | self.reveal_caret_in_editor();
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
        let animation_metrics = self.animation.metrics();
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
            virtual_visible: self.scroll.visible_item_range(),
            virtual_materialized: self.scroll.materialized_range(),
            skipped_instructions: self.metrics.skipped_instructions,
            producer_abi_version: self.metrics.producer_abi_version,
            interaction_state_changes: self.metrics.interaction_state_changes,
            animation_active: animation_metrics.active,
            animation_phase_before: animation_metrics.phase_before,
            animation_phase_active: animation_metrics.phase_active,
            animation_phase_after: animation_metrics.phase_after,
            animation_starts: animation_metrics.started,
            animation_retargets: animation_metrics.retargeted,
            animation_cancels: animation_metrics.cancelled,
            animation_sampled_frames: animation_metrics.sampled_frames,
            animation_presentation_changes: animation_metrics.presentation_changes,
            animation_layout_nodes: animation_metrics.layout_nodes,
            animation_retained_bytes: animation_metrics.retained_bytes,
            picture_defines: paint_metrics.picture_defines,
            picture_releases: paint_metrics.picture_releases,
            picture_resident_count: paint_metrics.picture_resident_count,
            picture_resident_bytes: paint_metrics.picture_resident_bytes,
            picture_resource_bytes: paint_metrics.picture_resource_bytes,
            picture_budget_fallbacks: paint_metrics.picture_budget_fallbacks,
        };
        if !painted.picture_resources.is_empty() {
            self.pending_picture_resources = painted.picture_resources.clone();
            self.pending_picture_frame_seq = Some(frame_seq);
        }
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
        nodes: &[pingo_scene::NodeId],
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
        if !self.pending_picture_resources.is_empty() {
            return Err(CoreError::PictureResourcesNotAcknowledged);
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

fn interaction_render_changed(scene: &Scene) -> bool {
    [
        DirtyDomain::Layout,
        DirtyDomain::Paint,
        DirtyDomain::PaintSelf,
        DirtyDomain::Hit,
        DirtyDomain::Semantics,
    ]
    .into_iter()
    .any(|domain| scene.dirty(domain).iter_ones().next().is_some())
}

fn annotate_event_cursors(scene: &Scene, records: &mut [EventTransactionRecord]) {
    for record in records {
        let raw_target = if matches!(
            record.kind,
            InputEventKind::PointerOut | InputEventKind::PointerLeave
        ) && record.related_target != NULL_NODE_ID
        {
            record.related_target
        } else {
            record.target
        };
        let Ok(target) = NodeId::from_raw(raw_target) else {
            record.cursor = StyleKeyword::Auto;
            continue;
        };
        record.cursor = scene
            .presented_style_keyword(target, StyleProperty::Cursor)
            .filter(|cursor| {
                matches!(
                    cursor,
                    StyleKeyword::Auto
                        | StyleKeyword::Crosshair
                        | StyleKeyword::Default
                        | StyleKeyword::Grab
                        | StyleKeyword::Grabbing
                        | StyleKeyword::NotAllowed
                        | StyleKeyword::Pointer
                        | StyleKeyword::Text
                )
            })
            .unwrap_or(StyleKeyword::Auto);
    }
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
            | InputCommand::SetScrollVelocity { .. }
            | InputCommand::ScrollTo { .. }
            | InputCommand::ScrollBy { .. }
    )
}

fn is_newer_sequence(candidate: u32, previous: u32) -> bool {
    let delta = candidate.wrapping_sub(previous);
    delta != 0 && delta < (1_u32 << 31)
}

fn system_text_nodes(scene: &Scene, pairs: &[(u32, u32)]) -> Vec<pingo_scene::NodeId> {
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

/// Resolves an offset against ascending word-start offsets.
///
/// `boundaries` are word starts, so the word containing `offset` runs from the
/// last start at or before it to the next start, or to the end of the value.
fn word_range_from_boundaries(boundaries: &[u32], offset: u32, length: u32) -> Option<(u32, u32)> {
    if boundaries.is_empty() {
        return None;
    }
    let start = boundaries
        .iter()
        .rev()
        .find(|candidate| **candidate <= offset)
        .copied()
        .unwrap_or(0);
    let end = boundaries
        .iter()
        .find(|candidate| **candidate > start)
        .copied()
        .unwrap_or(length);
    (start < end).then_some((start, end))
}

/// Caret bar width in logical pixels, shared by paint, geometry and reveal.
const CARET_WIDTH: f32 = 1.5;

fn editor_range_rect(
    carets: &[pingo_text::CaretStop],
    range: [u32; 2],
    geometry: WorldGeometry,
    scroll: [f32; 2],
) -> Option<WorldRect> {
    let first = closest_editor_caret(carets, range[0])?;
    let last = closest_editor_caret(carets, range[1])?;
    if range[0] == range[1] {
        return Some(transform_local_rect(
            geometry,
            scrolled([first.x, first.y, CARET_WIDTH, first.height], scroll),
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
        let world = transform_local_rect(geometry, scrolled(local, scroll));
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
    carets: &[pingo_text::CaretStop],
    requested: [u32; 2],
    geometry: WorldGeometry,
    scroll: [f32; 2],
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
            [pair[0].x, pair[0].y, CARET_WIDTH, pair[0].height]
        };
        result.push((
            [start, end],
            transform_local_rect(geometry, scrolled(local, scroll)),
        ));
    }
    result
}

fn closest_editor_caret(
    carets: &[pingo_text::CaretStop],
    offset: u32,
) -> Option<pingo_text::CaretStop> {
    carets
        .iter()
        .copied()
        .min_by_key(|caret| (i64::from(caret.utf16_offset) - i64::from(offset)).unsigned_abs())
}

/// Moves a content-space rectangle into the editor's painted position.
fn scrolled(rect: [f32; 4], scroll: [f32; 2]) -> [f32; 4] {
    [rect[0] - scroll[0], rect[1] - scroll[1], rect[2], rect[3]]
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

    use pingo_abi::{
        DisplayCommand, DisplayList, EVENT_FLAG_PRECISE_WHEEL, EditTransactionBatch,
        EventTransactionBatch, GlyphResourceBatch, GlyphResourceCommand, InputBatch, InputCommand,
        InputEventKind, InputInstruction, InputPointerType, Mutation, MutationBatch,
        MutationInstruction, NON_PASSIVE_REGION_HEADER_REGION_COUNT_INDEX,
        NON_PASSIVE_REGION_HEADER_VERSION_INDEX, NON_PASSIVE_REGION_HEADER_WORDS,
        NON_PASSIVE_REGION_RECORD_BOTTOM_BITS_INDEX, NON_PASSIVE_REGION_RECORD_FLAGS_INDEX,
        NON_PASSIVE_REGION_RECORD_LEFT_BITS_INDEX, NON_PASSIVE_REGION_RECORD_RIGHT_BITS_INDEX,
        NON_PASSIVE_REGION_RECORD_TOP_BITS_INDEX, NON_PASSIVE_REGION_VERSION, NULL_NODE_ID,
        NodeKind, PictureResourceBatch, Prop, RESOURCE_ENCODING_VERSION, ReplayRecord,
        ReplayRecording, ResourceKind, SFNT_FONT_DATA_BYTES_OFFSET, SFNT_FONT_DATA_OFFSET,
        SFNT_FONT_FACE_INDEX_OFFSET, SFNT_FONT_RESOURCE_VARIANT, SFNT_FONT_VARIANT_OFFSET,
        SFNT_FONT_VERSION_OFFSET, STYLE_ALL_FEATURE_BITS, STYLE_COMPUTED_ENCODING_VARIANT,
        STYLE_COMPUTED_ENCODING_VERSION, STYLE_VALUE_F32, STYLE_VALUE_KEYWORD, StyleKeyword,
        StyleProperty, SystemTextMetric, SystemTextMetricBatch, SystemTextMetricCommand,
        SystemTextMetricInstruction,
    };
    use pingo_edit::{EditConfig, EditSession, Selection};
    use pingo_headless::HeadlessRenderer;
    use pingo_paint::{AffineResource, SolidPaint, TextStyleResource};
    use pingo_scene::NodeId;

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

    fn computed_keyword(property: StyleProperty, keyword: StyleKeyword) -> Vec<u8> {
        let mut bytes = vec![0_u8; 28];
        bytes[0] = STYLE_COMPUTED_ENCODING_VERSION;
        bytes[1] = STYLE_COMPUTED_ENCODING_VARIANT;
        bytes[4..8].copy_from_slice(&STYLE_ALL_FEATURE_BITS.to_le_bytes());
        bytes[8..12].copy_from_slice(&1_u32.to_le_bytes());
        bytes[12..16].copy_from_slice(&12_u32.to_le_bytes());
        bytes[16..18].copy_from_slice(&(property as u16).to_le_bytes());
        bytes[19] = STYLE_VALUE_KEYWORD;
        bytes[20..22].copy_from_slice(&4_u16.to_le_bytes());
        bytes[24..26].copy_from_slice(&(keyword as u16).to_le_bytes());
        bytes
    }

    fn computed_f32(property: StyleProperty, value: f32) -> Vec<u8> {
        let mut bytes = vec![0_u8; 28];
        bytes[0] = STYLE_COMPUTED_ENCODING_VERSION;
        bytes[1] = STYLE_COMPUTED_ENCODING_VARIANT;
        bytes[4..8].copy_from_slice(&STYLE_ALL_FEATURE_BITS.to_le_bytes());
        bytes[8..12].copy_from_slice(&1_u32.to_le_bytes());
        bytes[12..16].copy_from_slice(&12_u32.to_le_bytes());
        bytes[16..18].copy_from_slice(&(property as u16).to_le_bytes());
        bytes[19] = STYLE_VALUE_F32;
        bytes[20..22].copy_from_slice(&4_u16.to_le_bytes());
        bytes[24..28].copy_from_slice(&value.to_le_bytes());
        bytes
    }

    fn opacity_transition_resource(duration_micros: u32) -> Vec<u8> {
        let mut bytes = vec![0_u8; 36];
        bytes[0] = 1;
        bytes[1] = 1;
        bytes[4..8].copy_from_slice(&36_u32.to_le_bytes());
        bytes[8] = 1;
        bytes[9] = 0;
        bytes[12..16].copy_from_slice(&duration_micros.to_le_bytes());
        bytes
    }

    fn opacity_keyframes_resource(duration_micros: u32) -> Vec<u8> {
        let mut bytes = vec![0_u8; 64];
        bytes[0] = 1;
        bytes[2] = 1;
        bytes[4..8].copy_from_slice(&64_u32.to_le_bytes());
        bytes[8] = 1;
        bytes[9] = 0;
        bytes[11] = 1;
        bytes[16..20].copy_from_slice(&duration_micros.to_le_bytes());
        bytes[24..28].copy_from_slice(&1.0_f32.to_le_bytes());
        bytes[28..30].copy_from_slice(&2_u16.to_le_bytes());
        bytes[48..52].copy_from_slice(&0.0_f32.to_le_bytes());
        bytes[52..56].copy_from_slice(&0.0_f32.to_le_bytes());
        bytes[56..60].copy_from_slice(&1.0_f32.to_le_bytes());
        bytes[60..64].copy_from_slice(&1.0_f32.to_le_bytes());
        bytes
    }

    fn transform_transition_resource(duration_micros: u32) -> Vec<u8> {
        let mut bytes = opacity_transition_resource(duration_micros);
        bytes[8] = 2;
        bytes
    }

    fn first_alpha(frame: &super::FrameOutput) -> Option<f32> {
        DisplayList::decode(&frame.display_list)
            .expect("display list")
            .instructions
            .iter()
            .find_map(|instruction| match instruction.command {
                DisplayCommand::Alpha(value) => Some(value),
                _ => None,
            })
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
                        font_style: StyleKeyword::Normal,
                        text_align: StyleKeyword::Start,
                        white_space: StyleKeyword::PreWrap,
                        overflow_wrap: StyleKeyword::Anywhere,
                        text_overflow: StyleKeyword::Clip,
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
                        font_style: StyleKeyword::Normal,
                        text_align: StyleKeyword::Start,
                        white_space: StyleKeyword::PreWrap,
                        overflow_wrap: StyleKeyword::Anywhere,
                        text_overflow: StyleKeyword::Clip,
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
                    font_style: StyleKeyword::Normal,
                    text_align: StyleKeyword::Start,
                    white_space: StyleKeyword::PreWrap,
                    overflow_wrap: StyleKeyword::Anywhere,
                    text_overflow: StyleKeyword::Clip,
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

    /// The same tree with an explicit box narrower than the value it holds.
    fn editable_tree_with_width(flags: u32, text: &str, width: f32) -> Vec<u8> {
        let mut batch = pingo_abi::MutationBatch::decode(&editable_tree_with_text(flags, text))
            .expect("decode");
        batch.instructions.push(instruction(Mutation::SetF32 {
            node_id: id(1),
            prop: Prop::Width,
            value: width,
        }));
        batch.encode().expect("encode")
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
                        font_style: StyleKeyword::Normal,
                        text_align: StyleKeyword::Start,
                        white_space: StyleKeyword::PreWrap,
                        overflow_wrap: StyleKeyword::Anywhere,
                        text_overflow: StyleKeyword::Clip,
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

    fn nested_scroll_tree(
        overscroll: Option<StyleKeyword>,
        touch_action: Option<StyleKeyword>,
    ) -> Vec<u8> {
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
                kind: NodeKind::Container,
                parent: id(1),
                before_sibling: NULL_NODE_ID,
            },
            Mutation::CreateNode {
                node_id: id(3),
                kind: NodeKind::Scroll,
                parent: id(2),
                before_sibling: NULL_NODE_ID,
            },
            Mutation::CreateNode {
                node_id: id(4),
                kind: NodeKind::Container,
                parent: id(3),
                before_sibling: NULL_NODE_ID,
            },
        ];
        for (node_id, width, height) in [
            (id(1), 100.0, 100.0),
            (id(2), 100.0, 500.0),
            (id(3), 100.0, 50.0),
            (id(4), 100.0, 200.0),
        ] {
            mutations.push(Mutation::SetF32 {
                node_id,
                prop: Prop::Width,
                value: width,
            });
            mutations.push(Mutation::SetF32 {
                node_id,
                prop: Prop::Height,
                value: height,
            });
        }
        if let Some(behavior) = overscroll {
            mutations.push(Mutation::DefineResource {
                resource_id: 20,
                kind: ResourceKind::ComputedStyle,
                bytes: computed_keyword(StyleProperty::OverscrollBehavior, behavior),
            });
            mutations.push(Mutation::SetRef {
                node_id: id(3),
                prop: Prop::ComputedStyle,
                resource_id: 20,
            });
        }
        if let Some(action) = touch_action {
            mutations.push(Mutation::DefineResource {
                resource_id: 21,
                kind: ResourceKind::ComputedStyle,
                bytes: computed_keyword(StyleProperty::TouchAction, action),
            });
            mutations.push(Mutation::SetRef {
                node_id: id(4),
                prop: Prop::ComputedStyle,
                resource_id: 21,
            });
        }
        mutations.push(Mutation::ScrollTo {
            node_id: id(3),
            x: 0.0,
            y: 150.0,
            behavior: 0,
        });
        frame(1, mutations)
    }

    /// Builds a virtual list sized like the playground's, so a refill window
    /// covers a hundred rows rather than a handful.
    fn sized_virtual_list_tree(viewport: f32, item_height: f32) -> Vec<u8> {
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
                    value: 640.0,
                },
                Mutation::SetF32 {
                    node_id: id(1),
                    prop: Prop::Height,
                    value: viewport,
                },
                Mutation::ConfigureVirtualList {
                    node_id: id(1),
                    item_count: 1_000_000,
                    estimated_item_size: item_height,
                    base_overscan_viewports: 1.0,
                    velocity_horizon_seconds: 0.25,
                    maximum_ahead_viewports: 4.0,
                    axis: pingo_abi::VirtualAxis::Y,
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
                    estimated_item_size: 20.0,
                    base_overscan_viewports: 1.0,
                    velocity_horizon_seconds: 0.25,
                    maximum_ahead_viewports: 4.0,
                    axis: pingo_abi::VirtualAxis::Y,
                },
            ],
        )
    }

    fn horizontal_virtual_list_tree() -> Vec<u8> {
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
                    value: 80.0,
                },
                Mutation::ConfigureVirtualList {
                    node_id: id(1),
                    item_count: 1_000_000,
                    estimated_item_size: 20.0,
                    base_overscan_viewports: 1.0,
                    velocity_horizon_seconds: 0.25,
                    maximum_ahead_viewports: 4.0,
                    axis: pingo_abi::VirtualAxis::X,
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

    fn assert_position(actual: [f32; 2], expected: [f32; 2]) {
        assert_eq!(actual.map(f32::to_bits), expected.map(f32::to_bits));
    }

    fn pointer_event(
        event_id: u32,
        pointer_id: u32,
        kind: InputEventKind,
        position: [f32; 2],
        buttons: u32,
    ) -> InputCommand {
        InputCommand::DispatchEvent {
            event_id,
            kind,
            flags: 0,
            position,
            delta: [0.0, 0.0],
            buttons,
            modifiers: 0,
            pointer_id,
            elapsed_micros: 16_667,
            pointer_type: InputPointerType::Mouse,
            is_primary: true,
            pressure: 0.5,
            tilt: [0.0, 0.0],
            contact_size: [1.0, 1.0],
        }
    }

    fn touch_pointer_event(
        event_id: u32,
        kind: InputEventKind,
        position: [f32; 2],
        buttons: u32,
    ) -> InputCommand {
        InputCommand::DispatchEvent {
            event_id,
            kind,
            flags: 0,
            position,
            delta: [0.0, 0.0],
            buttons,
            modifiers: 0,
            pointer_id: 9,
            elapsed_micros: 16_667,
            pointer_type: InputPointerType::Touch,
            is_primary: true,
            pressure: 0.5,
            tilt: [0.0, 0.0],
            contact_size: [8.0, 8.0],
        }
    }

    fn wheel_event(event_id: u32, position: [f32; 2], delta: [f32; 2]) -> InputCommand {
        InputCommand::DispatchEvent {
            event_id,
            kind: InputEventKind::Wheel,
            flags: EVENT_FLAG_PRECISE_WHEEL,
            position,
            delta,
            buttons: 0,
            modifiers: 0,
            pointer_id: 0,
            elapsed_micros: 16_667,
            pointer_type: InputPointerType::None,
            is_primary: false,
            pressure: 0.0,
            tilt: [0.0, 0.0],
            contact_size: [0.0, 0.0],
        }
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
            pingo_abi::FRAME_DIAGNOSTICS_WORDS
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
                .dirty(pingo_scene::DirtyDomain::Paint)
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
                        pointer_type: InputPointerType::Mouse,
                        is_primary: true,
                        pressure: 0.5,
                        tilt: [0.0, 0.0],
                        contact_size: [1.0, 1.0],
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
        assert_eq!(events.records.len(), 6);
        assert_eq!(
            events
                .records
                .iter()
                .map(|record| record.kind)
                .collect::<Vec<_>>(),
            vec![
                InputEventKind::PointerOver,
                InputEventKind::PointerEnter,
                InputEventKind::PointerEnter,
                InputEventKind::PointerDown,
                InputEventKind::Focus,
                InputEventKind::FocusIn,
            ]
        );
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
                        pointer_type: InputPointerType::None,
                        is_primary: false,
                        pressure: 0.0,
                        tilt: [0.0, 0.0],
                        contact_size: [0.0, 0.0],
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
                    pointer_type: InputPointerType::None,
                    is_primary: false,
                    pressure: 0.0,
                    tilt: [0.0, 0.0],
                    contact_size: [0.0, 0.0],
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
            pointer_type: InputPointerType::None,
            is_primary: false,
            pressure: 0.0,
            tilt: [0.0, 0.0],
            contact_size: [0.0, 0.0],
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
                    pointer_type: InputPointerType::None,
                    is_primary: false,
                    pressure: 0.0,
                    tilt: [0.0, 0.0],
                    contact_size: [0.0, 0.0],
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
    fn overscroll_behavior_controls_nested_wheel_chaining_and_edge_affordance() {
        let run = |behavior: Option<StyleKeyword>| {
            let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
            engine
                .commit(&nested_scroll_tree(behavior, None))
                .expect("nested frame");
            engine
                .input(&input(1, vec![wheel_event(1, [10.0, 10.0], [0.0, 20.0])]))
                .expect("wheel");
            engine.take_event_transactions().expect("event path");
            let position = |index| {
                engine
                    .scene()
                    .scroll_position(NodeId::from_raw(id(index)).expect("scroll id"))
                    .expect("scroll position")
            };
            (position(1), position(3))
        };

        let (outer_auto, inner_auto) = run(None);
        assert_position(inner_auto, [0.0, 150.0]);
        assert!(
            outer_auto[1] > 0.0,
            "auto must chain to the scrollable ancestor"
        );

        let (outer_contain, inner_contain) = run(Some(StyleKeyword::Contain));
        assert_position(outer_contain, [0.0, 0.0]);
        assert!(
            inner_contain[1] > 150.0,
            "contain retains the local edge affordance"
        );

        let (outer_none, inner_none) = run(Some(StyleKeyword::None));
        assert_position(outer_none, [0.0, 0.0]);
        assert_position(inner_none, [0.0, 150.0]);
    }

    #[test]
    fn touch_action_gates_core_default_scroll_axes() {
        let run = |action| {
            let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
            engine
                .commit(&nested_scroll_tree(None, Some(action)))
                .expect("nested frame");
            engine
                .input(&input(
                    1,
                    vec![touch_pointer_event(
                        1,
                        InputEventKind::PointerDown,
                        [10.0, 10.0],
                        1,
                    )],
                ))
                .expect("touch down");
            engine.take_event_transactions().expect("down events");
            engine
                .input(&input(
                    2,
                    vec![touch_pointer_event(
                        2,
                        InputEventKind::PointerMove,
                        [10.0, -10.0],
                        1,
                    )],
                ))
                .expect("touch move");
            engine.take_event_transactions().expect("move events");
            engine
                .scene()
                .scroll_position(NodeId::from_raw(id(1)).expect("outer id"))
                .expect("outer position")
        };

        assert_position(run(StyleKeyword::None), [0.0, 0.0]);
        assert!(run(StyleKeyword::PanY)[1] > 0.0);
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
            pointer_type: InputPointerType::Mouse,
            is_primary: true,
            pressure: 0.5,
            tilt: [0.0, 0.0],
            contact_size: [1.0, 1.0],
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
            let batch = pingo_abi::EditTransactionBatch::decode(&bytes).expect("decode");
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
    fn contraction_survives_a_value_that_diverged_from_the_measured_string() {
        // The recorded failure. Deleting the middle of a run leaves two marks
        // adjacent, and an application is not required to write the edited value
        // back -- the engine's own contract is that editing needs no Shell
        // re-render. The positional advances describe the Scene string and stop
        // applying the moment the value diverges, so the caret drifted by the
        // contracted width at the seam, permanently. The contraction table is a
        // property of the font, so it still applies.
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine
            .commit_with_system_text_metrics(
                // "A、X、B": deleting X leaves the two marks adjacent, and that
                // pair never occurs in the measured string.
                &editable_tree_with_text(1, "A\u{3001}X\u{3001}B"),
                Some(&system_metrics(SystemTextMetricCommand::Upsert(
                    SystemTextMetric {
                        string_id: 3,
                        style_id: 2,
                        max_line_width: 62.0,
                        line_count: 1,
                        advances: vec![('A', 10.0), ('B', 10.0), ('X', 10.0), ('\u{3001}', 16.0)],
                        positional_advances: vec![10.0, 16.0, 10.0, 16.0, 10.0],
                        contractions: vec![pingo_abi::TextContraction {
                            first: '\u{3001}',
                            second: '\u{3001}',
                            delta: -8.0,
                            // Every tested platform trims the first mark, so the
                            // stop between the pair belongs 8px earlier.
                            first_delta: -8.0,
                        }],
                    },
                ))),
            )
            .expect("frame");
        engine
            .input(&input(
                1,
                vec![InputCommand::FocusEditable { node_id: id(1) }],
            ))
            .expect("focus");
        engine.take_edit_transactions().expect("drain focus");

        // Delete the X. The Scene string is deliberately left untouched.
        engine
            .input(&input(
                2,
                vec![InputCommand::Replace {
                    node_id: id(1),
                    base_revision: 0,
                    start: 2,
                    end: 3,
                    text: String::new(),
                }],
            ))
            .expect("delete");
        engine.take_edit_transactions().expect("drain delete");

        let node = NodeId::from_raw(id(1)).expect("node");
        let stops = engine
            .text
            .editor_caret_stops(&engine.scene, node)
            .expect("caret stops");
        // "A、、B": the font trims the first mark, so it advances 16 - 8 = 8 and
        // the second keeps its full 16. The stop between the marks therefore
        // belongs at 10 + 8 = 18, not at 10 + 16 = 26, and the stop after them
        // at 34. Attributing the trim to the second mark puts the between-stop
        // on top of it, which is why the caret could not be placed there.
        let x = |offset: u32| {
            stops
                .iter()
                .find(|stop| stop.utf16_offset == offset)
                .map(|stop| stop.x)
                .expect("stop")
        };
        assert!((x(2) - 18.0).abs() < 0.01, "between the pair: {}", x(2));
        assert!((x(3) - 34.0).abs() < 0.01, "after the pair: {}", x(3));
        assert!((x(4) - 44.0).abs() < 0.01, "end: {}", x(4));
    }

    #[test]
    fn positional_advances_carry_contextual_punctuation_compression() {
        // CJK fonts contract consecutive full-width punctuation: "、、" measures
        // 24px, not 2 x 16px. The per-code-point table cannot express that, so
        // the caret drifted one notch to the right of every adjacent pair. The
        // positional advances are prefix differences and carry it exactly.
        let text = "A\u{3001}\u{3001}B";
        let offset_at = |positional: Vec<f32>| -> u32 {
            let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
            engine
                .commit_with_system_text_metrics(
                    &editable_tree_with_text(1, text),
                    Some(&system_metrics(SystemTextMetricCommand::Upsert(
                        SystemTextMetric {
                            string_id: 3,
                            style_id: 2,
                            max_line_width: 44.0,
                            line_count: 1,
                            advances: vec![('A', 10.0), ('B', 10.0), ('\u{3001}', 16.0)],
                            positional_advances: positional,
                            contractions: Vec::new(),
                        },
                    ))),
                )
                .expect("frame");
            engine
                .input(&input(
                    1,
                    vec![InputCommand::FocusEditable { node_id: id(1) }],
                ))
                .expect("focus");
            engine.take_edit_transactions().expect("drain focus");
            // Focus puts the caret at the end and the editor scrolls to reveal
            // it; move it home first so the click coordinate is unscrolled.
            engine
                .input(&input(
                    2,
                    vec![InputCommand::SetSelection {
                        node_id: id(1),
                        base_revision: 0,
                        selection: pingo_abi::InputSelection {
                            anchor: pingo_abi::InputPosition {
                                offset: 0,
                                affinity: pingo_abi::InputAffinity::Downstream,
                            },
                            focus: pingo_abi::InputPosition {
                                offset: 0,
                                affinity: pingo_abi::InputAffinity::Downstream,
                            },
                        },
                    }],
                ))
                .expect("home");
            engine.take_edit_transactions().expect("drain home");
            engine
                .input(&input(
                    3,
                    vec![InputCommand::PlaceCaret {
                        node_id: id(1),
                        position: [33.0, 0.0],
                        flags: 0,
                    }],
                ))
                .expect("place caret");
            let bytes = engine.take_edit_transactions().expect("edit bytes");
            pingo_abi::EditTransactionBatch::decode(&bytes)
                .expect("decode")
                .records
                .last()
                .expect("record")
                .selection[0]
        };

        // Measured in context the second mark advances 8px, so the stops are
        // 0/10/26/34/44 and x=33 lands after it. Isolated widths give
        // 0/10/26/42/52 and the same click lands one glyph earlier.
        assert_eq!(offset_at(vec![10.0, 16.0, 8.0, 10.0]), 3);
        assert_eq!(offset_at(Vec::new()), 2);
    }

    #[test]
    fn measured_advances_place_the_caret_where_the_glyphs_actually_are() {
        // Four full-width code points at 16px advance 16px each; the unmeasured
        // estimate is font_size * 0.6 = 9.6px, so by the fourth stop the two
        // models disagree by more than a whole glyph. The same stops resolve a
        // pointer to a text offset, so an unmeasured run also selects the wrong
        // word on a double click.
        let text = "中文备注";
        let measured = SystemTextMetricCommand::Upsert(SystemTextMetric {
            string_id: 3,
            style_id: 2,
            max_line_width: 64.0,
            line_count: 1,
            advances: vec![
                ('\u{4e2d}', 16.0),
                ('\u{5907}', 16.0),
                ('\u{6587}', 16.0),
                ('\u{6ce8}', 16.0),
            ],
            positional_advances: Vec::new(),
            contractions: Vec::new(),
        });

        let offset_at = |metrics: Option<Vec<u8>>| -> u32 {
            let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
            engine
                .commit_with_system_text_metrics(
                    &editable_tree_with_text(1, text),
                    metrics.as_deref(),
                )
                .expect("frame");
            engine
                .input(&input(
                    1,
                    vec![InputCommand::FocusEditable { node_id: id(1) }],
                ))
                .expect("focus");
            engine.take_edit_transactions().expect("drain focus");
            engine
                .input(&input(
                    2,
                    vec![InputCommand::PlaceCaret {
                        node_id: id(1),
                        // Inside the fourth glyph, which spans 48..64 when measured.
                        position: [44.0, 0.0],
                        flags: 0,
                    }],
                ))
                .expect("place caret");
            let bytes = engine.take_edit_transactions().expect("edit bytes");
            pingo_abi::EditTransactionBatch::decode(&bytes)
                .expect("decode")
                .records
                .last()
                .expect("record")
                .selection[0]
        };

        assert_eq!(offset_at(Some(system_metrics(measured))), 3);
        // Without advances the estimate runs out of string and clamps past it.
        assert_eq!(offset_at(None), 4);
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn a_double_click_uses_host_segmentation_for_scripts_without_spaces() {
        // UAX #29 has no dictionary: it makes every Han ideograph its own word,
        // so a double click selected one character. The browser's Intl.Segmenter
        // does have one, and its result arrives with the click.
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine
            .commit(&editable_tree_with_text(
                1,
                "\u{4eca}\u{5929}\u{5929}\u{6c14}",
            ))
            .expect("frame");
        engine
            .input(&input(
                1,
                vec![InputCommand::FocusEditable { node_id: id(1) }],
            ))
            .expect("focus");
        engine.take_edit_transactions().expect("drain focus");

        let selection_after = |engine: &mut CoreEngine| -> [u32; 2] {
            let bytes = engine.take_edit_transactions().expect("edit bytes");
            pingo_abi::EditTransactionBatch::decode(&bytes)
                .expect("decode")
                .records
                .last()
                .expect("record")
                .selection
        };
        // Unmeasured advances estimate to 9.6px, so stops sit at 0, 9.6, 19.2,
        // 28.8 and 38.4; this lands on offset 2, the second dictionary word.
        let position = [21.0, 0.0];
        let double_click = InputCommand::PlaceCaret {
            node_id: id(1),
            position,
            flags: 2,
        };

        engine
            .input(&input(2, vec![double_click.clone()]))
            .expect("word without boundaries");
        // Without segmentation this is one ideograph.
        assert_eq!(selection_after(&mut engine), [2, 3]);

        let revision_of = |engine: &CoreEngine| {
            engine
                .editing
                .session(NodeId::from_raw(id(1)).expect("node"))
                .expect("session")
                .revision()
        };
        let revision = revision_of(&engine);
        engine
            .input(&input(
                3,
                vec![
                    InputCommand::SetWordBoundaries {
                        node_id: id(1),
                        base_revision: revision,
                        boundaries: vec![0, 2],
                    },
                    double_click.clone(),
                ],
            ))
            .expect("word with boundaries");
        assert_eq!(selection_after(&mut engine), [2, 4]);

        // Boundaries computed before a caret click are still fresh: only the
        // text invalidates them. Gating on the full revision made every batch
        // racing an unacknowledged selection stale, and the fallback then
        // selected a single ideograph.
        let text_base = revision_of(&engine);
        engine
            .input(&input(
                4,
                vec![InputCommand::SetSelection {
                    node_id: id(1),
                    base_revision: text_base,
                    selection: pingo_abi::InputSelection {
                        anchor: pingo_abi::InputPosition {
                            offset: 0,
                            affinity: pingo_abi::InputAffinity::Downstream,
                        },
                        focus: pingo_abi::InputPosition {
                            offset: 0,
                            affinity: pingo_abi::InputAffinity::Downstream,
                        },
                    },
                }],
            ))
            .expect("selection bump");
        engine.take_edit_transactions().expect("drain selection");
        engine
            .input(&input(
                5,
                vec![
                    InputCommand::SetWordBoundaries {
                        node_id: id(1),
                        base_revision: text_base,
                        boundaries: vec![0, 2],
                    },
                    double_click.clone(),
                ],
            ))
            .expect("word with boundaries racing a selection");
        assert_eq!(selection_after(&mut engine), [2, 4]);

        // A base from before the last text change, or from a future the
        // session has not reached, must not select against the wrong text.
        engine
            .input(&input(
                6,
                vec![InputCommand::Insert {
                    node_id: id(1),
                    base_revision: revision_of(&engine),
                    text: "x".to_owned(),
                }],
            ))
            .expect("text change");
        engine.take_edit_transactions().expect("drain insert");
        for (seq, base) in [(7, text_base), (8, revision_of(&engine).wrapping_add(7))] {
            engine
                .input(&input(
                    seq,
                    vec![
                        InputCommand::SetWordBoundaries {
                            node_id: id(1),
                            base_revision: base,
                            boundaries: vec![0, 2],
                        },
                        double_click.clone(),
                    ],
                ))
                .expect("word with stale boundaries");
            assert_eq!(selection_after(&mut engine), [2, 3]);
        }
    }

    #[test]
    fn a_multiline_editor_wraps_and_a_single_line_one_does_not() {
        // The fallback path had no line breaking at all, so a value wider than
        // the box painted straight across whatever sat beside and below it.
        let drawn = |flags: u32| -> String {
            let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
            let output = engine
                .commit(&editable_tree_with_width(flags, "alpha beta gamma", 60.0))
                .expect("frame");
            DisplayList::decode(&output.display_list)
                .expect("DisplayList")
                .instructions
                .iter()
                .find_map(|instruction| match &instruction.command {
                    DisplayCommand::DrawTextInlineFallback { text, .. } => Some(text.clone()),
                    _ => None,
                })
                .expect("inline fallback draw")
        };

        // 16px estimates to 9.6px per code point, so six fit in 60px. The break
        // lands on a word opportunity rather than mid-word.
        assert_eq!(drawn(1), "alpha \nbeta \ngamma");
        // Single line: the value stays one line and the field scrolls instead.
        assert_eq!(drawn(0), "alpha beta gamma");
    }

    #[test]
    fn an_editor_scrolls_its_own_value_to_keep_the_caret_inside() {
        // The node clips to its box and the fallback path does not wrap, so a
        // value wider than the field would put the caret outside the clip and
        // make typing invisible.
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine
            // Flags zero: single line, so it scrolls rather than wrapping.
            .commit(&editable_tree_with_width(0, "abcdefghij", 40.0))
            .expect("frame");
        engine
            .input(&input(
                1,
                vec![InputCommand::FocusEditable { node_id: id(1) }],
            ))
            .expect("focus");
        engine.take_edit_transactions().expect("drain focus");

        let caret_left = |engine: &CoreEngine| {
            let words = engine.editing_geometry();
            f32::from_bits(
                words[pingo_abi::EDITING_GEOMETRY_HEADER_WORDS
                    + pingo_abi::EDITING_GEOMETRY_RECT_WORDS],
            )
        };
        let control_left = |engine: &CoreEngine| {
            f32::from_bits(engine.editing_geometry()[pingo_abi::EDITING_GEOMETRY_HEADER_WORDS])
        };

        // Focus leaves the caret at the end. Ten characters estimate to 96px in
        // a 40px box, so unscrolled it would sit far outside the clip; it has to
        // rest one caret bar inside the right edge instead.
        let inset = control_left(&engine) + 40.0 - caret_left(&engine);
        assert!(
            (inset - super::CARET_WIDTH).abs() < 0.01,
            "caret should rest one bar inside the right edge, inset {inset}"
        );

        engine
            .input(&input(
                2,
                vec![InputCommand::MoveCaret {
                    node_id: id(1),
                    direction: pingo_abi::CaretDirection::LineStart,
                    granularity: pingo_abi::CaretGranularity::Grapheme,
                    extend: false,
                }],
            ))
            .expect("move to start");
        engine.take_edit_transactions().expect("drain move");

        // Back at the start the field must scroll all the way back, not keep an
        // offset that leaves the first characters hidden.
        assert!(
            (caret_left(&engine) - control_left(&engine)).abs() < 0.01,
            "caret {} control {}",
            caret_left(&engine),
            control_left(&engine)
        );
    }

    #[test]
    fn editing_does_not_resize_a_measured_text_box() {
        // The browser-measured width applies to the Scene string. Falling back to
        // font_size * 0.6 for the whole session shrank a full-width run to 60% of
        // its width the moment it was focused, and snapped it back on blur.
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine
            .commit_with_system_text_metrics(
                &editable_tree_with_text(1, "\u{4e2d}\u{6587}"),
                Some(&system_metrics(SystemTextMetricCommand::Upsert(
                    SystemTextMetric {
                        string_id: 3,
                        style_id: 2,
                        max_line_width: 32.0,
                        line_count: 1,
                        advances: vec![('\u{4e2d}', 16.0), ('\u{5019}', 16.0), ('\u{6587}', 16.0)],
                        positional_advances: Vec::new(),
                        contractions: Vec::new(),
                    },
                ))),
            )
            .expect("frame");
        let text = NodeId::from_raw(id(1)).expect("text id");
        let width = |engine: &CoreEngine| {
            engine
                .layout
                .snapshot()
                .geometry(text)
                .map(|(_, size)| size.width)
                .expect("geometry")
        };
        assert!((width(&engine) - 32.0).abs() < 0.01, "{}", width(&engine));

        engine
            .input(&input(
                1,
                vec![InputCommand::FocusEditable { node_id: id(1) }],
            ))
            .expect("focus");
        engine.take_edit_transactions().expect("drain focus");
        // Focus alone must not resize: the session value still equals the string.
        assert!((width(&engine) - 32.0).abs() < 0.01, "{}", width(&engine));

        engine
            .input(&input(
                2,
                vec![InputCommand::Insert {
                    node_id: id(1),
                    base_revision: 0,
                    text: "\u{5019}".to_owned(),
                }],
            ))
            .expect("insert");
        engine.take_edit_transactions().expect("drain insert");
        // One more measured full-width glyph, so exactly one advance wider. The
        // estimate would have given 3 * 16 * 0.6 = 28.8, narrower than before.
        assert!((width(&engine) - 48.0).abs() < 0.01, "{}", width(&engine));
    }

    #[test]
    fn ime_preedit_uses_measured_advances_for_the_candidate_window() {
        // The preedit run lives only in the editing session: it is in no Scene
        // string, so the Host measures it into the same code-point table. Without
        // it the composition underline, the caret and the IME candidate-window
        // rectangles all fall back to font_size * 0.6.
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine
            .commit_with_system_text_metrics(
                &editable_tree_with_text(1, "\u{4e2d}\u{6587}"),
                Some(&system_metrics(SystemTextMetricCommand::Upsert(
                    SystemTextMetric {
                        string_id: 3,
                        style_id: 2,
                        max_line_width: 32.0,
                        line_count: 1,
                        // U+5019 occurs nowhere in the Scene string; it is only
                        // ever composed, which is the case that used to break.
                        advances: vec![('\u{4e2d}', 16.0), ('\u{5019}', 16.0), ('\u{6587}', 16.0)],
                        positional_advances: Vec::new(),
                        contractions: Vec::new(),
                    },
                ))),
            )
            .expect("frame");
        engine
            .input(&input(
                1,
                vec![InputCommand::FocusEditable { node_id: id(1) }],
            ))
            .expect("focus");
        engine.take_edit_transactions().expect("drain focus");

        let caret = |offset: u32| pingo_abi::InputPosition {
            offset,
            affinity: pingo_abi::InputAffinity::Downstream,
        };
        engine
            .input(&input(
                2,
                vec![
                    InputCommand::SetSelection {
                        node_id: id(1),
                        base_revision: 0,
                        selection: pingo_abi::InputSelection {
                            anchor: caret(2),
                            focus: caret(2),
                        },
                    },
                    InputCommand::BeginComposition {
                        node_id: id(1),
                        base_revision: 1,
                    },
                    InputCommand::UpdateComposition {
                        node_id: id(1),
                        base_revision: 2,
                        text: "\u{5019}".to_owned(),
                    },
                ],
            ))
            .expect("compose");
        engine.take_edit_transactions().expect("drain composition");

        engine
            .input(&input(
                3,
                vec![InputCommand::RequestCharacterBounds {
                    node_id: id(1),
                    start: 2,
                    end: 3,
                }],
            ))
            .expect("character bounds");

        let words = engine.editing_geometry();
        assert_eq!(words[0], pingo_abi::EDITING_GEOMETRY_VERSION);
        assert_eq!(words[4], 1, "one requested character");
        let rect = pingo_abi::EDITING_GEOMETRY_HEADER_WORDS
            + pingo_abi::EDITING_GEOMETRY_RECT_WORDS * 2
            + 2;
        let left = f32::from_bits(words[rect]);
        let width = f32::from_bits(words[rect + 2]);
        // Two measured glyphs precede it, and the preedit glyph is measured too;
        // the estimate would put it at 19.2 and make it 9.6 wide. The field is
        // exactly as wide as its three glyphs, so it scrolled by the caret bar
        // to keep that bar inside the clip -- hence 32 minus CARET_WIDTH.
        assert!(
            (left - (32.0 - super::CARET_WIDTH)).abs() < 0.01,
            "candidate window left {left}"
        );
        assert!(
            (width - 16.0).abs() < 0.01,
            "candidate window width {width}"
        );
    }

    #[test]
    fn move_caret_navigates_graphemes_words_lines_and_desired_column() {
        use pingo_abi::{CaretDirection as D, CaretGranularity as G};
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
            let batch = pingo_abi::EditTransactionBatch::decode(&bytes).expect("decode");
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

        engine
            .input(&input(
                1,
                vec![pointer_event(
                    11,
                    9,
                    InputEventKind::PointerDown,
                    [20.0, 60.0],
                    1,
                )],
            ))
            .expect("down");
        engine.take_event_transactions().expect("down event");
        assert!(
            engine
                .input(&input(
                    2,
                    vec![pointer_event(
                        11,
                        9,
                        InputEventKind::PointerMove,
                        [20.0, -20.0],
                        1,
                    )],
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

        engine
            .input(&input(3, vec![wheel_event(12, [20.0, 60.0], [0.0, 50.0])]))
            .expect("wheel");
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
                kind: pingo_abi::EditorDecorationKind::Caret,
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
                kind: pingo_abi::EditorDecorationKind::Caret,
                ..
            }
        )));

        let selected = engine
            .input(&input(
                2,
                vec![InputCommand::SetSelection {
                    node_id: id(1),
                    base_revision: 0,
                    selection: pingo_abi::InputSelection {
                        anchor: pingo_abi::InputPosition {
                            offset: 0,
                            affinity: pingo_abi::InputAffinity::Downstream,
                        },
                        focus: pingo_abi::InputPosition {
                            offset: 1,
                            affinity: pingo_abi::InputAffinity::Downstream,
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
                kind: pingo_abi::EditorDecorationKind::Selection,
                ..
            }
        )));
    }

    #[test]
    fn undo_repaints_after_the_value_returns_to_the_measured_string() {
        // The recorded failure: Backspace repainted, Ctrl+Z did not, and the
        // caret kept moving through text the screen no longer matched. Undo
        // restores the exact Scene string, which re-qualified the node for the
        // browser-metric measurement branch -- and that branch returned without
        // refreshing the wrapped display string paint serves, so the deleted
        // text stayed on screen. The production shape needs the metric present;
        // without one the miss branch always refreshed it, which is why the
        // earlier probe saw both frames repaint.
        let text = "ab";
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine
            .commit_with_system_text_metrics(
                &editable_tree_with_text(1, text),
                Some(&system_metrics(SystemTextMetricCommand::Upsert(
                    SystemTextMetric {
                        string_id: 3,
                        style_id: 2,
                        max_line_width: 20.0,
                        line_count: 1,
                        advances: vec![('a', 10.0), ('b', 10.0)],
                        positional_advances: vec![10.0, 10.0],
                        contractions: Vec::new(),
                    },
                ))),
            )
            .expect("frame");
        engine
            .input(&input(
                1,
                vec![InputCommand::FocusEditable { node_id: id(1) }],
            ))
            .expect("focus");
        engine.take_edit_transactions().expect("drain focus");

        let inline_text = |output: &crate::FrameOutput| -> String {
            DisplayList::decode(&output.display_list)
                .expect("decode")
                .instructions
                .iter()
                .filter_map(|instruction| match &instruction.command {
                    DisplayCommand::DrawTextInlineFallback { text, .. } => Some(text.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("|")
        };

        let deleted = engine
            .input(&input(
                2,
                vec![InputCommand::DeleteBackward {
                    node_id: id(1),
                    base_revision: 0,
                }],
            ))
            .expect("delete")
            .expect("delete frame");
        engine.take_edit_transactions().expect("drain delete");
        assert_eq!(inline_text(&deleted), "a");

        let restored = engine
            .input(&input(
                3,
                vec![InputCommand::Undo {
                    node_id: id(1),
                    base_revision: 1,
                }],
            ))
            .expect("undo")
            .expect("undo frame");
        assert_eq!(inline_text(&restored), "ab", "the undo frame must repaint");
    }

    #[test]
    fn a_raced_undo_still_restores_the_deleted_text() {
        // The recorded failure: double-click selects a word (each click's caret
        // placement consumes a revision through an asynchronous transport),
        // Backspace deletes it, and Ctrl+Z arrives carrying a base revision the
        // selection churn has already passed. Undo is defined against the
        // history, not a text position, so a stale base must not swallow it --
        // and it must never reject the frame.
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

        engine
            .input(&input(
                2,
                vec![InputCommand::Replace {
                    node_id: id(1),
                    base_revision: 0,
                    start: 0,
                    end: 2,
                    text: String::new(),
                }],
            ))
            .expect("delete");
        engine.take_edit_transactions().expect("drain delete");

        // An engine-side caret placement the input surface has not yet been
        // acknowledged for; it consumes revision 2.
        engine
            .input(&input(
                3,
                vec![InputCommand::PlaceCaret {
                    node_id: id(1),
                    position: [0.0, 0.0],
                    flags: 0,
                }],
            ))
            .expect("place caret");
        engine.take_edit_transactions().expect("drain caret");

        // The surface still believes the revision is 1.
        engine
            .input(&input(
                4,
                vec![InputCommand::Undo {
                    node_id: id(1),
                    base_revision: 1,
                }],
            ))
            .expect("raced undo");
        let node = NodeId::from_raw(id(1)).expect("node");
        assert_eq!(
            engine.editing.session(node).expect("session").text(),
            "ab cd",
            "the raced undo must still restore the deletion"
        );
    }

    #[test]
    fn undo_with_empty_history_is_a_no_op_not_a_poisoned_frame() {
        // Cmd+Z with nothing to undo is an ordinary key press. Rejecting the
        // input frame poisoned the Core, killed the render worker, and the
        // recovery that followed repainted a password field in plaintext.
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine.commit(&editable_text_tree(1)).expect("frame");
        engine
            .input(&input(
                1,
                vec![InputCommand::FocusEditable { node_id: id(1) }],
            ))
            .expect("focus");
        engine.take_edit_transactions().expect("drain focus");

        // Each no-op still consumes the revision and acknowledges it: the input
        // surface bumped its optimistic revision when it sent the command, and
        // only this acknowledgement keeps the two in step.
        for (seq, base, command) in [
            (
                2,
                0,
                InputCommand::Undo {
                    node_id: id(1),
                    base_revision: 0,
                },
            ),
            (
                3,
                1,
                InputCommand::Redo {
                    node_id: id(1),
                    base_revision: 1,
                },
            ),
        ] {
            engine
                .input(&input(seq, vec![command]))
                .expect("empty history must be a no-op");
            let bytes = engine.take_edit_transactions().expect("ack bytes");
            let batch = pingo_abi::EditTransactionBatch::decode(&bytes).expect("decode");
            let record = batch.records.last().expect("ack record");
            assert_eq!(record.base_revision, base);
            assert_eq!(record.revision, base + 1);
        }

        // The session is still alive and usable afterwards.
        engine
            .input(&input(
                4,
                vec![InputCommand::Insert {
                    node_id: id(1),
                    base_revision: 2,
                    text: "x".to_owned(),
                }],
            ))
            .expect("insert after no-op undo");
        let bytes = engine.take_edit_transactions().expect("edit bytes");
        assert!(!bytes.is_empty(), "insert still produces a transaction");
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
        // The first insert applies; the second arrives against a base the
        // first already consumed. Under an asynchronous transport that is an
        // ordinary race, so the command is dropped and acknowledged rather
        // than rejecting the frame -- a rejected frame poisons the render loop.
        let output = engine.input(&rejected).expect("raced frame");
        assert!(output.is_some(), "the applied insert still paints");
        let node = NodeId::from_raw(id(1)).expect("editable node");
        assert_eq!(
            engine.editing.session(node).expect("session").text(),
            "asecret",
            "the stale insert must not apply"
        );
        let bytes = engine.take_edit_transactions().expect("acks");
        let batch = pingo_abi::EditTransactionBatch::decode(&bytes).expect("decode");
        // One transaction for the applied insert, one no-op acknowledgement
        // realigning the input surface past the dropped command.
        assert_eq!(batch.records.len(), 2);
        assert_eq!(batch.records[1].base_revision, 1);
        assert_eq!(batch.records[1].revision, 2);
        assert!(batch.records[1].delta.is_none());

        let output = engine
            .input(&input(
                2,
                vec![InputCommand::Insert {
                    node_id: id(1),
                    base_revision: 2,
                    text: "secret".to_owned(),
                }],
            ))
            .expect("password input")
            .expect("changed frame");
        assert_eq!(
            engine.editing.session(node).expect("session").text(),
            "asecretsecret",
            "a current-base insert must apply"
        );
        let display = DisplayList::decode(&output.display_list).expect("DisplayList");
        let mask = "\u{2022}".repeat("asecretsecret".chars().count());
        assert!(display.instructions.iter().any(|instruction| matches!(
            &instruction.command,
            DisplayCommand::DrawTextInlineFallback { text, .. }
                if *text == mask && !text.contains("secret")
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
            advances: Vec::new(),
            positional_advances: Vec::new(),
            contractions: Vec::new(),
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
                        | DisplayCommand::DrawTextInlineFallback { .. }
                ))
        );
        let text = NodeId::from_raw(id(1)).expect("text id");
        assert_eq!(
            engine
                .layout
                .snapshot()
                .geometry(text)
                .map(|(_, size)| size),
            Some(pingo_layout::Size::new(80.0, 40.0))
        );
        assert_eq!(engine.text_metrics().system_metric_hits, 1);

        let refreshed = engine
            .set_system_text_metrics(&system_metrics(SystemTextMetricCommand::Upsert(
                SystemTextMetric {
                    string_id: 3,
                    style_id: 2,
                    max_line_width: 120.0,
                    line_count: 3,
                    advances: Vec::new(),
                    positional_advances: Vec::new(),
                    contractions: Vec::new(),
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
            Some(pingo_layout::Size::new(120.0, 60.0))
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
    fn picture_transactions_block_new_frames_until_the_exact_frame_is_acknowledged() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine
            .set_incremental_pictures_enabled(true)
            .expect("enable Pictures");
        let first = engine.commit(&painted_tree()).expect("first frame");
        assert!(matches!(
            DisplayList::decode(&first.display_list)
                .expect("root list")
                .instructions[0]
                .command,
            DisplayCommand::DrawPicture { .. }
        ));
        let resources = engine.take_picture_resources();
        assert!(!resources.is_empty());
        PictureResourceBatch::decode(&resources).expect("Picture transaction");
        assert_eq!(
            engine.commit(&frame(2, Vec::new())),
            Err(CoreError::PictureResourcesNotAcknowledged)
        );
        assert_eq!(
            engine.acknowledge_picture_resources(2),
            Err(CoreError::PictureResourceAcknowledgementMismatch)
        );
        engine
            .acknowledge_picture_resources(1)
            .expect("acknowledge exact frame");
        let clean = engine.commit(&frame(2, Vec::new())).expect("clean frame");
        assert!(!clean.rebuilt);
        assert!(engine.take_picture_resources().is_empty());
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
    fn keyframe_animation_uses_worker_time_and_stops_repainting_after_fill() {
        let mut engine = CoreEngine::new(100.0, 100.0).expect("Core");
        let initial = engine
            .commit(&frame(
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
                        value: 50.0,
                    },
                    Mutation::SetF32 {
                        node_id: id(1),
                        prop: Prop::Height,
                        value: 50.0,
                    },
                    Mutation::DefineResource {
                        resource_id: 20,
                        kind: ResourceKind::Animation,
                        bytes: opacity_keyframes_resource(1_000_000),
                    },
                    Mutation::SetRef {
                        node_id: id(1),
                        prop: Prop::Animation,
                        resource_id: 20,
                    },
                ],
            ))
            .expect("initial animation frame");
        assert_eq!(first_alpha(&initial), Some(0.0));
        assert_eq!(initial.diagnostics.animation_active, 1);
        assert_eq!(initial.diagnostics.animation_phase_active, 1);
        assert_eq!(initial.diagnostics.animation_layout_nodes, 0);
        assert!(initial.diagnostics.animation_retained_bytes > 0);
        assert!(initial.diagnostics.animation_retained_bytes < 128 * 1024);

        let middle = engine.advance(0.5).expect("advance").expect("middle frame");
        assert_eq!(first_alpha(&middle), Some(0.5));
        assert_eq!(middle.diagnostics.animation_active, 1);
        assert_eq!(middle.diagnostics.layout_visited_nodes, 0);
        let filled = engine.advance(0.5).expect("advance").expect("fill frame");
        assert_eq!(first_alpha(&filled), Some(1.0));
        assert_eq!(filled.diagnostics.animation_active, 0);
        assert_eq!(filled.diagnostics.animation_phase_after, 1);
        assert_eq!(filled.diagnostics.animation_layout_nodes, 0);
        assert!(filled.diagnostics.animation_sampled_frames >= 3);
        assert_eq!(engine.advance(0.1), Ok(None));
        assert_eq!(engine.metrics().committed_frames, 1);
    }

    #[test]
    fn keyframe_play_state_preserves_progress_across_pause_and_resume() {
        let mut running = opacity_keyframes_resource(1_000_000);
        let mut paused = running.clone();
        paused[12] = 1;
        let mut engine = CoreEngine::new(100.0, 100.0).expect("Core");
        engine
            .commit(&frame(
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
                    Mutation::DefineResource {
                        resource_id: 20,
                        kind: ResourceKind::Animation,
                        bytes: running.clone(),
                    },
                    Mutation::SetRef {
                        node_id: id(1),
                        prop: Prop::Animation,
                        resource_id: 20,
                    },
                ],
            ))
            .expect("running");
        assert_eq!(
            first_alpha(&engine.advance(0.4).expect("tick").expect("frame")),
            Some(0.4)
        );
        let paused_frame = engine
            .commit(&frame(
                2,
                vec![
                    Mutation::DefineResource {
                        resource_id: 21,
                        kind: ResourceKind::Animation,
                        bytes: paused,
                    },
                    Mutation::SetRef {
                        node_id: id(1),
                        prop: Prop::Animation,
                        resource_id: 21,
                    },
                ],
            ))
            .expect("pause");
        assert_eq!(first_alpha(&paused_frame), Some(0.4));
        assert_eq!(paused_frame.diagnostics.animation_active, 0);
        assert_eq!(engine.advance(0.4), Ok(None));

        let resumed_frame = engine
            .commit(&frame(
                3,
                vec![
                    Mutation::DefineResource {
                        resource_id: 22,
                        kind: ResourceKind::Animation,
                        bytes: std::mem::take(&mut running),
                    },
                    Mutation::SetRef {
                        node_id: id(1),
                        prop: Prop::Animation,
                        resource_id: 22,
                    },
                ],
            ))
            .expect("resume");
        assert_eq!(first_alpha(&resumed_frame), Some(0.4));
        assert_eq!(resumed_frame.diagnostics.animation_active, 1);
        assert_eq!(resumed_frame.diagnostics.animation_starts, 1);
        assert_eq!(
            first_alpha(&engine.advance(0.6).expect("tick").expect("final")),
            Some(1.0)
        );
    }

    #[test]
    fn transition_retargets_from_current_presentation_and_reduced_motion_finishes() {
        let mut engine = CoreEngine::new(100.0, 100.0).expect("Core");
        engine
            .commit(&frame(
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
                    Mutation::DefineResource {
                        resource_id: 20,
                        kind: ResourceKind::Animation,
                        bytes: opacity_transition_resource(1_000_000),
                    },
                    Mutation::DefineResource {
                        resource_id: 21,
                        kind: ResourceKind::ComputedStyle,
                        bytes: computed_f32(StyleProperty::Opacity, 0.0),
                    },
                    Mutation::SetRef {
                        node_id: id(1),
                        prop: Prop::Animation,
                        resource_id: 20,
                    },
                    Mutation::SetRef {
                        node_id: id(1),
                        prop: Prop::ComputedStyle,
                        resource_id: 21,
                    },
                ],
            ))
            .expect("initial");
        engine
            .commit(&frame(
                2,
                vec![
                    Mutation::DefineResource {
                        resource_id: 22,
                        kind: ResourceKind::ComputedStyle,
                        bytes: computed_f32(StyleProperty::Opacity, 1.0),
                    },
                    Mutation::SetRef {
                        node_id: id(1),
                        prop: Prop::ComputedStyle,
                        resource_id: 22,
                    },
                ],
            ))
            .expect("target one");
        let started = engine.advance(0.0).expect("zero tick should be valid");
        assert_eq!(started, None);
        assert_eq!(
            first_alpha(&engine.advance(0.5).expect("advance").expect("half")),
            Some(0.5)
        );
        let retarget = engine
            .commit(&frame(
                3,
                vec![
                    Mutation::DefineResource {
                        resource_id: 23,
                        kind: ResourceKind::ComputedStyle,
                        bytes: computed_f32(StyleProperty::Opacity, 0.25),
                    },
                    Mutation::SetRef {
                        node_id: id(1),
                        prop: Prop::ComputedStyle,
                        resource_id: 23,
                    },
                ],
            ))
            .expect("retarget");
        assert_eq!(first_alpha(&retarget), Some(0.5));
        assert_eq!(retarget.diagnostics.animation_retargets, 1);
        assert_eq!(
            first_alpha(
                &engine
                    .advance(0.5)
                    .expect("advance")
                    .expect("retarget half")
            ),
            Some(0.375)
        );
        let reduced = engine
            .set_reduced_motion(true)
            .expect("reduce")
            .expect("final frame");
        assert_eq!(first_alpha(&reduced), Some(0.25));
        assert_eq!(engine.advance(1.0), Ok(None));
    }

    #[test]
    fn direct_opacity_targets_animate_without_layout_work() {
        let mut engine = CoreEngine::new(100.0, 100.0).expect("Core");
        engine
            .commit(&frame(
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
                        value: 20.0,
                    },
                    Mutation::SetF32 {
                        node_id: id(1),
                        prop: Prop::Height,
                        value: 20.0,
                    },
                    Mutation::SetF32 {
                        node_id: id(1),
                        prop: Prop::Opacity,
                        value: 0.0,
                    },
                    Mutation::DefineResource {
                        resource_id: 20,
                        kind: ResourceKind::Animation,
                        bytes: opacity_transition_resource(1_000_000),
                    },
                    Mutation::SetRef {
                        node_id: id(1),
                        prop: Prop::Animation,
                        resource_id: 20,
                    },
                ],
            ))
            .expect("initial opacity");
        engine
            .commit(&frame(
                2,
                vec![Mutation::SetF32 {
                    node_id: id(1),
                    prop: Prop::Opacity,
                    value: 1.0,
                }],
            ))
            .expect("opacity target");
        let opacity_half = engine
            .advance(0.5)
            .expect("advance")
            .expect("opacity frame");
        assert_eq!(first_alpha(&opacity_half), Some(0.5));
        assert_eq!(opacity_half.diagnostics.layout_visited_nodes, 0);
        assert_eq!(opacity_half.diagnostics.animation_layout_nodes, 0);
    }

    #[test]
    fn direct_transform_targets_update_paint_and_hit_without_layout_work() {
        let mut transform_engine = CoreEngine::new(100.0, 100.0).expect("Core");
        let identity = AffineResource {
            matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        }
        .encode()
        .to_vec();
        let scaled = AffineResource {
            matrix: [2.0, 0.0, 0.0, 2.0, 0.0, 0.0],
        }
        .encode()
        .to_vec();
        transform_engine
            .commit(&frame(
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
                        value: 20.0,
                    },
                    Mutation::SetF32 {
                        node_id: id(1),
                        prop: Prop::Height,
                        value: 20.0,
                    },
                    Mutation::DefineResource {
                        resource_id: 30,
                        kind: ResourceKind::Affine,
                        bytes: identity,
                    },
                    Mutation::DefineResource {
                        resource_id: 31,
                        kind: ResourceKind::Affine,
                        bytes: scaled,
                    },
                    Mutation::DefineResource {
                        resource_id: 32,
                        kind: ResourceKind::Animation,
                        bytes: transform_transition_resource(1_000_000),
                    },
                    Mutation::SetRef {
                        node_id: id(1),
                        prop: Prop::Transform,
                        resource_id: 30,
                    },
                    Mutation::SetRef {
                        node_id: id(1),
                        prop: Prop::Animation,
                        resource_id: 32,
                    },
                ],
            ))
            .expect("initial transform");
        transform_engine
            .commit(&frame(
                2,
                vec![Mutation::SetRef {
                    node_id: id(1),
                    prop: Prop::Transform,
                    resource_id: 31,
                }],
            ))
            .expect("transform target");
        let transform_half = transform_engine
            .advance(0.5)
            .expect("advance")
            .expect("transform frame");
        let commands = DisplayList::decode(&transform_half.display_list)
            .expect("display list")
            .instructions;
        assert!(commands.iter().any(|instruction| {
            matches!(
                instruction.command,
                DisplayCommand::Transform([x, 0.0, 0.0, y, 0.0, 0.0])
                    if (x - 1.5).abs() < 0.001 && (y - 1.5).abs() < 0.001
            )
        }));
        assert_eq!(transform_half.diagnostics.layout_visited_nodes, 0);
        assert_eq!(
            transform_engine
                .hit
                .hit(
                    transform_engine.scene(),
                    pingo_hit::HitPoint { x: 28.0, y: 10.0 },
                )
                .map(|hit| hit.target.raw()),
            Some(id(1))
        );
    }

    #[test]
    fn display_none_cancels_animation_and_restore_restarts_from_durable_state() {
        let mut engine = CoreEngine::new(100.0, 100.0).expect("Core");
        engine
            .commit(&frame(
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
                    Mutation::DefineResource {
                        resource_id: 20,
                        kind: ResourceKind::Animation,
                        bytes: opacity_keyframes_resource(1_000_000),
                    },
                    Mutation::SetRef {
                        node_id: id(1),
                        prop: Prop::Animation,
                        resource_id: 20,
                    },
                ],
            ))
            .expect("initial");
        engine.advance(0.25).expect("advance").expect("frame");
        let hidden = engine
            .commit(&frame(
                2,
                vec![
                    Mutation::DefineResource {
                        resource_id: 21,
                        kind: ResourceKind::ComputedStyle,
                        bytes: computed_keyword(StyleProperty::Display, StyleKeyword::None),
                    },
                    Mutation::SetRef {
                        node_id: id(1),
                        prop: Prop::ComputedStyle,
                        resource_id: 21,
                    },
                ],
            ))
            .expect("hide");
        assert_eq!(hidden.diagnostics.animation_active, 0);
        assert!(hidden.diagnostics.animation_cancels >= 1);
        assert_eq!(engine.advance(0.25), Ok(None));

        let restored = engine
            .commit(&frame(
                3,
                vec![
                    Mutation::DefineResource {
                        resource_id: 22,
                        kind: ResourceKind::ComputedStyle,
                        bytes: computed_keyword(StyleProperty::Display, StyleKeyword::Flex),
                    },
                    Mutation::SetRef {
                        node_id: id(1),
                        prop: Prop::ComputedStyle,
                        resource_id: 22,
                    },
                ],
            ))
            .expect("restore");
        assert_eq!(first_alpha(&restored), Some(0.0));
        assert_eq!(restored.diagnostics.animation_active, 1);
    }

    #[test]
    fn constant_scroll_velocity_advances_until_core_is_told_to_stop() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine.commit(&scroll_tree()).expect("initial frame");
        assert_eq!(
            engine.input(&input(
                1,
                vec![InputCommand::SetScrollVelocity {
                    node_id: id(1),
                    velocity_x: 0.0,
                    velocity_y: 120.0,
                }],
            )),
            Ok(None)
        );

        for expected_y in [30.0, 60.0] {
            engine.advance(0.25).expect("tick").expect("scroll frame");
            assert_eq!(
                engine
                    .scene()
                    .scroll_position(NodeId::from_raw(id(1)).expect("id")),
                Some([0.0, expected_y])
            );
        }

        assert_eq!(
            engine.input(&input(
                2,
                vec![InputCommand::SetScrollVelocity {
                    node_id: id(1),
                    velocity_x: 0.0,
                    velocity_y: 0.0,
                }],
            )),
            Ok(None)
        );
        assert_eq!(engine.advance(0.25), Ok(None));
    }

    #[test]
    fn imperative_scroll_commands_are_atomic_clamped_and_cancel_motion() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        engine.commit(&scroll_tree()).expect("initial frame");
        engine
            .input(&input(
                1,
                vec![InputCommand::SetScrollVelocity {
                    node_id: id(1),
                    velocity_x: 0.0,
                    velocity_y: 120.0,
                }],
            ))
            .expect("velocity");
        engine
            .input(&input(
                2,
                vec![
                    InputCommand::ScrollTo {
                        node_id: id(1),
                        x: 12.0,
                        y: 500.0,
                    },
                    InputCommand::ScrollBy {
                        node_id: id(1),
                        delta_x: 8.0,
                        delta_y: -40.0,
                    },
                ],
            ))
            .expect("imperative scroll")
            .expect("changed frame");
        assert_eq!(
            engine
                .scene()
                .scroll_position(NodeId::from_raw(id(1)).expect("id")),
            Some([20.0, 460.0])
        );
        assert_eq!(engine.advance(0.25), Ok(None));
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

    /// Materializes a half-open window of virtual items as direct children.
    ///
    /// Node slots are allocated contiguously from `base` because the Scene
    /// rejects gaps, so the node id and the logical item index are independent.
    fn virtual_window(frame_seq: u32, start: u32, end: u32, base: u32) -> Vec<u8> {
        let mut mutations = Vec::new();
        for index in start..end {
            let node = id(base + index - start);
            mutations.push(Mutation::CreateNode {
                node_id: node,
                kind: NodeKind::Container,
                parent: id(1),
                before_sibling: NULL_NODE_ID,
            });
            mutations.push(Mutation::SetF32 {
                node_id: node,
                prop: Prop::Width,
                value: 100.0,
            });
            mutations.push(Mutation::SetF32 {
                node_id: node,
                prop: Prop::Height,
                value: 20.0,
            });
            mutations.push(Mutation::SetVirtualItem {
                node_id: node,
                item_index: index,
            });
        }
        frame(frame_seq, mutations)
    }

    #[test]
    fn shifting_a_virtual_window_costs_the_change_not_the_whole_scene() {
        // Scrolling moves the window by an item or two per frame. If that costs
        // a layout pass over the entire Scene, the cost of scrolling grows with
        // the window size, which is why a large preheat window and smooth
        // scrolling could not both be had.
        let mut engine = CoreEngine::new(100.0, 100.0).expect("Core");
        engine.commit(&virtual_list_tree()).expect("list");
        engine.commit(&virtual_window(2, 0, 40, 2)).expect("window");

        // Drop one item off the front and add one at the back: two nodes change
        // out of a 41-node Scene.
        let shift = frame(
            3,
            vec![
                Mutation::RemoveNode { node_id: id(2) },
                Mutation::CreateNode {
                    node_id: id(42),
                    kind: NodeKind::Container,
                    parent: id(1),
                    before_sibling: NULL_NODE_ID,
                },
                Mutation::SetF32 {
                    node_id: id(42),
                    prop: Prop::Width,
                    value: 100.0,
                },
                Mutation::SetF32 {
                    node_id: id(42),
                    prop: Prop::Height,
                    value: 20.0,
                },
                Mutation::SetVirtualItem {
                    node_id: id(42),
                    item_index: 40,
                },
            ],
        );
        let output = engine.commit(&shift).expect("shift");
        let visited = output.diagnostics.layout_visited_nodes;
        let scene_nodes = output.diagnostics.scene_nodes;
        assert!(
            visited * 2 < scene_nodes,
            "a two-node window shift visited {visited} of {scene_nodes} nodes"
        );

        // Reusing geometry is only worth anything if it is the same geometry.
        // Lay the identical Scene out from scratch and require an exact match,
        // because a wrong offset here would be quietly repaired by the
        // measurement-correction pass and show up only as a visited count.
        let mut reference = CoreEngine::new(100.0, 100.0).expect("Core");
        reference.commit(&virtual_list_tree()).expect("list");
        reference
            .commit(&virtual_window(2, 1, 41, 2))
            .expect("window");

        // The two Scenes hold the same items under different node ids, so
        // compare them by logical item index.
        let geometry_by_item = |engine: &CoreEngine| {
            let scene = engine.scene();
            let snapshot = engine.layout.snapshot();
            let mut found = Vec::new();
            for node in scene.ids().iter().copied() {
                if let Some(item) = scene.virtual_item_index(node)
                    && let Some(geometry) = snapshot.geometry(node)
                {
                    found.push((item, geometry));
                }
            }
            found.sort_by_key(|(item, _)| *item);
            found
        };
        let incremental = geometry_by_item(&engine);
        let full = geometry_by_item(&reference);
        assert_eq!(incremental.len(), 40, "the shifted window holds 40 items");
        assert_eq!(
            incremental, full,
            "incremental window shift must match a full layout exactly"
        );
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
    fn horizontal_virtualization_scrolls_measures_and_paints_along_x() {
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        let output = engine
            .commit(&horizontal_virtual_list_tree())
            .expect("initial frame");
        let display = DisplayList::decode(&output.display_list).expect("display list");
        let skeletons: Vec<[f32; 4]> = display
            .instructions
            .iter()
            .filter_map(|instruction| match instruction.command {
                DisplayCommand::FillPlaceholder { rect, .. } => Some(rect),
                _ => None,
            })
            .collect();
        assert_eq!(skeletons.len(), 5);
        assert!(skeletons.iter().all(|rect| rect[1] == 0.0));
        assert!(
            skeletons
                .iter()
                .all(|rect| (rect[2] - 20.0).abs() < f32::EPSILON)
        );
        assert!(
            skeletons
                .iter()
                .all(|rect| (rect[3] - 80.0).abs() < f32::EPSILON)
        );

        engine.take_virtual_refills();
        engine
            .input(&input(
                1,
                vec![InputCommand::ScrollDelta {
                    node_id: id(1),
                    delta_x: 200.0,
                    delta_y: 0.0,
                    elapsed_micros: 16_667,
                }],
            ))
            .expect("horizontal input");
        let list = NodeId::from_raw(id(1)).expect("list");
        let position = engine.scene().scroll_position(list).expect("position");
        assert!(position[0] > 0.0);
        assert!(position[1].abs() < f32::EPSILON);
        assert!(
            engine
                .take_virtual_refills()
                .iter()
                .any(|request| request.start > 0),
            "moving beyond the first viewport must request a later window"
        );
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

        // Advance without materializing anything. The retry is deliberately not
        // every frame -- that made the Shell thrash -- so drive enough frames to
        // cross the bounded retry interval.
        let mut repeated = Vec::new();
        for _ in 0..60 {
            engine.advance(1.0 / 60.0).expect("frame");
            repeated = engine.take_virtual_refills();
            if !repeated.is_empty() {
                break;
            }
        }
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

    /// A Shell that answers every refill window the frame it is asked.
    ///
    /// This is the reconciler's behaviour reduced to mutations: wrappers inside
    /// the window exist and carry their item index, wrappers outside it are
    /// removed. Answering with no latency isolates Core's own bookkeeping from
    /// the worker round trip.
    struct ShellStub {
        next_node: u32,
        materialized: std::collections::BTreeMap<u32, u32>,
    }

    impl ShellStub {
        fn new() -> Self {
            Self {
                // Scene slots are dense, so item nodes continue from the list.
                next_node: 2,
                materialized: std::collections::BTreeMap::new(),
            }
        }

        fn answer(&mut self, engine: &mut CoreEngine, frame_seq: u32, start: u32, end: u32) {
            let mut mutations = Vec::new();
            let stale: Vec<u32> = self
                .materialized
                .keys()
                .copied()
                .filter(|index| *index < start || *index >= end)
                .collect();
            for index in stale {
                let node = self.materialized.remove(&index).expect("materialized node");
                mutations.push(Mutation::RemoveNode { node_id: node });
            }
            for index in start..end {
                if self.materialized.contains_key(&index) {
                    continue;
                }
                let node = id(self.next_node);
                self.next_node += 1;
                self.materialized.insert(index, node);
                mutations.push(Mutation::CreateNode {
                    node_id: node,
                    kind: NodeKind::Container,
                    parent: id(1),
                    before_sibling: NULL_NODE_ID,
                });
                mutations.push(Mutation::SetF32 {
                    node_id: node,
                    prop: Prop::Height,
                    value: 32.0,
                });
                mutations.push(Mutation::SetVirtualItem {
                    node_id: node,
                    item_index: index,
                });
            }
            if mutations.is_empty() {
                return;
            }
            engine
                .commit(&frame(frame_seq, mutations))
                .expect("refill commit");
        }
    }

    /// Runs a sustained wheel gesture and returns the frames the viewport spent
    /// on skeletons after the input stopped.
    ///
    /// `latency` is how many frames the Shell takes to answer a window, which
    /// is the worker round trip the deployed transport actually pays.
    fn frames_to_materialize_after_a_gesture(latency: usize) -> Option<usize> {
        const VIEWPORT: f32 = 900.0;
        const ROW_HEIGHT: f32 = 32.0;
        let mut engine = CoreEngine::new(640.0, VIEWPORT).expect("Core");
        engine
            .commit(&sized_virtual_list_tree(VIEWPORT, ROW_HEIGHT))
            .expect("initial frame");
        let mut shell = ShellStub::new();
        let mut frame_seq = 1;
        let mut inflight: std::collections::VecDeque<Option<(u32, u32)>> =
            std::collections::VecDeque::from(vec![None; latency]);
        let answer =
            |engine: &mut CoreEngine,
             shell: &mut ShellStub,
             seq: &mut u32,
             inflight: &mut std::collections::VecDeque<Option<(u32, u32)>>| {
                // The host keeps only the newest window per list, so a superseded
                // request is never rendered.
                let request = engine
                    .take_virtual_refills()
                    .last()
                    .map(|request| (request.start, request.end));
                inflight.push_back(request);
                if let Some(Some((start, end))) = inflight.pop_front() {
                    *seq += 1;
                    shell.answer(engine, *seq, start, end);
                }
            };
        answer(&mut engine, &mut shell, &mut frame_seq, &mut inflight);

        // A sustained gesture: one discrete notch per frame, the shape a
        // trackpad flick produces once the host has classified it.
        for event_id in 0..40 {
            engine
                .input(&input(
                    event_id + 1,
                    vec![InputCommand::DispatchEvent {
                        event_id: event_id + 1,
                        kind: InputEventKind::Wheel,
                        flags: 0,
                        position: [50.0, 50.0],
                        delta: [0.0, 400.0],
                        buttons: 0,
                        modifiers: 0,
                        pointer_id: 0,
                        elapsed_micros: 16_667,
                        pointer_type: InputPointerType::None,
                        is_primary: false,
                        pressure: 0.0,
                        tilt: [0.0, 0.0],
                        contact_size: [0.0, 0.0],
                    }],
                ))
                .expect("wheel input");
            engine.take_event_transactions().expect("events");
            engine.advance(1.0 / 60.0).expect("frame");
            answer(&mut engine, &mut shell, &mut frame_seq, &mut inflight);
        }

        // Input has stopped. The notch animation lands within 120ms, so once
        // the last answer arrives there is nothing left to wait for.
        for tick in 0..60 {
            engine.advance(1.0 / 60.0).expect("settle frame");
            answer(&mut engine, &mut shell, &mut frame_seq, &mut inflight);
            if engine.scroll.visible_placeholders() == 0 {
                return Some(tick);
            }
        }
        None
    }

    #[test]
    fn a_settled_viewport_stops_showing_skeletons_once_the_shell_answers() {
        // Reported from the deployed playground: after a fast trackpad flick
        // the rows stayed grey for hundreds of milliseconds even though the
        // offset had stopped and the main thread was idle. A Shell that answers
        // instantly hides the defect, so the round trip is part of the test.
        for latency in [0, 1, 2, 3, 4, 5, 6, 8] {
            let settled = frames_to_materialize_after_a_gesture(latency).unwrap_or_else(|| {
                panic!("viewport never materialized with a {latency}-frame Shell round trip")
            });
            println!("latency {latency} -> settled after {settled} frames");
            assert!(
                settled <= latency + 8,
                "a viewport at rest took {settled} frames to lose its skeletons \
                 with a {latency}-frame Shell round trip",
            );
        }
    }

    #[test]
    fn a_skipped_instruction_reaches_the_host_diagnostics() {
        // The downgrade is only defensible if an operator can see it. Producing
        // the count inside the decoder and dropping it would leave a Core that
        // silently renders less than it was asked for.
        let mut engine = CoreEngine::new(320.0, 240.0).expect("Core");
        let canonical = painted_tree();
        let commit = canonical.len() - 8;
        let mut bytes = canonical;
        // An opcode no build will ever define, marked skippable, two words wide.
        bytes.splice(
            commit..commit,
            [
                0xfe_u8,
                pingo_abi::INSTRUCTION_FLAG_OPTIONAL,
                2,
                0,
                0,
                0,
                0,
                0,
            ],
        );
        let length = u32::try_from(bytes.len()).expect("length");
        bytes[8..12].copy_from_slice(&length.to_le_bytes());
        let count = u32::from_le_bytes(bytes[12..16].try_into().expect("count")) + 1;
        bytes[12..16].copy_from_slice(&count.to_le_bytes());

        let output = engine.commit(&bytes).expect("frame");
        assert_eq!(output.diagnostics.skipped_instructions, 1);
        assert_eq!(
            output.diagnostics.producer_abi_version,
            u32::from(pingo_abi::ABI_VERSION)
        );
        let words = output.diagnostics.to_words();
        assert_eq!(
            words[pingo_abi::FRAME_DIAGNOSTICS_SKIPPED_INSTRUCTIONS_INDEX],
            1
        );

        // The same instruction unmarked is still fatal: a structural mutation
        // this build cannot read must never be dropped behind the operator.
        let mut fatal = bytes.clone();
        fatal[commit + 1] = 0;
        assert!(matches!(
            CoreEngine::new(320.0, 240.0).expect("Core").commit(&fatal),
            Err(CoreError::Abi(_))
        ));
    }

    #[test]
    fn content_that_overflows_a_child_box_is_still_scrollable() {
        // Reported from a phone: a list row is wider than the viewport and the
        // content is visibly cut off, but the list refuses to scroll sideways.
        // The row declares a width, so its own box fits; what overflows is
        // inside it. Scrolling has to follow the reach, not the clipped box.
        let mut engine = CoreEngine::new(200.0, 200.0).expect("Core");
        engine
            .commit(&frame(
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
                        value: 200.0,
                    },
                    Mutation::SetF32 {
                        node_id: id(1),
                        prop: Prop::Height,
                        value: 200.0,
                    },
                    // A row that fits, holding a child that does not.
                    Mutation::CreateNode {
                        node_id: id(2),
                        kind: NodeKind::Container,
                        parent: id(1),
                        before_sibling: NULL_NODE_ID,
                    },
                    Mutation::SetF32 {
                        node_id: id(2),
                        prop: Prop::Width,
                        value: 200.0,
                    },
                    Mutation::SetF32 {
                        node_id: id(2),
                        prop: Prop::Height,
                        value: 50.0,
                    },
                    // A row of cells that each fit on their own but whose
                    // accumulated offsets run past the row, which is the shape
                    // a real list cell has.
                    Mutation::SetF32 {
                        node_id: id(2),
                        prop: Prop::Direction,
                        value: 1.0,
                    },
                    Mutation::CreateNode {
                        node_id: id(3),
                        kind: NodeKind::Container,
                        parent: id(2),
                        before_sibling: NULL_NODE_ID,
                    },
                    Mutation::SetF32 {
                        node_id: id(3),
                        prop: Prop::Width,
                        value: 150.0,
                    },
                    Mutation::SetF32 {
                        node_id: id(3),
                        prop: Prop::Height,
                        value: 50.0,
                    },
                    Mutation::CreateNode {
                        node_id: id(4),
                        kind: NodeKind::Container,
                        parent: id(2),
                        before_sibling: NULL_NODE_ID,
                    },
                    Mutation::SetF32 {
                        node_id: id(4),
                        prop: Prop::Width,
                        value: 150.0,
                    },
                    Mutation::SetF32 {
                        node_id: id(4),
                        prop: Prop::Height,
                        value: 50.0,
                    },
                ],
            ))
            .expect("frame");

        let scroll = NodeId::from_raw(id(1)).expect("scroll");
        engine
            .input(&input(
                1,
                vec![InputCommand::ScrollDelta {
                    node_id: id(1),
                    delta_x: 120.0,
                    delta_y: 0.0,
                    elapsed_micros: 16_667,
                }],
            ))
            .expect("horizontal scroll");
        let offset = engine.scene().scroll_position(scroll).expect("position");
        assert!(
            offset[0] > 0.0,
            "a row wider than the viewport must scroll sideways, offset {offset:?}"
        );
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

        // Two passes: three newly materialized items, then a corrective pass over
        // the list subtree because their measured heights differ from the
        // estimate. Neither one re-lays-out the whole Scene, which is why this
        // is 7 rather than the 5 + 4 it used to be.
        assert_eq!(output.diagnostics.layout_visited_nodes, 7);

        assert_eq!(
            engine
                .layout
                .snapshot()
                .geometry(NodeId::from_raw(id(2)).expect("id")),
            Some((
                pingo_layout::Point::new(0.0, 0.0),
                pingo_layout::Size::new(0.0, 30.0),
            ))
        );
        assert_eq!(
            engine
                .layout
                .snapshot()
                .geometry(NodeId::from_raw(id(3)).expect("id")),
            Some((
                pingo_layout::Point::new(0.0, 30.0),
                pingo_layout::Size::new(0.0, 40.0),
            ))
        );
        assert_eq!(
            engine
                .layout
                .snapshot()
                .geometry(NodeId::from_raw(id(4)).expect("id")),
            Some((
                pingo_layout::Point::new(0.0, 70.0),
                pingo_layout::Size::new(0.0, 20.0),
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
                ReplayRecord::AnimationFrame {
                    elapsed_micros: 16_667,
                },
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
                    ReplayRecord::AnimationFrame { elapsed_micros } => {
                        if let Some(frame) = engine
                            .advance(std::time::Duration::from_micros(elapsed_micros).as_secs_f64())
                            .expect("replay logical frame")
                        {
                            picture_hashes.push(frame.diagnostics.picture_hash);
                        }
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
