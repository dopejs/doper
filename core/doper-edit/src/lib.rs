#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Deterministic, revisioned editable-text state for doper Core.

mod error;
mod index;
mod input;
mod session;
mod types;

pub use error::EditError;
pub use index::{OffsetBias, TextIndex};
pub use input::{InputReplayError, InputReplayOutcome};
pub use session::EditSession;
pub use types::{
    Affinity, EditCommand, EditConfig, EditDelta, EditIntent, EditTransaction, ExternalValue,
    Selection, TransactionKind, Utf16Position, Utf16Range,
};
