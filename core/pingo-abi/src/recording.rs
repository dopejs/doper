use crate::codec::{
    Reader, Writer, read_header, read_instruction_header, validate_encode_instruction_count,
};
use crate::{
    AbiError, InputBatch, MAX_RECORDING_BYTES, MAX_RECORDING_RECORDS, MutationBatch,
    RECORD_HEADER_BYTES, RECORDING_MAGIC, RecordingRecordKind, StreamKind, SystemTextMetricBatch,
};

/// One exact binary transaction in an ordered deterministic replay recording.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReplayRecord {
    /// A complete Shell-to-Core Mutation Stream.
    Mutation(Vec<u8>),
    /// A complete Host-to-Core Input Stream.
    Input(Vec<u8>),
    /// A complete Host-to-Core system-font metric cache delta.
    SystemTextMetrics(Vec<u8>),
    /// One exact logical frame delta used by Core-owned animation and scrolling.
    AnimationFrame {
        /// Elapsed logical time since the preceding recorded frame.
        elapsed_micros: u64,
    },
}

impl ReplayRecord {
    fn kind(&self) -> RecordingRecordKind {
        match self {
            Self::Mutation(_) => RecordingRecordKind::Mutation,
            Self::Input(_) => RecordingRecordKind::Input,
            Self::SystemTextMetrics(_) => RecordingRecordKind::SystemTextMetrics,
            Self::AnimationFrame { .. } => RecordingRecordKind::AnimationFrame,
        }
    }

    fn payload_length(&self) -> usize {
        match self {
            Self::Mutation(bytes) | Self::Input(bytes) | Self::SystemTextMetrics(bytes) => {
                bytes.len()
            }
            Self::AnimationFrame { .. } => 8,
        }
    }

    fn validate(&self) -> Result<(), AbiError> {
        match self {
            Self::Mutation(bytes) => MutationBatch::decode(bytes).map(|_| ()),
            Self::Input(bytes) => InputBatch::decode(bytes).map(|_| ()),
            Self::SystemTextMetrics(bytes) => SystemTextMetricBatch::decode(bytes).map(|_| ()),
            Self::AnimationFrame { .. } => Ok(()),
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
        let stream = read_header(&mut reader, RECORDING_MAGIC, MAX_RECORDING_BYTES)?;
        let declared_count = stream.declared_count;
        let mut skipped = 0_u32;
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
            let header = read_instruction_header(&mut reader)?;
            let (offset, raw_kind) = (header.offset, header.opcode);
            // A stream from a newer build may carry instructions this decoder has
            // never heard of. Skipping one is only safe when the producer marked it
            // optional, so an unmarked unknown instruction is still fatal.
            let Some(kind) = RecordingRecordKind::from_u8(raw_kind) else {
                if header.optional() {
                    skipped = skipped.saturating_add(1);
                    reader.seek_to(header.end)?;
                    continue;
                }
                return Err(AbiError::UnknownOpcode {
                    stream: StreamKind::Recording,
                    opcode: raw_kind,
                    offset,
                });
            };
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
                RecordingRecordKind::SystemTextMetrics => {
                    SystemTextMetricBatch::decode(&payload)?;
                    ReplayRecord::SystemTextMetrics(payload)
                }
                RecordingRecordKind::AnimationFrame => {
                    if payload.len() != 8 {
                        return Err(AbiError::InvalidValue(
                            "animation frame payload must be eight bytes",
                        ));
                    }
                    let mut encoded_micros = [0; 8];
                    encoded_micros.copy_from_slice(&payload);
                    ReplayRecord::AnimationFrame {
                        elapsed_micros: u64::from_le_bytes(encoded_micros),
                    }
                }
            };
            records.push(record);
        }
        // A skipped record was still in the stream, so it counts toward the
        // declared total; otherwise the count check rejects every downgrade.
        let actual = u32::try_from(records.len())
            .map_err(|_| AbiError::ArithmeticOverflow)?
            .checked_add(skipped)
            .ok_or(AbiError::ArithmeticOverflow)?;
        if actual != declared_count {
            return Err(AbiError::InstructionCountMismatch {
                declared: declared_count,
                actual,
            });
        }
        Ok((
            Self { records },
            crate::DecodeReport {
                skipped_instructions: skipped,
                producer_abi_version: stream.producer_version,
            },
        ))
    }

    /// Encodes a canonical recording after recursively validating all nested streams.
    pub fn encode(&self) -> Result<Vec<u8>, AbiError> {
        validate_encode_instruction_count(self.records.len(), 0, MAX_RECORDING_RECORDS)?;
        let mut writer = Writer::new(RECORDING_MAGIC);
        for record in &self.records {
            record.validate()?;
            let payload_length =
                u32::try_from(record.payload_length()).map_err(|_| AbiError::ArithmeticOverflow)?;
            writer.instruction(record.kind() as u8, 0);
            writer.u32(payload_length);
            match record {
                ReplayRecord::Mutation(bytes)
                | ReplayRecord::Input(bytes)
                | ReplayRecord::SystemTextMetrics(bytes) => writer.bytes(bytes),
                ReplayRecord::AnimationFrame { elapsed_micros } => {
                    writer.u32(*elapsed_micros as u32);
                    writer.u32((*elapsed_micros >> 32) as u32);
                }
            }
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
        SystemTextMetric, SystemTextMetricCommand, SystemTextMetricInstruction,
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

    fn system_metrics() -> Vec<u8> {
        SystemTextMetricBatch {
            instructions: vec![SystemTextMetricInstruction {
                flags: 0,
                command: SystemTextMetricCommand::Upsert(SystemTextMetric {
                    string_id: 7,
                    style_id: 9,
                    max_line_width: 42.0,
                    line_count: 1,
                    advances: Vec::new(),
                    positional_advances: Vec::new(),
                    contractions: Vec::new(),
                }),
            }],
        }
        .encode()
        .expect("system text metrics")
    }

    #[test]
    fn preserves_exact_nested_bytes_and_observed_order() {
        let recording = ReplayRecording {
            records: vec![
                ReplayRecord::Mutation(mutation(1)),
                ReplayRecord::SystemTextMetrics(system_metrics()),
                ReplayRecord::Input(input(2)),
                ReplayRecord::AnimationFrame {
                    elapsed_micros: 16_667,
                },
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

        let animation_frame = ReplayRecording {
            records: vec![ReplayRecord::AnimationFrame { elapsed_micros: 1 }],
        }
        .encode()
        .expect("animation frame");
        let mut wrong_payload_length = animation_frame.clone();
        wrong_payload_length[20..24].copy_from_slice(&4_u32.to_le_bytes());
        assert_eq!(
            ReplayRecording::decode(&wrong_payload_length),
            Err(AbiError::InvalidValue(
                "animation frame payload must be eight bytes"
            ))
        );
        let mut misaligned_payload = animation_frame;
        misaligned_payload[20..24].copy_from_slice(&5_u32.to_le_bytes());
        assert!(matches!(
            ReplayRecording::decode(&misaligned_payload),
            Err(AbiError::Misaligned { .. })
        ));

        let mut count_mismatch = ReplayRecording {
            records: vec![ReplayRecord::Mutation(mutation(1))],
        }
        .encode()
        .expect("recording");
        count_mismatch[12..16].copy_from_slice(&0_u32.to_le_bytes());
        assert_eq!(
            ReplayRecording::decode(&count_mismatch),
            Err(AbiError::InstructionCountMismatch {
                declared: 0,
                actual: 1,
            })
        );
    }

    proptest! {
        #[test]
        fn arbitrary_bytes_never_panic(bytes in prop::collection::vec(any::<u8>(), 0..4096)) {
            let _ = ReplayRecording::decode(&bytes);
        }
    }
    #[test]
    fn an_unknown_record_is_skipped_only_when_the_producer_allowed_it() {
        // A recording outlives the build that wrote it, so a file carrying a
        // record kind this build never had must stay replayable for the kinds
        // it does know -- but only where the producer said dropping one is safe.
        let build = |flags: u8| {
            let canonical = ReplayRecording {
                records: vec![ReplayRecord::Mutation(mutation(1))],
            }
            .encode()
            .expect("encode");
            let mut bytes = canonical;
            bytes.extend_from_slice(&[0xfe, flags, 2, 0, 0, 0, 0, 0]);
            let length = u32::try_from(bytes.len()).expect("length");
            bytes[8..12].copy_from_slice(&length.to_le_bytes());
            bytes[12..16].copy_from_slice(&2_u32.to_le_bytes());
            bytes
        };

        let (recording, report) =
            ReplayRecording::decode_with_report(&build(crate::INSTRUCTION_FLAG_OPTIONAL))
                .expect("skipped");
        assert_eq!(report.skipped_instructions, 1);
        assert_eq!(recording.records.len(), 1);

        assert!(matches!(
            ReplayRecording::decode(&build(0)),
            Err(AbiError::UnknownOpcode { opcode: 0xfe, .. })
        ));
    }
}
