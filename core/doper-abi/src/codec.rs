use crate::{
    ABI_VERSION, AbiError, INSTRUCTION_HEADER_BYTES, PROTOCOL_ALIGNMENT, STREAM_HEADER_BYTES,
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
}

impl Writer {
    pub(crate) fn new(magic: u32) -> Self {
        let mut result = Self {
            bytes: Vec::with_capacity(256),
            instruction_count: 0,
        };
        result.u32(magic);
        result.u16(ABI_VERSION);
        result.u16(STREAM_HEADER_BYTES as u16);
        result.u32(0);
        result.u32(0);
        result
    }

    pub(crate) fn instruction(&mut self, opcode: u8, flags: u8) {
        self.u8(opcode);
        self.u8(flags);
        self.u16(0);
        self.instruction_count += 1;
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

pub(crate) fn read_header(
    reader: &mut Reader<'_>,
    expected_magic: u32,
    maximum: usize,
) -> Result<u32, AbiError> {
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
    let version = reader.read_u16()?;
    if version != ABI_VERSION {
        return Err(AbiError::UnsupportedVersion {
            expected: ABI_VERSION,
            actual: version,
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
    reader.read_u32()
}

pub(crate) fn read_instruction_header(
    reader: &mut Reader<'_>,
) -> Result<(usize, u8, u8), AbiError> {
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
    if flags != 0 {
        return Err(AbiError::UnsupportedFlags { offset, flags });
    }
    let reserved_offset = reader.offset();
    if reader.read_u16()? != 0 {
        return Err(AbiError::NonZeroReserved {
            offset: reserved_offset,
        });
    }
    Ok((offset, opcode, flags))
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
    fn instruction_headers_reject_misalignment_truncation_flags_and_reserved_bytes() {
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
            read_instruction_header(&mut Reader::new(&[1, 2, 0, 0])),
            Err(AbiError::UnsupportedFlags { flags: 2, .. })
        ));
        assert!(matches!(
            read_instruction_header(&mut Reader::new(&[1, 0, 1, 0])),
            Err(AbiError::NonZeroReserved { .. })
        ));
        assert_eq!(checked_padding(4), Ok(0));
        assert_eq!(checked_padding(5), Ok(3));
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
