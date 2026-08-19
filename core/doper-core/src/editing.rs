use std::{collections::BTreeMap, sync::Arc};

use doper_abi::{
    EditTransactionBatch, EditTransactionKind, EditTransactionRecord, InputCommand,
    MAX_RESOURCE_BYTES, NodeKind, ResourceKind, WireAffinity, WireRange,
};
use doper_edit::{
    Affinity, EditConfig, EditIntent, EditSession, EditTransaction, ExternalValue, Selection,
    TransactionKind, edit_command_from_input,
};
use doper_scene::{NodeId, Scene};

use crate::CoreError;

const EDITABLE_MULTILINE: u32 = 1;
const EDITABLE_READ_ONLY: u32 = 1 << 1;
const EDITABLE_PASSWORD: u32 = 1 << 2;
const EDITABLE_KNOWN_FLAGS: u32 = EDITABLE_MULTILINE | EDITABLE_READ_ONLY | EDITABLE_PASSWORD;
const MAX_EDITABLE_GRAPHEMES: u32 = 1_000_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct EditableConfiguration {
    pub(crate) node_id: u32,
    pub(crate) revision: u64,
    pub(crate) flags: u32,
    pub(crate) max_graphemes: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ActiveEditorVisual {
    pub(crate) node: NodeId,
    pub(crate) selection: [u32; 2],
    pub(crate) composition: Option<[u32; 2]>,
    /// How far this editor has scrolled its own value inside its box.
    pub(crate) scroll_offset: [f32; 2],
}

#[derive(Clone)]
struct ActiveEdit {
    session: EditSession,
    flags: u32,
    max_graphemes: u32,
    /// Local scroll of the value inside the box, kept so the caret stays visible.
    scroll_offset: [f32; 2],
}

#[derive(Clone, Default)]
pub(crate) struct EditingController {
    sessions: BTreeMap<NodeId, ActiveEdit>,
    pending: Vec<(NodeId, EditTransaction)>,
    active_node: Option<NodeId>,
}

#[derive(Debug, Default)]
pub(crate) struct EditingInputOutcome {
    pub(crate) changed_nodes: Vec<NodeId>,
    pub(crate) accepted_commands: usize,
}

impl EditingController {
    pub(crate) fn validate_character_range(
        &self,
        node: NodeId,
        start: u32,
        end: u32,
    ) -> Result<(), CoreError> {
        let active = self
            .sessions
            .get(&node)
            .ok_or(CoreError::InvalidEditableTarget { node })?;
        if self.active_node != Some(node) {
            return Err(CoreError::InvalidEditableTarget { node });
        }
        let length = active.session.text_index().utf16_len();
        if start > end || end > length {
            return Err(CoreError::InvalidEditableCharacterRange {
                node,
                start,
                end,
                length,
            });
        }
        Ok(())
    }

    pub(crate) fn synchronize(
        &mut self,
        scene: &Scene,
        configurations: &[EditableConfiguration],
    ) -> Result<Vec<NodeId>, CoreError> {
        let mut requested = BTreeMap::new();
        for configuration in configurations {
            validate_configuration(*configuration)?;
            let node = NodeId::from_raw(configuration.node_id)?;
            if scene.kind(node) != Some(NodeKind::EditableText) {
                return Err(CoreError::InvalidEditableTarget { node });
            }
            requested.insert(node, *configuration);
        }

        self.sessions
            .retain(|node, _| scene.kind(*node) == Some(NodeKind::EditableText));
        if self
            .active_node
            .is_some_and(|node| !self.sessions.contains_key(&node))
        {
            self.active_node = None;
        }
        self.pending
            .retain(|(node, _)| scene.kind(*node) == Some(NodeKind::EditableText));

        let mut changed = Vec::new();
        for node in scene
            .ids()
            .iter()
            .copied()
            .filter(|node| scene.kind(*node) == Some(NodeKind::EditableText))
        {
            let value = scene_text(scene, node)?;
            let requested_config = requested.get(&node).copied();
            if let Some(active) = self.sessions.get_mut(&node) {
                if let Some(configuration) = requested_config {
                    active.session.reconfigure(edit_config(configuration))?;
                    active.flags = configuration.flags;
                    active.max_graphemes = configuration.max_graphemes;
                    if configuration.revision > active.session.revision() {
                        let selection = Selection::collapsed(utf16_len(value)?);
                        let transaction = active.session.apply_external(ExternalValue {
                            revision: configuration.revision,
                            text: value.to_owned(),
                            selection,
                        })?;
                        self.pending.push((node, transaction));
                        changed.push(node);
                    } else if configuration.revision == active.session.revision()
                        && value != active.session.text()
                    {
                        return Err(CoreError::EditableRevisionConflict {
                            node,
                            revision: configuration.revision,
                        });
                    }
                }
            } else {
                let configuration = requested_config.unwrap_or(EditableConfiguration {
                    node_id: node.raw(),
                    revision: 0,
                    flags: EDITABLE_MULTILINE,
                    max_graphemes: MAX_EDITABLE_GRAPHEMES,
                });
                let selection = Selection::collapsed(utf16_len(value)?);
                let session = EditSession::new(
                    value.to_owned(),
                    selection,
                    configuration.revision,
                    edit_config(configuration),
                )?;
                self.sessions.insert(
                    node,
                    ActiveEdit {
                        session,
                        flags: configuration.flags,
                        max_graphemes: configuration.max_graphemes,
                        scroll_offset: [0.0, 0.0],
                    },
                );
                changed.push(node);
            }
        }
        changed.sort_unstable();
        changed.dedup();
        Ok(changed)
    }

    pub(crate) fn apply_commands(
        &mut self,
        commands: impl IntoIterator<Item = InputCommand>,
    ) -> Result<EditingInputOutcome, CoreError> {
        let mut outcome = EditingInputOutcome::default();
        for input in commands {
            match input {
                InputCommand::FocusEditable { node_id } => {
                    let node = NodeId::from_raw(node_id)?;
                    if !self.sessions.contains_key(&node) {
                        return Err(CoreError::InvalidEditableTarget { node });
                    }
                    if self.active_node != Some(node) {
                        if let Some(previous) = self.active_node.replace(node) {
                            outcome.changed_nodes.push(previous);
                        }
                        outcome.changed_nodes.push(node);
                    }
                    outcome.accepted_commands = outcome.accepted_commands.saturating_add(1);
                    continue;
                }
                InputCommand::BlurEditable { node_id } => {
                    let node = NodeId::from_raw(node_id)?;
                    if !self.sessions.contains_key(&node) {
                        return Err(CoreError::InvalidEditableTarget { node });
                    }
                    if self.active_node == Some(node) {
                        self.active_node = None;
                        outcome.changed_nodes.push(node);
                    }
                    outcome.accepted_commands = outcome.accepted_commands.saturating_add(1);
                    continue;
                }
                _ => {}
            }
            let (raw_node, command) =
                edit_command_from_input(input).map_err(|_| CoreError::UnsupportedInputCommand)?;
            let node = NodeId::from_raw(raw_node)?;
            let active = self
                .sessions
                .get_mut(&node)
                .ok_or(CoreError::InvalidEditableTarget { node })?;
            if active.flags & EDITABLE_READ_ONLY != 0
                && !matches!(command.intent, EditIntent::SetSelection(_))
            {
                return Err(CoreError::EditableReadOnly { node });
            }
            let transaction = active.session.apply(command)?;
            // Selection/composition-only transitions still change editor overlays.
            outcome.changed_nodes.push(node);
            self.pending.push((node, transaction));
            outcome.accepted_commands = outcome.accepted_commands.saturating_add(1);
        }
        outcome.changed_nodes.sort_unstable();
        outcome.changed_nodes.dedup();
        Ok(outcome)
    }

    pub(crate) fn display_overrides(&self) -> std::collections::HashMap<NodeId, Arc<str>> {
        self.sessions
            .iter()
            .map(|(&node, active)| {
                let display: Arc<str> = if active.flags & EDITABLE_PASSWORD == 0 {
                    Arc::from(active.session.text())
                } else {
                    Arc::from("\u{2022}".repeat(active.session.text_index().grapheme_count()))
                };
                (node, display)
            })
            .collect()
    }

    pub(crate) fn active_visual(&self) -> Option<ActiveEditorVisual> {
        let node = self.active_node?;
        let session = &self.sessions.get(&node)?.session;
        let selection = session.selection();
        Some(ActiveEditorVisual {
            node,
            selection: [selection.anchor.offset, selection.focus.offset],
            composition: session
                .composition_range()
                .map(|range| [range.start, range.end]),
            scroll_offset: self
                .sessions
                .get(&node)
                .map_or([0.0, 0.0], |active| active.scroll_offset),
        })
    }

    pub(crate) fn scroll_offset(&self, node: NodeId) -> [f32; 2] {
        self.sessions
            .get(&node)
            .map_or([0.0, 0.0], |active| active.scroll_offset)
    }

    /// Records how far an editor scrolled its own value; see `Engine::reveal_caret_in_editor`.
    pub(crate) fn set_scroll_offset(&mut self, node: NodeId, offset: [f32; 2]) -> bool {
        let Some(active) = self.sessions.get_mut(&node) else {
            return false;
        };
        // Bit equality, not a tolerance: this decides whether the frame has to
        // repaint, and a sub-pixel move still moves every glyph in the node.
        if active.scroll_offset.map(f32::to_bits) == offset.map(f32::to_bits) {
            return false;
        }
        active.scroll_offset = offset;
        true
    }

    pub(crate) fn has_pending_transactions(&self) -> bool {
        !self.pending.is_empty()
    }

    pub(crate) fn take_transactions(&mut self) -> EditTransactionBatch {
        EditTransactionBatch {
            records: std::mem::take(&mut self.pending)
                .into_iter()
                .map(|(node, transaction)| transaction_record(node, transaction))
                .collect(),
        }
    }

    pub(crate) fn encode_pending(&self) -> Result<Vec<u8>, doper_abi::AbiError> {
        EditTransactionBatch {
            records: self
                .pending
                .iter()
                .cloned()
                .map(|(node, transaction)| transaction_record(node, transaction))
                .collect(),
        }
        .encode()
    }

    pub(crate) fn session(&self, node: NodeId) -> Option<&EditSession> {
        self.sessions.get(&node).map(|active| &active.session)
    }

    pub(crate) fn session_is_password(&self, node: NodeId) -> Option<bool> {
        self.sessions
            .get(&node)
            .map(|active| active.flags & EDITABLE_PASSWORD != 0)
    }
}

fn transaction_record(node: NodeId, transaction: EditTransaction) -> EditTransactionRecord {
    EditTransactionRecord {
        node_id: node.raw(),
        base_revision: transaction.base_revision,
        revision: transaction.revision,
        delta: transaction.delta.map(|delta| {
            (
                WireRange {
                    start: delta.range.start,
                    end: delta.range.end,
                },
                delta.text,
            )
        }),
        selection: [
            transaction.selection.anchor.offset,
            transaction.selection.focus.offset,
        ],
        affinities: [
            wire_affinity(transaction.selection.anchor.affinity),
            wire_affinity(transaction.selection.focus.affinity),
        ],
        composition: transaction.composition.map(|range| WireRange {
            start: range.start,
            end: range.end,
        }),
        kind: match transaction.kind {
            TransactionKind::Edit => EditTransactionKind::Edit,
            TransactionKind::Composition => EditTransactionKind::Composition,
            TransactionKind::Undo => EditTransactionKind::Undo,
            TransactionKind::Redo => EditTransactionKind::Redo,
            TransactionKind::External => EditTransactionKind::External,
        },
    }
}

const fn wire_affinity(affinity: Affinity) -> WireAffinity {
    match affinity {
        Affinity::Upstream => WireAffinity::Upstream,
        Affinity::Downstream => WireAffinity::Downstream,
    }
}

fn validate_configuration(configuration: EditableConfiguration) -> Result<(), CoreError> {
    if configuration.flags & !EDITABLE_KNOWN_FLAGS != 0 {
        return Err(CoreError::InvalidEditableConfiguration(
            "editable flags contain reserved bits",
        ));
    }
    if configuration.max_graphemes > MAX_EDITABLE_GRAPHEMES {
        return Err(CoreError::InvalidEditableConfiguration(
            "editable grapheme limit exceeds the protocol maximum",
        ));
    }
    Ok(())
}

fn edit_config(configuration: EditableConfiguration) -> EditConfig {
    EditConfig {
        multiline: configuration.flags & EDITABLE_MULTILINE != 0,
        max_utf8_bytes: MAX_RESOURCE_BYTES,
        max_graphemes: configuration.max_graphemes as usize,
        ..EditConfig::default()
    }
}

fn scene_text(scene: &Scene, node: NodeId) -> Result<&str, CoreError> {
    let run = scene
        .text_run(node)
        .ok_or(CoreError::MissingEditableText { node })?;
    scene
        .resource(run.string_id)
        .filter(|resource| resource.kind == ResourceKind::Utf8String)
        .and_then(|resource| std::str::from_utf8(&resource.bytes).ok())
        .ok_or(CoreError::MissingEditableText { node })
}

fn utf16_len(value: &str) -> Result<u32, CoreError> {
    u32::try_from(value.encode_utf16().count())
        .map_err(|_| CoreError::InvalidEditableConfiguration("UTF-16 length exceeds u32"))
}
