use std::{collections::HashSet, sync::Arc};

use crate::codec::{
    Reader, Writer, checked_padding, finish_instruction, read_header, read_instruction_header,
    validate_encode_instruction_count,
};
use crate::{
    AbiError, DisplayList, MAX_PICTURE_RESIDENT_BYTES, MAX_PICTURE_RESOURCE_INSTRUCTIONS,
    MAX_PICTURE_RESOURCES_BYTES, MAX_RESOURCE_BYTES, PICTURE_RESOURCES_MAGIC,
    PictureResourceOpcode, StreamKind,
};

/// One immutable Picture-resource lifecycle operation.
#[derive(Clone, Debug, PartialEq)]
pub enum PictureResourceCommand {
    /// Publishes a complete DisplayList before a frame may reference it.
    Define {
        /// Session-unique, non-zero Picture generation token.
        picture_id: u32,
        /// Canonical, independently validated DisplayList bytes.
        bytes: Arc<[u8]>,
    },
    /// Releases a Picture after no subsequently replayed frame references it.
    Release {
        /// Previously published Picture generation token.
        picture_id: u32,
    },
}

/// A Picture-resource command plus versioned instruction flags.
#[derive(Clone, Debug, PartialEq)]
pub struct PictureResourceInstruction {
    /// Instruction flags. ABI v17 requires zero.
    pub flags: u8,
    /// Validated lifecycle operation.
    pub command: PictureResourceCommand,
}

/// Transactional Core-to-backend Picture resource delta batch.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PictureResourceBatch {
    /// Definitions followed by releases for one committed frame.
    pub instructions: Vec<PictureResourceInstruction>,
}

impl PictureResourceBatch {
    /// Fully decodes and validates a Picture resource batch.
    pub fn decode(bytes: &[u8]) -> Result<Self, AbiError> {
        Self::decode_with_report(bytes).map(|(batch, _)| batch)
    }

    /// Decodes while reporting compatible optional instructions.
    pub fn decode_with_report(bytes: &[u8]) -> Result<(Self, crate::DecodeReport), AbiError> {
        let mut reader = Reader::new(bytes);
        let stream = read_header(
            &mut reader,
            PICTURE_RESOURCES_MAGIC,
            MAX_PICTURE_RESOURCES_BYTES,
        )?;
        if stream.declared_count > MAX_PICTURE_RESOURCE_INSTRUCTIONS {
            return Err(AbiError::InstructionCountTooLarge {
                declared: stream.declared_count,
                maximum: MAX_PICTURE_RESOURCE_INSTRUCTIONS,
            });
        }
        let maximum_count =
            u32::try_from(reader.remaining() / 8).map_err(|_| AbiError::ArithmeticOverflow)?;
        if stream.declared_count > maximum_count {
            return Err(AbiError::InstructionCountTooLarge {
                declared: stream.declared_count,
                maximum: maximum_count,
            });
        }
        let capacity =
            usize::try_from(stream.declared_count).map_err(|_| AbiError::ArithmeticOverflow)?;
        let mut instructions = Vec::with_capacity(capacity);
        let mut seen = HashSet::with_capacity(capacity);
        let mut actual_count = 0_u32;
        let mut skipped = 0_u32;
        let mut payload_total = 0_usize;
        while reader.remaining() != 0 {
            let header = read_instruction_header(&mut reader)?;
            let (offset, raw_opcode, flags) = (header.offset, header.opcode, header.flags);
            let Some(opcode) = PictureResourceOpcode::from_u8(raw_opcode) else {
                if header.optional() {
                    skipped = skipped.saturating_add(1);
                    actual_count = actual_count
                        .checked_add(1)
                        .ok_or(AbiError::ArithmeticOverflow)?;
                    reader.seek_to(header.end)?;
                    continue;
                }
                return Err(AbiError::UnknownOpcode {
                    stream: StreamKind::PictureResources,
                    opcode: raw_opcode,
                    offset,
                });
            };
            actual_count = actual_count
                .checked_add(1)
                .ok_or(AbiError::ArithmeticOverflow)?;
            let picture_id = nonzero_id(reader.read_u32()?)?;
            if !seen.insert(picture_id) {
                return Err(AbiError::InvalidValue(
                    "picture id occurs more than once in a batch",
                ));
            }
            let command = match opcode {
                PictureResourceOpcode::DefinePicture => {
                    let payload_bytes = usize::try_from(reader.read_u32()?)
                        .map_err(|_| AbiError::ArithmeticOverflow)?;
                    if payload_bytes > MAX_RESOURCE_BYTES {
                        return Err(AbiError::ResourceTooLarge {
                            actual: payload_bytes,
                            maximum: MAX_RESOURCE_BYTES,
                        });
                    }
                    payload_total = payload_total
                        .checked_add(payload_bytes)
                        .ok_or(AbiError::ArithmeticOverflow)?;
                    if payload_total > MAX_PICTURE_RESIDENT_BYTES {
                        return Err(AbiError::ResourceTooLarge {
                            actual: payload_total,
                            maximum: MAX_PICTURE_RESIDENT_BYTES,
                        });
                    }
                    let payload = reader.read_bytes(payload_bytes)?;
                    DisplayList::decode(payload)?;
                    reader.read_zeroes(checked_padding(payload_bytes)?)?;
                    PictureResourceCommand::Define {
                        picture_id,
                        bytes: Arc::from(payload),
                    }
                }
                PictureResourceOpcode::ReleasePicture => {
                    PictureResourceCommand::Release { picture_id }
                }
            };
            validate_instruction_size(opcode, offset, reader.offset())?;
            finish_instruction(&reader, header)?;
            instructions.push(PictureResourceInstruction { flags, command });
        }
        if actual_count != stream.declared_count {
            return Err(AbiError::InstructionCountMismatch {
                declared: stream.declared_count,
                actual: actual_count,
            });
        }
        Ok((
            Self { instructions },
            crate::DecodeReport {
                skipped_instructions: skipped,
                producer_abi_version: stream.producer_version,
            },
        ))
    }

    /// Encodes one canonical, bounded Picture resource transaction.
    pub fn encode(&self) -> Result<Vec<u8>, AbiError> {
        validate_encode_instruction_count(
            self.instructions.len(),
            0,
            MAX_PICTURE_RESOURCE_INSTRUCTIONS,
        )?;
        let mut writer = Writer::new(PICTURE_RESOURCES_MAGIC);
        let mut seen = HashSet::with_capacity(self.instructions.len());
        let mut payload_total = 0_usize;
        for instruction in &self.instructions {
            if instruction.flags != 0 {
                return Err(AbiError::InvalidValue(
                    "picture resource instruction flags must be zero",
                ));
            }
            let picture_id = match &instruction.command {
                PictureResourceCommand::Define { picture_id, .. }
                | PictureResourceCommand::Release { picture_id } => nonzero_id(*picture_id)?,
            };
            if !seen.insert(picture_id) {
                return Err(AbiError::InvalidValue(
                    "picture id occurs more than once in a batch",
                ));
            }
            match &instruction.command {
                PictureResourceCommand::Define { bytes, .. } => {
                    DisplayList::decode(bytes)?;
                    if bytes.len() > MAX_RESOURCE_BYTES {
                        return Err(AbiError::ResourceTooLarge {
                            actual: bytes.len(),
                            maximum: MAX_RESOURCE_BYTES,
                        });
                    }
                    payload_total = payload_total
                        .checked_add(bytes.len())
                        .ok_or(AbiError::ArithmeticOverflow)?;
                    if payload_total > MAX_PICTURE_RESIDENT_BYTES {
                        return Err(AbiError::ResourceTooLarge {
                            actual: payload_total,
                            maximum: MAX_PICTURE_RESIDENT_BYTES,
                        });
                    }
                    writer.instruction(PictureResourceOpcode::DefinePicture as u8, 0);
                    writer.u32(picture_id);
                    writer
                        .u32(u32::try_from(bytes.len()).map_err(|_| AbiError::ArithmeticOverflow)?);
                    writer.bytes(bytes);
                    writer.pad();
                }
                PictureResourceCommand::Release { .. } => {
                    writer.instruction(PictureResourceOpcode::ReleasePicture as u8, 0);
                    writer.u32(picture_id);
                }
            }
        }
        writer.finish(MAX_PICTURE_RESOURCES_BYTES)
    }

    /// Encodes Core-authored commands whose IDs and nested DisplayLists were
    /// created by the typed paint builder in this process.
    ///
    /// The public/general encoder above remains the validation oracle for
    /// fixtures and external producers. This narrower path deliberately avoids
    /// decoding every just-encoded DisplayList a second time on the product
    /// WASM boundary; the backend decoder still treats the resulting bytes as
    /// untrusted input before installation.
    #[doc(hidden)]
    pub fn encode_core_owned(&self) -> Result<Vec<u8>, AbiError> {
        validate_encode_instruction_count(
            self.instructions.len(),
            0,
            MAX_PICTURE_RESOURCE_INSTRUCTIONS,
        )?;
        let mut writer = Writer::new(PICTURE_RESOURCES_MAGIC);
        let mut payload_total = 0_usize;
        for instruction in &self.instructions {
            if instruction.flags != 0 {
                return Err(AbiError::InvalidValue(
                    "picture resource instruction flags must be zero",
                ));
            }
            let picture_id = match &instruction.command {
                PictureResourceCommand::Define { picture_id, .. }
                | PictureResourceCommand::Release { picture_id } => nonzero_id(*picture_id)?,
            };
            match &instruction.command {
                PictureResourceCommand::Define { bytes, .. } => {
                    if bytes.len() > MAX_RESOURCE_BYTES {
                        return Err(AbiError::ResourceTooLarge {
                            actual: bytes.len(),
                            maximum: MAX_RESOURCE_BYTES,
                        });
                    }
                    payload_total = payload_total
                        .checked_add(bytes.len())
                        .ok_or(AbiError::ArithmeticOverflow)?;
                    if payload_total > MAX_PICTURE_RESIDENT_BYTES {
                        return Err(AbiError::ResourceTooLarge {
                            actual: payload_total,
                            maximum: MAX_PICTURE_RESIDENT_BYTES,
                        });
                    }
                    writer.instruction(PictureResourceOpcode::DefinePicture as u8, 0);
                    writer.u32(picture_id);
                    writer
                        .u32(u32::try_from(bytes.len()).map_err(|_| AbiError::ArithmeticOverflow)?);
                    writer.bytes(bytes);
                    writer.pad();
                }
                PictureResourceCommand::Release { .. } => {
                    writer.instruction(PictureResourceOpcode::ReleasePicture as u8, 0);
                    writer.u32(picture_id);
                }
            }
        }
        writer.finish(MAX_PICTURE_RESOURCES_BYTES)
    }
}

fn nonzero_id(value: u32) -> Result<u32, AbiError> {
    if value == 0 {
        Err(AbiError::InvalidValue("picture id must be non-zero"))
    } else {
        Ok(value)
    }
}

fn validate_instruction_size(
    opcode: PictureResourceOpcode,
    start: usize,
    end: usize,
) -> Result<(), AbiError> {
    let actual = end.checked_sub(start).ok_or(AbiError::ArithmeticOverflow)?;
    if let Some(expected) = opcode.fixed_bytes()
        && actual != expected
    {
        return Err(AbiError::InstructionLengthMismatch {
            opcode: opcode as u8,
            offset: start,
            expected,
            actual,
        });
    }
    if actual < opcode.minimum_bytes() {
        return Err(AbiError::InstructionLengthMismatch {
            opcode: opcode as u8,
            offset: start,
            expected: opcode.minimum_bytes(),
            actual,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DisplayCommand, DisplayInstruction};

    fn list() -> Arc<[u8]> {
        Arc::from(
            DisplayList {
                instructions: vec![
                    DisplayInstruction {
                        flags: 0,
                        command: DisplayCommand::Save,
                    },
                    DisplayInstruction {
                        flags: 0,
                        command: DisplayCommand::Restore,
                    },
                ],
            }
            .encode()
            .expect("display list"),
        )
    }

    #[test]
    fn round_trips_define_and_release() {
        let batch = PictureResourceBatch {
            instructions: vec![
                PictureResourceInstruction {
                    flags: 0,
                    command: PictureResourceCommand::Define {
                        picture_id: 7,
                        bytes: list(),
                    },
                },
                PictureResourceInstruction {
                    flags: 0,
                    command: PictureResourceCommand::Release { picture_id: 8 },
                },
            ],
        };
        let encoded = batch.encode().expect("encode");
        assert_eq!(encoded, batch.encode_core_owned().expect("Core encode"));
        assert_eq!(
            PictureResourceBatch::decode(&encoded).expect("decode"),
            batch
        );
    }

    #[test]
    fn rejects_duplicate_ids_and_malformed_nested_lists() {
        let duplicate = PictureResourceBatch {
            instructions: vec![
                PictureResourceInstruction {
                    flags: 0,
                    command: PictureResourceCommand::Release { picture_id: 4 },
                },
                PictureResourceInstruction {
                    flags: 0,
                    command: PictureResourceCommand::Release { picture_id: 4 },
                },
            ],
        };
        assert!(duplicate.encode().is_err());
        let malformed = PictureResourceBatch {
            instructions: vec![PictureResourceInstruction {
                flags: 0,
                command: PictureResourceCommand::Define {
                    picture_id: 9,
                    bytes: Arc::from([1_u8, 2, 3, 4]),
                },
            }],
        };
        assert!(malformed.encode().is_err());
    }
}
