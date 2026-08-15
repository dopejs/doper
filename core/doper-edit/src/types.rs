/// Caret affinity when a logical position has two visual interpretations.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Affinity {
    /// Prefer the preceding grapheme/line edge.
    Upstream,
    /// Prefer the following grapheme/line edge.
    #[default]
    Downstream,
}

/// A UTF-16 code-unit position used at browser protocol boundaries.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Utf16Position {
    /// UTF-16 code-unit offset.
    pub offset: u32,
    /// Visual edge preference.
    pub affinity: Affinity,
}

impl Utf16Position {
    /// Creates a downstream-affinity position.
    #[must_use]
    pub const fn new(offset: u32) -> Self {
        Self {
            offset,
            affinity: Affinity::Downstream,
        }
    }
}

/// A normalized half-open UTF-16 range.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Utf16Range {
    /// Inclusive start offset.
    pub start: u32,
    /// Exclusive end offset.
    pub end: u32,
}

impl Utf16Range {
    /// Creates a range; validation occurs against a concrete text revision.
    #[must_use]
    pub const fn new(start: u32, end: u32) -> Self {
        Self { start, end }
    }

    /// Creates a collapsed range.
    #[must_use]
    pub const fn collapsed(offset: u32) -> Self {
        Self {
            start: offset,
            end: offset,
        }
    }

    /// Returns whether no text is selected.
    #[must_use]
    pub const fn is_collapsed(self) -> bool {
        self.start == self.end
    }
}

/// Anchor/focus selection preserving direction and affinity.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Selection {
    /// Fixed selection edge.
    pub anchor: Utf16Position,
    /// Moving selection edge and caret location.
    pub focus: Utf16Position,
}

impl Selection {
    /// Creates a collapsed downstream-affinity selection.
    #[must_use]
    pub const fn collapsed(offset: u32) -> Self {
        let position = Utf16Position::new(offset);
        Self {
            anchor: position,
            focus: position,
        }
    }

    /// Returns the direction-independent selected range.
    #[must_use]
    pub const fn range(self) -> Utf16Range {
        if self.anchor.offset <= self.focus.offset {
            Utf16Range::new(self.anchor.offset, self.focus.offset)
        } else {
            Utf16Range::new(self.focus.offset, self.anchor.offset)
        }
    }

    /// Returns whether the selection is a caret.
    #[must_use]
    pub const fn is_collapsed(self) -> bool {
        self.anchor.offset == self.focus.offset
    }
}

/// Resource and behavior limits for one editing session.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EditConfig {
    /// Whether line terminators are accepted.
    pub multiline: bool,
    /// Maximum UTF-8 storage for the active value.
    pub max_utf8_bytes: usize,
    /// Maximum user-perceived characters.
    pub max_graphemes: usize,
    /// Maximum retained undo entries.
    pub max_history_entries: usize,
    /// Maximum UTF-8 payload retained by undo entries.
    pub max_history_bytes: usize,
}

impl Default for EditConfig {
    fn default() -> Self {
        Self {
            multiline: true,
            max_utf8_bytes: 16 * 1024 * 1024,
            max_graphemes: 1_000_000,
            max_history_entries: 100,
            max_history_bytes: 4 * 1024 * 1024,
        }
    }
}

/// One atomic replacement expressed in offsets from the prior revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditDelta {
    /// Replaced UTF-16 range.
    pub range: Utf16Range,
    /// Inserted UTF-8 text.
    pub text: String,
}

/// A browser-independent edit intent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EditIntent {
    /// Replaces an explicit logical range.
    Replace {
        /// Range in the command's base revision.
        range: Utf16Range,
        /// Replacement text.
        text: String,
    },
    /// Replaces the active selection.
    Insert(String),
    /// Deletes the selection or preceding grapheme.
    DeleteBackward,
    /// Deletes the selection or following grapheme.
    DeleteForward,
    /// Changes selection without changing text.
    SetSelection(Selection),
    /// Starts a single active IME composition over the selection.
    BeginComposition,
    /// Replaces the current composition span without adding undo history.
    UpdateComposition(String),
    /// Atomically commits the composition, optionally applying one final value.
    CommitComposition(Option<String>),
    /// Restores the pre-composition value and selection.
    CancelComposition,
    /// Applies the latest inverse transaction.
    Undo,
    /// Reapplies the latest undone transaction.
    Redo,
}

/// A revision-checked input message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditCommand {
    /// Exact Core revision the producer observed.
    pub base_revision: u64,
    /// Requested edit.
    pub intent: EditIntent,
}

/// Source semantics for a committed state transition.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransactionKind {
    /// Ordinary insertion, replacement, deletion, or selection change.
    Edit,
    /// IME composition lifecycle update.
    Composition,
    /// Undo operation.
    Undo,
    /// Redo operation.
    Redo,
    /// Authoritative external value replacement.
    External,
}

/// A committed Core edit transition for Shell acknowledgement or replay.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditTransaction {
    /// Revision this transaction was applied to.
    pub base_revision: u64,
    /// New Core revision.
    pub revision: u64,
    /// Text replacement, absent for selection/lifecycle-only changes.
    pub delta: Option<EditDelta>,
    /// Selection after the transaction.
    pub selection: Selection,
    /// Active temporary composition span.
    pub composition: Option<Utf16Range>,
    /// Transition source.
    pub kind: TransactionKind,
}

/// Authoritative Shell state used for correction or recovery.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExternalValue {
    /// Revision newer than the active Core revision.
    pub revision: u64,
    /// Complete UTF-8 value.
    pub text: String,
    /// Browser-facing UTF-16 selection.
    pub selection: Selection,
}
