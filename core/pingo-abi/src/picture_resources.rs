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
    use crate::{ABI_VERSION, DisplayCommand, DisplayInstruction, INSTRUCTION_FLAG_OPTIONAL};

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

    #[test]
    fn reports_future_versions_and_skips_only_optional_unknown_commands() {
        let canonical = PictureResourceBatch {
            instructions: vec![PictureResourceInstruction {
                flags: 0,
                command: PictureResourceCommand::Release { picture_id: 7 },
            }],
        }
        .encode()
        .expect("release batch");
        let build = |flags: u8| {
            let mut bytes = canonical.clone();
            bytes[4..6].copy_from_slice(&(ABI_VERSION + 1).to_le_bytes());
            bytes[16] = 0xfe;
            bytes[17] = flags;
            bytes
        };
        let (batch, report) =
            PictureResourceBatch::decode_with_report(&build(INSTRUCTION_FLAG_OPTIONAL))
                .expect("optional future command");
        assert!(batch.instructions.is_empty());
        assert_eq!(report.skipped_instructions, 1);
        assert_eq!(report.producer_abi_version, ABI_VERSION + 1);
        assert!(matches!(
            PictureResourceBatch::decode(&build(0)),
            Err(AbiError::UnknownOpcode { opcode: 0xfe, .. })
        ));
    }

    #[test]
    fn decoder_rejects_hostile_counts_ids_lengths_and_nested_payloads() {
        let release = PictureResourceBatch {
            instructions: vec![PictureResourceInstruction {
                flags: 0,
                command: PictureResourceCommand::Release { picture_id: 7 },
            }],
        }
        .encode()
        .expect("release batch");
        for corrupt in [
            |bytes: &mut Vec<u8>| bytes[12..16].copy_from_slice(&u32::MAX.to_le_bytes()),
            |bytes: &mut Vec<u8>| bytes[12..16].copy_from_slice(&2_u32.to_le_bytes()),
            |bytes: &mut Vec<u8>| bytes[20..24].copy_from_slice(&0_u32.to_le_bytes()),
            |bytes: &mut Vec<u8>| bytes[17] = 2,
            |bytes: &mut Vec<u8>| bytes[18..20].copy_from_slice(&1_u16.to_le_bytes()),
        ] {
            let mut bytes = release.clone();
            corrupt(&mut bytes);
            assert!(PictureResourceBatch::decode(&bytes).is_err());
        }

        let mut count_mismatch = release.clone();
        count_mismatch[12..16].copy_from_slice(&0_u32.to_le_bytes());
        assert!(matches!(
            PictureResourceBatch::decode(&count_mismatch),
            Err(AbiError::InstructionCountMismatch { .. })
        ));

        let mut declared_too_long = release.clone();
        declared_too_long.extend_from_slice(&[0; 4]);
        declared_too_long[8..12].copy_from_slice(&28_u32.to_le_bytes());
        declared_too_long[18..20].copy_from_slice(&3_u16.to_le_bytes());
        assert!(matches!(
            PictureResourceBatch::decode(&declared_too_long),
            Err(AbiError::InstructionLengthMismatch { .. })
        ));

        let duplicate = PictureResourceBatch {
            instructions: vec![
                PictureResourceInstruction {
                    flags: 0,
                    command: PictureResourceCommand::Release { picture_id: 7 },
                },
                PictureResourceInstruction {
                    flags: 0,
                    command: PictureResourceCommand::Release { picture_id: 8 },
                },
            ],
        }
        .encode()
        .expect("unique releases");
        let mut duplicate = duplicate;
        duplicate[28..32].copy_from_slice(&7_u32.to_le_bytes());
        assert!(PictureResourceBatch::decode(&duplicate).is_err());

        let defined = PictureResourceBatch {
            instructions: vec![PictureResourceInstruction {
                flags: 0,
                command: PictureResourceCommand::Define {
                    picture_id: 9,
                    bytes: list(),
                },
            }],
        }
        .encode()
        .expect("defined picture");
        let mut oversized = defined.clone();
        oversized[24..28].copy_from_slice(
            &(u32::try_from(MAX_RESOURCE_BYTES).expect("limit") + 1).to_le_bytes(),
        );
        assert!(matches!(
            PictureResourceBatch::decode(&oversized),
            Err(AbiError::ResourceTooLarge { .. })
        ));
        let mut malformed_nested = defined;
        malformed_nested[28] ^= 0xff;
        assert!(PictureResourceBatch::decode(&malformed_nested).is_err());

        assert!(validate_instruction_size(PictureResourceOpcode::ReleasePicture, 0, 12).is_err());
        assert!(validate_instruction_size(PictureResourceOpcode::DefinePicture, 0, 8).is_err());
    }

    #[test]
    fn encoders_reject_invalid_flags_ids_counts_and_core_owned_budgets() {
        let command = |flags, picture_id| PictureResourceBatch {
            instructions: vec![PictureResourceInstruction {
                flags,
                command: PictureResourceCommand::Release { picture_id },
            }],
        };
        for batch in [command(1, 1), command(0, 0)] {
            assert!(batch.encode().is_err());
            assert!(batch.encode_core_owned().is_err());
        }

        let too_many = PictureResourceBatch {
            instructions: (0..=MAX_PICTURE_RESOURCE_INSTRUCTIONS)
                .map(|index| PictureResourceInstruction {
                    flags: 0,
                    command: PictureResourceCommand::Release {
                        picture_id: index.saturating_add(1),
                    },
                })
                .collect(),
        };
        assert!(too_many.encode().is_err());
        assert!(too_many.encode_core_owned().is_err());

        let oversized = PictureResourceBatch {
            instructions: vec![PictureResourceInstruction {
                flags: 0,
                command: PictureResourceCommand::Define {
                    picture_id: 1,
                    bytes: Arc::from(vec![0; MAX_RESOURCE_BYTES + 1]),
                },
            }],
        };
        assert!(matches!(
            oversized.encode_core_owned(),
            Err(AbiError::ResourceTooLarge { .. })
        ));

        let maximum = Arc::<[u8]>::from(vec![0; MAX_RESOURCE_BYTES]);
        let over_resident = PictureResourceBatch {
            instructions: vec![
                PictureResourceInstruction {
                    flags: 0,
                    command: PictureResourceCommand::Define {
                        picture_id: 1,
                        bytes: maximum.clone(),
                    },
                },
                PictureResourceInstruction {
                    flags: 0,
                    command: PictureResourceCommand::Define {
                        picture_id: 2,
                        bytes: maximum,
                    },
                },
                PictureResourceInstruction {
                    flags: 0,
                    command: PictureResourceCommand::Define {
                        picture_id: 3,
                        bytes: Arc::from([0_u8; 4]),
                    },
                },
            ],
        };
        assert!(matches!(
            over_resident.encode_core_owned(),
            Err(AbiError::ResourceTooLarge { .. })
        ));
    }
}
