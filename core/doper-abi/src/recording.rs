use crate::codec::{
    Reader, Writer, read_header, read_instruction_header, validate_encode_instruction_count,
};
use crate::{
    AbiError, InputBatch, MAX_RECORDING_BYTES, MAX_RECORDING_RECORDS, MutationBatch,
    RECORD_HEADER_BYTES, RECORDING_MAGIC, RecordingRecordKind, StreamKind,
};

/// One exact binary transaction in an ordered deterministic replay recording.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReplayRecord {
    /// A complete Shell-to-Core Mutation Stream.
    Mutation(Vec<u8>),
    /// A complete Host-to-Core Input Stream.
    Input(Vec<u8>),
}

impl ReplayRecord {
    fn kind(&self) -> RecordingRecordKind {
        match self {
            Self::Mutation(_) => RecordingRecordKind::Mutation,
            Self::Input(_) => RecordingRecordKind::Input,
        }
    }

    fn bytes(&self) -> &[u8] {
        match self {
            Self::Mutation(bytes) | Self::Input(bytes) => bytes,
        }
    }

    fn validate(&self) -> Result<(), AbiError> {
        match self {
            Self::Mutation(bytes) => MutationBatch::decode(bytes).map(|_| ()),
            Self::Input(bytes) => InputBatch::decode(bytes).map(|_| ()),
        }
    }
}

/// Versioned archive preserving the exact order and bytes of mutation and input transactions.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ReplayRecording {
    /// Validated records in observed order.
    pub records: Vec<ReplayRecord>,
}

impl ReplayRecording {
    /// Decodes and recursively validates an untrusted recording before returning any record.
    pub fn decode(bytes: &[u8]) -> Result<Self, AbiError> {
        let mut reader = Reader::new(bytes);
        let declared_count = read_header(&mut reader, RECORDING_MAGIC, MAX_RECORDING_BYTES)?;
        if declared_count > MAX_RECORDING_RECORDS {
            return Err(AbiError::InstructionCountTooLarge {
                declared: declared_count,
                maximum: MAX_RECORDING_RECORDS,
            });
        }
        let maximum_count = u32::try_from(reader.remaining() / RECORD_HEADER_BYTES)
            .map_err(|_| AbiError::ArithmeticOverflow)?;
        if declared_count > maximum_count {
            return Err(AbiError::InstructionCountTooLarge {
                declared: declared_count,
                maximum: maximum_count,
            });
        }

        let capacity = usize::try_from(declared_count).map_err(|_| AbiError::ArithmeticOverflow)?;
        let mut records = Vec::with_capacity(capacity);
        while reader.remaining() != 0 {
            let (offset, raw_kind, _) = read_instruction_header(&mut reader)?;
            let kind = RecordingRecordKind::from_u8(raw_kind).ok_or(AbiError::UnknownOpcode {
                stream: StreamKind::Recording,
                opcode: raw_kind,
                offset,
            })?;
            let length =
                usize::try_from(reader.read_u32()?).map_err(|_| AbiError::ArithmeticOverflow)?;
            if !length.is_multiple_of(crate::PROTOCOL_ALIGNMENT) {
                return Err(AbiError::Misaligned {
                    offset: reader.offset().saturating_add(length),
                });
            }
            let payload = reader.read_bytes(length)?.to_vec();
            let record = match kind {
                RecordingRecordKind::Mutation => {
                    MutationBatch::decode(&payload)?;
                    ReplayRecord::Mutation(payload)
                }
                RecordingRecordKind::Input => {
                    InputBatch::decode(&payload)?;
                    ReplayRecord::Input(payload)
                }
            };
            records.push(record);
        }
        let actual = u32::try_from(records.len()).map_err(|_| AbiError::ArithmeticOverflow)?;
        if actual != declared_count {
            return Err(AbiError::InstructionCountMismatch {
                declared: declared_count,
                actual,
            });
        }
        Ok(Self { records })
    }

    /// Encodes a canonical recording after recursively validating all nested streams.
    pub fn encode(&self) -> Result<Vec<u8>, AbiError> {
        validate_encode_instruction_count(self.records.len(), 0, MAX_RECORDING_RECORDS)?;
        let mut writer = Writer::new(RECORDING_MAGIC);
        for record in &self.records {
            record.validate()?;
            let payload = record.bytes();
            let payload_length =
                u32::try_from(payload.len()).map_err(|_| AbiError::ArithmeticOverflow)?;
            writer.instruction(record.kind() as u8, 0);
            writer.u32(payload_length);
            writer.bytes(payload);
        }
        writer.finish(MAX_RECORDING_BYTES)
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;
    use crate::{
        InputCommand, InputInstruction, Mutation, MutationInstruction, NULL_NODE_ID, NodeKind,
    };

    fn mutation(frame_seq: u32) -> Vec<u8> {
        MutationBatch {
            frame_seq,
            instructions: vec![MutationInstruction {
                flags: 0,
                mutation: Mutation::CreateNode {
                    node_id: 1 << 20,
                    kind: NodeKind::Root,
                    parent: NULL_NODE_ID,
                    before_sibling: NULL_NODE_ID,
                },
            }],
        }
        .encode()
        .expect("mutation")
    }

    fn input(frame_seq: u32) -> Vec<u8> {
        InputBatch {
            frame_seq,
            instructions: vec![InputInstruction {
                flags: 0,
                command: InputCommand::Insert {
                    node_id: 1 << 20,
                    base_revision: 7,
                    text: "你".to_owned(),
                },
            }],
        }
        .encode()
        .expect("input")
    }

    #[test]
    fn preserves_exact_nested_bytes_and_observed_order() {
        let recording = ReplayRecording {
            records: vec![
                ReplayRecord::Mutation(mutation(1)),
                ReplayRecord::Input(input(2)),
                ReplayRecord::Mutation(mutation(3)),
            ],
        };
        let bytes = recording.encode().expect("recording");
        assert_eq!(ReplayRecording::decode(&bytes), Ok(recording));
    }

    #[test]
    fn rejects_invalid_envelopes_and_nested_streams() {
        let mut bytes = ReplayRecording {
            records: vec![ReplayRecord::Mutation(mutation(1))],
        }
        .encode()
        .expect("recording");

        let mut unknown = bytes.clone();
        unknown[16] = 0xff;
        assert!(matches!(
            ReplayRecording::decode(&unknown),
            Err(AbiError::UnknownOpcode {
                stream: StreamKind::Recording,
                opcode: 0xff,
                offset: 16,
            })
        ));

        let mut hostile_count = bytes.clone();
        hostile_count[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(matches!(
            ReplayRecording::decode(&hostile_count),
            Err(AbiError::InstructionCountTooLarge { .. })
        ));

        bytes[24] = 0;
        assert!(ReplayRecording::decode(&bytes).is_err());
        assert!(
            ReplayRecording {
                records: vec![ReplayRecord::Input(vec![1, 2, 3, 4])],
            }
            .encode()
            .is_err()
        );
    }

    proptest! {
        #[test]
        fn arbitrary_bytes_never_panic(bytes in prop::collection::vec(any::<u8>(), 0..4096)) {
            let _ = ReplayRecording::decode(&bytes);
        }
    }
}
