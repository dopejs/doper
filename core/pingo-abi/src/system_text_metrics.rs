use std::collections::HashSet;

use crate::codec::{
    Reader, Writer, finish_instruction, read_header, read_instruction_header,
    validate_encode_instruction_count,
};
use crate::{
    AbiError, MAX_SYSTEM_TEXT_ADVANCES, MAX_SYSTEM_TEXT_LINES, MAX_SYSTEM_TEXT_METRIC_INSTRUCTIONS,
    MAX_SYSTEM_TEXT_METRICS_BYTES, SYSTEM_TEXT_METRICS_MAGIC, StreamKind, SystemTextMetricOpcode,
};

/// Browser-measured dimensions for one immutable fallback string/style pair.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SystemTextMetric {
    /// Immutable UTF-8 string resource identifier.
    pub string_id: u32,
    /// Immutable text-style resource identifier.
    pub style_id: u32,
    /// Widest hard line in logical CSS pixels.
    pub max_line_width: f32,
    /// Number of hard lines separated by newline characters.
    pub line_count: u32,
    /// Horizontal advance in logical CSS pixels for each measured code point,
    /// ascending by code point, or empty when the Host did not measure the pair.
    ///
    /// A table rather than a positional array, because the caret is placed
    /// against the live editing value while this pair names the Scene string,
    /// and during IME composition the two differ by the whole preedit run. The
    /// Host may therefore include code points that do not occur in the string.
    ///
    /// Measured only for pairs a Scene node makes editable: caret placement,
    /// pointer hit testing and the IME candidate-window rectangles all read
    /// these, and measuring every text run would put one `measureText` call per
    /// distinct code point on the scroll hot path.
    pub advances: Vec<(char, f32)>,
    /// Advance of each code point of the string in order, measured in context
    /// from prefix differences, or empty when the pair was not measured.
    ///
    /// The per-code-point table cannot express contextual width: CJK fonts
    /// contract consecutive full-width punctuation, so summing isolated widths
    /// drifts the caret one notch per adjacent pair. These are exact for the
    /// string they were measured from and apply only while the editing value
    /// still equals it.
    pub positional_advances: Vec<f32>,
    /// Widths a font removes when the second code point directly follows the
    /// first.
    ///
    /// CJK fonts contract adjacent full-width punctuation, and the per-code-point
    /// table cannot express it. Positional advances can, but only while the
    /// editing value still equals the string they were measured from — an
    /// application is not required to write the value back, so that can be never.
    /// This table is a property of the font, not of one string, so it keeps the
    /// caret correct for any value built from these code points.
    pub contractions: Vec<TextContraction>,
}

/// One pair a font sets closer together than the sum of their advances.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextContraction {
    /// Leading code point of the pair.
    pub first: char,
    /// Code point that must directly follow it.
    pub second: char,
    /// Total width removed from the pair, normally negative.
    pub delta: f32,
    /// Portion taken from the first code point's own advance.
    ///
    /// Measured rather than assumed: which half of a pair a font trims decides
    /// where the caret between them belongs. Every tested platform trims the
    /// first, so a model that assumed the second put the caret on top of the
    /// following glyph. `delta - first_delta` is what the second loses.
    pub first_delta: f32,
}

/// One transactional system-text metric cache delta.
#[derive(Clone, Debug, PartialEq)]
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
#[derive(Clone, Debug, PartialEq)]
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
    /// Decodes without reporting what the decoder had to tolerate.
    ///
    /// # Errors
    ///
    /// Returns the same errors as [`Self::decode_with_report`].
    pub fn decode(bytes: &[u8]) -> Result<Self, AbiError> {
        Self::decode_with_report(bytes).map(|(value, _)| value)
    }

    /// Decodes and reports what this build had to tolerate to read the stream.
    ///
    /// Instructions with an opcode this build does not know are stepped over
    /// when the producer marked them optional, and counted in the report.
    ///
    /// # Errors
    ///
    /// Returns an [`AbiError`] for a malformed, truncated, oversized, or
    /// too-old stream, and for an unknown instruction that was not marked
    /// optional.
    pub fn decode_with_report(bytes: &[u8]) -> Result<(Self, crate::DecodeReport), AbiError> {
        let mut reader = Reader::new(bytes);
        let stream = read_header(
            &mut reader,
            SYSTEM_TEXT_METRICS_MAGIC,
            MAX_SYSTEM_TEXT_METRICS_BYTES,
        )?;
        let declared_count = stream.declared_count;
        let mut skipped = 0_u32;
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
            let header = read_instruction_header(&mut reader)?;
            let (offset, raw_opcode, flags) = (header.offset, header.opcode, header.flags);
            // A stream from a newer build may carry instructions this decoder has
            // never heard of. Skipping one is only safe when the producer marked it
            // optional, so an unmarked unknown instruction is still fatal.
            let Some(opcode) = SystemTextMetricOpcode::from_u8(raw_opcode) else {
                if header.optional() {
                    // A skipped instruction was still in the stream, so it counts
                    // toward the declared total.
                    skipped = skipped.saturating_add(1);
                    actual_count = actual_count
                        .checked_add(1)
                        .ok_or(AbiError::ArithmeticOverflow)?;
                    reader.seek_to(header.end)?;
                    continue;
                }
                return Err(AbiError::UnknownOpcode {
                    stream: StreamKind::SystemTextMetrics,
                    opcode: raw_opcode,
                    offset,
                });
            };
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
                    let advance_count = reader.read_u32()?;
                    let advances = read_advances(&mut reader, advance_count)?;
                    let positional_count = reader.read_u32()?;
                    let positional_advances =
                        read_positional_advances(&mut reader, positional_count)?;
                    let contraction_count = reader.read_u32()?;
                    let contractions = read_contractions(&mut reader, contraction_count)?;
                    validate_metric(
                        max_line_width,
                        line_count,
                        &advances,
                        &positional_advances,
                        &contractions,
                    )?;
                    SystemTextMetricCommand::Upsert(SystemTextMetric {
                        string_id,
                        style_id,
                        max_line_width,
                        line_count,
                        advances,
                        positional_advances,
                        contractions,
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
            finish_instruction(&reader, header)?;
            instructions.push(SystemTextMetricInstruction { flags, command });
        }
        if actual_count != declared_count {
            return Err(AbiError::InstructionCountMismatch {
                declared: declared_count,
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
            let (string_id, style_id) = pair(&instruction.command);
            nonzero_id(string_id, "text metric string id must be non-zero")?;
            nonzero_id(style_id, "text metric style id must be non-zero")?;
            if !seen.insert((string_id, style_id)) {
                return Err(AbiError::InvalidValue(
                    "text metric resource pair occurs more than once in a batch",
                ));
            }
            match &instruction.command {
                SystemTextMetricCommand::Upsert(metric) => {
                    validate_metric(
                        metric.max_line_width,
                        metric.line_count,
                        &metric.advances,
                        &metric.positional_advances,
                        &metric.contractions,
                    )?;
                    let advance_count = u32::try_from(metric.advances.len())
                        .map_err(|_| AbiError::ArithmeticOverflow)?;
                    writer.instruction(SystemTextMetricOpcode::UpsertSystemTextMetric as u8, 0);
                    writer.u32(metric.string_id);
                    writer.u32(metric.style_id);
                    writer.f32(metric.max_line_width)?;
                    writer.u32(metric.line_count);
                    writer.u32(advance_count);
                    for (code_point, advance) in &metric.advances {
                        writer.u32(*code_point as u32);
                        writer.f32(*advance)?;
                    }
                    let positional_count = u32::try_from(metric.positional_advances.len())
                        .map_err(|_| AbiError::ArithmeticOverflow)?;
                    writer.u32(positional_count);
                    for advance in &metric.positional_advances {
                        writer.f32(*advance)?;
                    }
                    let contraction_count = u32::try_from(metric.contractions.len())
                        .map_err(|_| AbiError::ArithmeticOverflow)?;
                    writer.u32(contraction_count);
                    for contraction in &metric.contractions {
                        writer.u32(contraction.first as u32);
                        writer.u32(contraction.second as u32);
                        writer.f32(contraction.delta)?;
                        writer.f32(contraction.first_delta)?;
                    }
                }
                SystemTextMetricCommand::Release {
                    string_id,
                    style_id,
                } => {
                    writer.instruction(SystemTextMetricOpcode::ReleaseSystemTextMetric as u8, 0);
                    writer.u32(*string_id);
                    writer.u32(*style_id);
                }
            }
        }
        writer.finish(MAX_SYSTEM_TEXT_METRICS_BYTES)
    }
}

fn pair(command: &SystemTextMetricCommand) -> (u32, u32) {
    match command {
        SystemTextMetricCommand::Upsert(metric) => (metric.string_id, metric.style_id),
        SystemTextMetricCommand::Release {
            string_id,
            style_id,
        } => (*string_id, *style_id),
    }
}

/// Reads a declared advance array, bounding it before it can drive an
/// allocation. The stream is untrusted even when this project produced it.
fn read_advances(reader: &mut Reader<'_>, declared: u32) -> Result<Vec<(char, f32)>, AbiError> {
    if declared > MAX_SYSTEM_TEXT_ADVANCES {
        return Err(AbiError::InvalidValue(
            "system text advance count is outside the supported limit",
        ));
    }
    let count = usize::try_from(declared).map_err(|_| AbiError::ArithmeticOverflow)?;
    // Reserve against the bytes that actually remain, never the declared count:
    // a truncated stream must fail on the read, not on a huge allocation.
    let mut advances = Vec::with_capacity(count.min(reader.remaining() / 8));
    for _ in 0..count {
        let raw = reader.read_u32()?;
        let code_point = char::from_u32(raw).ok_or(AbiError::UnknownIdentifier {
            category: "system text advance code point",
            value: raw,
        })?;
        advances.push((code_point, reader.read_f32()?));
    }
    Ok(advances)
}

/// Reads a declared in-order advance array, bounded before it can allocate.
fn read_positional_advances(reader: &mut Reader<'_>, declared: u32) -> Result<Vec<f32>, AbiError> {
    if declared > MAX_SYSTEM_TEXT_ADVANCES {
        return Err(AbiError::InvalidValue(
            "system text positional advance count is outside the supported limit",
        ));
    }
    let count = usize::try_from(declared).map_err(|_| AbiError::ArithmeticOverflow)?;
    let mut advances = Vec::with_capacity(count.min(reader.remaining() / 4));
    for _ in 0..count {
        let advance = reader.read_f32()?;
        if !advance.is_finite() || advance < 0.0 {
            return Err(AbiError::InvalidValue(
                "system text advance must be finite and non-negative",
            ));
        }
        advances.push(advance);
    }
    Ok(advances)
}

/// Reads a declared contraction table, bounded before it can allocate.
fn read_contractions(
    reader: &mut Reader<'_>,
    declared: u32,
) -> Result<Vec<TextContraction>, AbiError> {
    if declared > MAX_SYSTEM_TEXT_ADVANCES {
        return Err(AbiError::InvalidValue(
            "system text contraction count is outside the supported limit",
        ));
    }
    let count = usize::try_from(declared).map_err(|_| AbiError::ArithmeticOverflow)?;
    let mut contractions = Vec::with_capacity(count.min(reader.remaining() / 16));
    let mut previous: Option<(u32, u32)> = None;
    for _ in 0..count {
        let first = reader.read_u32()?;
        let second = reader.read_u32()?;
        let delta = reader.read_f32()?;
        let first_delta = reader.read_f32()?;
        // Ascending and unique keeps one table one byte sequence.
        if previous.is_some_and(|last| (first, second) <= last) {
            return Err(AbiError::InvalidValue(
                "system text contractions must ascend without duplicates",
            ));
        }
        previous = Some((first, second));
        let (Some(first), Some(second)) = (char::from_u32(first), char::from_u32(second)) else {
            return Err(AbiError::InvalidValue(
                "system text contraction code point is not a Unicode scalar value",
            ));
        };
        if !delta.is_finite() || !first_delta.is_finite() {
            return Err(AbiError::InvalidValue(
                "system text contraction must be finite",
            ));
        }
        contractions.push(TextContraction {
            first,
            second,
            delta,
            first_delta,
        });
    }
    Ok(contractions)
}

fn validate_metric(
    max_line_width: f32,
    line_count: u32,
    advances: &[(char, f32)],
    positional_advances: &[f32],
    contractions: &[TextContraction],
) -> Result<(), AbiError> {
    if contractions.len() > MAX_SYSTEM_TEXT_ADVANCES as usize {
        return Err(AbiError::InvalidValue(
            "system text contraction count is outside the supported limit",
        ));
    }
    if contractions.windows(2).any(|pair| {
        (pair[0].first as u32, pair[0].second as u32)
            >= (pair[1].first as u32, pair[1].second as u32)
    }) {
        return Err(AbiError::InvalidValue(
            "system text contractions must ascend without duplicates",
        ));
    }
    if contractions
        .iter()
        .any(|entry| !entry.delta.is_finite() || !entry.first_delta.is_finite())
    {
        return Err(AbiError::InvalidValue(
            "system text contraction must be finite",
        ));
    }
    if positional_advances.len() > MAX_SYSTEM_TEXT_ADVANCES as usize {
        return Err(AbiError::InvalidValue(
            "system text positional advance count is outside the supported limit",
        ));
    }
    if positional_advances
        .iter()
        .any(|advance| !advance.is_finite() || *advance < 0.0)
    {
        return Err(AbiError::InvalidValue(
            "system text advance must be finite and non-negative",
        ));
    }
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
    if advances.len() > MAX_SYSTEM_TEXT_ADVANCES as usize {
        return Err(AbiError::InvalidValue(
            "system text advance count is outside the supported limit",
        ));
    }
    if advances
        .iter()
        .any(|(_, advance)| !advance.is_finite() || *advance < 0.0)
    {
        return Err(AbiError::InvalidValue(
            "system text advance must be finite and non-negative",
        ));
    }
    // Ascending and unique keeps one table one byte sequence, so a golden
    // fixture and a cross-language round trip still pin the encoding.
    if advances.windows(2).any(|pair| pair[0].0 >= pair[1].0) {
        return Err(AbiError::InvalidValue(
            "system text advances must ascend by code point without duplicates",
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
    // Fixed-size instructions must match exactly; a variable-size one still has
    // a floor below which its fixed fields could not have been read.
    let expected = match opcode.fixed_bytes() {
        Some(fixed) if actual != fixed => Some(fixed),
        Some(_) => None,
        None if actual < opcode.minimum_bytes() => Some(opcode.minimum_bytes()),
        None => None,
    };
    if let Some(expected) = expected {
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
                        advances: vec![('\n', 0.0), ('a', 6.5), ('\u{4e2d}', 12.0)],
                        positional_advances: vec![6.5, 0.0, 11.5],
                        contractions: vec![TextContraction {
                            first: '\u{3001}',
                            second: '\u{3001}',
                            delta: -8.0,
                            first_delta: -8.0,
                        }],
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
        duplicate
            .instructions
            .push(duplicate.instructions[0].clone());
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
                advances: Vec::new(),
                positional_advances: Vec::new(),
                contractions: Vec::new(),
            },
            SystemTextMetric {
                string_id: 1,
                style_id: 1,
                max_line_width: -1.0,
                line_count: 1,
                advances: Vec::new(),
                positional_advances: Vec::new(),
                contractions: Vec::new(),
            },
            SystemTextMetric {
                string_id: 1,
                style_id: 1,
                max_line_width: 1.0,
                line_count: 0,
                advances: Vec::new(),
                positional_advances: Vec::new(),
                contractions: Vec::new(),
            },
            SystemTextMetric {
                string_id: 1,
                style_id: 1,
                max_line_width: 1.0,
                line_count: 1,
                advances: vec![('a', f32::NAN)],
                positional_advances: Vec::new(),
                contractions: Vec::new(),
            },
            SystemTextMetric {
                string_id: 1,
                style_id: 1,
                max_line_width: 1.0,
                line_count: 1,
                advances: vec![('a', -1.0)],
                positional_advances: Vec::new(),
                contractions: Vec::new(),
            },
            SystemTextMetric {
                string_id: 1,
                style_id: 1,
                max_line_width: 1.0,
                line_count: 1,
                advances: Vec::new(),
                positional_advances: vec![-1.0],
                contractions: Vec::new(),
            },
            SystemTextMetric {
                string_id: 1,
                style_id: 1,
                max_line_width: 1.0,
                line_count: 1,
                advances: Vec::new(),
                positional_advances: vec![f32::NAN],
                contractions: Vec::new(),
            },
            SystemTextMetric {
                string_id: 1,
                style_id: 1,
                max_line_width: 1.0,
                line_count: 1,
                advances: Vec::new(),
                positional_advances: Vec::new(),
                contractions: vec![TextContraction {
                    first: 'a',
                    second: 'b',
                    delta: f32::NAN,
                    first_delta: 0.0,
                }],
            },
            SystemTextMetric {
                string_id: 1,
                style_id: 1,
                max_line_width: 1.0,
                line_count: 1,
                advances: Vec::new(),
                positional_advances: Vec::new(),
                contractions: vec![
                    TextContraction {
                        first: 'b',
                        second: 'a',
                        delta: -1.0,
                        first_delta: -1.0,
                    },
                    TextContraction {
                        first: 'a',
                        second: 'b',
                        delta: -1.0,
                        first_delta: -1.0,
                    },
                ],
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
    fn rejects_hostile_advance_counts_without_allocating() {
        let encoded = canonical().encode().expect("encode");
        // The Upsert advance count sits after opcode header, both ids, the width
        // and the line count: 16 stream header + 4 + 8 + 4 + 4.
        let count_offset = 36;
        assert_eq!(
            u32::from_le_bytes(
                encoded[count_offset..count_offset + 4]
                    .try_into()
                    .expect("count")
            ),
            3
        );

        let mut over_limit = encoded.clone();
        over_limit[count_offset..count_offset + 4]
            .copy_from_slice(&(MAX_SYSTEM_TEXT_ADVANCES + 1).to_le_bytes());
        assert_eq!(
            SystemTextMetricBatch::decode(&over_limit),
            Err(AbiError::InvalidValue(
                "system text advance count is outside the supported limit"
            ))
        );

        // Under the limit but past the payload: this must fail on the read, not
        // on a reservation sized by the attacker's number.
        let mut beyond_payload = encoded;
        beyond_payload[count_offset..count_offset + 4]
            .copy_from_slice(&1_000_000_u32.to_le_bytes());
        assert!(SystemTextMetricBatch::decode(&beyond_payload).is_err());

        // Reachable only from a hand-built batch, so assert the guards directly.
        assert_eq!(
            validate_metric(
                1.0,
                1,
                &(0..=MAX_SYSTEM_TEXT_ADVANCES)
                    .map(|index| (char::from_u32(index).unwrap_or('a'), 0.0))
                    .collect::<Vec<_>>(),
                &[],
                &[]
            ),
            Err(AbiError::InvalidValue(
                "system text advance count is outside the supported limit"
            ))
        );
        assert_eq!(
            validate_instruction_size(SystemTextMetricOpcode::UpsertSystemTextMetric, 0, 20),
            Err(AbiError::InstructionLengthMismatch {
                opcode: SystemTextMetricOpcode::UpsertSystemTextMetric as u8,
                offset: 0,
                expected: 32,
                actual: 20,
            })
        );
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

        // More instructions than the remaining bytes could possibly hold, even
        // at the smallest instruction size. Derived from the encoding so growing
        // an instruction does not silently turn this into a different assertion.
        let payload_ceiling = u32::try_from((encoded.len() - 16) / 12).expect("ceiling");
        let mut impossible_for_payload = encoded.clone();
        impossible_for_payload[12..16].copy_from_slice(&(payload_ceiling + 1).to_le_bytes());
        assert_eq!(
            SystemTextMetricBatch::decode(&impossible_for_payload),
            Err(AbiError::InstructionCountTooLarge {
                declared: payload_ceiling + 1,
                maximum: payload_ceiling,
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

        // The trailing Release instruction ends the stream, so its two resource
        // ids are the last eight bytes whatever the Upsert before it encodes to.
        let mut duplicate_pair = encoded.clone();
        let ids = duplicate_pair.len() - 8;
        duplicate_pair[ids..ids + 4].copy_from_slice(&7_u32.to_le_bytes());
        duplicate_pair[ids + 4..ids + 8].copy_from_slice(&9_u32.to_le_bytes());
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
