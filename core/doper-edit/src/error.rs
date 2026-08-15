use core::fmt;

/// A rejected edit. The active session remains unchanged.
#[allow(missing_docs)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EditError {
    StaleRevision { current: u64, supplied: u64 },
    RevisionOverflow,
    OffsetOverflow,
    InvalidRange { start: u32, end: u32, text_len: u32 },
    InvalidUtf8Boundary { offset: usize },
    CompositionAlreadyActive,
    CompositionNotActive,
    CompositionActive,
    NothingToUndo,
    NothingToRedo,
    NewlineNotAllowed,
    TextByteLimitExceeded { actual: usize, maximum: usize },
    GraphemeLimitExceeded { actual: usize, maximum: usize },
}

impl fmt::Display for EditError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "edit rejected: {self:?}")
    }
}

impl std::error::Error for EditError {}
