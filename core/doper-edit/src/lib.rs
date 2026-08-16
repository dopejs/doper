#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Deterministic, revisioned editable-text state for doper Core.

mod error;
mod index;
mod input;
mod session;
mod types;

pub use error::EditError;
pub use index::{OffsetBias, TextIndex, word_range_utf16};
pub use input::{InputReplayError, InputReplayOutcome, edit_command_from_input};
pub use session::EditSession;
pub use types::{
    Affinity, EditCommand, EditConfig, EditDelta, EditIntent, EditTransaction, ExternalValue,
    Selection, TransactionKind, Utf16Position, Utf16Range,
};
