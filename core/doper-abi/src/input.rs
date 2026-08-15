use crate::codec::{
    Reader, Writer, checked_padding, read_header, read_instruction_header,
    validate_encode_instruction_count,
};
use crate::{
    AbiError, INPUT_MAGIC, InputOpcode, MAX_INPUT_BYTES, MAX_INPUT_INSTRUCTIONS,
    MAX_RESOURCE_BYTES, StreamKind,
};

/// Visual edge preference carried at the browser UTF-16 boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum InputAffinity {
    /// Prefer the preceding grapheme or line edge.
    Upstream = 0,
    /// Prefer the following grapheme or line edge.
    Downstream = 1,
}

impl InputAffinity {
    fn decode(value: u8) -> Result<Self, AbiError> {
        match value {
            0 => Ok(Self::Upstream),
            1 => Ok(Self::Downstream),
            _ => Err(AbiError::UnknownIdentifier {
                category: "input affinity",
                value: u32::from(value),
            }),
        }
    }
}

/// One UTF-16 input position and its visual affinity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InputPosition {
    /// UTF-16 code-unit offset.
    pub offset: u32,
    /// Visual edge preference.
    pub affinity: InputAffinity,
}

/// Directed anchor/focus selection from an input host.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InputSelection {
    /// Fixed edge.
    pub anchor: InputPosition,
    /// Moving edge and caret.
    pub focus: InputPosition,
}

const MAX_SCROLL_DELTA: f32 = 1_000_000.0;
const MAX_SCROLL_DELTA_MICROS: u32 = 1_000_000;

/// One browser-independent editing or direct-manipulation command.
#[derive(Clone, Debug, PartialEq)]
pub enum InputCommand {
    /// Replaces an explicit UTF-16 range.
    Replace {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
        /// Inclusive UTF-16 range start.
        start: u32,
        /// Exclusive UTF-16 range end.
        end: u32,
        /// Replacement UTF-8 text.
        text: String,
    },
    /// Replaces the active selection.
    Insert {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
        /// Inserted UTF-8 text.
        text: String,
    },
    /// Deletes the selection or preceding grapheme.
    DeleteBackward {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
    },
    /// Deletes the selection or following grapheme.
    DeleteForward {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
    },
    /// Updates the directed selection.
    SetSelection {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
        /// Directed selection in browser-facing UTF-16 offsets.
        selection: InputSelection,
    },
    /// Starts one IME composition.
    BeginComposition {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
    },
    /// Replaces the active composition span.
    UpdateComposition {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
        /// Current UTF-8 composition text.
        text: String,
    },
    /// Commits composition, optionally with a final replacement.
    CommitComposition {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
        /// Optional final UTF-8 composition text.
        text: Option<String>,
    },
    /// Restores the pre-composition state.
    CancelComposition {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
    },
    /// Applies the latest inverse edit.
    Undo {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
    },
    /// Reapplies the latest undone edit.
    Redo {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
    },
    /// Starts direct manipulation of a Core-owned scroll node.
    ScrollBegin {
        /// Generation-bearing target scroll node.
        node_id: u32,
    },
    /// Applies a timed two-dimensional logical content-offset delta.
    ScrollDelta {
        /// Generation-bearing target scroll node.
        node_id: u32,
        /// Horizontal logical-pixel delta.
        delta_x: f32,
        /// Vertical logical-pixel delta.
        delta_y: f32,
        /// Time since the preceding sample, in microseconds.
        elapsed_micros: u32,
    },
    /// Ends direct manipulation and starts a Core-estimated fling.
    ScrollEnd {
        /// Generation-bearing target scroll node.
        node_id: u32,
    },
    /// Cancels direct manipulation without retaining fling velocity.
    ScrollCancel {
        /// Generation-bearing target scroll node.
        node_id: u32,
    },
}

/// One input command plus versioned instruction flags.
#[derive(Clone, Debug, PartialEq)]
pub struct InputInstruction {
    /// Version 1 requires zero.
    pub flags: u8,
    /// Validated command.
    pub command: InputCommand,
}

/// A complete input transaction ending in one Commit instruction.
#[derive(Clone, Debug, PartialEq)]
pub struct InputBatch {
    /// Monotonic input transaction sequence.
    pub frame_seq: u32,
    /// Commands applied in deterministic order.
    pub instructions: Vec<InputInstruction>,
}

impl InputBatch {
    /// Decodes an untrusted input transaction without mutating editing state.
    pub fn decode(bytes: &[u8]) -> Result<Self, AbiError> {
        let mut reader = Reader::new(bytes);
        let declared_count = read_header(&mut reader, INPUT_MAGIC, MAX_INPUT_BYTES)?;
        validate_declared_count(declared_count, reader.remaining())?;
        let capacity = usize::try_from(declared_count).map_err(|_| AbiError::ArithmeticOverflow)?;
        let mut instructions = Vec::with_capacity(capacity.saturating_sub(1));
        let mut actual_count = 0_u32;
        let mut frame_seq = None;

        while reader.remaining() != 0 {
            let (offset, raw_opcode, flags) = read_instruction_header(&mut reader)?;
            actual_count = actual_count
                .checked_add(1)
                .ok_or(AbiError::ArithmeticOverflow)?;
            if frame_seq.is_some() {
                return Err(AbiError::CommitNotLast { offset });
            }
            let opcode = InputOpcode::from_u8(raw_opcode).ok_or(AbiError::UnknownOpcode {
                stream: StreamKind::Input,
                opcode: raw_opcode,
                offset,
            })?;
            if opcode == InputOpcode::Commit {
                frame_seq = Some(reader.read_u32()?);
                validate_instruction_size(opcode, offset, reader.offset())?;
                continue;
            }
            let command = decode_command(opcode, &mut reader)?;
            validate_instruction_size(opcode, offset, reader.offset())?;
            instructions.push(InputInstruction { flags, command });
        }
        if actual_count != declared_count {
            return Err(AbiError::InstructionCountMismatch {
                declared: declared_count,
                actual: actual_count,
            });
        }
        Ok(Self {
            frame_seq: frame_seq.ok_or(AbiError::MissingCommit)?,
            instructions,
        })
    }

    /// Encodes one canonical little-endian input transaction.
    pub fn encode(&self) -> Result<Vec<u8>, AbiError> {
        validate_encode_instruction_count(self.instructions.len(), 1, MAX_INPUT_INSTRUCTIONS)?;
        let mut writer = Writer::new(INPUT_MAGIC);
        for instruction in &self.instructions {
            encode_command(&mut writer, instruction)?;
        }
        let commit_offset = writer.offset();
        writer.instruction(InputOpcode::Commit as u8, 0);
        writer.u32(self.frame_seq);
        validate_instruction_size(InputOpcode::Commit, commit_offset, writer.offset())?;
        writer.finish(MAX_INPUT_BYTES)
    }
}

fn validate_declared_count(declared: u32, remaining: usize) -> Result<(), AbiError> {
    if declared > MAX_INPUT_INSTRUCTIONS {
        return Err(AbiError::InstructionCountTooLarge {
            declared,
            maximum: MAX_INPUT_INSTRUCTIONS,
        });
    }
    let maximum = u32::try_from(remaining / 4).map_err(|_| AbiError::ArithmeticOverflow)?;
    if declared > maximum {
        return Err(AbiError::InstructionCountTooLarge { declared, maximum });
    }
    Ok(())
}

fn decode_command(opcode: InputOpcode, reader: &mut Reader<'_>) -> Result<InputCommand, AbiError> {
    Ok(match opcode {
        InputOpcode::Replace => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::Replace {
                node_id,
                base_revision,
                start: reader.read_u32()?,
                end: reader.read_u32()?,
                text: read_text(reader)?,
            }
        }
        InputOpcode::Insert => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::Insert {
                node_id,
                base_revision,
                text: read_text(reader)?,
            }
        }
        InputOpcode::DeleteBackward => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::DeleteBackward {
                node_id,
                base_revision,
            }
        }
        InputOpcode::DeleteForward => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::DeleteForward {
                node_id,
                base_revision,
            }
        }
        InputOpcode::SetSelection => {
            let (node_id, base_revision) = read_target(reader)?;
            let anchor_offset = reader.read_u32()?;
            let focus_offset = reader.read_u32()?;
            let anchor_affinity = InputAffinity::decode(reader.read_u8()?)?;
            let focus_affinity = InputAffinity::decode(reader.read_u8()?)?;
            reader.read_zeroes(2)?;
            InputCommand::SetSelection {
                node_id,
                base_revision,
                selection: InputSelection {
                    anchor: InputPosition {
                        offset: anchor_offset,
                        affinity: anchor_affinity,
                    },
                    focus: InputPosition {
                        offset: focus_offset,
                        affinity: focus_affinity,
                    },
                },
            }
        }
        InputOpcode::BeginComposition => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::BeginComposition {
                node_id,
                base_revision,
            }
        }
        InputOpcode::UpdateComposition => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::UpdateComposition {
                node_id,
                base_revision,
                text: read_text(reader)?,
            }
        }
        InputOpcode::CommitComposition => {
            let (node_id, base_revision) = read_target(reader)?;
            let has_text = reader.read_u8()?;
            reader.read_zeroes(3)?;
            let text = read_text(reader)?;
            let text = match has_text {
                0 if text.is_empty() => None,
                1 => Some(text),
                0 => {
                    return Err(AbiError::InvalidValue(
                        "absent composition text is non-empty",
                    ));
                }
                _ => {
                    return Err(AbiError::InvalidValue(
                        "invalid composition text presence flag",
                    ));
                }
            };
            InputCommand::CommitComposition {
                node_id,
                base_revision,
                text,
            }
        }
        InputOpcode::CancelComposition => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::CancelComposition {
                node_id,
                base_revision,
            }
        }
        InputOpcode::Undo => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::Undo {
                node_id,
                base_revision,
            }
        }
        InputOpcode::Redo => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::Redo {
                node_id,
                base_revision,
            }
        }
        InputOpcode::ScrollBegin => InputCommand::ScrollBegin {
            node_id: reader.read_u32()?,
        },
        InputOpcode::ScrollDelta => {
            let node_id = reader.read_u32()?;
            let delta_x = reader.read_f32()?;
            let delta_y = reader.read_f32()?;
            if delta_x.abs() > MAX_SCROLL_DELTA || delta_y.abs() > MAX_SCROLL_DELTA {
                return Err(AbiError::InvalidValue("scroll delta exceeds maximum"));
            }
            let elapsed_micros = reader.read_u32()?;
            if elapsed_micros == 0 || elapsed_micros > MAX_SCROLL_DELTA_MICROS {
                return Err(AbiError::InvalidValue(
                    "scroll delta elapsed time is invalid",
                ));
            }
            InputCommand::ScrollDelta {
                node_id,
                delta_x,
                delta_y,
                elapsed_micros,
            }
        }
        InputOpcode::ScrollEnd => InputCommand::ScrollEnd {
            node_id: reader.read_u32()?,
        },
        InputOpcode::ScrollCancel => InputCommand::ScrollCancel {
            node_id: reader.read_u32()?,
        },
        InputOpcode::Commit => return Err(AbiError::InvalidValue("nested input commit")),
    })
}

fn encode_command(writer: &mut Writer, instruction: &InputInstruction) -> Result<(), AbiError> {
    let offset = writer.offset();
    if instruction.flags != 0 {
        return Err(AbiError::UnsupportedFlags {
            offset,
            flags: instruction.flags,
        });
    }
    let opcode = command_opcode(&instruction.command);
    writer.instruction(opcode as u8, instruction.flags);
    match &instruction.command {
        InputCommand::Replace {
            node_id,
            base_revision,
            start,
            end,
            text,
        } => {
            write_target(writer, *node_id, *base_revision);
            writer.u32(*start);
            writer.u32(*end);
            write_text(writer, text)?;
        }
        InputCommand::Insert {
            node_id,
            base_revision,
            text,
        }
        | InputCommand::UpdateComposition {
            node_id,
            base_revision,
            text,
        } => {
            write_target(writer, *node_id, *base_revision);
            write_text(writer, text)?;
        }
        InputCommand::SetSelection {
            node_id,
            base_revision,
            selection,
        } => {
            write_target(writer, *node_id, *base_revision);
            writer.u32(selection.anchor.offset);
            writer.u32(selection.focus.offset);
            writer.u8(selection.anchor.affinity as u8);
            writer.u8(selection.focus.affinity as u8);
            writer.u16(0);
        }
        InputCommand::CommitComposition {
            node_id,
            base_revision,
            text,
        } => {
            write_target(writer, *node_id, *base_revision);
            writer.u8(u8::from(text.is_some()));
            writer.u8(0);
            writer.u16(0);
            write_text(writer, text.as_deref().unwrap_or_default())?;
        }
        InputCommand::ScrollBegin { node_id }
        | InputCommand::ScrollEnd { node_id }
        | InputCommand::ScrollCancel { node_id } => writer.u32(*node_id),
        InputCommand::ScrollDelta {
            node_id,
            delta_x,
            delta_y,
            elapsed_micros,
        } => {
            if delta_x.abs() > MAX_SCROLL_DELTA || delta_y.abs() > MAX_SCROLL_DELTA {
                return Err(AbiError::InvalidValue("scroll delta exceeds maximum"));
            }
            if *elapsed_micros == 0 || *elapsed_micros > MAX_SCROLL_DELTA_MICROS {
                return Err(AbiError::InvalidValue(
                    "scroll delta elapsed time is invalid",
                ));
            }
            writer.u32(*node_id);
            writer.f32(*delta_x)?;
            writer.f32(*delta_y)?;
            writer.u32(*elapsed_micros);
        }
        command => {
            let (node_id, base_revision) = command_target(command);
            write_target(writer, node_id, base_revision);
        }
    }
    validate_instruction_size(opcode, offset, writer.offset())
}

fn command_target(command: &InputCommand) -> (u32, u64) {
    match command {
        InputCommand::DeleteBackward {
            node_id,
            base_revision,
        }
        | InputCommand::DeleteForward {
            node_id,
            base_revision,
        }
        | InputCommand::BeginComposition {
            node_id,
            base_revision,
        }
        | InputCommand::CancelComposition {
            node_id,
            base_revision,
        }
        | InputCommand::Undo {
            node_id,
            base_revision,
        }
        | InputCommand::Redo {
            node_id,
            base_revision,
        } => (*node_id, *base_revision),
        _ => unreachable!("variable input commands are encoded separately"),
    }
}

fn command_opcode(command: &InputCommand) -> InputOpcode {
    match command {
        InputCommand::Replace { .. } => InputOpcode::Replace,
        InputCommand::Insert { .. } => InputOpcode::Insert,
        InputCommand::DeleteBackward { .. } => InputOpcode::DeleteBackward,
        InputCommand::DeleteForward { .. } => InputOpcode::DeleteForward,
        InputCommand::SetSelection { .. } => InputOpcode::SetSelection,
        InputCommand::BeginComposition { .. } => InputOpcode::BeginComposition,
        InputCommand::UpdateComposition { .. } => InputOpcode::UpdateComposition,
        InputCommand::CommitComposition { .. } => InputOpcode::CommitComposition,
        InputCommand::CancelComposition { .. } => InputOpcode::CancelComposition,
        InputCommand::Undo { .. } => InputOpcode::Undo,
        InputCommand::Redo { .. } => InputOpcode::Redo,
        InputCommand::ScrollBegin { .. } => InputOpcode::ScrollBegin,
        InputCommand::ScrollDelta { .. } => InputOpcode::ScrollDelta,
        InputCommand::ScrollEnd { .. } => InputOpcode::ScrollEnd,
        InputCommand::ScrollCancel { .. } => InputOpcode::ScrollCancel,
    }
}

fn read_target(reader: &mut Reader<'_>) -> Result<(u32, u64), AbiError> {
    let node_id = reader.read_u32()?;
    let low = reader.read_u32()?;
    let high = reader.read_u32()?;
    Ok((node_id, u64::from(low) | (u64::from(high) << 32)))
}

fn write_target(writer: &mut Writer, node_id: u32, revision: u64) {
    writer.u32(node_id);
    writer.u32(revision as u32);
    writer.u32((revision >> 32) as u32);
}

fn read_text(reader: &mut Reader<'_>) -> Result<String, AbiError> {
    let length = usize::try_from(reader.read_u32()?).map_err(|_| AbiError::ArithmeticOverflow)?;
    if length > MAX_RESOURCE_BYTES {
        return Err(AbiError::ResourceTooLarge {
            actual: length,
            maximum: MAX_RESOURCE_BYTES,
        });
    }
    let bytes = reader.read_bytes(length)?;
    let text = std::str::from_utf8(bytes)
        .map_err(|_| AbiError::InvalidValue("input text is not valid UTF-8"))?
        .to_owned();
    reader.read_zeroes(checked_padding(length)?)?;
    Ok(text)
}

fn write_text(writer: &mut Writer, text: &str) -> Result<(), AbiError> {
    if text.len() > MAX_RESOURCE_BYTES {
        return Err(AbiError::ResourceTooLarge {
            actual: text.len(),
            maximum: MAX_RESOURCE_BYTES,
        });
    }
    writer.u32(u32::try_from(text.len()).map_err(|_| AbiError::ArithmeticOverflow)?);
    writer.bytes(text.as_bytes());
    writer.pad();
    Ok(())
}

fn validate_instruction_size(
    opcode: InputOpcode,
    offset: usize,
    end: usize,
) -> Result<(), AbiError> {
    let actual = end
        .checked_sub(offset)
        .ok_or(AbiError::ArithmeticOverflow)?;
    if let Some(expected) = opcode.fixed_bytes()
        && actual != expected
    {
        return Err(AbiError::InstructionLengthMismatch {
            opcode: opcode as u8,
            offset,
            expected,
            actual,
        });
    }
    if actual < opcode.minimum_bytes() {
        return Err(AbiError::InstructionLengthMismatch {
            opcode: opcode as u8,
            offset,
            expected: opcode.minimum_bytes(),
            actual,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn instruction(command: InputCommand) -> InputInstruction {
        InputInstruction { flags: 0, command }
    }

    fn sample_batch() -> InputBatch {
        let revision = 0x0123_4567_89ab_cdef;
        InputBatch {
            frame_seq: 77,
            instructions: vec![
                instruction(InputCommand::Replace {
                    node_id: 1,
                    base_revision: revision,
                    start: 2,
                    end: 4,
                    text: "替换".to_owned(),
                }),
                instruction(InputCommand::Insert {
                    node_id: 1,
                    base_revision: revision + 1,
                    text: "👨‍👩‍👧‍👦".to_owned(),
                }),
                instruction(InputCommand::DeleteBackward {
                    node_id: 1,
                    base_revision: revision + 2,
                }),
                instruction(InputCommand::DeleteForward {
                    node_id: 1,
                    base_revision: revision + 3,
                }),
                instruction(InputCommand::SetSelection {
                    node_id: 1,
                    base_revision: revision + 4,
                    selection: InputSelection {
                        anchor: InputPosition {
                            offset: 8,
                            affinity: InputAffinity::Upstream,
                        },
                        focus: InputPosition {
                            offset: 3,
                            affinity: InputAffinity::Downstream,
                        },
                    },
                }),
                instruction(InputCommand::BeginComposition {
                    node_id: 1,
                    base_revision: revision + 5,
                }),
                instruction(InputCommand::UpdateComposition {
                    node_id: 1,
                    base_revision: revision + 6,
                    text: "に".to_owned(),
                }),
                instruction(InputCommand::CommitComposition {
                    node_id: 1,
                    base_revision: revision + 7,
                    text: Some("日本".to_owned()),
                }),
                instruction(InputCommand::CommitComposition {
                    node_id: 1,
                    base_revision: revision + 8,
                    text: None,
                }),
                instruction(InputCommand::CancelComposition {
                    node_id: 1,
                    base_revision: revision + 9,
                }),
                instruction(InputCommand::Undo {
                    node_id: 1,
                    base_revision: revision + 10,
                }),
                instruction(InputCommand::Redo {
                    node_id: 1,
                    base_revision: revision + 11,
                }),
                instruction(InputCommand::ScrollBegin { node_id: 2 }),
                instruction(InputCommand::ScrollDelta {
                    node_id: 2,
                    delta_x: -3.5,
                    delta_y: 24.25,
                    elapsed_micros: 16_667,
                }),
                instruction(InputCommand::ScrollEnd { node_id: 2 }),
                instruction(InputCommand::ScrollCancel { node_id: 2 }),
            ],
        }
    }

    #[test]
    fn every_input_command_round_trips_with_exact_revisions_and_unicode() {
        let batch = sample_batch();
        let bytes = batch.encode().expect("encode input batch");
        assert_eq!(InputBatch::decode(&bytes), Ok(batch));
        assert_eq!(bytes.len() % 4, 0);
    }

    #[test]
    fn rejects_unknown_flags_opcodes_affinities_presence_and_utf8() {
        let flagged = InputBatch {
            frame_seq: 1,
            instructions: vec![InputInstruction {
                flags: 1,
                command: InputCommand::Undo {
                    node_id: 1,
                    base_revision: 0,
                },
            }],
        };
        assert!(matches!(
            flagged.encode(),
            Err(AbiError::UnsupportedFlags { flags: 1, .. })
        ));

        let mut unknown = InputBatch {
            frame_seq: 1,
            instructions: vec![instruction(InputCommand::Undo {
                node_id: 1,
                base_revision: 0,
            })],
        }
        .encode()
        .expect("undo bytes");
        unknown[16] = 0xfe;
        assert!(matches!(
            InputBatch::decode(&unknown),
            Err(AbiError::UnknownOpcode {
                stream: StreamKind::Input,
                opcode: 0xfe,
                offset: 16,
            })
        ));

        let mut selection = InputBatch {
            frame_seq: 1,
            instructions: vec![instruction(InputCommand::SetSelection {
                node_id: 1,
                base_revision: 0,
                selection: InputSelection {
                    anchor: InputPosition {
                        offset: 0,
                        affinity: InputAffinity::Upstream,
                    },
                    focus: InputPosition {
                        offset: 0,
                        affinity: InputAffinity::Downstream,
                    },
                },
            })],
        }
        .encode()
        .expect("selection bytes");
        selection[40] = 2;
        assert!(matches!(
            InputBatch::decode(&selection),
            Err(AbiError::UnknownIdentifier {
                category: "input affinity",
                value: 2,
            })
        ));

        let mut composition = InputBatch {
            frame_seq: 1,
            instructions: vec![instruction(InputCommand::CommitComposition {
                node_id: 1,
                base_revision: 0,
                text: Some("x".to_owned()),
            })],
        }
        .encode()
        .expect("composition bytes");
        composition[32] = 0;
        assert_eq!(
            InputBatch::decode(&composition),
            Err(AbiError::InvalidValue(
                "absent composition text is non-empty"
            ))
        );
        composition[32] = 2;
        assert_eq!(
            InputBatch::decode(&composition),
            Err(AbiError::InvalidValue(
                "invalid composition text presence flag"
            ))
        );
        composition[32] = 1;
        composition[40] = 0xff;
        assert_eq!(
            InputBatch::decode(&composition),
            Err(AbiError::InvalidValue("input text is not valid UTF-8"))
        );
    }

    #[test]
    fn rejects_invalid_scroll_sample_bounds_on_encode_and_decode() {
        let invalid_time = InputBatch {
            frame_seq: 1,
            instructions: vec![instruction(InputCommand::ScrollDelta {
                node_id: 1,
                delta_x: 0.0,
                delta_y: 1.0,
                elapsed_micros: 0,
            })],
        };
        assert_eq!(
            invalid_time.encode(),
            Err(AbiError::InvalidValue(
                "scroll delta elapsed time is invalid"
            ))
        );

        let mut bytes = InputBatch {
            frame_seq: 1,
            instructions: vec![instruction(InputCommand::ScrollDelta {
                node_id: 1,
                delta_x: 0.0,
                delta_y: 1.0,
                elapsed_micros: 16_667,
            })],
        }
        .encode()
        .expect("scroll sample");
        bytes[24..28].copy_from_slice(&f32::NAN.to_le_bytes());
        assert_eq!(
            InputBatch::decode(&bytes),
            Err(AbiError::NonFiniteFloat { offset: 24 })
        );
    }

    #[test]
    fn rejects_missing_or_non_final_commit_and_hostile_declared_sizes() {
        let missing = Writer::new(INPUT_MAGIC)
            .finish(MAX_INPUT_BYTES)
            .expect("header only");
        assert_eq!(InputBatch::decode(&missing), Err(AbiError::MissingCommit));

        let mut extra = InputBatch {
            frame_seq: 1,
            instructions: Vec::new(),
        }
        .encode()
        .expect("commit");
        extra.extend_from_slice(&[InputOpcode::Undo as u8, 0, 0, 0]);
        extra.extend_from_slice(&1_u32.to_le_bytes());
        extra.extend_from_slice(&0_u64.to_le_bytes());
        let length = u32::try_from(extra.len()).expect("short fixture");
        extra[8..12].copy_from_slice(&length.to_le_bytes());
        extra[12..16].copy_from_slice(&2_u32.to_le_bytes());
        assert_eq!(
            InputBatch::decode(&extra),
            Err(AbiError::CommitNotLast { offset: 24 })
        );

        let mut hostile_count = InputBatch {
            frame_seq: 1,
            instructions: Vec::new(),
        }
        .encode()
        .expect("commit");
        hostile_count[12..16].copy_from_slice(&(MAX_INPUT_INSTRUCTIONS + 1).to_le_bytes());
        assert!(matches!(
            InputBatch::decode(&hostile_count),
            Err(AbiError::InstructionCountTooLarge { .. })
        ));

        let mut oversized = Writer::new(INPUT_MAGIC);
        oversized.instruction(InputOpcode::Insert as u8, 0);
        write_target(&mut oversized, 1, 0);
        oversized.u32(u32::try_from(MAX_RESOURCE_BYTES + 1).expect("bounded maximum"));
        let oversized = oversized
            .finish(MAX_INPUT_BYTES)
            .expect("short hostile stream");
        assert!(matches!(
            InputBatch::decode(&oversized),
            Err(AbiError::ResourceTooLarge { .. })
        ));
    }

    proptest! {
        #[test]
        fn arbitrary_bytes_never_panic(bytes in prop::collection::vec(any::<u8>(), 0..4096)) {
            let _ = InputBatch::decode(&bytes);
        }
    }
}
