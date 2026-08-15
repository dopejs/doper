use core::fmt;

use doper_abi::{AbiError, InputAffinity, InputBatch, InputCommand, InputPosition, InputSelection};

use crate::{
    Affinity, EditCommand, EditError, EditIntent, EditSession, EditTransaction, Selection,
    Utf16Position, Utf16Range,
};

/// Result of replaying one committed binary input transaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InputReplayOutcome {
    /// Monotonic sequence from the Input Stream Commit instruction.
    pub frame_seq: u32,
    /// Editing transactions in exact input order.
    pub transactions: Vec<EditTransaction>,
}

/// Failure to decode, route, or atomically apply a binary input transaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InputReplayError {
    /// The untrusted binary stream is malformed or unsupported.
    Abi(AbiError),
    /// A command targets a different active editing session.
    WrongTarget {
        /// Node owned by this editing session.
        expected: u32,
        /// Node encoded in the rejected command.
        actual: u32,
    },
    /// A revision, offset, composition, or resource invariant was rejected.
    Edit(EditError),
}

impl fmt::Display for InputReplayError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "input replay rejected: {self:?}")
    }
}

impl std::error::Error for InputReplayError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Abi(error) => Some(error),
            Self::Edit(error) => Some(error),
            Self::WrongTarget { .. } => None,
        }
    }
}

impl From<AbiError> for InputReplayError {
    fn from(value: AbiError) -> Self {
        Self::Abi(value)
    }
}

impl From<EditError> for InputReplayError {
    fn from(value: EditError) -> Self {
        Self::Edit(value)
    }
}

impl EditSession {
    /// Decodes and atomically replays one versioned Input Stream transaction.
    ///
    /// The session is unchanged when any command is malformed, misrouted, or
    /// rejected. This makes recorded composition sequences safe replay inputs.
    pub fn replay_input(
        &mut self,
        node_id: u32,
        bytes: &[u8],
    ) -> Result<InputReplayOutcome, InputReplayError> {
        let batch = InputBatch::decode(bytes)?;
        let mut candidate = self.clone();
        let mut transactions = Vec::with_capacity(batch.instructions.len());
        for instruction in batch.instructions {
            let (actual_node, command) = edit_command(instruction.command);
            if actual_node != node_id {
                return Err(InputReplayError::WrongTarget {
                    expected: node_id,
                    actual: actual_node,
                });
            }
            transactions.push(candidate.apply(command)?);
        }
        *self = candidate;
        Ok(InputReplayOutcome {
            frame_seq: batch.frame_seq,
            transactions,
        })
    }
}

fn edit_command(command: InputCommand) -> (u32, EditCommand) {
    let (node_id, base_revision, intent) = match command {
        InputCommand::Replace {
            node_id,
            base_revision,
            start,
            end,
            text,
        } => (
            node_id,
            base_revision,
            EditIntent::Replace {
                range: Utf16Range::new(start, end),
                text,
            },
        ),
        InputCommand::Insert {
            node_id,
            base_revision,
            text,
        } => (node_id, base_revision, EditIntent::Insert(text)),
        InputCommand::DeleteBackward {
            node_id,
            base_revision,
        } => (node_id, base_revision, EditIntent::DeleteBackward),
        InputCommand::DeleteForward {
            node_id,
            base_revision,
        } => (node_id, base_revision, EditIntent::DeleteForward),
        InputCommand::SetSelection {
            node_id,
            base_revision,
            selection,
        } => (
            node_id,
            base_revision,
            EditIntent::SetSelection(selection_from_wire(selection)),
        ),
        InputCommand::BeginComposition {
            node_id,
            base_revision,
        } => (node_id, base_revision, EditIntent::BeginComposition),
        InputCommand::UpdateComposition {
            node_id,
            base_revision,
            text,
        } => (node_id, base_revision, EditIntent::UpdateComposition(text)),
        InputCommand::CommitComposition {
            node_id,
            base_revision,
            text,
        } => (node_id, base_revision, EditIntent::CommitComposition(text)),
        InputCommand::CancelComposition {
            node_id,
            base_revision,
        } => (node_id, base_revision, EditIntent::CancelComposition),
        InputCommand::Undo {
            node_id,
            base_revision,
        } => (node_id, base_revision, EditIntent::Undo),
        InputCommand::Redo {
            node_id,
            base_revision,
        } => (node_id, base_revision, EditIntent::Redo),
    };
    (
        node_id,
        EditCommand {
            base_revision,
            intent,
        },
    )
}

fn selection_from_wire(selection: InputSelection) -> Selection {
    Selection {
        anchor: position_from_wire(selection.anchor),
        focus: position_from_wire(selection.focus),
    }
}

const fn position_from_wire(position: InputPosition) -> Utf16Position {
    Utf16Position {
        offset: position.offset,
        affinity: match position.affinity {
            InputAffinity::Upstream => Affinity::Upstream,
            InputAffinity::Downstream => Affinity::Downstream,
        },
    }
}

#[cfg(test)]
mod tests {
    use doper_abi::{InputInstruction, InputOpcode};

    use super::*;
    use crate::EditConfig;

    fn instruction(command: InputCommand) -> InputInstruction {
        InputInstruction { flags: 0, command }
    }

    fn session() -> EditSession {
        EditSession::new(
            String::new(),
            Selection::collapsed(0),
            10,
            EditConfig::default(),
        )
        .expect("session")
    }

    #[test]
    fn composition_recording_replays_deterministically() {
        let bytes = InputBatch {
            frame_seq: 42,
            instructions: vec![
                instruction(InputCommand::BeginComposition {
                    node_id: 7,
                    base_revision: 10,
                }),
                instruction(InputCommand::UpdateComposition {
                    node_id: 7,
                    base_revision: 11,
                    text: "你".to_owned(),
                }),
                instruction(InputCommand::CommitComposition {
                    node_id: 7,
                    base_revision: 12,
                    text: Some("你好".to_owned()),
                }),
            ],
        }
        .encode()
        .expect("input bytes");

        let mut first = session();
        let mut second = session();
        let first_outcome = first.replay_input(7, &bytes).expect("first replay");
        let second_outcome = second.replay_input(7, &bytes).expect("second replay");
        assert_eq!(first_outcome, second_outcome);
        assert_eq!(first_outcome.frame_seq, 42);
        assert_eq!(first_outcome.transactions.len(), 3);
        assert_eq!(first.text(), "你好");
        assert_eq!(first.revision(), 13);
        assert_eq!(first.composition_range(), None);
        assert!(first.can_undo());
        assert_eq!(first.text(), second.text());
        assert_eq!(first.selection(), second.selection());
    }

    #[test]
    fn late_failure_rolls_back_the_entire_input_batch() {
        let bytes = InputBatch {
            frame_seq: 1,
            instructions: vec![
                instruction(InputCommand::Insert {
                    node_id: 7,
                    base_revision: 10,
                    text: "accepted only in candidate".to_owned(),
                }),
                instruction(InputCommand::DeleteBackward {
                    node_id: 7,
                    base_revision: 10,
                }),
            ],
        }
        .encode()
        .expect("input bytes");
        let mut session = session();
        assert_eq!(
            session.replay_input(7, &bytes),
            Err(InputReplayError::Edit(EditError::StaleRevision {
                current: 11,
                supplied: 10,
            }))
        );
        assert_eq!(session.text(), "");
        assert_eq!(session.revision(), 10);
        assert!(!session.can_undo());
    }

    #[test]
    fn rejects_wrong_targets_and_malformed_streams_without_state_change() {
        let bytes = InputBatch {
            frame_seq: 1,
            instructions: vec![instruction(InputCommand::Undo {
                node_id: 8,
                base_revision: 10,
            })],
        }
        .encode()
        .expect("input bytes");
        let mut session = session();
        assert_eq!(
            session.replay_input(7, &bytes),
            Err(InputReplayError::WrongTarget {
                expected: 7,
                actual: 8,
            })
        );
        assert_eq!(session.revision(), 10);

        let mut malformed = bytes;
        malformed[16] = InputOpcode::Commit as u8;
        assert!(matches!(
            session.replay_input(7, &malformed),
            Err(InputReplayError::Abi(_))
        ));
        assert_eq!(session.revision(), 10);
    }
}
