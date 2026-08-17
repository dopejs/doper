use std::collections::HashSet;

use crate::codec::{
    Reader, Writer, read_header, read_instruction_header, validate_encode_instruction_count,
};
use crate::{
    AbiError, EVENT_TRANSACTIONS_MAGIC, EventTransactionOpcode, InputEventKind,
    MAX_EVENT_TRANSACTION_INSTRUCTIONS, MAX_EVENT_TRANSACTIONS_BYTES, MAX_RESOURCE_BYTES,
    NULL_NODE_ID, StreamKind,
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
    pub fn decode(bytes: &[u8]) -> Result<Self, AbiError> {
        let mut reader = Reader::new(bytes);
        let declared = read_header(
            &mut reader,
            EVENT_TRANSACTIONS_MAGIC,
            MAX_EVENT_TRANSACTIONS_BYTES,
        )?;
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
            let (offset, raw_opcode, _) = read_instruction_header(&mut reader)?;
            let opcode =
                EventTransactionOpcode::from_u8(raw_opcode).ok_or(AbiError::UnknownOpcode {
                    stream: StreamKind::EventTransactions,
                    opcode: raw_opcode,
                    offset,
                })?;
            let record = decode_record(&mut reader)?;
            validate_size(opcode, offset, reader.offset())?;
            records.push(record);
        }
        let actual = u32::try_from(records.len()).map_err(|_| AbiError::ArithmeticOverflow)?;
        if actual != declared {
            return Err(AbiError::InstructionCountMismatch { declared, actual });
        }
        Ok(Self { records })
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
