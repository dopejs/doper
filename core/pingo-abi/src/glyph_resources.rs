use std::{collections::HashSet, sync::Arc};

use crate::codec::{
    Reader, Writer, checked_padding, finish_instruction, read_header, read_instruction_header,
    validate_encode_instruction_count,
};
use crate::{
    AbiError, GLYPH_BITMAP_MINIMUM_BYTES, GLYPH_PLACEMENT_MINIMUM_BYTES, GLYPH_RESOURCES_MAGIC,
    GlyphResourceOpcode, MAX_GLYPH_BITMAP_PIXELS, MAX_GLYPH_RESOURCE_INSTRUCTIONS,
    MAX_GLYPH_RESOURCES_BYTES, PROTOCOL_ALIGNMENT, StreamKind,
};

/// One immutable grayscale glyph bitmap in device pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct GlyphBitmapResource {
    /// Font-local glyph identifier.
    pub glyph_id: u16,
    /// Device-pixel offset left of the glyph origin.
    pub left: f32,
    /// Device-pixel offset above the baseline.
    pub top: f32,
    /// Bitmap width in device pixels.
    pub width: u32,
    /// Bitmap height in device pixels.
    pub height: u32,
    /// Device-pixel ratio used to generate the bitmap.
    pub device_pixel_ratio: f32,
    /// One alpha byte per pixel in row-major order.
    pub data: Arc<[u8]>,
}

/// One positioned use of a bitmap inside a shaped span.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlyphPlacementResource {
    /// Index into [`GlyphSpanResource::bitmaps`].
    pub bitmap_index: u32,
    /// Logical-pixel glyph origin relative to the run origin.
    pub x: f32,
    /// Logical-pixel glyph baseline relative to the run origin.
    pub y: f32,
}

/// Complete immutable backend payload for one shaped glyph span.
#[derive(Clone, Debug, PartialEq)]
pub struct GlyphSpanResource {
    /// Core-owned derived resource identifier.
    pub span_id: u32,
    /// Portable solid-paint resource used to colorize the masks.
    pub paint_id: u32,
    /// Unique bitmaps used by this span.
    pub bitmaps: Vec<GlyphBitmapResource>,
    /// Glyphs in visual draw order.
    pub placements: Vec<GlyphPlacementResource>,
}

/// One glyph-resource delta.
#[derive(Clone, Debug, PartialEq)]
pub enum GlyphResourceCommand {
    /// Defines a new immutable glyph span.
    Define(GlyphSpanResource),
    /// Releases a span after no active DisplayList references it.
    Release {
        /// Core-owned derived resource identifier.
        span_id: u32,
    },
}

/// A glyph-resource command plus versioned flags.
#[derive(Clone, Debug, PartialEq)]
pub struct GlyphResourceInstruction {
    /// Instruction flags. ABI v1 requires zero.
    pub flags: u8,
    /// Validated resource delta.
    pub command: GlyphResourceCommand,
}

/// Transactional Core-to-backend glyph resource batch.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GlyphResourceBatch {
    /// Resource deltas in application order.
    pub instructions: Vec<GlyphResourceInstruction>,
}

impl GlyphResourceBatch {
    /// Decodes and fully validates a glyph-resource batch.
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
            GLYPH_RESOURCES_MAGIC,
            MAX_GLYPH_RESOURCES_BYTES,
        )?;
        let declared_count = stream.declared_count;
        let mut skipped = 0_u32;
        if declared_count > MAX_GLYPH_RESOURCE_INSTRUCTIONS {
            return Err(AbiError::InstructionCountTooLarge {
                declared: declared_count,
                maximum: MAX_GLYPH_RESOURCE_INSTRUCTIONS,
            });
        }
        let maximum_count =
            u32::try_from(reader.remaining() / 8).map_err(|_| AbiError::ArithmeticOverflow)?;
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
            let Some(opcode) = GlyphResourceOpcode::from_u8(raw_opcode) else {
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
                    stream: StreamKind::GlyphResources,
                    opcode: raw_opcode,
                    offset,
                });
            };
            actual_count = actual_count
                .checked_add(1)
                .ok_or(AbiError::ArithmeticOverflow)?;
            let command = match opcode {
                GlyphResourceOpcode::DefineGlyphSpan => {
                    GlyphResourceCommand::Define(decode_span(&mut reader)?)
                }
                GlyphResourceOpcode::ReleaseGlyphSpan => GlyphResourceCommand::Release {
                    span_id: nonzero_id(reader.read_u32()?, "glyph span id must be non-zero")?,
                },
            };
            let span_id = match &command {
                GlyphResourceCommand::Define(span) => span.span_id,
                GlyphResourceCommand::Release { span_id } => *span_id,
            };
            if !seen.insert(span_id) {
                return Err(AbiError::InvalidValue(
                    "glyph span id occurs more than once in a batch",
                ));
            }
            validate_instruction_size(opcode, offset, reader.offset())?;
            finish_instruction(&reader, header)?;
            instructions.push(GlyphResourceInstruction { flags, command });
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

    /// Encodes a canonical glyph-resource batch.
    pub fn encode(&self) -> Result<Vec<u8>, AbiError> {
        validate_encode_instruction_count(
            self.instructions.len(),
            0,
            MAX_GLYPH_RESOURCE_INSTRUCTIONS,
        )?;
        let mut writer = Writer::new(GLYPH_RESOURCES_MAGIC);
        let mut seen = HashSet::with_capacity(self.instructions.len());
        for instruction in &self.instructions {
            if instruction.flags != 0 {
                return Err(AbiError::InvalidValue(
                    "glyph resource instruction flags must be zero",
                ));
            }
            let span_id = match &instruction.command {
                GlyphResourceCommand::Define(span) => span.span_id,
                GlyphResourceCommand::Release { span_id } => *span_id,
            };
            nonzero_id(span_id, "glyph span id must be non-zero")?;
            if !seen.insert(span_id) {
                return Err(AbiError::InvalidValue(
                    "glyph span id occurs more than once in a batch",
                ));
            }
            encode_command(&mut writer, &instruction.command)?;
        }
        writer.finish(MAX_GLYPH_RESOURCES_BYTES)
    }
}

fn decode_span(reader: &mut Reader<'_>) -> Result<GlyphSpanResource, AbiError> {
    let span_id = nonzero_id(reader.read_u32()?, "glyph span id must be non-zero")?;
    let paint_id = nonzero_id(reader.read_u32()?, "glyph paint id must be non-zero")?;
    let bitmap_count =
        usize::try_from(reader.read_u32()?).map_err(|_| AbiError::ArithmeticOverflow)?;
    let glyph_count =
        usize::try_from(reader.read_u32()?).map_err(|_| AbiError::ArithmeticOverflow)?;
    let payload_bytes =
        usize::try_from(reader.read_u32()?).map_err(|_| AbiError::ArithmeticOverflow)?;
    if !payload_bytes.is_multiple_of(PROTOCOL_ALIGNMENT) {
        return Err(AbiError::Misaligned {
            offset: payload_bytes,
        });
    }
    let payload = reader.read_bytes(payload_bytes)?;
    let minimum = bitmap_count
        .checked_mul(GLYPH_BITMAP_MINIMUM_BYTES)
        .and_then(|bytes| {
            glyph_count
                .checked_mul(GLYPH_PLACEMENT_MINIMUM_BYTES)
                .and_then(|placements| bytes.checked_add(placements))
        })
        .ok_or(AbiError::ArithmeticOverflow)?;
    if minimum > payload.len() {
        return Err(AbiError::Truncated {
            offset: 0,
            needed: minimum,
            available: payload.len(),
        });
    }
    let mut payload_reader = Reader::new(payload);
    let mut bitmaps = Vec::with_capacity(bitmap_count);
    for _ in 0..bitmap_count {
        bitmaps.push(decode_bitmap(&mut payload_reader)?);
    }
    let mut placements = Vec::with_capacity(glyph_count);
    for _ in 0..glyph_count {
        let bitmap_index = payload_reader.read_u32()?;
        if usize::try_from(bitmap_index)
            .ok()
            .is_none_or(|index| index >= bitmaps.len())
        {
            return Err(AbiError::InvalidValue(
                "glyph placement bitmap index is out of bounds",
            ));
        }
        placements.push(GlyphPlacementResource {
            bitmap_index,
            x: payload_reader.read_f32()?,
            y: payload_reader.read_f32()?,
        });
    }
    if payload_reader.remaining() != 0 {
        return Err(AbiError::InstructionLengthMismatch {
            opcode: GlyphResourceOpcode::DefineGlyphSpan as u8,
            offset: 0,
            expected: payload.len() - payload_reader.remaining(),
            actual: payload.len(),
        });
    }
    Ok(GlyphSpanResource {
        span_id,
        paint_id,
        bitmaps,
        placements,
    })
}

fn decode_bitmap(reader: &mut Reader<'_>) -> Result<GlyphBitmapResource, AbiError> {
    let glyph_id = reader.read_u16()?;
    reader.read_zeroes(2)?;
    let left = reader.read_f32()?;
    let top = reader.read_f32()?;
    let width = reader.read_u32()?;
    let height = reader.read_u32()?;
    let device_pixel_ratio = reader.read_f32()?;
    if device_pixel_ratio <= 0.0 {
        return Err(AbiError::InvalidValue("glyph bitmap DPR must be positive"));
    }
    let data_bytes =
        usize::try_from(reader.read_u32()?).map_err(|_| AbiError::ArithmeticOverflow)?;
    validate_bitmap_area(width, height, data_bytes)?;
    let data = Arc::from(reader.read_bytes(data_bytes)?);
    reader.read_zeroes(checked_padding(data_bytes)?)?;
    Ok(GlyphBitmapResource {
        glyph_id,
        left,
        top,
        width,
        height,
        device_pixel_ratio,
        data,
    })
}

fn encode_command(writer: &mut Writer, command: &GlyphResourceCommand) -> Result<(), AbiError> {
    match command {
        GlyphResourceCommand::Define(span) => {
            nonzero_id(span.paint_id, "glyph paint id must be non-zero")?;
            let payload_bytes = span_payload_bytes(span)?;
            writer.instruction(GlyphResourceOpcode::DefineGlyphSpan as u8, 0);
            writer.u32(span.span_id);
            writer.u32(span.paint_id);
            writer
                .u32(u32::try_from(span.bitmaps.len()).map_err(|_| AbiError::ArithmeticOverflow)?);
            writer.u32(
                u32::try_from(span.placements.len()).map_err(|_| AbiError::ArithmeticOverflow)?,
            );
            writer.u32(u32::try_from(payload_bytes).map_err(|_| AbiError::ArithmeticOverflow)?);
            for bitmap in &span.bitmaps {
                validate_bitmap(bitmap)?;
                writer.u16(bitmap.glyph_id);
                writer.u16(0);
                writer.f32(bitmap.left)?;
                writer.f32(bitmap.top)?;
                writer.u32(bitmap.width);
                writer.u32(bitmap.height);
                writer.f32(bitmap.device_pixel_ratio)?;
                writer.u32(
                    u32::try_from(bitmap.data.len()).map_err(|_| AbiError::ArithmeticOverflow)?,
                );
                writer.bytes(&bitmap.data);
                writer.pad();
            }
            for placement in &span.placements {
                if usize::try_from(placement.bitmap_index)
                    .ok()
                    .is_none_or(|index| index >= span.bitmaps.len())
                {
                    return Err(AbiError::InvalidValue(
                        "glyph placement bitmap index is out of bounds",
                    ));
                }
                writer.u32(placement.bitmap_index);
                writer.f32(placement.x)?;
                writer.f32(placement.y)?;
            }
        }
        GlyphResourceCommand::Release { span_id } => {
            writer.instruction(GlyphResourceOpcode::ReleaseGlyphSpan as u8, 0);
            writer.u32(*span_id);
        }
    }
    Ok(())
}

fn span_payload_bytes(span: &GlyphSpanResource) -> Result<usize, AbiError> {
    let mut bytes = span
        .placements
        .len()
        .checked_mul(GLYPH_PLACEMENT_MINIMUM_BYTES)
        .ok_or(AbiError::ArithmeticOverflow)?;
    for bitmap in &span.bitmaps {
        validate_bitmap(bitmap)?;
        bytes = bytes
            .checked_add(GLYPH_BITMAP_MINIMUM_BYTES)
            .and_then(|total| total.checked_add(bitmap.data.len()))
            .and_then(|total| total.checked_add(checked_padding(bitmap.data.len()).ok()?))
            .ok_or(AbiError::ArithmeticOverflow)?;
    }
    Ok(bytes)
}

fn validate_bitmap(bitmap: &GlyphBitmapResource) -> Result<(), AbiError> {
    if !bitmap.left.is_finite()
        || !bitmap.top.is_finite()
        || !bitmap.device_pixel_ratio.is_finite()
        || bitmap.device_pixel_ratio <= 0.0
    {
        return Err(AbiError::InvalidValue(
            "glyph bitmap geometry and DPR must be finite and positive",
        ));
    }
    validate_bitmap_area(bitmap.width, bitmap.height, bitmap.data.len())
}

fn validate_bitmap_area(width: u32, height: u32, data_bytes: usize) -> Result<(), AbiError> {
    let pixels = usize::try_from(width)
        .map_err(|_| AbiError::ArithmeticOverflow)?
        .checked_mul(usize::try_from(height).map_err(|_| AbiError::ArithmeticOverflow)?)
        .ok_or(AbiError::ArithmeticOverflow)?;
    if pixels == 0 || pixels > MAX_GLYPH_BITMAP_PIXELS || pixels != data_bytes {
        return Err(AbiError::InvalidValue(
            "glyph bitmap must contain one bounded alpha byte per pixel",
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
    opcode: GlyphResourceOpcode,
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
    use std::sync::Arc;

    use proptest::prelude::*;

    use super::*;

    fn sample_batch() -> GlyphResourceBatch {
        GlyphResourceBatch {
            instructions: vec![
                GlyphResourceInstruction {
                    flags: 0,
                    command: GlyphResourceCommand::Define(GlyphSpanResource {
                        span_id: 7,
                        paint_id: 3,
                        bitmaps: vec![GlyphBitmapResource {
                            glyph_id: 42,
                            left: -1.0,
                            top: 9.0,
                            width: 2,
                            height: 2,
                            device_pixel_ratio: 2.0,
                            data: Arc::from([0_u8, 127, 255, 64]),
                        }],
                        placements: vec![GlyphPlacementResource {
                            bitmap_index: 0,
                            x: 1.5,
                            y: 12.0,
                        }],
                    }),
                },
                GlyphResourceInstruction {
                    flags: 0,
                    command: GlyphResourceCommand::Release { span_id: 8 },
                },
            ],
        }
    }

    #[test]
    fn canonical_batch_round_trips_exactly() {
        let batch = sample_batch();
        let bytes = batch.encode().expect("encode");
        assert_eq!(bytes.len() % PROTOCOL_ALIGNMENT, 0);
        assert_eq!(GlyphResourceBatch::decode(&bytes), Ok(batch));
    }

    #[test]
    fn rejects_bad_bitmap_geometry_indices_duplicates_and_truncation() {
        let mut bad_area = sample_batch();
        let GlyphResourceCommand::Define(span) = &mut bad_area.instructions[0].command else {
            unreachable!()
        };
        span.bitmaps[0].width = 3;
        assert!(matches!(bad_area.encode(), Err(AbiError::InvalidValue(_))));

        let mut bad_index = sample_batch();
        let GlyphResourceCommand::Define(span) = &mut bad_index.instructions[0].command else {
            unreachable!()
        };
        span.placements[0].bitmap_index = 1;
        assert!(matches!(bad_index.encode(), Err(AbiError::InvalidValue(_))));

        let mut duplicate = sample_batch();
        duplicate.instructions[1].command = GlyphResourceCommand::Release { span_id: 7 };
        assert!(matches!(duplicate.encode(), Err(AbiError::InvalidValue(_))));

        let bytes = sample_batch().encode().expect("encode");
        assert!(GlyphResourceBatch::decode(&bytes[..bytes.len() - 4]).is_err());
    }

    #[test]
    fn encoder_rejects_every_invalid_identity_flag_and_geometry_lane() {
        let mut cases = Vec::new();

        let mut flags = sample_batch();
        flags.instructions[0].flags = 1;
        cases.push(flags);

        let mut zero_span = sample_batch();
        let GlyphResourceCommand::Define(span) = &mut zero_span.instructions[0].command else {
            unreachable!()
        };
        span.span_id = 0;
        cases.push(zero_span);

        let mut zero_paint = sample_batch();
        let GlyphResourceCommand::Define(span) = &mut zero_paint.instructions[0].command else {
            unreachable!()
        };
        span.paint_id = 0;
        cases.push(zero_paint);

        let mut zero_area = sample_batch();
        let GlyphResourceCommand::Define(span) = &mut zero_area.instructions[0].command else {
            unreachable!()
        };
        span.bitmaps[0].width = 0;
        cases.push(zero_area);

        let mut non_finite = sample_batch();
        let GlyphResourceCommand::Define(span) = &mut non_finite.instructions[0].command else {
            unreachable!()
        };
        span.bitmaps[0].left = f32::NAN;
        cases.push(non_finite);

        let mut zero_dpr = sample_batch();
        let GlyphResourceCommand::Define(span) = &mut zero_dpr.instructions[0].command else {
            unreachable!()
        };
        span.bitmaps[0].device_pixel_ratio = 0.0;
        cases.push(zero_dpr);

        for case in cases {
            assert!(matches!(case.encode(), Err(AbiError::InvalidValue(_))));
        }
    }

    #[test]
    fn decoder_rejects_hostile_opcode_headers_counts_and_payload_fields() {
        let canonical = sample_batch().encode().expect("encode");
        // Byte 17 is the instruction flags: bit zero now means "skippable", so
        // an undefined bit is what must still be refused.
        for (offset, value) in [(16, 99), (17, 2), (18, 1)] {
            let mut bytes = canonical.clone();
            bytes[offset] = value;
            assert!(GlyphResourceBatch::decode(&bytes).is_err());
        }

        for (offset, value) in [(20, 0), (24, 0), (52, 3), (60, 0), (72, 1)] {
            let mut bytes = canonical.clone();
            write_u32(&mut bytes, offset, value);
            assert!(GlyphResourceBatch::decode(&bytes).is_err());
        }

        let mut duplicate = canonical.clone();
        write_u32(&mut duplicate, 88, 7);
        assert!(matches!(
            GlyphResourceBatch::decode(&duplicate),
            Err(AbiError::InvalidValue(_))
        ));

        let mut count_mismatch = canonical.clone();
        write_u32(&mut count_mismatch, 12, 1);
        assert!(matches!(
            GlyphResourceBatch::decode(&count_mismatch),
            Err(AbiError::InstructionCountMismatch { .. })
        ));

        let mut trailing_payload = canonical;
        write_u32(&mut trailing_payload, 28, 0);
        write_u32(&mut trailing_payload, 32, 0);
        assert!(matches!(
            GlyphResourceBatch::decode(&trailing_payload),
            Err(AbiError::InstructionLengthMismatch { .. })
        ));
    }

    #[test]
    fn bitmap_padding_is_canonical_and_checked() {
        let mut batch = sample_batch();
        let GlyphResourceCommand::Define(span) = &mut batch.instructions[0].command else {
            unreachable!()
        };
        span.bitmaps[0].width = 3;
        span.bitmaps[0].height = 1;
        span.bitmaps[0].data = Arc::from([1_u8, 2, 3]);
        let mut bytes = batch.encode().expect("three-byte bitmap");
        assert_eq!(bytes[71], 0);
        bytes[71] = 1;
        assert!(matches!(
            GlyphResourceBatch::decode(&bytes),
            Err(AbiError::NonZeroReserved { .. })
        ));
    }

    #[test]
    fn empty_and_bitmap_free_batches_round_trip() {
        let empty = GlyphResourceBatch::default();
        assert_eq!(
            GlyphResourceBatch::decode(&empty.encode().expect("empty encode")),
            Ok(empty)
        );
        let blank = GlyphResourceBatch {
            instructions: vec![GlyphResourceInstruction {
                flags: 0,
                command: GlyphResourceCommand::Define(GlyphSpanResource {
                    span_id: 9,
                    paint_id: 3,
                    bitmaps: Vec::new(),
                    placements: Vec::new(),
                }),
            }],
        };
        assert_eq!(
            GlyphResourceBatch::decode(&blank.encode().expect("blank encode")),
            Ok(blank)
        );
    }

    #[test]
    fn decoder_rejects_impossible_envelopes_before_allocation() {
        let canonical = sample_batch().encode().expect("encode");
        let mut excessive = canonical.clone();
        write_u32(&mut excessive, 12, MAX_GLYPH_RESOURCE_INSTRUCTIONS + 1);
        assert!(matches!(
            GlyphResourceBatch::decode(&excessive),
            Err(AbiError::InstructionCountTooLarge { .. })
        ));

        let mut cannot_fit = canonical.clone();
        write_u32(&mut cannot_fit, 12, 100);
        assert!(matches!(
            GlyphResourceBatch::decode(&cannot_fit),
            Err(AbiError::InstructionCountTooLarge { .. })
        ));

        let mut misaligned_payload = canonical.clone();
        write_u32(&mut misaligned_payload, 36, 1);
        assert!(matches!(
            GlyphResourceBatch::decode(&misaligned_payload),
            Err(AbiError::Misaligned { .. })
        ));

        let mut non_finite = canonical;
        write_u32(&mut non_finite, 44, f32::NAN.to_bits());
        assert!(matches!(
            GlyphResourceBatch::decode(&non_finite),
            Err(AbiError::NonFiniteFloat { .. })
        ));
    }

    fn write_u32(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    proptest! {
        #[test]
        fn arbitrary_bytes_never_panic(bytes in proptest::collection::vec(any::<u8>(), 0..512)) {
            let _ = GlyphResourceBatch::decode(&bytes);
        }
    }
}
