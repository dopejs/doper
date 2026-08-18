use crate::{
    ABI_VERSION, AbiError, INSTRUCTION_FLAG_MASK, INSTRUCTION_HEADER_BYTES,
    INSTRUCTION_LENGTH_ESCAPE, MINIMUM_READABLE_ABI_VERSION, PROTOCOL_ALIGNMENT,
    STREAM_HEADER_BYTES,
};

pub(crate) struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    pub(crate) const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    pub(crate) const fn offset(&self) -> usize {
        self.offset
    }

    pub(crate) fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.offset)
    }

    pub(crate) const fn len(&self) -> usize {
        self.bytes.len()
    }

    /// Moves the cursor to an absolute offset at or after the current one.
    pub(crate) fn seek_to(&mut self, offset: usize) -> Result<(), AbiError> {
        if offset < self.offset || offset > self.bytes.len() {
            return Err(AbiError::Truncated {
                offset: self.offset,
                needed: offset.saturating_sub(self.offset),
                available: self.remaining(),
            });
        }
        self.offset = offset;
        Ok(())
    }

    pub(crate) fn read_u8(&mut self) -> Result<u8, AbiError> {
        let offset = self.offset;
        self.require(1)?;
        self.offset += 1;
        Ok(self.bytes[offset])
    }

    pub(crate) fn read_u16(&mut self) -> Result<u16, AbiError> {
        let bytes = self.read_array::<2>()?;
        Ok(u16::from_le_bytes(bytes))
    }

    pub(crate) fn read_u32(&mut self) -> Result<u32, AbiError> {
        let bytes = self.read_array::<4>()?;
        Ok(u32::from_le_bytes(bytes))
    }

    pub(crate) fn read_f32(&mut self) -> Result<f32, AbiError> {
        let offset = self.offset;
        let value = f32::from_bits(self.read_u32()?);
        if value.is_finite() {
            Ok(value)
        } else {
            Err(AbiError::NonFiniteFloat { offset })
        }
    }

    pub(crate) fn read_bytes(&mut self, length: usize) -> Result<&'a [u8], AbiError> {
        self.require(length)?;
        let start = self.offset;
        self.offset += length;
        Ok(&self.bytes[start..self.offset])
    }

    pub(crate) fn read_zeroes(&mut self, length: usize) -> Result<(), AbiError> {
        let offset = self.offset;
        let bytes = self.read_bytes(length)?;
        if let Some(index) = bytes.iter().position(|byte| *byte != 0) {
            Err(AbiError::NonZeroReserved {
                offset: offset + index,
            })
        } else {
            Ok(())
        }
    }

    fn read_array<const N: usize>(&mut self) -> Result<[u8; N], AbiError> {
        let bytes = self.read_bytes(N)?;
        let mut result = [0; N];
        result.copy_from_slice(bytes);
        Ok(result)
    }

    fn require(&self, needed: usize) -> Result<(), AbiError> {
        let available = self.remaining();
        if available < needed {
            Err(AbiError::Truncated {
                offset: self.offset,
                needed,
                available,
            })
        } else {
            Ok(())
        }
    }
}

pub(crate) struct Writer {
    bytes: Vec<u8>,
    instruction_count: u32,
    /// Offset of the instruction still being written, if any.
    ///
    /// The length is not known when the header is emitted, so it is patched in
    /// once the instruction ends -- at the next header, or when the stream is
    /// finished. Keeping that here means no encoder call site has to know it
    /// exists, and no instruction can be written without a length.
    open_instruction: Option<usize>,
}

impl Writer {
    pub(crate) fn new(magic: u32) -> Self {
        let mut result = Self {
            bytes: Vec::with_capacity(256),
            instruction_count: 0,
            open_instruction: None,
        };
        result.u32(magic);
        result.u16(ABI_VERSION);
        result.u16(STREAM_HEADER_BYTES as u16);
        result.u32(0);
        result.u32(0);
        result
    }

    pub(crate) fn instruction(&mut self, opcode: u8, flags: u8) {
        self.close_instruction();
        self.open_instruction = Some(self.bytes.len());
        self.u8(opcode);
        self.u8(flags);
        // Patched by `close_instruction` once the payload is known.
        self.u16(0);
        self.instruction_count += 1;
    }

    /// Writes the length of the instruction that just ended.
    ///
    /// Instructions are four-byte aligned, so the length is stored in words and
    /// a `u16` covers 256 KiB. A resource payload may be far larger than that,
    /// so an oversized instruction stores {@link INSTRUCTION_LENGTH_ESCAPE} and
    /// carries its byte length in the trailing word instead, which a skipping
    /// reader finds without knowing the opcode.
    fn close_instruction(&mut self) {
        let Some(start) = self.open_instruction.take() else {
            return;
        };
        let length = self.bytes.len() - start;
        debug_assert!(
            length.is_multiple_of(PROTOCOL_ALIGNMENT),
            "unaligned instruction"
        );
        let words = length / PROTOCOL_ALIGNMENT;
        if let Ok(words) = u16::try_from(words)
            && words < INSTRUCTION_LENGTH_ESCAPE
        {
            self.bytes[start + 2..start + 4].copy_from_slice(&words.to_le_bytes());
            return;
        }
        self.bytes[start + 2..start + 4].copy_from_slice(&INSTRUCTION_LENGTH_ESCAPE.to_le_bytes());
        // Immediately after the header, not at the end: a reader that does not
        // know the opcode has no way to find the end until it has the length.
        let total = u32::try_from(length + PROTOCOL_ALIGNMENT).unwrap_or(u32::MAX);
        let header_end = start + INSTRUCTION_HEADER_BYTES;
        self.bytes
            .splice(header_end..header_end, total.to_le_bytes());
    }

    pub(crate) fn offset(&self) -> usize {
        self.bytes.len()
    }

    pub(crate) fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }

    pub(crate) fn u16(&mut self, value: u16) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub(crate) fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub(crate) fn f32(&mut self, value: f32) -> Result<(), AbiError> {
        if !value.is_finite() {
            return Err(AbiError::InvalidValue("non-finite float"));
        }
        self.u32(value.to_bits());
        Ok(())
    }

    pub(crate) fn bytes(&mut self, value: &[u8]) {
        self.bytes.extend_from_slice(value);
    }

    pub(crate) fn pad(&mut self) {
        while !self.bytes.len().is_multiple_of(PROTOCOL_ALIGNMENT) {
            self.u8(0);
        }
    }

    pub(crate) fn finish(mut self, maximum: usize) -> Result<Vec<u8>, AbiError> {
        self.close_instruction();
        if !self.bytes.len().is_multiple_of(PROTOCOL_ALIGNMENT) {
            return Err(AbiError::Misaligned {
                offset: self.bytes.len(),
            });
        }
        if self.bytes.len() > maximum {
            return Err(AbiError::TooLarge {
                actual: self.bytes.len(),
                maximum,
            });
        }
        let length = u32::try_from(self.bytes.len()).map_err(|_| AbiError::ArithmeticOverflow)?;
        self.bytes[8..12].copy_from_slice(&length.to_le_bytes());
        self.bytes[12..16].copy_from_slice(&self.instruction_count.to_le_bytes());
        Ok(self.bytes)
    }
}

/// One decoded stream header.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct StreamHeader {
    /// Instruction count the producer declared.
    pub declared_count: u32,
    /// ABI version the producer was built against.
    pub producer_version: u16,
}

pub(crate) fn read_header(
    reader: &mut Reader<'_>,
    expected_magic: u32,
    maximum: usize,
) -> Result<StreamHeader, AbiError> {
    let actual_length = reader.remaining();
    if actual_length > maximum {
        return Err(AbiError::TooLarge {
            actual: actual_length,
            maximum,
        });
    }
    if !actual_length.is_multiple_of(PROTOCOL_ALIGNMENT) {
        return Err(AbiError::Misaligned {
            offset: actual_length,
        });
    }
    if actual_length < STREAM_HEADER_BYTES {
        return Err(AbiError::Truncated {
            offset: 0,
            needed: STREAM_HEADER_BYTES,
            available: actual_length,
        });
    }

    let magic = reader.read_u32()?;
    if magic != expected_magic {
        return Err(AbiError::WrongMagic {
            expected: expected_magic,
            actual: magic,
        });
    }
    let producer_version = reader.read_u16()?;
    // A stream from a newer build stays readable: every instruction carries its
    // own length, so one this decoder has never heard of can be stepped over
    // when the producer marked it optional. A stream from before that framing
    // existed cannot be stepped through at all, so it is still refused rather
    // than parsed into garbage.
    if producer_version < MINIMUM_READABLE_ABI_VERSION {
        return Err(AbiError::UnsupportedVersion {
            expected: ABI_VERSION,
            actual: producer_version,
        });
    }
    let header_length = reader.read_u16()?;
    if usize::from(header_length) != STREAM_HEADER_BYTES {
        return Err(AbiError::InvalidHeaderLength {
            actual: header_length,
        });
    }
    let declared_length =
        usize::try_from(reader.read_u32()?).map_err(|_| AbiError::ArithmeticOverflow)?;
    if declared_length != actual_length {
        return Err(AbiError::LengthMismatch {
            declared: declared_length,
            actual: actual_length,
        });
    }
    Ok(StreamHeader {
        declared_count: reader.read_u32()?,
        producer_version,
    })
}

/// One decoded instruction header, including where the instruction ends.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct InstructionHeader {
    /// Offset the instruction starts at, for error reporting.
    pub offset: usize,
    pub opcode: u8,
    pub flags: u8,
    /// Offset one past the instruction's last byte.
    pub end: usize,
}

impl InstructionHeader {
    /// Whether the producer marked this instruction safe to ignore.
    ///
    /// Skipping is the producer's call, not the reader's: dropping an unknown
    /// draw command costs a visual detail, while dropping an unknown structural
    /// mutation would silently corrupt the Scene.
    pub const fn optional(self) -> bool {
        self.flags & crate::INSTRUCTION_FLAG_OPTIONAL != 0
    }
}

pub(crate) fn read_instruction_header(
    reader: &mut Reader<'_>,
) -> Result<InstructionHeader, AbiError> {
    let offset = reader.offset();
    if !offset.is_multiple_of(PROTOCOL_ALIGNMENT) {
        return Err(AbiError::Misaligned { offset });
    }
    if reader.remaining() < INSTRUCTION_HEADER_BYTES {
        return Err(AbiError::Truncated {
            offset,
            needed: INSTRUCTION_HEADER_BYTES,
            available: reader.remaining(),
        });
    }
    let opcode = reader.read_u8()?;
    let flags = reader.read_u8()?;
    if flags & !INSTRUCTION_FLAG_MASK != 0 {
        return Err(AbiError::UnsupportedFlags { offset, flags });
    }
    let words = reader.read_u16()?;
    let length = if words == INSTRUCTION_LENGTH_ESCAPE {
        // The word right after the header carries the true length; consume it
        // so the caller's cursor lands on the payload either way.
        let extended = reader.read_u32()?;
        usize::try_from(extended).map_err(|_| AbiError::ArithmeticOverflow)?
    } else {
        usize::from(words)
            .checked_mul(PROTOCOL_ALIGNMENT)
            .ok_or(AbiError::ArithmeticOverflow)?
    };
    let end = offset
        .checked_add(length)
        .ok_or(AbiError::ArithmeticOverflow)?;
    // A length that is too small, misaligned, or past the end of the stream
    // would let a skipping reader resume mid-instruction and decode payload
    // bytes as opcodes.
    if length < INSTRUCTION_HEADER_BYTES
        || !length.is_multiple_of(PROTOCOL_ALIGNMENT)
        || end > reader.len()
    {
        return Err(AbiError::InstructionLengthMismatch {
            opcode,
            offset,
            expected: INSTRUCTION_HEADER_BYTES,
            actual: length,
        });
    }
    Ok(InstructionHeader {
        offset,
        opcode,
        flags,
        end,
    })
}

/// Checks that a decoded instruction consumed exactly what its header declared.
///
/// Without this a stream could declare one length and carry another: the
/// decoder would read the real payload while a skipping reader stepped by the
/// declared one, and the two would disagree about where the next instruction
/// begins.
pub(crate) fn finish_instruction(
    reader: &Reader<'_>,
    header: InstructionHeader,
) -> Result<(), AbiError> {
    if reader.offset() != header.end {
        return Err(AbiError::InstructionLengthMismatch {
            opcode: header.opcode,
            offset: header.offset,
            expected: header.end - header.offset,
            actual: reader.offset().saturating_sub(header.offset),
        });
    }
    Ok(())
}

pub(crate) fn checked_padding(length: usize) -> Result<usize, AbiError> {
    let remainder = length % PROTOCOL_ALIGNMENT;
    Ok(if remainder == 0 {
        0
    } else {
        PROTOCOL_ALIGNMENT
            .checked_sub(remainder)
            .ok_or(AbiError::ArithmeticOverflow)?
    })
}

pub(crate) fn validate_encode_instruction_count(
    payload_count: usize,
    trailing_count: usize,
    maximum: u32,
) -> Result<(), AbiError> {
    let actual = payload_count
        .checked_add(trailing_count)
        .ok_or(AbiError::ArithmeticOverflow)?;
    if actual > maximum as usize {
        return Err(AbiError::InstructionCountTooLarge {
            declared: u32::try_from(actual).unwrap_or(u32::MAX),
            maximum,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::INSTRUCTION_FLAG_OPTIONAL;
    use crate::MUTATION_MAGIC;

    #[test]
    fn reader_reports_non_finite_reserved_and_truncated_fields() {
        let nan = f32::NAN.to_le_bytes();
        assert!(matches!(
            Reader::new(&nan).read_f32(),
            Err(AbiError::NonFiniteFloat { offset: 0 })
        ));
        assert_eq!(
            Reader::new(&[0, 1]).read_zeroes(2),
            Err(AbiError::NonZeroReserved { offset: 1 })
        );
        assert_eq!(
            Reader::new(&[1]).read_u32(),
            Err(AbiError::Truncated {
                offset: 0,
                needed: 4,
                available: 1,
            })
        );
    }

    #[test]
    fn writer_enforces_float_alignment_and_size_contracts() {
        let mut non_finite = Writer::new(MUTATION_MAGIC);
        assert_eq!(
            non_finite.f32(f32::INFINITY),
            Err(AbiError::InvalidValue("non-finite float"))
        );

        let mut misaligned = Writer::new(MUTATION_MAGIC);
        misaligned.u8(1);
        assert_eq!(
            misaligned.finish(100),
            Err(AbiError::Misaligned { offset: 17 })
        );

        let mut padded = Writer::new(MUTATION_MAGIC);
        padded.bytes(&[1, 2, 3]);
        padded.pad();
        let bytes = padded.finish(20).expect("aligned writer");
        assert_eq!(&bytes[16..], &[1, 2, 3, 0]);

        let mut too_large = Writer::new(MUTATION_MAGIC);
        too_large.u32(1);
        assert_eq!(
            too_large.finish(16),
            Err(AbiError::TooLarge {
                actual: 20,
                maximum: 16,
            })
        );
    }

    #[test]
    fn header_validation_rejects_each_declared_envelope_mismatch() {
        let canonical = Writer::new(MUTATION_MAGIC).finish(16).expect("header");
        let mut wrong_magic = canonical.clone();
        wrong_magic[0] ^= 1;
        assert!(matches!(
            read_header(&mut Reader::new(&wrong_magic), MUTATION_MAGIC, 16),
            Err(AbiError::WrongMagic { .. })
        ));
        let mut wrong_header = canonical.clone();
        wrong_header[6..8].copy_from_slice(&12_u16.to_le_bytes());
        assert_eq!(
            read_header(&mut Reader::new(&wrong_header), MUTATION_MAGIC, 16),
            Err(AbiError::InvalidHeaderLength { actual: 12 })
        );
        let mut wrong_length = canonical.clone();
        wrong_length[8..12].copy_from_slice(&20_u32.to_le_bytes());
        assert!(matches!(
            read_header(&mut Reader::new(&wrong_length), MUTATION_MAGIC, 16),
            Err(AbiError::LengthMismatch { .. })
        ));
        assert!(matches!(
            read_header(&mut Reader::new(&canonical), MUTATION_MAGIC, 15),
            Err(AbiError::TooLarge { .. })
        ));
        assert!(matches!(
            read_header(&mut Reader::new(&canonical[..15]), MUTATION_MAGIC, 16),
            Err(AbiError::Misaligned { .. })
        ));
        assert!(matches!(
            read_header(&mut Reader::new(&canonical[..12]), MUTATION_MAGIC, 16),
            Err(AbiError::Truncated { .. })
        ));
    }

    #[test]
    fn instruction_headers_reject_misalignment_truncation_flags_and_bad_lengths() {
        let mut reader = Reader::new(&[0; 8]);
        reader.read_u8().expect("one byte");
        assert_eq!(
            read_instruction_header(&mut reader),
            Err(AbiError::Misaligned { offset: 1 })
        );
        assert!(matches!(
            read_instruction_header(&mut Reader::new(&[1, 0, 0])),
            Err(AbiError::Truncated { .. })
        ));
        assert!(matches!(
            read_instruction_header(&mut Reader::new(&[1, 2, 1, 0])),
            Err(AbiError::UnsupportedFlags { flags: 2, .. })
        ));
        // A length of zero words would leave a skipping reader on the same
        // instruction forever; one that runs past the stream would let it
        // resume inside a payload and read it as opcodes.
        assert!(matches!(
            read_instruction_header(&mut Reader::new(&[1, 0, 0, 0])),
            Err(AbiError::InstructionLengthMismatch { .. })
        ));
        assert!(matches!(
            read_instruction_header(&mut Reader::new(&[1, 0, 2, 0])),
            Err(AbiError::InstructionLengthMismatch { .. })
        ));
        let header = read_instruction_header(&mut Reader::new(&[7, 0, 1, 0])).expect("header");
        assert_eq!(header.opcode, 7);
        assert_eq!(header.end, 4);
        assert!(!header.optional());
        assert!(
            read_instruction_header(&mut Reader::new(&[7, INSTRUCTION_FLAG_OPTIONAL, 1, 0]))
                .expect("optional header")
                .optional()
        );
        assert_eq!(checked_padding(4), Ok(0));
        assert_eq!(checked_padding(5), Ok(3));
    }

    #[test]
    fn an_oversized_instruction_carries_its_length_in_a_trailing_word() {
        // A `u16` word count tops out at 256 KiB while a resource may be eight
        // megabytes, so the escape has to work or large resources cannot be
        // skipped by a reader that does not know their opcode.
        let mut writer = Writer::new(MUTATION_MAGIC);
        writer.instruction(1, INSTRUCTION_FLAG_OPTIONAL);
        let payload = usize::from(INSTRUCTION_LENGTH_ESCAPE) * PROTOCOL_ALIGNMENT;
        for _ in 0..payload / 4 {
            writer.u32(0);
        }
        let bytes = writer.finish(usize::MAX).expect("stream");
        let mut reader = Reader::new(&bytes);
        read_header(&mut reader, MUTATION_MAGIC, usize::MAX).expect("header");
        let header = read_instruction_header(&mut reader).expect("instruction");
        assert!(header.optional());
        assert_eq!(header.end, bytes.len());
    }

    #[test]
    fn a_declared_length_that_disagrees_with_the_payload_is_refused() {
        // The skip path and the decode path must agree on where an instruction
        // ends. If they can disagree, a stream can make one of them resume in
        // the middle of a payload and read it as opcodes.
        let mut reader = Reader::new(&[7, 0, 2, 0, 0, 0, 0, 0]);
        let header = read_instruction_header(&mut reader).expect("header");
        assert_eq!(finish_instruction(&reader, header), {
            Err(AbiError::InstructionLengthMismatch {
                opcode: 7,
                offset: 0,
                expected: 8,
                actual: 4,
            })
        });
        reader.read_u32().expect("payload");
        assert_eq!(finish_instruction(&reader, header), Ok(()));
    }

    #[test]
    fn seeking_refuses_to_move_backwards_or_past_the_end() {
        // A skip that could move backwards would let a stream loop forever, and
        // one past the end would read whatever follows the buffer.
        let mut reader = Reader::new(&[0; 8]);
        reader.read_u32().expect("advance");
        assert!(matches!(reader.seek_to(0), Err(AbiError::Truncated { .. })));
        assert!(matches!(reader.seek_to(9), Err(AbiError::Truncated { .. })));
        assert_eq!(reader.seek_to(8), Ok(()));
        assert_eq!(reader.remaining(), 0);
    }

    #[test]
    fn an_escaped_length_is_read_back_exactly_as_written() {
        // The escape only matters for payloads past 256 KiB, which is where a
        // resource lives, so it has to survive a real round trip rather than
        // only the header check.
        let mut writer = Writer::new(MUTATION_MAGIC);
        writer.instruction(1, 0);
        let payload_words = usize::from(INSTRUCTION_LENGTH_ESCAPE);
        for index in 0..payload_words {
            writer.u32(index as u32);
        }
        writer.instruction(2, INSTRUCTION_FLAG_OPTIONAL);
        writer.u32(0xdead_beef);
        let bytes = writer.finish(usize::MAX).expect("stream");

        let mut reader = Reader::new(&bytes);
        read_header(&mut reader, MUTATION_MAGIC, usize::MAX).expect("header");
        let first = read_instruction_header(&mut reader).expect("first");
        assert_eq!(first.opcode, 1);
        assert!(!first.optional());
        reader.seek_to(first.end).expect("skip payload");
        let second = read_instruction_header(&mut reader).expect("second");
        assert_eq!(second.opcode, 2);
        assert!(second.optional());
        assert_eq!(reader.read_u32(), Ok(0xdead_beef));
        assert_eq!(finish_instruction(&reader, second), Ok(()));
        assert_eq!(second.end, bytes.len());
    }

    #[test]
    fn encode_instruction_count_is_checked_before_writing() {
        assert_eq!(validate_encode_instruction_count(2, 1, 3), Ok(()));
        assert_eq!(
            validate_encode_instruction_count(3, 1, 3),
            Err(AbiError::InstructionCountTooLarge {
                declared: 4,
                maximum: 3,
            })
        );
        assert_eq!(
            validate_encode_instruction_count(usize::MAX, 1, 3),
            Err(AbiError::ArithmeticOverflow)
        );
    }
}
