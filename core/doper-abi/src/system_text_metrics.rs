use std::collections::HashSet;

use crate::codec::{
    Reader, Writer, read_header, read_instruction_header, validate_encode_instruction_count,
};
use crate::{
    AbiError, MAX_SYSTEM_TEXT_LINES, MAX_SYSTEM_TEXT_METRIC_INSTRUCTIONS,
    MAX_SYSTEM_TEXT_METRICS_BYTES, SYSTEM_TEXT_METRICS_MAGIC, StreamKind, SystemTextMetricOpcode,
};

/// Browser-measured dimensions for one immutable fallback string/style pair.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SystemTextMetric {
    /// Immutable UTF-8 string resource identifier.
    pub string_id: u32,
    /// Immutable text-style resource identifier.
    pub style_id: u32,
    /// Widest hard line in logical CSS pixels.
    pub max_line_width: f32,
    /// Number of hard lines separated by newline characters.
    pub line_count: u32,
}

/// One transactional system-text metric cache delta.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SystemTextMetricCommand {
    /// Defines or refreshes a metric for an active immutable resource pair.
    Upsert(SystemTextMetric),
    /// Releases a metric after the last Scene node stops using the pair.
    Release {
        /// Immutable UTF-8 string resource identifier.
        string_id: u32,
        /// Immutable text-style resource identifier.
        style_id: u32,
    },
}

/// One metric cache delta plus versioned instruction flags.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SystemTextMetricInstruction {
    /// Instruction flags. ABI v1 requires zero.
    pub flags: u8,
    /// Validated cache delta.
    pub command: SystemTextMetricCommand,
}

/// Transactional Host-to-Core system-font measurement batch.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SystemTextMetricBatch {
    /// Metric deltas in application order.
    pub instructions: Vec<SystemTextMetricInstruction>,
}

impl SystemTextMetricBatch {
    /// Decodes and fully validates a system-font measurement batch.
    pub fn decode(bytes: &[u8]) -> Result<Self, AbiError> {
        let mut reader = Reader::new(bytes);
        let declared_count = read_header(
            &mut reader,
            SYSTEM_TEXT_METRICS_MAGIC,
            MAX_SYSTEM_TEXT_METRICS_BYTES,
        )?;
        if declared_count > MAX_SYSTEM_TEXT_METRIC_INSTRUCTIONS {
            return Err(AbiError::InstructionCountTooLarge {
                declared: declared_count,
                maximum: MAX_SYSTEM_TEXT_METRIC_INSTRUCTIONS,
            });
        }
        let maximum_count =
            u32::try_from(reader.remaining() / 12).map_err(|_| AbiError::ArithmeticOverflow)?;
        if declared_count > maximum_count {
            return Err(AbiError::InstructionCountTooLarge {
                declared: declared_count,
                maximum: maximum_count,
            });
        }
        let capacity = usize::try_from(declared_count).map_err(|_| AbiError::ArithmeticOverflow)?;
        let mut instructions = Vec::with_capacity(capacity);
        let mut seen = HashSet::with_capacity(capacity);
        let mut actual_count = 0_u32;
        while reader.remaining() != 0 {
            let (offset, raw_opcode, flags) = read_instruction_header(&mut reader)?;
            let opcode =
                SystemTextMetricOpcode::from_u8(raw_opcode).ok_or(AbiError::UnknownOpcode {
                    stream: StreamKind::SystemTextMetrics,
                    opcode: raw_opcode,
                    offset,
                })?;
            actual_count = actual_count
                .checked_add(1)
                .ok_or(AbiError::ArithmeticOverflow)?;
            let string_id =
                nonzero_id(reader.read_u32()?, "text metric string id must be non-zero")?;
            let style_id = nonzero_id(reader.read_u32()?, "text metric style id must be non-zero")?;
            if !seen.insert((string_id, style_id)) {
                return Err(AbiError::InvalidValue(
                    "text metric resource pair occurs more than once in a batch",
                ));
            }
            let command = match opcode {
                SystemTextMetricOpcode::UpsertSystemTextMetric => {
                    let max_line_width = reader.read_f32()?;
                    let line_count = reader.read_u32()?;
                    validate_metric(max_line_width, line_count)?;
                    SystemTextMetricCommand::Upsert(SystemTextMetric {
                        string_id,
                        style_id,
                        max_line_width,
                        line_count,
                    })
                }
                SystemTextMetricOpcode::ReleaseSystemTextMetric => {
                    SystemTextMetricCommand::Release {
                        string_id,
                        style_id,
                    }
                }
            };
            validate_instruction_size(opcode, offset, reader.offset())?;
            instructions.push(SystemTextMetricInstruction { flags, command });
        }
        if actual_count != declared_count {
            return Err(AbiError::InstructionCountMismatch {
                declared: declared_count,
                actual: actual_count,
            });
        }
        Ok(Self { instructions })
    }

    /// Encodes a canonical system-font measurement batch.
    pub fn encode(&self) -> Result<Vec<u8>, AbiError> {
        validate_encode_instruction_count(
            self.instructions.len(),
            0,
            MAX_SYSTEM_TEXT_METRIC_INSTRUCTIONS,
        )?;
        let mut writer = Writer::new(SYSTEM_TEXT_METRICS_MAGIC);
        let mut seen = HashSet::with_capacity(self.instructions.len());
        for instruction in &self.instructions {
            if instruction.flags != 0 {
                return Err(AbiError::InvalidValue(
                    "system text metric instruction flags must be zero",
                ));
            }
            let (string_id, style_id) = pair(instruction.command);
            nonzero_id(string_id, "text metric string id must be non-zero")?;
            nonzero_id(style_id, "text metric style id must be non-zero")?;
            if !seen.insert((string_id, style_id)) {
                return Err(AbiError::InvalidValue(
                    "text metric resource pair occurs more than once in a batch",
                ));
            }
            match instruction.command {
                SystemTextMetricCommand::Upsert(metric) => {
                    validate_metric(metric.max_line_width, metric.line_count)?;
                    writer.instruction(SystemTextMetricOpcode::UpsertSystemTextMetric as u8, 0);
                    writer.u32(metric.string_id);
                    writer.u32(metric.style_id);
                    writer.f32(metric.max_line_width)?;
                    writer.u32(metric.line_count);
                }
                SystemTextMetricCommand::Release {
                    string_id,
                    style_id,
                } => {
                    writer.instruction(SystemTextMetricOpcode::ReleaseSystemTextMetric as u8, 0);
                    writer.u32(string_id);
                    writer.u32(style_id);
                }
            }
        }
        writer.finish(MAX_SYSTEM_TEXT_METRICS_BYTES)
    }
}

fn pair(command: SystemTextMetricCommand) -> (u32, u32) {
    match command {
        SystemTextMetricCommand::Upsert(metric) => (metric.string_id, metric.style_id),
        SystemTextMetricCommand::Release {
            string_id,
            style_id,
        } => (string_id, style_id),
    }
}

fn validate_metric(max_line_width: f32, line_count: u32) -> Result<(), AbiError> {
    if !max_line_width.is_finite() || max_line_width < 0.0 {
        return Err(AbiError::InvalidValue(
            "system text width must be finite and non-negative",
        ));
    }
    if line_count == 0 || line_count > MAX_SYSTEM_TEXT_LINES {
        return Err(AbiError::InvalidValue(
            "system text line count is outside the supported limit",
        ));
    }
    Ok(())
}

fn nonzero_id(value: u32, message: &'static str) -> Result<u32, AbiError> {
    if value == 0 {
        Err(AbiError::InvalidValue(message))
    } else {
        Ok(value)
    }
}

fn validate_instruction_size(
    opcode: SystemTextMetricOpcode,
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn canonical() -> SystemTextMetricBatch {
        SystemTextMetricBatch {
            instructions: vec![
                SystemTextMetricInstruction {
                    flags: 0,
                    command: SystemTextMetricCommand::Upsert(SystemTextMetric {
                        string_id: 7,
                        style_id: 9,
                        max_line_width: 123.5,
                        line_count: 2,
                    }),
                },
                SystemTextMetricInstruction {
                    flags: 0,
                    command: SystemTextMetricCommand::Release {
                        string_id: 8,
                        style_id: 10,
                    },
                },
            ],
        }
    }

    #[test]
    fn canonical_batch_round_trips_exactly() {
        let encoded = canonical().encode().expect("encode");
        assert_eq!(SystemTextMetricBatch::decode(&encoded), Ok(canonical()));
        assert_eq!(
            SystemTextMetricBatch::decode(&encoded)
                .expect("decode")
                .encode(),
            Ok(encoded)
        );
    }

    #[test]
    fn rejects_duplicate_invalid_and_truncated_records() {
        let mut duplicate = canonical();
        duplicate.instructions.push(duplicate.instructions[0]);
        assert!(matches!(
            duplicate.encode(),
            Err(AbiError::InvalidValue(
                "text metric resource pair occurs more than once in a batch"
            ))
        ));

        for metric in [
            SystemTextMetric {
                string_id: 0,
                style_id: 1,
                max_line_width: 1.0,
                line_count: 1,
            },
            SystemTextMetric {
                string_id: 1,
                style_id: 1,
                max_line_width: -1.0,
                line_count: 1,
            },
            SystemTextMetric {
                string_id: 1,
                style_id: 1,
                max_line_width: 1.0,
                line_count: 0,
            },
        ] {
            let batch = SystemTextMetricBatch {
                instructions: vec![SystemTextMetricInstruction {
                    flags: 0,
                    command: SystemTextMetricCommand::Upsert(metric),
                }],
            };
            assert!(batch.encode().is_err());
        }

        let encoded = canonical().encode().expect("encode");
        assert!(SystemTextMetricBatch::decode(&encoded[..encoded.len() - 1]).is_err());
    }

    #[test]
    fn rejects_hostile_declared_counts_without_allocating() {
        let encoded = canonical().encode().expect("encode");

        let mut over_limit = encoded.clone();
        over_limit[12..16]
            .copy_from_slice(&(MAX_SYSTEM_TEXT_METRIC_INSTRUCTIONS + 1).to_le_bytes());
        assert_eq!(
            SystemTextMetricBatch::decode(&over_limit),
            Err(AbiError::InstructionCountTooLarge {
                declared: MAX_SYSTEM_TEXT_METRIC_INSTRUCTIONS + 1,
                maximum: MAX_SYSTEM_TEXT_METRIC_INSTRUCTIONS,
            })
        );

        let mut impossible_for_payload = encoded.clone();
        impossible_for_payload[12..16].copy_from_slice(&3_u32.to_le_bytes());
        assert_eq!(
            SystemTextMetricBatch::decode(&impossible_for_payload),
            Err(AbiError::InstructionCountTooLarge {
                declared: 3,
                maximum: 2,
            })
        );

        let mut mismatched = encoded;
        mismatched[12..16].copy_from_slice(&1_u32.to_le_bytes());
        assert_eq!(
            SystemTextMetricBatch::decode(&mismatched),
            Err(AbiError::InstructionCountMismatch {
                declared: 1,
                actual: 2,
            })
        );
    }

    #[test]
    fn rejects_noncanonical_flags_and_malformed_resource_records() {
        let mut flagged = canonical();
        flagged.instructions[0].flags = 1;
        assert_eq!(
            flagged.encode(),
            Err(AbiError::InvalidValue(
                "system text metric instruction flags must be zero"
            ))
        );

        let encoded = canonical().encode().expect("encode");

        let mut duplicate_pair = encoded.clone();
        duplicate_pair[40..44].copy_from_slice(&7_u32.to_le_bytes());
        duplicate_pair[44..48].copy_from_slice(&9_u32.to_le_bytes());
        assert_eq!(
            SystemTextMetricBatch::decode(&duplicate_pair),
            Err(AbiError::InvalidValue(
                "text metric resource pair occurs more than once in a batch"
            ))
        );

        let mut unknown_opcode = encoded.clone();
        unknown_opcode[16] = u8::MAX;
        assert!(matches!(
            SystemTextMetricBatch::decode(&unknown_opcode),
            Err(AbiError::UnknownOpcode {
                stream: StreamKind::SystemTextMetrics,
                opcode: u8::MAX,
                offset: 16,
            })
        ));

        let mut zero_string_id = encoded.clone();
        zero_string_id[20..24].copy_from_slice(&0_u32.to_le_bytes());
        assert_eq!(
            SystemTextMetricBatch::decode(&zero_string_id),
            Err(AbiError::InvalidValue(
                "text metric string id must be non-zero"
            ))
        );

        let mut negative_width = encoded.clone();
        negative_width[28..32].copy_from_slice(&(-1.0_f32).to_le_bytes());
        assert_eq!(
            SystemTextMetricBatch::decode(&negative_width),
            Err(AbiError::InvalidValue(
                "system text width must be finite and non-negative"
            ))
        );

        let mut excessive_lines = encoded;
        excessive_lines[32..36].copy_from_slice(&(MAX_SYSTEM_TEXT_LINES + 1).to_le_bytes());
        assert_eq!(
            SystemTextMetricBatch::decode(&excessive_lines),
            Err(AbiError::InvalidValue(
                "system text line count is outside the supported limit"
            ))
        );
    }

    proptest! {
        #[test]
        fn arbitrary_bytes_never_panic(bytes in prop::collection::vec(any::<u8>(), 0..512)) {
            let _ = SystemTextMetricBatch::decode(&bytes);
        }
    }
}
