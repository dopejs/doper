use std::collections::VecDeque;

use crate::{
    EditCommand, EditConfig, EditDelta, EditError, EditIntent, EditTransaction, ExternalValue,
    OffsetBias, Selection, TextIndex, TransactionKind, Utf16Range,
};

#[derive(Clone, Debug, Eq, PartialEq)]
struct Composition {
    original_range: Utf16Range,
    current_range: Utf16Range,
    original_text: String,
    original_selection: Selection,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct HistoryEntry {
    forward: EditDelta,
    inverse: EditDelta,
    before_selection: Selection,
    after_selection: Selection,
    retained_bytes: usize,
}

struct PreparedReplacement {
    next_text: String,
    next_index: TextIndex,
    forward: EditDelta,
    inverse: EditDelta,
    after_selection: Selection,
    text_changed: bool,
}

/// Core-owned state for one active editable-text node.
#[derive(Clone)]
pub struct EditSession {
    text: String,
    index: TextIndex,
    selection: Selection,
    composition: Option<Composition>,
    revision: u64,
    config: EditConfig,
    undo: VecDeque<HistoryEntry>,
    redo: VecDeque<HistoryEntry>,
    undo_bytes: usize,
    redo_bytes: usize,
}

impl EditSession {
    /// Creates a validated session from authoritative initial state.
    pub fn new(
        text: String,
        selection: Selection,
        revision: u64,
        config: EditConfig,
    ) -> Result<Self, EditError> {
        let index = TextIndex::new(&text)?;
        validate_value(&config, &text, &index)?;
        let selection = index.normalize_selection(selection)?;
        Ok(Self {
            text,
            index,
            selection,
            composition: None,
            revision,
            config,
            undo: VecDeque::new(),
            redo: VecDeque::new(),
            undo_bytes: 0,
            redo_bytes: 0,
        })
    }

    /// Returns the active UTF-8 value.
    #[must_use]
    pub fn text(&self) -> &str {
        &self.text
    }

    /// Returns the conversion table for the active revision.
    #[must_use]
    pub const fn text_index(&self) -> &TextIndex {
        &self.index
    }

    /// Returns the active directed selection.
    #[must_use]
    pub const fn selection(&self) -> Selection {
        self.selection
    }

    /// Returns the active Core revision.
    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    /// Returns the temporary composition span.
    #[must_use]
    pub fn composition_range(&self) -> Option<Utf16Range> {
        self.composition
            .as_ref()
            .map(|composition| composition.current_range)
    }

    /// Returns whether an undo operation is available.
    #[must_use]
    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty() && self.composition.is_none()
    }

    /// Returns whether a redo operation is available.
    #[must_use]
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty() && self.composition.is_none()
    }

    /// Applies one exact-base-revision command atomically.
    pub fn apply(&mut self, command: EditCommand) -> Result<EditTransaction, EditError> {
        if command.base_revision != self.revision {
            return Err(EditError::StaleRevision {
                current: self.revision,
                supplied: command.base_revision,
            });
        }
        let next_revision = self
            .revision
            .checked_add(1)
            .ok_or(EditError::RevisionOverflow)?;
        if self.composition.is_some()
            && matches!(
                command.intent,
                EditIntent::Replace { .. }
                    | EditIntent::Insert(_)
                    | EditIntent::DeleteBackward
                    | EditIntent::DeleteForward
                    | EditIntent::Undo
                    | EditIntent::Redo
            )
        {
            return Err(EditError::CompositionActive);
        }

        let (delta, kind) = match command.intent {
            EditIntent::Replace { range, text } => {
                let prepared = self.prepare_replacement(range, text)?;
                let delta = prepared.forward.clone();
                self.commit_regular(prepared);
                (Some(delta), TransactionKind::Edit)
            }
            EditIntent::Insert(text) => {
                let prepared = self.prepare_replacement(self.selection.range(), text)?;
                let delta = prepared.forward.clone();
                self.commit_regular(prepared);
                (Some(delta), TransactionKind::Edit)
            }
            EditIntent::DeleteBackward => {
                let range = if self.selection.is_collapsed() {
                    let caret = self.selection.focus.offset;
                    Utf16Range::new(self.index.previous(caret)?, caret)
                } else {
                    self.selection.range()
                };
                let prepared = self.prepare_replacement(range, String::new())?;
                let delta = prepared.forward.clone();
                self.commit_regular(prepared);
                (Some(delta), TransactionKind::Edit)
            }
            EditIntent::DeleteForward => {
                let range = if self.selection.is_collapsed() {
                    let caret = self.selection.focus.offset;
                    Utf16Range::new(caret, self.index.next(caret)?)
                } else {
                    self.selection.range()
                };
                let prepared = self.prepare_replacement(range, String::new())?;
                let delta = prepared.forward.clone();
                self.commit_regular(prepared);
                (Some(delta), TransactionKind::Edit)
            }
            EditIntent::SetSelection(selection) => {
                self.selection = self.index.normalize_selection(selection)?;
                (None, TransactionKind::Edit)
            }
            EditIntent::BeginComposition => {
                if self.composition.is_some() {
                    return Err(EditError::CompositionAlreadyActive);
                }
                let range = self.index.normalize_range(self.selection.range())?;
                let original_text = self.slice(range)?.to_owned();
                self.composition = Some(Composition {
                    original_range: range,
                    current_range: range,
                    original_text,
                    original_selection: self.selection,
                });
                (None, TransactionKind::Composition)
            }
            EditIntent::UpdateComposition(text) => {
                let composition = self
                    .composition
                    .clone()
                    .ok_or(EditError::CompositionNotActive)?;
                let prepared = self.prepare_replacement(composition.current_range, text)?;
                let delta = prepared.forward.clone();
                let next_range = range_after(&prepared.forward)?;
                self.commit_prepared(prepared);
                self.composition
                    .as_mut()
                    .expect("composition validated before replacement")
                    .current_range = next_range;
                (Some(delta), TransactionKind::Composition)
            }
            EditIntent::CommitComposition(final_text) => {
                let mut composition = self
                    .composition
                    .clone()
                    .ok_or(EditError::CompositionNotActive)?;
                let delta = if let Some(text) = final_text {
                    let prepared = self.prepare_replacement(composition.current_range, text)?;
                    let delta = prepared.forward.clone();
                    composition.current_range = range_after(&prepared.forward)?;
                    self.commit_prepared(prepared);
                    Some(delta)
                } else {
                    None
                };
                let final_text = self.slice(composition.current_range)?.to_owned();
                let forward = EditDelta {
                    range: composition.original_range,
                    text: final_text,
                };
                let inverse = EditDelta {
                    range: composition.current_range,
                    text: composition.original_text,
                };
                if forward.text != inverse.text || forward.range != inverse.range {
                    let entry = HistoryEntry::new(
                        forward,
                        inverse,
                        composition.original_selection,
                        self.selection,
                    );
                    self.push_undo(entry);
                    self.clear_redo();
                }
                self.composition = None;
                (delta, TransactionKind::Composition)
            }
            EditIntent::CancelComposition => {
                let composition = self
                    .composition
                    .clone()
                    .ok_or(EditError::CompositionNotActive)?;
                let prepared =
                    self.prepare_replacement(composition.current_range, composition.original_text)?;
                let delta = prepared.forward.clone();
                self.commit_prepared(prepared);
                self.selection = composition.original_selection;
                self.composition = None;
                (Some(delta), TransactionKind::Composition)
            }
            EditIntent::Undo => {
                let entry = self.undo.back().ok_or(EditError::NothingToUndo)?;
                let prepared =
                    self.prepare_replacement(entry.inverse.range, entry.inverse.text.clone())?;
                let delta = prepared.forward.clone();
                let entry = self.undo.pop_back().expect("history entry validated");
                self.undo_bytes -= entry.retained_bytes;
                self.commit_prepared(prepared);
                self.selection = entry.before_selection;
                self.redo_bytes += entry.retained_bytes;
                self.redo.push_back(entry);
                (Some(delta), TransactionKind::Undo)
            }
            EditIntent::Redo => {
                let entry = self.redo.back().ok_or(EditError::NothingToRedo)?;
                let prepared =
                    self.prepare_replacement(entry.forward.range, entry.forward.text.clone())?;
                let delta = prepared.forward.clone();
                let entry = self.redo.pop_back().expect("redo entry validated");
                self.redo_bytes -= entry.retained_bytes;
                self.commit_prepared(prepared);
                self.selection = entry.after_selection;
                self.undo_bytes += entry.retained_bytes;
                self.undo.push_back(entry);
                (Some(delta), TransactionKind::Redo)
            }
        };

        let base_revision = self.revision;
        self.revision = next_revision;
        Ok(EditTransaction {
            base_revision,
            revision: next_revision,
            delta,
            selection: self.selection,
            composition: self.composition_range(),
            kind,
        })
    }

    /// Applies a strictly newer authoritative Shell value and clears local history.
    pub fn apply_external(
        &mut self,
        external: ExternalValue,
    ) -> Result<EditTransaction, EditError> {
        if external.revision <= self.revision {
            return Err(EditError::StaleRevision {
                current: self.revision,
                supplied: external.revision,
            });
        }
        let index = TextIndex::new(&external.text)?;
        validate_value(&self.config, &external.text, &index)?;
        let selection = index.normalize_selection(external.selection)?;
        let base_revision = self.revision;
        let delta = EditDelta {
            range: Utf16Range::new(0, self.index.utf16_len()),
            text: external.text.clone(),
        };
        self.text = external.text;
        self.index = index;
        self.selection = selection;
        self.composition = None;
        self.revision = external.revision;
        self.undo.clear();
        self.redo.clear();
        self.undo_bytes = 0;
        self.redo_bytes = 0;
        Ok(EditTransaction {
            base_revision,
            revision: self.revision,
            delta: Some(delta),
            selection: self.selection,
            composition: None,
            kind: TransactionKind::External,
        })
    }

    fn prepare_replacement(
        &self,
        range: Utf16Range,
        inserted: String,
    ) -> Result<PreparedReplacement, EditError> {
        let range = self.index.normalize_range(range)?;
        let start = self
            .index
            .utf16_to_utf8(range.start, OffsetBias::Backward)?;
        let end = self.index.utf16_to_utf8(range.end, OffsetBias::Forward)?;
        let removed = self.text[start..end].to_owned();
        let mut next_text = String::with_capacity(self.text.len() - (end - start) + inserted.len());
        next_text.push_str(&self.text[..start]);
        next_text.push_str(&inserted);
        next_text.push_str(&self.text[end..]);
        let next_index = TextIndex::new(&next_text)?;
        validate_value(&self.config, &next_text, &next_index)?;
        let inserted_units = u32::try_from(inserted.encode_utf16().count())
            .map_err(|_| EditError::OffsetOverflow)?;
        let inserted_end = range
            .start
            .checked_add(inserted_units)
            .ok_or(EditError::OffsetOverflow)?;
        let after_selection = Selection::collapsed(inserted_end);
        let text_changed = next_text != self.text;
        Ok(PreparedReplacement {
            next_text,
            next_index,
            forward: EditDelta {
                range,
                text: inserted,
            },
            inverse: EditDelta {
                range: Utf16Range::new(range.start, inserted_end),
                text: removed,
            },
            after_selection,
            text_changed,
        })
    }

    fn commit_regular(&mut self, prepared: PreparedReplacement) {
        let entry = prepared.text_changed.then(|| {
            HistoryEntry::new(
                prepared.forward.clone(),
                prepared.inverse.clone(),
                self.selection,
                prepared.after_selection,
            )
        });
        self.commit_prepared(prepared);
        if let Some(entry) = entry {
            self.push_undo(entry);
            self.clear_redo();
        }
    }

    fn commit_prepared(&mut self, prepared: PreparedReplacement) {
        self.text = prepared.next_text;
        self.index = prepared.next_index;
        self.selection = prepared.after_selection;
    }

    fn slice(&self, range: Utf16Range) -> Result<&str, EditError> {
        let range = self.index.normalize_range(range)?;
        let start = self
            .index
            .utf16_to_utf8(range.start, OffsetBias::Backward)?;
        let end = self.index.utf16_to_utf8(range.end, OffsetBias::Forward)?;
        Ok(&self.text[start..end])
    }

    fn push_undo(&mut self, entry: HistoryEntry) {
        if self.config.max_history_entries == 0
            || entry.retained_bytes > self.config.max_history_bytes
        {
            self.undo.clear();
            self.undo_bytes = 0;
            return;
        }
        self.undo_bytes += entry.retained_bytes;
        self.undo.push_back(entry);
        while self.undo.len() > self.config.max_history_entries
            || self.undo_bytes > self.config.max_history_bytes
        {
            let removed = self.undo.pop_front().expect("history is non-empty");
            self.undo_bytes -= removed.retained_bytes;
        }
    }

    fn clear_redo(&mut self) {
        self.redo.clear();
        self.redo_bytes = 0;
    }
}

impl HistoryEntry {
    fn new(
        forward: EditDelta,
        inverse: EditDelta,
        before_selection: Selection,
        after_selection: Selection,
    ) -> Self {
        let retained_bytes = forward.text.len() + inverse.text.len();
        Self {
            forward,
            inverse,
            before_selection,
            after_selection,
            retained_bytes,
        }
    }
}

fn range_after(delta: &EditDelta) -> Result<Utf16Range, EditError> {
    let units =
        u32::try_from(delta.text.encode_utf16().count()).map_err(|_| EditError::OffsetOverflow)?;
    let end = delta
        .range
        .start
        .checked_add(units)
        .ok_or(EditError::OffsetOverflow)?;
    Ok(Utf16Range::new(delta.range.start, end))
}

fn validate_value(config: &EditConfig, text: &str, index: &TextIndex) -> Result<(), EditError> {
    if !config.multiline
        && text
            .chars()
            .any(|character| matches!(character, '\n' | '\r'))
    {
        return Err(EditError::NewlineNotAllowed);
    }
    if text.len() > config.max_utf8_bytes {
        return Err(EditError::TextByteLimitExceeded {
            actual: text.len(),
            maximum: config.max_utf8_bytes,
        });
    }
    if index.grapheme_count() > config.max_graphemes {
        return Err(EditError::GraphemeLimitExceeded {
            actual: index.grapheme_count(),
            maximum: config.max_graphemes,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;
    use crate::Utf16Position;

    fn session(text: &str, selection: Selection) -> EditSession {
        EditSession::new(text.to_owned(), selection, 0, EditConfig::default()).expect("session")
    }

    fn apply(session: &mut EditSession, intent: EditIntent) -> EditTransaction {
        session
            .apply(EditCommand {
                base_revision: session.revision(),
                intent,
            })
            .expect("accepted command")
    }

    #[test]
    fn stale_command_cannot_overwrite_newer_input() {
        let mut editor = session("", Selection::collapsed(0));
        apply(&mut editor, EditIntent::Insert("a".to_owned()));
        let before = (
            editor.text().to_owned(),
            editor.selection(),
            editor.revision(),
        );
        assert_eq!(
            editor.apply(EditCommand {
                base_revision: 0,
                intent: EditIntent::Insert("stale".to_owned()),
            }),
            Err(EditError::StaleRevision {
                current: 1,
                supplied: 0,
            })
        );
        assert_eq!(
            (
                editor.text().to_owned(),
                editor.selection(),
                editor.revision()
            ),
            before
        );
    }

    #[test]
    fn backward_delete_removes_one_extended_grapheme() {
        let value = "a\u{301}👨‍👩‍👧‍👦";
        let end = value.encode_utf16().count() as u32;
        let mut editor = session(value, Selection::collapsed(end));
        apply(&mut editor, EditIntent::DeleteBackward);
        assert_eq!(editor.text(), "a\u{301}");
        apply(&mut editor, EditIntent::DeleteBackward);
        assert_eq!(editor.text(), "");
    }

    #[test]
    fn composition_updates_commit_as_one_undo_unit() {
        let mut editor = session(
            "ab",
            Selection {
                anchor: Utf16Position::new(1),
                focus: Utf16Position::new(2),
            },
        );
        apply(&mut editor, EditIntent::BeginComposition);
        apply(&mut editor, EditIntent::UpdateComposition("に".to_owned()));
        apply(
            &mut editor,
            EditIntent::UpdateComposition("日本".to_owned()),
        );
        apply(&mut editor, EditIntent::CommitComposition(None));
        assert_eq!(editor.text(), "a日本");
        assert!(editor.can_undo());
        apply(&mut editor, EditIntent::Undo);
        assert_eq!(editor.text(), "ab");
        assert!(!editor.can_undo());
        apply(&mut editor, EditIntent::Redo);
        assert_eq!(editor.text(), "a日本");
    }

    #[test]
    fn cancel_composition_restores_value_and_selection() {
        let original_selection = Selection::collapsed(1);
        let mut editor = session("ab", original_selection);
        apply(&mut editor, EditIntent::BeginComposition);
        apply(
            &mut editor,
            EditIntent::UpdateComposition("候補".to_owned()),
        );
        apply(&mut editor, EditIntent::CancelComposition);
        assert_eq!(editor.text(), "ab");
        assert_eq!(editor.selection(), original_selection);
        assert!(!editor.can_undo());
    }

    #[test]
    fn newer_external_value_cancels_composition_and_history() {
        let mut editor = session("old", Selection::collapsed(3));
        apply(&mut editor, EditIntent::Insert("!".to_owned()));
        apply(&mut editor, EditIntent::BeginComposition);
        let current = editor.revision();
        editor
            .apply_external(ExternalValue {
                revision: current + 10,
                text: "server".to_owned(),
                selection: Selection::collapsed(6),
            })
            .expect("newer external state");
        assert_eq!(editor.text(), "server");
        assert_eq!(editor.composition_range(), None);
        assert!(!editor.can_undo());
        assert_eq!(
            editor.apply_external(ExternalValue {
                revision: current,
                text: "stale".to_owned(),
                selection: Selection::collapsed(0),
            }),
            Err(EditError::StaleRevision {
                current: current + 10,
                supplied: current,
            })
        );
    }

    proptest! {
        #[test]
        fn arbitrary_insert_delete_sequences_are_grapheme_safe_and_reversible(
            operations in prop::collection::vec((any::<bool>(), 0_usize..5), 0..100),
        ) {
            let corpus = ["a", "é", "a\u{301}", "👨‍👩‍👧‍👦", "日本"];
            let mut editor = session("", Selection::collapsed(0));
            let mut last_revision = editor.revision();
            for (insert, corpus_index) in operations {
                let intent = if insert {
                    EditIntent::Insert(corpus[corpus_index].to_owned())
                } else {
                    EditIntent::DeleteBackward
                };
                apply(&mut editor, intent);
                prop_assert!(editor.revision() > last_revision);
                last_revision = editor.revision();
                let focus = editor.selection().focus.offset;
                let byte = editor.text_index().utf16_to_utf8(focus, OffsetBias::Backward).expect("focus");
                prop_assert_eq!(editor.text_index().utf8_to_utf16(byte), Ok(focus));
            }
            let final_text = editor.text().to_owned();
            while editor.can_undo() {
                apply(&mut editor, EditIntent::Undo);
            }
            prop_assert_eq!(editor.text(), "");
            while editor.can_redo() {
                apply(&mut editor, EditIntent::Redo);
            }
            prop_assert_eq!(editor.text(), final_text);
        }

        #[test]
        fn replaying_the_same_intents_is_deterministic(
            operations in prop::collection::vec((any::<bool>(), 0_usize..3), 0..64),
        ) {
            let corpus = ["x", "🙂", "e\u{301}"];
            let mut first = session("", Selection::collapsed(0));
            let mut second = session("", Selection::collapsed(0));
            for (insert, corpus_index) in operations {
                let intent = if insert {
                    EditIntent::Insert(corpus[corpus_index].to_owned())
                } else {
                    EditIntent::DeleteBackward
                };
                let left = apply(&mut first, intent.clone());
                let right = apply(&mut second, intent);
                prop_assert_eq!(left, right);
                prop_assert_eq!(first.text(), second.text());
            }
        }
    }
}
