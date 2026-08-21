use std::collections::HashSet;

use crate::codec::{
    Reader, Writer, finish_instruction, read_header, read_instruction_header,
    validate_encode_instruction_count,
};
use crate::{
    AbiError, EVENT_TRANSACTIONS_MAGIC, EventTransactionOpcode, InputEventKind, InputPointerType,
    MAX_EVENT_TRANSACTION_INSTRUCTIONS, MAX_EVENT_TRANSACTIONS_BYTES, MAX_KEYBOARD_CODE_ID,
    MAX_KEYBOARD_KEY_NAME_ID, MAX_RESOURCE_BYTES, NULL_NODE_ID, StreamKind, StyleKeyword,
};

/// One Core-hit-tested event and its stable propagation path.
#[derive(Clone, Debug, PartialEq)]
pub struct EventTransactionRecord {
    /// Host-monotonic event identifier.
    pub event_id: u32,
    /// Browser-independent event category.
    pub kind: InputEventKind,
    /// Deepest hit node.
    pub target: u32,
    /// Canvas-local logical coordinates.
    pub position: [f32; 2],
    /// Wheel delta or zeroes.
    pub delta: [f32; 2],
    /// Browser pointer button bitset.
    pub buttons: u32,
    /// Shift/Control/Alt/Meta bits.
    pub modifiers: u32,
    /// Browser pointer identity, or zero for non-pointer events.
    pub pointer_id: u32,
    /// Time since the previous related sample in microseconds.
    pub elapsed_micros: u32,
    /// Opposite endpoint for boundary/focus transitions, or the null node id.
    pub related_target: u32,
    /// Normalized browser pointer source.
    pub pointer_type: InputPointerType,
    /// Whether this is the primary pointer of its type.
    pub is_primary: bool,
    /// Normalized pressure in the inclusive 0..=1 range.
    pub pressure: f32,
    /// Pen tilt in degrees for the X and Y planes.
    pub tilt: [f32; 2],
    /// Contact geometry in logical pixels.
    pub contact_size: [f32; 2],
    /// Core-resolved CSS cursor for the current physical pointer target.
    pub cursor: StyleKeyword,
    /// Interned `KeyboardEvent.code`, or zero outside a key event.
    pub key_code: u16,
    /// Interned named `KeyboardEvent.key`, or zero.
    pub key_name: u16,
    /// Unicode scalar of a single-character `key`, or zero.
    pub key_text: u32,
    /// Whether a key press is an auto-repeat.
    pub repeat: bool,
    /// Root-to-target generation-bearing path.
    pub path: Vec<u32>,
}

/// Transactional reverse-event batch.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EventTransactionBatch {
    /// Events in accepted input order.
    pub records: Vec<EventTransactionRecord>,
}

impl EventTransactionBatch {
    /// Fully decodes and validates untrusted reverse event bytes.
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
            EVENT_TRANSACTIONS_MAGIC,
            MAX_EVENT_TRANSACTIONS_BYTES,
        )?;
        let declared = stream.declared_count;
        let mut skipped = 0_u32;
        if declared > MAX_EVENT_TRANSACTION_INSTRUCTIONS {
            return Err(AbiError::InstructionCountTooLarge {
                declared,
                maximum: MAX_EVENT_TRANSACTION_INSTRUCTIONS,
            });
        }
        let minimum = EventTransactionOpcode::Event.minimum_bytes();
        let maximum = u32::try_from(reader.remaining() / minimum)
            .map_err(|_| AbiError::ArithmeticOverflow)?;
        if declared > maximum {
            return Err(AbiError::InstructionCountTooLarge { declared, maximum });
        }
        let capacity = usize::try_from(declared).map_err(|_| AbiError::ArithmeticOverflow)?;
        let mut records = Vec::with_capacity(capacity);
        while reader.remaining() > 0 {
            let header = read_instruction_header(&mut reader)?;
            let (offset, raw_opcode) = (header.offset, header.opcode);
            // A stream from a newer build may carry instructions this decoder has
            // never heard of. Skipping one is only safe when the producer marked it
            // optional, so an unmarked unknown instruction is still fatal.
            let Some(opcode) = EventTransactionOpcode::from_u8(raw_opcode) else {
                if header.optional() {
                    skipped = skipped.saturating_add(1);
                    reader.seek_to(header.end)?;
                    continue;
                }
                return Err(AbiError::UnknownOpcode {
                    stream: StreamKind::EventTransactions,
                    opcode: raw_opcode,
                    offset,
                });
            };
            let record = decode_record(&mut reader)?;
            finish_instruction(&reader, header)?;
            validate_size(opcode, offset, reader.offset())?;
            records.push(record);
        }
        // A skipped record was still in the stream, so it counts toward the
        // declared total; otherwise the count check rejects every downgrade.
        let actual = u32::try_from(records.len())
            .map_err(|_| AbiError::ArithmeticOverflow)?
            .checked_add(skipped)
            .ok_or(AbiError::ArithmeticOverflow)?;
        if actual != declared {
            return Err(AbiError::InstructionCountMismatch { declared, actual });
        }
        Ok((
            Self { records },
            crate::DecodeReport {
                skipped_instructions: skipped,
                producer_abi_version: stream.producer_version,
            },
        ))
    }

    /// Encodes a canonical aligned reverse event batch.
    pub fn encode(&self) -> Result<Vec<u8>, AbiError> {
        validate_encode_instruction_count(
            self.records.len(),
            0,
            MAX_EVENT_TRANSACTION_INSTRUCTIONS,
        )?;
        let mut writer = Writer::new(EVENT_TRANSACTIONS_MAGIC);
        for record in &self.records {
            validate_record(record)?;
            let offset = writer.offset();
            writer.instruction(EventTransactionOpcode::Event as u8, 0);
            writer.u32(record.event_id);
            writer.u16(record.kind as u16);
            writer.u16(0);
            writer.u32(record.target);
            for value in record.position.into_iter().chain(record.delta) {
                writer.f32(value)?;
            }
            writer.u32(record.buttons);
            writer.u32(record.modifiers);
            writer.u32(record.pointer_id);
            writer.u32(record.elapsed_micros);
            writer.u32(record.related_target);
            writer.u8(record.pointer_type as u8);
            writer.u8(u8::from(record.is_primary));
            writer.u16(0);
            writer.f32(record.pressure)?;
            writer.f32(record.tilt[0])?;
            writer.f32(record.tilt[1])?;
            writer.f32(record.contact_size[0])?;
            writer.f32(record.contact_size[1])?;
            writer.u16(record.cursor as u16);
            writer.u16(record.key_code);
            writer.u16(record.key_name);
            writer.u8(u8::from(record.repeat));
            writer.u8(0);
            writer.u32(record.key_text);
            writer.u32(u32::try_from(record.path.len()).map_err(|_| AbiError::ArithmeticOverflow)?);
            for node in &record.path {
                writer.u32(*node);
            }
            validate_size(EventTransactionOpcode::Event, offset, writer.offset())?;
        }
        writer.finish(MAX_EVENT_TRANSACTIONS_BYTES)
    }
}

fn decode_record(reader: &mut Reader<'_>) -> Result<EventTransactionRecord, AbiError> {
    let event_id = reader.read_u32()?;
    let kind = InputEventKind::decode(reader.read_u16()?)?;
    reader.read_zeroes(2)?;
    let target = reader.read_u32()?;
    let position = [reader.read_f32()?, reader.read_f32()?];
    let delta = [reader.read_f32()?, reader.read_f32()?];
    let buttons = reader.read_u32()?;
    let modifiers = reader.read_u32()?;
    let pointer_id = reader.read_u32()?;
    let elapsed_micros = reader.read_u32()?;
    let related_target = reader.read_u32()?;
    let pointer_type = InputPointerType::decode(reader.read_u8()?)?;
    let is_primary = match reader.read_u8()? {
        0 => false,
        1 => true,
        value => {
            return Err(AbiError::UnknownIdentifier {
                category: "primary pointer flag",
                value: u32::from(value),
            });
        }
    };
    reader.read_zeroes(2)?;
    let pressure = reader.read_f32()?;
    let tilt = [reader.read_f32()?, reader.read_f32()?];
    let contact_size = [reader.read_f32()?, reader.read_f32()?];
    let cursor = StyleKeyword::from_u16(reader.read_u16()?).ok_or(AbiError::InvalidValue(
        "event transaction cursor is unknown",
    ))?;
    let key_code = reader.read_u16()?;
    let key_name = reader.read_u16()?;
    let repeat = match reader.read_u8()? {
        0 => false,
        1 => true,
        value => {
            return Err(AbiError::UnknownIdentifier {
                category: "key repeat flag",
                value: u32::from(value),
            });
        }
    };
    reader.read_zeroes(1)?;
    let key_text = reader.read_u32()?;
    let path_count =
        usize::try_from(reader.read_u32()?).map_err(|_| AbiError::ArithmeticOverflow)?;
    let path_bytes = path_count
        .checked_mul(4)
        .ok_or(AbiError::ArithmeticOverflow)?;
    if path_bytes > MAX_RESOURCE_BYTES || path_bytes > reader.remaining() {
        return Err(AbiError::ResourceTooLarge {
            actual: path_bytes,
            maximum: MAX_RESOURCE_BYTES.min(reader.remaining()),
        });
    }
    let mut path = Vec::with_capacity(path_count);
    for _ in 0..path_count {
        path.push(reader.read_u32()?);
    }
    let record = EventTransactionRecord {
        event_id,
        kind,
        target,
        position,
        delta,
        buttons,
        modifiers,
        pointer_id,
        elapsed_micros,
        related_target,
        pointer_type,
        is_primary,
        pressure,
        tilt,
        contact_size,
        cursor,
        key_code,
        key_name,
        key_text,
        repeat,
        path,
    };
    validate_record(&record)?;
    Ok(record)
}

fn validate_record(record: &EventTransactionRecord) -> Result<(), AbiError> {
    if record.path.is_empty()
        || record.target == NULL_NODE_ID
        || record.path.last() != Some(&record.target)
    {
        return Err(AbiError::InvalidValue(
            "event path must end at a non-null target",
        ));
    }
    if record.path.len().saturating_mul(4) > MAX_RESOURCE_BYTES {
        return Err(AbiError::ResourceTooLarge {
            actual: record.path.len().saturating_mul(4),
            maximum: MAX_RESOURCE_BYTES,
        });
    }
    let mut unique = HashSet::with_capacity(record.path.len());
    if record
        .path
        .iter()
        .any(|node| *node == NULL_NODE_ID || !unique.insert(*node))
    {
        return Err(AbiError::InvalidValue(
            "event path contains a null or repeated node",
        ));
    }
    if record.buttons & !0xffff != 0 || record.modifiers & !0x0f != 0 {
        return Err(AbiError::InvalidValue(
            "event button or modifier bits are reserved",
        ));
    }
    if record.elapsed_micros == 0 || record.elapsed_micros > 1_000_000 {
        return Err(AbiError::InvalidValue("event elapsed time is invalid"));
    }
    if !matches!(
        record.cursor,
        StyleKeyword::Auto
            | StyleKeyword::Crosshair
            | StyleKeyword::Default
            | StyleKeyword::Grab
            | StyleKeyword::Grabbing
            | StyleKeyword::NotAllowed
            | StyleKeyword::Pointer
            | StyleKeyword::Text
    ) {
        return Err(AbiError::InvalidValue(
            "event transaction cursor is not a supported cursor keyword",
        ));
    }
    let pointer_event = matches!(
        record.kind,
        InputEventKind::PointerDown
            | InputEventKind::PointerUp
            | InputEventKind::PointerMove
            | InputEventKind::PointerCancel
            | InputEventKind::PointerOver
            | InputEventKind::PointerOut
            | InputEventKind::PointerEnter
            | InputEventKind::PointerLeave
            | InputEventKind::GotPointerCapture
            | InputEventKind::LostPointerCapture
    );
    if pointer_event != (record.pointer_id != 0 && record.pointer_type != InputPointerType::None) {
        return Err(AbiError::InvalidValue(
            "event pointer identity and type are inconsistent",
        ));
    }
    if !record.pressure.is_finite() || !(0.0..=1.0).contains(&record.pressure) {
        return Err(AbiError::InvalidValue("event pressure is outside 0..=1"));
    }
    if record
        .tilt
        .iter()
        .any(|value| !value.is_finite() || !(-90.0..=90.0).contains(value))
    {
        return Err(AbiError::InvalidValue("event tilt is outside -90..=90"));
    }
    if record
        .contact_size
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0 || *value > 1_000_000.0)
    {
        return Err(AbiError::InvalidValue("event contact size is invalid"));
    }
    validate_key_payload(record)?;
    Ok(())
}

/// Rejects key payloads on non-key records and out-of-range identifiers.
///
/// Every non-key record zeroes these fields, the same way a focus record
/// already zeroes the pointer fields, so a non-zero value there means the
/// producer and this build disagree about the layout.
fn validate_key_payload(record: &EventTransactionRecord) -> Result<(), AbiError> {
    let key_event = matches!(record.kind, InputEventKind::KeyDown | InputEventKind::KeyUp);
    if !key_event
        && (record.key_code != 0 || record.key_name != 0 || record.key_text != 0 || record.repeat)
    {
        return Err(AbiError::InvalidValue(
            "non-key event carries a key payload",
        ));
    }
    if record.key_code > MAX_KEYBOARD_CODE_ID || record.key_name > MAX_KEYBOARD_KEY_NAME_ID {
        return Err(AbiError::InvalidValue("key identifier is out of range"));
    }
    if record.key_text != 0
        && (record.key_text > 0x0010_ffff || (0xd800..=0xdfff).contains(&record.key_text))
    {
        return Err(AbiError::InvalidValue("key text is not a Unicode scalar"));
    }
    if record.key_name != 0 && record.key_text != 0 {
        return Err(AbiError::InvalidValue(
            "key cannot be both named and printable",
        ));
    }
    Ok(())
}

fn validate_size(
    opcode: EventTransactionOpcode,
    offset: usize,
    end: usize,
) -> Result<(), AbiError> {
    let actual = end
        .checked_sub(offset)
        .ok_or(AbiError::ArithmeticOverflow)?;
    if actual < opcode.minimum_bytes() || actual % crate::PROTOCOL_ALIGNMENT != 0 {
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
    use super::*;

    #[test]
    fn event_path_round_trips_and_rejects_cycles() {
        let record = EventTransactionRecord {
            event_id: 9,
            kind: InputEventKind::PointerDown,
            target: 3,
            position: [12.0, 20.0],
            delta: [0.0, 0.0],
            buttons: 1,
            modifiers: 4,
            pointer_id: 1,
            elapsed_micros: 16_667,
            related_target: NULL_NODE_ID,
            pointer_type: InputPointerType::Mouse,
            is_primary: true,
            pressure: 0.5,
            tilt: [0.0, 0.0],
            contact_size: [1.0, 1.0],
            cursor: StyleKeyword::Pointer,
            key_code: 0,
            key_name: 0,
            key_text: 0,
            repeat: false,
            path: vec![1, 2, 3],
        };
        let batch = EventTransactionBatch {
            records: vec![record],
        };
        let bytes = batch.encode().expect("encode");
        assert_eq!(EventTransactionBatch::decode(&bytes), Ok(batch));
        let cyclic = EventTransactionBatch {
            records: vec![EventTransactionRecord {
                path: vec![1, 1],
                target: 1,
                ..EventTransactionRecord {
                    event_id: 1,
                    kind: InputEventKind::Click,
                    target: 1,
                    position: [0.0, 0.0],
                    delta: [0.0, 0.0],
                    buttons: 0,
                    modifiers: 0,
                    pointer_id: 0,
                    elapsed_micros: 1,
                    related_target: NULL_NODE_ID,
                    pointer_type: InputPointerType::None,
                    is_primary: false,
                    pressure: 0.0,
                    tilt: [0.0, 0.0],
                    contact_size: [0.0, 0.0],
                    cursor: StyleKeyword::Auto,
                    key_code: 0,
                    key_name: 0,
                    key_text: 0,
                    repeat: false,
                    path: vec![],
                }
            }],
        };
        assert!(cyclic.encode().is_err());
    }

    #[test]
    fn hostile_event_records_fail_closed_on_every_validated_field() {
        let valid = EventTransactionRecord {
            event_id: 9,
            kind: InputEventKind::PointerMove,
            target: 3,
            position: [12.0, 20.0],
            delta: [0.0, 0.0],
            buttons: 1,
            modifiers: 4,
            pointer_id: 1,
            elapsed_micros: 16_667,
            related_target: NULL_NODE_ID,
            pointer_type: InputPointerType::Mouse,
            is_primary: true,
            pressure: 0.5,
            tilt: [0.0, 0.0],
            contact_size: [1.0, 1.0],
            cursor: StyleKeyword::Pointer,
            key_code: 0,
            key_name: 0,
            key_text: 0,
            repeat: false,
            path: vec![1, 2, 3],
        };
        let reject = |mutate: fn(&mut EventTransactionRecord)| {
            let mut record = valid.clone();
            mutate(&mut record);
            assert!(
                EventTransactionBatch {
                    records: vec![record],
                }
                .encode()
                .is_err()
            );
        };
        reject(|record| record.path.clear());
        reject(|record| record.target = crate::NULL_NODE_ID);
        reject(|record| record.path = vec![1, 2]);
        reject(|record| record.path = vec![crate::NULL_NODE_ID, 3]);
        reject(|record| record.buttons = 0x1_0000);
        reject(|record| record.modifiers = 0x10);
        reject(|record| record.elapsed_micros = 0);
        reject(|record| record.elapsed_micros = 2_000_000);
        reject(|record| record.pointer_id = 0);
        reject(|record| record.pointer_type = InputPointerType::None);
        reject(|record| record.pressure = 1.1);
        reject(|record| record.pressure = f32::NAN);
        reject(|record| record.tilt[0] = 91.0);
        reject(|record| record.contact_size[1] = -1.0);
        reject(|record| record.cursor = StyleKeyword::Normal);

        let bytes = EventTransactionBatch {
            records: vec![valid],
        }
        .encode()
        .expect("encode");
        // Truncations and every byte-flip either decode or fail without panic.
        for cut in 0..bytes.len() {
            let _ = EventTransactionBatch::decode(&bytes[..cut]);
        }
        for index in 0..bytes.len() {
            let mut hostile = bytes.clone();
            hostile[index] ^= 0xff;
            let _ = EventTransactionBatch::decode(&hostile);
        }
        let mut wrong_count = bytes.clone();
        wrong_count[12..16].copy_from_slice(&999_u32.to_le_bytes());
        assert!(EventTransactionBatch::decode(&wrong_count).is_err());
    }
}
