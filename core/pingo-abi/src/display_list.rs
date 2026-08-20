use crate::codec::{
    Reader, Writer, checked_padding, finish_instruction, read_header, read_instruction_header,
    validate_encode_instruction_count,
};
use crate::{
    AbiError, DISPLAY_LIST_MAGIC, DisplayOpcode, MAX_DISPLAY_INSTRUCTIONS, MAX_DISPLAY_LIST_BYTES,
    MAX_RESOURCE_BYTES, StreamKind,
};

/// Semantic editor overlay kind retained for backend conformance diagnostics.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u16)]
pub enum EditorDecorationKind {
    /// Active range selection background.
    Selection = 1,
    /// Collapsed insertion caret.
    Caret = 2,
    /// Active IME composition underline.
    Composition = 3,
}

impl EditorDecorationKind {
    fn decode(value: u16) -> Result<Self, AbiError> {
        match value {
            1 => Ok(Self::Selection),
            2 => Ok(Self::Caret),
            3 => Ok(Self::Composition),
            _ => Err(AbiError::InvalidValue("unknown editor decoration kind")),
        }
    }
}

/// One validated Core-to-backend drawing command.
#[derive(Clone, Debug, PartialEq)]
pub enum DisplayCommand {
    /// Saves the current graphics state.
    Save,
    /// Restores the most recently saved graphics state.
    Restore,
    /// Concatenates an affine transform `[a, b, c, d, e, f]`.
    Transform([f32; 6]),
    /// Intersects the current clip with a rectangle `[x, y, width, height]`.
    ClipRect([f32; 4]),
    /// Multiplies global alpha by a value in the inclusive range zero to one.
    Alpha(f32),
    /// Fills a rectangle with an interned paint.
    FillRect {
        /// Rectangle `[x, y, width, height]`.
        rect: [f32; 4],
        /// Interned paint identifier.
        paint_id: u32,
    },
    /// Fills a rounded rectangle with per-corner radii.
    FillRRect {
        /// Rectangle `[x, y, width, height]`.
        rect: [f32; 4],
        /// Corner radii `[top_left, top_right, bottom_right, bottom_left]`.
        radii: [f32; 4],
        /// Interned paint identifier.
        paint_id: u32,
    },
    /// Fills an interned path.
    FillPath {
        /// Interned path identifier.
        path_id: u32,
        /// Interned paint identifier.
        paint_id: u32,
    },
    /// Draws a shaped glyph span.
    DrawGlyphRun {
        /// Interned font identifier.
        font_id: u32,
        /// Font size in logical pixels.
        size: f32,
        /// Baseline origin `[x, y]`.
        origin: [f32; 2],
        /// Interned glyph-span identifier.
        glyph_span_id: u32,
    },
    /// Draws a system-font fallback string.
    DrawTextFallback {
        /// Interned UTF-8 string identifier.
        string_id: u32,
        /// Interned host font description identifier.
        font_description_id: u32,
        /// Baseline origin `[x, y]`.
        origin: [f32; 2],
    },
    /// Draws a validated inline UTF-8 fallback owned by active Core editing state.
    DrawTextInlineFallback {
        /// Interned host font description identifier.
        font_description_id: u32,
        /// Baseline origin `[x, y]`.
        origin: [f32; 2],
        /// Inline text unavailable as an immutable Scene resource yet.
        text: String,
    },
    /// Fills a Core-authored skeleton for a virtual item the Shell has not
    /// materialized yet, so a lagging refill degrades to a visible placeholder
    /// instead of blank canvas.
    FillPlaceholder {
        /// Rectangle `[x, y, width, height]`.
        rect: [f32; 4],
        /// Straight (non-premultiplied) RGBA colour.
        rgba: u32,
    },
    /// Draws one Core-derived editor overlay without a transient Scene resource.
    DrawEditorDecoration {
        /// Local rectangle `[x, y, width, height]`.
        rect: [f32; 4],
        /// Packed red/green/blue/alpha bytes in network-readable `0xRRGGBBAA` order.
        rgba: u32,
        /// Overlay semantics.
        kind: EditorDecorationKind,
    },
    /// Draws an image from one rectangle into another.
    DrawImage {
        /// Interned image identifier.
        image_id: u32,
        /// Source rectangle.
        source: [f32; 4],
        /// Destination rectangle.
        destination: [f32; 4],
    },
    /// Reuses an immutable cached picture at an offset.
    DrawPicture {
        /// Interned picture identifier.
        picture_id: u32,
        /// Destination offset `[x, y]`.
        offset: [f32; 2],
    },
}

/// A drawing command plus versioned flags.
#[derive(Clone, Debug, PartialEq)]
pub struct DisplayInstruction {
    /// Instruction flags. Version 1 requires this value to be zero.
    pub flags: u8,
    /// Validated drawing command.
    pub command: DisplayCommand,
}

/// A complete, balanced, immutable display list.
#[derive(Clone, Debug, PartialEq)]
pub struct DisplayList {
    /// Commands in replay order.
    pub instructions: Vec<DisplayInstruction>,
}

impl DisplayList {
    /// Decodes a complete list and validates the graphics-state stack.
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
        let stream = read_header(&mut reader, DISPLAY_LIST_MAGIC, MAX_DISPLAY_LIST_BYTES)?;
        let declared_count = stream.declared_count;
        let mut skipped = 0_u32;
        if declared_count > MAX_DISPLAY_INSTRUCTIONS {
            return Err(AbiError::InstructionCountTooLarge {
                declared: declared_count,
                maximum: MAX_DISPLAY_INSTRUCTIONS,
            });
        }
        let maximum_count =
            u32::try_from(reader.remaining() / 4).map_err(|_| AbiError::ArithmeticOverflow)?;
        if declared_count > maximum_count {
            return Err(AbiError::InstructionCountTooLarge {
                declared: declared_count,
                maximum: maximum_count,
            });
        }
        let capacity = usize::try_from(declared_count).map_err(|_| AbiError::ArithmeticOverflow)?;
        let mut instructions = Vec::with_capacity(capacity);
        let mut actual_count = 0_u32;
        let mut save_depth = 0_u32;

        while reader.remaining() != 0 {
            let header = read_instruction_header(&mut reader)?;
            let (offset, raw_opcode, flags) = (header.offset, header.opcode, header.flags);
            // A stream from a newer build may carry instructions this decoder has
            // never heard of. Skipping one is only safe when the producer marked it
            // optional, so an unmarked unknown instruction is still fatal.
            let Some(opcode) = DisplayOpcode::from_u8(raw_opcode) else {
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
                    stream: StreamKind::DisplayList,
                    opcode: raw_opcode,
                    offset,
                });
            };
            actual_count = actual_count
                .checked_add(1)
                .ok_or(AbiError::ArithmeticOverflow)?;
            if opcode == DisplayOpcode::Save {
                save_depth = save_depth
                    .checked_add(1)
                    .ok_or(AbiError::ArithmeticOverflow)?;
            } else if opcode == DisplayOpcode::Restore {
                save_depth = save_depth
                    .checked_sub(1)
                    .ok_or(AbiError::RestoreUnderflow { offset })?;
            }
            let command = decode_command(opcode, &mut reader)?;
            validate_instruction_size(opcode, offset, reader.offset())?;
            finish_instruction(&reader, header)?;
            instructions.push(DisplayInstruction { flags, command });
        }

        if actual_count != declared_count {
            return Err(AbiError::InstructionCountMismatch {
                declared: declared_count,
                actual: actual_count,
            });
        }
        if save_depth != 0 {
            return Err(AbiError::UnbalancedState { depth: save_depth });
        }
        Ok((
            Self { instructions },
            crate::DecodeReport {
                skipped_instructions: skipped,
                producer_abi_version: stream.producer_version,
            },
        ))
    }

    /// Encodes a canonical list after validating graphics-state balance.
    pub fn encode(&self) -> Result<Vec<u8>, AbiError> {
        validate_encode_instruction_count(self.instructions.len(), 0, MAX_DISPLAY_INSTRUCTIONS)?;
        let mut writer = Writer::new(DISPLAY_LIST_MAGIC);
        let mut save_depth = 0_u32;
        for instruction in &self.instructions {
            match instruction.command {
                DisplayCommand::Save => {
                    save_depth = save_depth
                        .checked_add(1)
                        .ok_or(AbiError::ArithmeticOverflow)?;
                }
                DisplayCommand::Restore => {
                    save_depth = save_depth
                        .checked_sub(1)
                        .ok_or(AbiError::InvalidValue("Restore without Save"))?;
                }
                _ => {}
            }
            encode_command(&mut writer, instruction)?;
        }
        if save_depth != 0 {
            return Err(AbiError::UnbalancedState { depth: save_depth });
        }
        writer.finish(MAX_DISPLAY_LIST_BYTES)
    }
}

fn decode_command(
    opcode: DisplayOpcode,
    reader: &mut Reader<'_>,
) -> Result<DisplayCommand, AbiError> {
    Ok(match opcode {
        DisplayOpcode::Save => DisplayCommand::Save,
        DisplayOpcode::Restore => DisplayCommand::Restore,
        DisplayOpcode::Transform => DisplayCommand::Transform(read_f32_array(reader)?),
        DisplayOpcode::ClipRect => DisplayCommand::ClipRect(read_f32_array(reader)?),
        DisplayOpcode::Alpha => {
            let value = reader.read_f32()?;
            if !(0.0..=1.0).contains(&value) {
                return Err(AbiError::InvalidValue("alpha outside zero-to-one range"));
            }
            DisplayCommand::Alpha(value)
        }
        DisplayOpcode::FillRect => DisplayCommand::FillRect {
            rect: read_f32_array(reader)?,
            paint_id: reader.read_u32()?,
        },
        DisplayOpcode::FillRRect => DisplayCommand::FillRRect {
            rect: read_f32_array(reader)?,
            radii: read_f32_array(reader)?,
            paint_id: reader.read_u32()?,
        },
        DisplayOpcode::FillPath => DisplayCommand::FillPath {
            path_id: reader.read_u32()?,
            paint_id: reader.read_u32()?,
        },
        DisplayOpcode::DrawGlyphRun => DisplayCommand::DrawGlyphRun {
            font_id: reader.read_u32()?,
            size: reader.read_f32()?,
            origin: read_f32_array(reader)?,
            glyph_span_id: reader.read_u32()?,
        },
        DisplayOpcode::DrawTextFallback => DisplayCommand::DrawTextFallback {
            string_id: reader.read_u32()?,
            font_description_id: reader.read_u32()?,
            origin: read_f32_array(reader)?,
        },
        DisplayOpcode::DrawTextInlineFallback => {
            let font_description_id = reader.read_u32()?;
            let origin = read_f32_array(reader)?;
            let length =
                usize::try_from(reader.read_u32()?).map_err(|_| AbiError::ArithmeticOverflow)?;
            if length > MAX_RESOURCE_BYTES {
                return Err(AbiError::ResourceTooLarge {
                    actual: length,
                    maximum: MAX_RESOURCE_BYTES,
                });
            }
            let text = std::str::from_utf8(reader.read_bytes(length)?)
                .map_err(|_| AbiError::InvalidValue("inline fallback text is not UTF-8"))?
                .to_owned();
            reader.read_zeroes(checked_padding(length)?)?;
            DisplayCommand::DrawTextInlineFallback {
                font_description_id,
                origin,
                text,
            }
        }
        DisplayOpcode::DrawEditorDecoration => {
            let rect = read_f32_array(reader)?;
            if rect[2] < 0.0 || rect[3] < 0.0 {
                return Err(AbiError::InvalidValue(
                    "editor decoration has negative extent",
                ));
            }
            let rgba = reader.read_u32()?;
            let kind = EditorDecorationKind::decode(reader.read_u16()?)?;
            reader.read_zeroes(2)?;
            DisplayCommand::DrawEditorDecoration { rect, rgba, kind }
        }
        DisplayOpcode::FillPlaceholder => {
            let rect = read_f32_array(reader)?;
            if rect[2] < 0.0 || rect[3] < 0.0 {
                return Err(AbiError::InvalidValue("placeholder has negative extent"));
            }
            DisplayCommand::FillPlaceholder {
                rect,
                rgba: reader.read_u32()?,
            }
        }
        DisplayOpcode::DrawImage => DisplayCommand::DrawImage {
            image_id: reader.read_u32()?,
            source: read_f32_array(reader)?,
            destination: read_f32_array(reader)?,
        },
        DisplayOpcode::DrawPicture => DisplayCommand::DrawPicture {
            picture_id: reader.read_u32()?,
            offset: read_f32_array(reader)?,
        },
    })
}

fn encode_command(writer: &mut Writer, instruction: &DisplayInstruction) -> Result<(), AbiError> {
    let offset = writer.offset();
    let flags = instruction.flags;
    if flags != 0 {
        return Err(AbiError::UnsupportedFlags { offset: 0, flags });
    }
    match &instruction.command {
        DisplayCommand::Save => writer.instruction(DisplayOpcode::Save as u8, flags),
        DisplayCommand::Restore => writer.instruction(DisplayOpcode::Restore as u8, flags),
        DisplayCommand::Transform(transform) => {
            writer.instruction(DisplayOpcode::Transform as u8, flags);
            write_f32_array(writer, transform)?;
        }
        DisplayCommand::ClipRect(rect) => {
            writer.instruction(DisplayOpcode::ClipRect as u8, flags);
            write_f32_array(writer, rect)?;
        }
        DisplayCommand::Alpha(value) => {
            if !(0.0..=1.0).contains(value) {
                return Err(AbiError::InvalidValue("alpha outside zero-to-one range"));
            }
            writer.instruction(DisplayOpcode::Alpha as u8, flags);
            writer.f32(*value)?;
        }
        DisplayCommand::FillRect { rect, paint_id } => {
            writer.instruction(DisplayOpcode::FillRect as u8, flags);
            write_f32_array(writer, rect)?;
            writer.u32(*paint_id);
        }
        DisplayCommand::FillRRect {
            rect,
            radii,
            paint_id,
        } => {
            writer.instruction(DisplayOpcode::FillRRect as u8, flags);
            write_f32_array(writer, rect)?;
            write_f32_array(writer, radii)?;
            writer.u32(*paint_id);
        }
        DisplayCommand::FillPath { path_id, paint_id } => {
            writer.instruction(DisplayOpcode::FillPath as u8, flags);
            writer.u32(*path_id);
            writer.u32(*paint_id);
        }
        DisplayCommand::DrawGlyphRun {
            font_id,
            size,
            origin,
            glyph_span_id,
        } => {
            writer.instruction(DisplayOpcode::DrawGlyphRun as u8, flags);
            writer.u32(*font_id);
            writer.f32(*size)?;
            write_f32_array(writer, origin)?;
            writer.u32(*glyph_span_id);
        }
        DisplayCommand::DrawTextFallback {
            string_id,
            font_description_id,
            origin,
        } => {
            writer.instruction(DisplayOpcode::DrawTextFallback as u8, flags);
            writer.u32(*string_id);
            writer.u32(*font_description_id);
            write_f32_array(writer, origin)?;
        }
        DisplayCommand::DrawTextInlineFallback {
            font_description_id,
            origin,
            text,
        } => {
            if text.len() > MAX_RESOURCE_BYTES {
                return Err(AbiError::ResourceTooLarge {
                    actual: text.len(),
                    maximum: MAX_RESOURCE_BYTES,
                });
            }
            writer.instruction(DisplayOpcode::DrawTextInlineFallback as u8, flags);
            writer.u32(*font_description_id);
            write_f32_array(writer, origin)?;
            writer.u32(u32::try_from(text.len()).map_err(|_| AbiError::ArithmeticOverflow)?);
            writer.bytes(text.as_bytes());
            writer.pad();
        }
        DisplayCommand::DrawEditorDecoration { rect, rgba, kind } => {
            if rect[2] < 0.0 || rect[3] < 0.0 {
                return Err(AbiError::InvalidValue(
                    "editor decoration has negative extent",
                ));
            }
            writer.instruction(DisplayOpcode::DrawEditorDecoration as u8, flags);
            write_f32_array(writer, rect)?;
            writer.u32(*rgba);
            writer.u16(*kind as u16);
            writer.u16(0);
        }
        DisplayCommand::FillPlaceholder { rect, rgba } => {
            if rect[2] < 0.0 || rect[3] < 0.0 {
                return Err(AbiError::InvalidValue("placeholder has negative extent"));
            }
            writer.instruction(DisplayOpcode::FillPlaceholder as u8, flags);
            write_f32_array(writer, rect)?;
            writer.u32(*rgba);
        }
        DisplayCommand::DrawImage {
            image_id,
            source,
            destination,
        } => {
            writer.instruction(DisplayOpcode::DrawImage as u8, flags);
            writer.u32(*image_id);
            write_f32_array(writer, source)?;
            write_f32_array(writer, destination)?;
        }
        DisplayCommand::DrawPicture { picture_id, offset } => {
            writer.instruction(DisplayOpcode::DrawPicture as u8, flags);
            writer.u32(*picture_id);
            write_f32_array(writer, offset)?;
        }
    }
    validate_instruction_size(
        display_opcode(&instruction.command),
        offset,
        writer.offset(),
    )?;
    Ok(())
}

fn display_opcode(command: &DisplayCommand) -> DisplayOpcode {
    match command {
        DisplayCommand::Save => DisplayOpcode::Save,
        DisplayCommand::Restore => DisplayOpcode::Restore,
        DisplayCommand::Transform(_) => DisplayOpcode::Transform,
        DisplayCommand::ClipRect(_) => DisplayOpcode::ClipRect,
        DisplayCommand::Alpha(_) => DisplayOpcode::Alpha,
        DisplayCommand::FillRect { .. } => DisplayOpcode::FillRect,
        DisplayCommand::FillRRect { .. } => DisplayOpcode::FillRRect,
        DisplayCommand::FillPath { .. } => DisplayOpcode::FillPath,
        DisplayCommand::DrawGlyphRun { .. } => DisplayOpcode::DrawGlyphRun,
        DisplayCommand::DrawTextFallback { .. } => DisplayOpcode::DrawTextFallback,
        DisplayCommand::DrawTextInlineFallback { .. } => DisplayOpcode::DrawTextInlineFallback,
        DisplayCommand::DrawEditorDecoration { .. } => DisplayOpcode::DrawEditorDecoration,
        DisplayCommand::FillPlaceholder { .. } => DisplayOpcode::FillPlaceholder,
        DisplayCommand::DrawImage { .. } => DisplayOpcode::DrawImage,
        DisplayCommand::DrawPicture { .. } => DisplayOpcode::DrawPicture,
    }
}

fn validate_instruction_size(
    opcode: DisplayOpcode,
    offset: usize,
    end: usize,
) -> Result<(), AbiError> {
    let actual = end
        .checked_sub(offset)
        .ok_or(AbiError::ArithmeticOverflow)?;
    let expected = opcode
        .fixed_bytes()
        .unwrap_or_else(|| opcode.minimum_bytes());
    if opcode.fixed_bytes().is_some() && actual != expected
        || opcode.fixed_bytes().is_none()
            && (actual < expected || actual % crate::PROTOCOL_ALIGNMENT != 0)
    {
        return Err(AbiError::InstructionLengthMismatch {
            opcode: opcode as u8,
            offset,
            expected,
            actual,
        });
    }
    Ok(())
}

fn read_f32_array<const N: usize>(reader: &mut Reader<'_>) -> Result<[f32; N], AbiError> {
    let mut result = [0.0; N];
    for value in &mut result {
        *value = reader.read_f32()?;
    }
    Ok(result)
}

fn write_f32_array(writer: &mut Writer, values: &[f32]) -> Result<(), AbiError> {
    for value in values {
        writer.f32(*value)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn sample_list() -> DisplayList {
        DisplayList {
            instructions: vec![
                DisplayInstruction {
                    flags: 0,
                    command: DisplayCommand::Save,
                },
                DisplayInstruction {
                    flags: 0,
                    command: DisplayCommand::ClipRect([0.0, 0.0, 640.0, 480.0]),
                },
                DisplayInstruction {
                    flags: 0,
                    command: DisplayCommand::FillRect {
                        rect: [4.0, 8.0, 100.0, 20.0],
                        paint_id: 2,
                    },
                },
                DisplayInstruction {
                    flags: 0,
                    command: DisplayCommand::Restore,
                },
            ],
        }
    }

    #[test]
    fn canonical_round_trip() {
        let list = sample_list();
        let bytes = list.encode().expect("sample encodes");
        assert_eq!(DisplayList::decode(&bytes), Ok(list));
    }

    #[test]
    fn every_display_opcode_round_trips_in_one_balanced_list() {
        let commands = vec![
            DisplayCommand::Save,
            DisplayCommand::Transform([1.0, 0.0, 0.0, 1.0, 4.0, 8.0]),
            DisplayCommand::ClipRect([0.0, 0.0, 100.0, 50.0]),
            DisplayCommand::Alpha(0.5),
            DisplayCommand::FillRect {
                rect: [1.0, 2.0, 3.0, 4.0],
                paint_id: 1,
            },
            DisplayCommand::FillRRect {
                rect: [1.0, 2.0, 3.0, 4.0],
                radii: [1.0, 2.0, 3.0, 4.0],
                paint_id: 2,
            },
            DisplayCommand::FillPath {
                path_id: 3,
                paint_id: 4,
            },
            DisplayCommand::DrawGlyphRun {
                font_id: 5,
                size: 16.0,
                origin: [6.0, 7.0],
                glyph_span_id: 8,
            },
            DisplayCommand::DrawTextFallback {
                string_id: 9,
                font_description_id: 10,
                origin: [11.0, 12.0],
            },
            DisplayCommand::DrawTextInlineFallback {
                font_description_id: 10,
                origin: [11.0, 12.0],
                text: "编🙂".to_owned(),
            },
            DisplayCommand::DrawEditorDecoration {
                rect: [2.0, 3.0, 1.5, 18.0],
                rgba: 0x1122_33ff,
                kind: EditorDecorationKind::Caret,
            },
            DisplayCommand::DrawImage {
                image_id: 13,
                source: [0.0, 0.0, 10.0, 10.0],
                destination: [1.0, 2.0, 20.0, 20.0],
            },
            DisplayCommand::DrawPicture {
                picture_id: 14,
                offset: [15.0, 16.0],
            },
            DisplayCommand::Restore,
        ];
        let list = DisplayList {
            instructions: commands
                .into_iter()
                .map(|command| DisplayInstruction { flags: 0, command })
                .collect(),
        };
        assert_eq!(
            DisplayList::decode(&list.encode().expect("encode")),
            Ok(list)
        );
    }

    #[test]
    fn rejects_unbalanced_state() {
        let list = DisplayList {
            instructions: vec![DisplayInstruction {
                flags: 0,
                command: DisplayCommand::Save,
            }],
        };
        assert_eq!(list.encode(), Err(AbiError::UnbalancedState { depth: 1 }));
    }

    #[test]
    fn rejects_hostile_counts_before_allocating_commands() {
        let mut bytes = sample_list().encode().expect("sample encodes");
        bytes[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(matches!(
            DisplayList::decode(&bytes),
            Err(AbiError::InstructionCountTooLarge { .. })
        ));
    }

    proptest! {
        #[test]
        fn arbitrary_bytes_never_panic(bytes in prop::collection::vec(any::<u8>(), 0..4096)) {
            let _ = DisplayList::decode(&bytes);
        }

        #[test]
        fn fill_rect_round_trips(
            rect in prop::array::uniform4(-10000.0_f32..10000.0),
            paint_id in any::<u32>(),
        ) {
            let list = DisplayList {
                instructions: vec![DisplayInstruction {
                    flags: 0,
                    command: DisplayCommand::FillRect { rect, paint_id },
                }],
            };
            let bytes = list.encode().expect("finite list encodes");
            prop_assert_eq!(DisplayList::decode(&bytes), Ok(list));
        }
    }
    #[test]
    fn an_unknown_draw_command_is_skipped_only_when_the_producer_allowed_it() {
        // Losing a draw command costs a visual detail, which is the defined
        // downgrade for a list produced by a newer build. Losing one the
        // producer did not mark skippable is not: it could be the Restore that
        // balances a Save.
        let canonical = DisplayList {
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
        .expect("encode");

        let build = |flags: u8| {
            let mut bytes = canonical.clone();
            bytes.extend_from_slice(&[0xfe, flags, 2, 0, 0, 0, 0, 0]);
            let length = u32::try_from(bytes.len()).expect("length");
            bytes[8..12].copy_from_slice(&length.to_le_bytes());
            bytes[12..16].copy_from_slice(&3_u32.to_le_bytes());
            bytes
        };

        let (list, report) =
            DisplayList::decode_with_report(&build(crate::INSTRUCTION_FLAG_OPTIONAL))
                .expect("skipped");
        assert_eq!(report.skipped_instructions, 1);
        assert_eq!(report.producer_abi_version, crate::ABI_VERSION);
        assert_eq!(list.instructions.len(), 2);

        assert!(matches!(
            DisplayList::decode(&build(0)),
            Err(AbiError::UnknownOpcode { opcode: 0xfe, .. })
        ));
    }
}
