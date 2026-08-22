use crate::codec::{
    Reader, Writer, checked_padding, finish_instruction, read_header, read_instruction_header,
    validate_encode_instruction_count,
};
use crate::{
    AbiError, MAX_MUTATION_BYTES, MAX_MUTATION_INSTRUCTIONS, MAX_RESOURCE_BYTES, MUTATION_MAGIC,
    MutationOpcode, NodeKind, Prop, PropValueType, ResourceKind, StreamKind, VirtualAxis,
};

/// Version 1 observation flags: bit 0 asks Core to report this node's geometry.
///
/// Zero withdraws the observation, so the mask doubles as the reserved-bit
/// check — an unknown bit must not be read as "withdraw".
pub const OBSERVE_GEOMETRY_FLAG_ACTIVE: u32 = 1;
const OBSERVE_GEOMETRY_FLAG_MASK: u32 = OBSERVE_GEOMETRY_FLAG_ACTIVE;

/// One validated Shell-to-Core mutation.
#[derive(Clone, Debug, PartialEq)]
pub enum Mutation {
    /// Creates a node and optionally inserts it before a sibling.
    CreateNode {
        /// Generation-bearing node identifier.
        node_id: u32,
        /// Generated host node kind.
        kind: NodeKind,
        /// Parent identifier or `NULL_NODE_ID` for the root.
        parent: u32,
        /// Sibling identifier or `NULL_NODE_ID` for append.
        before_sibling: u32,
    },
    /// Removes a node and its subtree.
    RemoveNode {
        /// Generation-bearing node identifier.
        node_id: u32,
    },
    /// Moves a node under a new parent.
    Reparent {
        /// Generation-bearing node identifier.
        node_id: u32,
        /// New parent identifier.
        new_parent: u32,
        /// Sibling identifier or `NULL_NODE_ID` for append.
        before_sibling: u32,
    },
    /// Sets a scalar property.
    SetF32 {
        /// Target node.
        node_id: u32,
        /// Generated scalar property.
        prop: Prop,
        /// Finite property value.
        value: f32,
    },
    /// Sets a four-component property.
    SetVec4 {
        /// Target node.
        node_id: u32,
        /// Generated vector property.
        prop: Prop,
        /// Four finite values.
        value: [f32; 4],
    },
    /// Sets an interned-resource property.
    SetRef {
        /// Target node.
        node_id: u32,
        /// Generated reference property.
        prop: Prop,
        /// Interned resource identifier.
        resource_id: u32,
    },
    /// Updates node flags atomically.
    SetFlags {
        /// Target node.
        node_id: u32,
        /// Bits to set.
        set: u32,
        /// Bits to clear.
        clear: u32,
    },
    /// Restores one generated property to its absent/default state.
    ClearProp {
        /// Target node.
        node_id: u32,
        /// Property to clear, regardless of its wire value lane.
        prop: Prop,
    },
    /// Associates text and style resources with a text node.
    SetTextRun {
        /// Target node.
        node_id: u32,
        /// UTF-8 string resource identifier.
        string_id: u32,
        /// Text style resource identifier.
        style_id: u32,
    },
    /// Defines an immutable interned resource.
    DefineResource {
        /// Resource identifier.
        resource_id: u32,
        /// Generated resource kind.
        kind: ResourceKind,
        /// Canonical resource bytes.
        bytes: Vec<u8>,
    },
    /// Releases an immutable resource after all references are removed in the transaction.
    ReleaseResource {
        /// Resource identifier.
        resource_id: u32,
    },
    /// Requests a Core-owned scroll position change.
    ScrollTo {
        /// Target scroll node.
        node_id: u32,
        /// Finite horizontal position.
        x: f32,
        /// Finite vertical position.
        y: f32,
        /// Generated behavior identifier reserved by the scrolling subsystem.
        behavior: u16,
    },
    /// Configures a Scroll node as a Core-owned virtual list.
    ConfigureVirtualList {
        /// Target Scroll node.
        node_id: u32,
        /// Total logical item count without materializing Scene nodes.
        item_count: u32,
        /// Initial logical size estimate for every item along `axis`.
        estimated_item_size: f32,
        /// Symmetric preheat extent in viewport multiples.
        base_overscan_viewports: f32,
        /// Velocity projection horizon in seconds.
        velocity_horizon_seconds: f32,
        /// Maximum directional preheat extent in viewport multiples.
        maximum_ahead_viewports: f32,
        /// Main axis used for item offsets, measurement, scrolling, and placeholders.
        axis: VirtualAxis,
    },
    /// Associates one materialized direct child with its logical list index.
    SetVirtualItem {
        /// Materialized item wrapper node.
        node_id: u32,
        /// Zero-based logical item index.
        item_index: u32,
    },
    /// Creates or updates the revisioned policy for an editable-text node.
    ConfigureEditable {
        /// Target editable-text node.
        node_id: u32,
        /// Authoritative Shell revision.
        revision: u64,
        /// Version 1 editable behavior flags.
        flags: u32,
        /// Maximum user-perceived characters accepted by Core.
        max_graphemes: u32,
    },
    /// Declares or withdraws Shell interest in one node's laid-out geometry.
    ///
    /// Observation is explicit because exporting every node's rect each frame
    /// would be an allocation proportional to the scene; the observed set is
    /// bounded by `MAX_OBSERVED_GEOMETRY_NODES`.
    ObserveGeometry {
        /// Node whose geometry the Shell wants reported.
        node_id: u32,
        /// Version 1 observation flags; zero withdraws the observation.
        flags: u32,
    },
}

/// A mutation plus transport flags retained for forward-compatible semantics.
#[derive(Clone, Debug, PartialEq)]
pub struct MutationInstruction {
    /// Instruction flags. Version 1 requires this value to be zero.
    pub flags: u8,
    /// Validated mutation.
    pub mutation: Mutation,
}

/// A complete transaction ending in one Commit instruction.
#[derive(Clone, Debug, PartialEq)]
pub struct MutationBatch {
    /// Monotonic Shell frame sequence.
    pub frame_seq: u32,
    /// Mutations to apply atomically.
    pub instructions: Vec<MutationInstruction>,
}

impl MutationBatch {
    /// Decodes and validates a complete transaction without mutating caller state.
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
        let stream = read_header(&mut reader, MUTATION_MAGIC, MAX_MUTATION_BYTES)?;
        let declared_count = stream.declared_count;
        let mut skipped = 0_u32;
        if declared_count > MAX_MUTATION_INSTRUCTIONS {
            return Err(AbiError::InstructionCountTooLarge {
                declared: declared_count,
                maximum: MAX_MUTATION_INSTRUCTIONS,
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
        let mut instructions = Vec::with_capacity(capacity.saturating_sub(1));
        let mut actual_count = 0_u32;
        let mut frame_seq = None;

        while reader.remaining() != 0 {
            let header = read_instruction_header(&mut reader)?;
            let (offset, raw_opcode, flags) = (header.offset, header.opcode, header.flags);
            actual_count = actual_count
                .checked_add(1)
                .ok_or(AbiError::ArithmeticOverflow)?;
            if frame_seq.is_some() {
                return Err(AbiError::CommitNotLast { offset });
            }
            // A stream from a newer build may carry instructions this decoder has
            // never heard of. Skipping one is only safe when the producer marked it
            // optional, so an unmarked unknown instruction is still fatal.
            let Some(opcode) = MutationOpcode::from_u8(raw_opcode) else {
                if header.optional() {
                    skipped = skipped.saturating_add(1);
                    reader.seek_to(header.end)?;
                    continue;
                }
                return Err(AbiError::UnknownOpcode {
                    stream: StreamKind::Mutation,
                    opcode: raw_opcode,
                    offset,
                });
            };

            if opcode == MutationOpcode::Commit {
                frame_seq = Some(reader.read_u32()?);
                validate_instruction_size(opcode, offset, reader.offset())?;
                finish_instruction(&reader, header)?;
                continue;
            }

            let mutation = decode_mutation(opcode, &mut reader)?;
            validate_instruction_size(opcode, offset, reader.offset())?;
            instructions.push(MutationInstruction { flags, mutation });
        }

        if actual_count != declared_count {
            return Err(AbiError::InstructionCountMismatch {
                declared: declared_count,
                actual: actual_count,
            });
        }
        Ok((
            Self {
                frame_seq: frame_seq.ok_or(AbiError::MissingCommit)?,
                instructions,
            },
            crate::DecodeReport {
                skipped_instructions: skipped,
                producer_abi_version: stream.producer_version,
            },
        ))
    }

    /// Encodes a canonical, little-endian transaction.
    pub fn encode(&self) -> Result<Vec<u8>, AbiError> {
        validate_encode_instruction_count(self.instructions.len(), 1, MAX_MUTATION_INSTRUCTIONS)?;
        let mut writer = Writer::new(MUTATION_MAGIC);
        for instruction in &self.instructions {
            encode_mutation(&mut writer, instruction)?;
        }
        let commit_offset = writer.offset();
        writer.instruction(MutationOpcode::Commit as u8, 0);
        writer.u32(self.frame_seq);
        validate_instruction_size(MutationOpcode::Commit, commit_offset, writer.offset())?;
        writer.finish(MAX_MUTATION_BYTES)
    }
}

fn decode_mutation(opcode: MutationOpcode, reader: &mut Reader<'_>) -> Result<Mutation, AbiError> {
    Ok(match opcode {
        MutationOpcode::CreateNode => {
            let node_id = reader.read_u32()?;
            let raw_kind = reader.read_u16()?;
            reader.read_zeroes(2)?;
            let kind = NodeKind::from_u16(raw_kind).ok_or(AbiError::UnknownIdentifier {
                category: "node kind",
                value: u32::from(raw_kind),
            })?;
            Mutation::CreateNode {
                node_id,
                kind,
                parent: reader.read_u32()?,
                before_sibling: reader.read_u32()?,
            }
        }
        MutationOpcode::RemoveNode => Mutation::RemoveNode {
            node_id: reader.read_u32()?,
        },
        MutationOpcode::Reparent => Mutation::Reparent {
            node_id: reader.read_u32()?,
            new_parent: reader.read_u32()?,
            before_sibling: reader.read_u32()?,
        },
        MutationOpcode::SetF32 => {
            let node_id = reader.read_u32()?;
            let prop = read_prop(reader, PropValueType::F32, "SetF32")?;
            Mutation::SetF32 {
                node_id,
                prop,
                value: reader.read_f32()?,
            }
        }
        MutationOpcode::SetVec4 => {
            let node_id = reader.read_u32()?;
            let prop = read_prop(reader, PropValueType::Vec4, "SetVec4")?;
            Mutation::SetVec4 {
                node_id,
                prop,
                value: [
                    reader.read_f32()?,
                    reader.read_f32()?,
                    reader.read_f32()?,
                    reader.read_f32()?,
                ],
            }
        }
        MutationOpcode::SetRef => {
            let node_id = reader.read_u32()?;
            let prop = read_prop(reader, PropValueType::Ref, "SetRef")?;
            Mutation::SetRef {
                node_id,
                prop,
                resource_id: reader.read_u32()?,
            }
        }
        MutationOpcode::SetFlags => {
            let node_id = reader.read_u32()?;
            let set = reader.read_u32()?;
            let clear = reader.read_u32()?;
            if set & clear != 0 {
                return Err(AbiError::InvalidValue(
                    "SetFlags set and clear masks overlap",
                ));
            }
            Mutation::SetFlags {
                node_id,
                set,
                clear,
            }
        }
        MutationOpcode::ClearProp => Mutation::ClearProp {
            node_id: reader.read_u32()?,
            prop: read_any_prop(reader)?,
        },
        MutationOpcode::SetTextRun => Mutation::SetTextRun {
            node_id: reader.read_u32()?,
            string_id: reader.read_u32()?,
            style_id: reader.read_u32()?,
        },
        MutationOpcode::DefineResource => {
            let resource_id = reader.read_u32()?;
            let raw_kind = reader.read_u16()?;
            reader.read_zeroes(2)?;
            let kind = ResourceKind::from_u16(raw_kind).ok_or(AbiError::UnknownIdentifier {
                category: "resource kind",
                value: u32::from(raw_kind),
            })?;
            let length =
                usize::try_from(reader.read_u32()?).map_err(|_| AbiError::ArithmeticOverflow)?;
            if length > MAX_RESOURCE_BYTES {
                return Err(AbiError::ResourceTooLarge {
                    actual: length,
                    maximum: MAX_RESOURCE_BYTES,
                });
            }
            let bytes = reader.read_bytes(length)?.to_vec();
            reader.read_zeroes(checked_padding(length)?)?;
            Mutation::DefineResource {
                resource_id,
                kind,
                bytes,
            }
        }
        MutationOpcode::ReleaseResource => Mutation::ReleaseResource {
            resource_id: reader.read_u32()?,
        },
        MutationOpcode::ScrollTo => {
            let result = Mutation::ScrollTo {
                node_id: reader.read_u32()?,
                x: reader.read_f32()?,
                y: reader.read_f32()?,
                behavior: reader.read_u16()?,
            };
            reader.read_zeroes(2)?;
            result
        }
        MutationOpcode::ConfigureVirtualList => {
            let result = Mutation::ConfigureVirtualList {
                node_id: reader.read_u32()?,
                item_count: reader.read_u32()?,
                estimated_item_size: reader.read_f32()?,
                base_overscan_viewports: reader.read_f32()?,
                velocity_horizon_seconds: reader.read_f32()?,
                maximum_ahead_viewports: reader.read_f32()?,
                axis: VirtualAxis::from_u8(reader.read_u8()?)
                    .ok_or(AbiError::InvalidValue("virtual axis"))?,
            };
            reader.read_zeroes(3)?;
            result
        }
        MutationOpcode::SetVirtualItem => Mutation::SetVirtualItem {
            node_id: reader.read_u32()?,
            item_index: reader.read_u32()?,
        },
        MutationOpcode::ConfigureEditable => Mutation::ConfigureEditable {
            node_id: reader.read_u32()?,
            revision: u64::from(reader.read_u32()?) | (u64::from(reader.read_u32()?) << 32),
            flags: reader.read_u32()?,
            max_graphemes: reader.read_u32()?,
        },
        MutationOpcode::ObserveGeometry => Mutation::ObserveGeometry {
            node_id: reader.read_u32()?,
            flags: {
                let flags = reader.read_u32()?;
                // Reserved bits are rejected rather than masked off: a newer
                // producer's flag must not be silently read as "withdraw".
                if flags & !OBSERVE_GEOMETRY_FLAG_MASK != 0 {
                    return Err(AbiError::InvalidValue(
                        "observe-geometry flags use reserved bits",
                    ));
                }
                flags
            },
        },
        MutationOpcode::Commit => return Err(AbiError::InvalidValue("nested commit")),
    })
}

fn read_any_prop(reader: &mut Reader<'_>) -> Result<Prop, AbiError> {
    let raw_prop = reader.read_u16()?;
    reader.read_zeroes(2)?;
    Prop::from_u16(raw_prop).ok_or(AbiError::UnknownIdentifier {
        category: "prop",
        value: u32::from(raw_prop),
    })
}

fn read_prop(
    reader: &mut Reader<'_>,
    expected: PropValueType,
    actual: &'static str,
) -> Result<Prop, AbiError> {
    let raw_prop = reader.read_u16()?;
    reader.read_zeroes(2)?;
    let prop = Prop::from_u16(raw_prop).ok_or(AbiError::UnknownIdentifier {
        category: "prop",
        value: u32::from(raw_prop),
    })?;
    if prop.value_type() != expected {
        return Err(AbiError::WrongPropertyEncoding {
            prop: raw_prop,
            expected: match prop.value_type() {
                PropValueType::F32 => "SetF32",
                PropValueType::Vec4 => "SetVec4",
                PropValueType::Ref => "SetRef",
            },
            actual,
        });
    }
    Ok(prop)
}

fn encode_mutation(writer: &mut Writer, instruction: &MutationInstruction) -> Result<(), AbiError> {
    let offset = writer.offset();
    let flags = instruction.flags;
    if flags != 0 {
        return Err(AbiError::UnsupportedFlags { offset: 0, flags });
    }
    match &instruction.mutation {
        Mutation::CreateNode {
            node_id,
            kind,
            parent,
            before_sibling,
        } => {
            writer.instruction(MutationOpcode::CreateNode as u8, flags);
            writer.u32(*node_id);
            writer.u16(*kind as u16);
            writer.u16(0);
            writer.u32(*parent);
            writer.u32(*before_sibling);
        }
        Mutation::RemoveNode { node_id } => {
            writer.instruction(MutationOpcode::RemoveNode as u8, flags);
            writer.u32(*node_id);
        }
        Mutation::Reparent {
            node_id,
            new_parent,
            before_sibling,
        } => {
            writer.instruction(MutationOpcode::Reparent as u8, flags);
            writer.u32(*node_id);
            writer.u32(*new_parent);
            writer.u32(*before_sibling);
        }
        Mutation::SetF32 {
            node_id,
            prop,
            value,
        } => {
            require_prop_type(*prop, PropValueType::F32, "SetF32")?;
            writer.instruction(MutationOpcode::SetF32 as u8, flags);
            writer.u32(*node_id);
            writer.u16(*prop as u16);
            writer.u16(0);
            writer.f32(*value)?;
        }
        Mutation::SetVec4 {
            node_id,
            prop,
            value,
        } => {
            require_prop_type(*prop, PropValueType::Vec4, "SetVec4")?;
            writer.instruction(MutationOpcode::SetVec4 as u8, flags);
            writer.u32(*node_id);
            writer.u16(*prop as u16);
            writer.u16(0);
            for component in value {
                writer.f32(*component)?;
            }
        }
        Mutation::SetRef {
            node_id,
            prop,
            resource_id,
        } => {
            require_prop_type(*prop, PropValueType::Ref, "SetRef")?;
            writer.instruction(MutationOpcode::SetRef as u8, flags);
            writer.u32(*node_id);
            writer.u16(*prop as u16);
            writer.u16(0);
            writer.u32(*resource_id);
        }
        Mutation::SetFlags {
            node_id,
            set,
            clear,
        } => {
            if set & clear != 0 {
                return Err(AbiError::InvalidValue(
                    "SetFlags set and clear masks overlap",
                ));
            }
            writer.instruction(MutationOpcode::SetFlags as u8, flags);
            writer.u32(*node_id);
            writer.u32(*set);
            writer.u32(*clear);
        }
        Mutation::ClearProp { node_id, prop } => {
            writer.instruction(MutationOpcode::ClearProp as u8, flags);
            writer.u32(*node_id);
            writer.u16(*prop as u16);
            writer.u16(0);
        }
        Mutation::SetTextRun {
            node_id,
            string_id,
            style_id,
        } => {
            writer.instruction(MutationOpcode::SetTextRun as u8, flags);
            writer.u32(*node_id);
            writer.u32(*string_id);
            writer.u32(*style_id);
        }
        Mutation::DefineResource {
            resource_id,
            kind,
            bytes,
        } => {
            if bytes.len() > MAX_RESOURCE_BYTES {
                return Err(AbiError::ResourceTooLarge {
                    actual: bytes.len(),
                    maximum: MAX_RESOURCE_BYTES,
                });
            }
            let length = u32::try_from(bytes.len()).map_err(|_| AbiError::ArithmeticOverflow)?;
            writer.instruction(MutationOpcode::DefineResource as u8, flags);
            writer.u32(*resource_id);
            writer.u16(*kind as u16);
            writer.u16(0);
            writer.u32(length);
            writer.bytes(bytes);
            writer.pad();
        }
        Mutation::ReleaseResource { resource_id } => {
            writer.instruction(MutationOpcode::ReleaseResource as u8, flags);
            writer.u32(*resource_id);
        }
        Mutation::ScrollTo {
            node_id,
            x,
            y,
            behavior,
        } => {
            writer.instruction(MutationOpcode::ScrollTo as u8, flags);
            writer.u32(*node_id);
            writer.f32(*x)?;
            writer.f32(*y)?;
            writer.u16(*behavior);
            writer.u16(0);
        }
        Mutation::ConfigureVirtualList {
            node_id,
            item_count,
            estimated_item_size,
            base_overscan_viewports,
            velocity_horizon_seconds,
            maximum_ahead_viewports,
            axis,
        } => {
            writer.instruction(MutationOpcode::ConfigureVirtualList as u8, flags);
            writer.u32(*node_id);
            writer.u32(*item_count);
            writer.f32(*estimated_item_size)?;
            writer.f32(*base_overscan_viewports)?;
            writer.f32(*velocity_horizon_seconds)?;
            writer.f32(*maximum_ahead_viewports)?;
            writer.u8(*axis as u8);
            writer.u8(0);
            writer.u16(0);
        }
        Mutation::SetVirtualItem {
            node_id,
            item_index,
        } => {
            writer.instruction(MutationOpcode::SetVirtualItem as u8, flags);
            writer.u32(*node_id);
            writer.u32(*item_index);
        }
        Mutation::ObserveGeometry {
            node_id,
            flags: observe_flags,
        } => {
            writer.instruction(MutationOpcode::ObserveGeometry as u8, flags);
            writer.u32(*node_id);
            writer.u32(*observe_flags);
        }
        Mutation::ConfigureEditable {
            node_id,
            revision,
            flags: editable_flags,
            max_graphemes,
        } => {
            writer.instruction(MutationOpcode::ConfigureEditable as u8, flags);
            let revision = revision.to_le_bytes();
            writer.u32(*node_id);
            writer.u32(u32::from_le_bytes(
                revision[..4].try_into().expect("four bytes"),
            ));
            writer.u32(u32::from_le_bytes(
                revision[4..].try_into().expect("four bytes"),
            ));
            writer.u32(*editable_flags);
            writer.u32(*max_graphemes);
        }
    }
    validate_instruction_size(
        mutation_opcode(&instruction.mutation),
        offset,
        writer.offset(),
    )?;
    Ok(())
}

fn mutation_opcode(mutation: &Mutation) -> MutationOpcode {
    match mutation {
        Mutation::CreateNode { .. } => MutationOpcode::CreateNode,
        Mutation::RemoveNode { .. } => MutationOpcode::RemoveNode,
        Mutation::Reparent { .. } => MutationOpcode::Reparent,
        Mutation::SetF32 { .. } => MutationOpcode::SetF32,
        Mutation::SetVec4 { .. } => MutationOpcode::SetVec4,
        Mutation::SetRef { .. } => MutationOpcode::SetRef,
        Mutation::SetFlags { .. } => MutationOpcode::SetFlags,
        Mutation::ClearProp { .. } => MutationOpcode::ClearProp,
        Mutation::SetTextRun { .. } => MutationOpcode::SetTextRun,
        Mutation::DefineResource { .. } => MutationOpcode::DefineResource,
        Mutation::ReleaseResource { .. } => MutationOpcode::ReleaseResource,
        Mutation::ScrollTo { .. } => MutationOpcode::ScrollTo,
        Mutation::ConfigureVirtualList { .. } => MutationOpcode::ConfigureVirtualList,
        Mutation::SetVirtualItem { .. } => MutationOpcode::SetVirtualItem,
        Mutation::ConfigureEditable { .. } => MutationOpcode::ConfigureEditable,
        Mutation::ObserveGeometry { .. } => MutationOpcode::ObserveGeometry,
    }
}

fn validate_instruction_size(
    opcode: MutationOpcode,
    offset: usize,
    end: usize,
) -> Result<(), AbiError> {
    let actual = end
        .checked_sub(offset)
        .ok_or(AbiError::ArithmeticOverflow)?;
    if let Some(expected) = opcode.fixed_bytes()
        && actual != expected
    {
        return Err(AbiError::InstructionLengthMismatch {
            opcode: opcode as u8,
            offset,
            expected,
            actual,
        });
    }
    if actual < opcode.minimum_bytes() {
        return Err(AbiError::InstructionLengthMismatch {
            opcode: opcode as u8,
            offset,
            expected: opcode.minimum_bytes(),
            actual,
        });
    }
    Ok(())
}

fn require_prop_type(
    prop: Prop,
    expected: PropValueType,
    actual: &'static str,
) -> Result<(), AbiError> {
    if prop.value_type() == expected {
        Ok(())
    } else {
        Err(AbiError::WrongPropertyEncoding {
            prop: prop as u16,
            expected: match prop.value_type() {
                PropValueType::F32 => "SetF32",
                PropValueType::Vec4 => "SetVec4",
                PropValueType::Ref => "SetRef",
            },
            actual,
        })
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;
    use crate::{
        ABI_VERSION, INSTRUCTION_FLAG_OPTIONAL, MINIMUM_READABLE_ABI_VERSION, NULL_NODE_ID,
    };

    fn sample_batch() -> MutationBatch {
        MutationBatch {
            frame_seq: 42,
            instructions: vec![
                MutationInstruction {
                    flags: 0,
                    mutation: Mutation::CreateNode {
                        node_id: 7,
                        kind: NodeKind::Text,
                        parent: NULL_NODE_ID,
                        before_sibling: NULL_NODE_ID,
                    },
                },
                MutationInstruction {
                    flags: 0,
                    mutation: Mutation::SetF32 {
                        node_id: 7,
                        prop: Prop::Width,
                        value: 320.5,
                    },
                },
                MutationInstruction {
                    flags: 0,
                    mutation: Mutation::DefineResource {
                        resource_id: 9,
                        kind: ResourceKind::Utf8String,
                        bytes: b"hello".to_vec(),
                    },
                },
                MutationInstruction {
                    flags: 0,
                    mutation: Mutation::SetTextRun {
                        node_id: 7,
                        string_id: 9,
                        style_id: 10,
                    },
                },
            ],
        }
    }

    #[test]
    fn canonical_round_trip() {
        let batch = sample_batch();
        let bytes = batch.encode().expect("sample encodes");
        assert_eq!(MutationBatch::decode(&bytes), Ok(batch));
    }

    #[test]
    fn every_mutation_opcode_round_trips_in_one_transaction() {
        let mutations = vec![
            Mutation::CreateNode {
                node_id: 1,
                kind: NodeKind::Scroll,
                parent: NULL_NODE_ID,
                before_sibling: NULL_NODE_ID,
            },
            Mutation::RemoveNode { node_id: 2 },
            Mutation::Reparent {
                node_id: 3,
                new_parent: 4,
                before_sibling: 5,
            },
            Mutation::SetF32 {
                node_id: 6,
                prop: Prop::Opacity,
                value: 0.5,
            },
            Mutation::SetVec4 {
                node_id: 7,
                prop: Prop::Padding,
                value: [1.0, 2.0, 3.0, 4.0],
            },
            Mutation::SetRef {
                node_id: 8,
                prop: Prop::Transform,
                resource_id: 9,
            },
            Mutation::SetFlags {
                node_id: 10,
                set: 0b0011,
                clear: 0b1100,
            },
            Mutation::ClearProp {
                node_id: 11,
                prop: Prop::SemanticLabel,
            },
            Mutation::SetTextRun {
                node_id: 12,
                string_id: 13,
                style_id: 14,
            },
            Mutation::DefineResource {
                resource_id: 15,
                kind: ResourceKind::GlyphSpan,
                bytes: vec![1, 2, 3],
            },
            Mutation::ReleaseResource { resource_id: 16 },
            Mutation::ScrollTo {
                node_id: 17,
                x: 18.0,
                y: 19.0,
                behavior: 20,
            },
            Mutation::ConfigureVirtualList {
                node_id: 17,
                item_count: 1_000_000,
                estimated_item_size: 24.0,
                base_overscan_viewports: 1.0,
                velocity_horizon_seconds: 0.25,
                maximum_ahead_viewports: 4.0,
                axis: VirtualAxis::Y,
            },
            Mutation::SetVirtualItem {
                node_id: 18,
                item_index: 999_999,
            },
            Mutation::ConfigureEditable {
                node_id: 19,
                revision: 0x0123_4567_89ab_cdef,
                flags: 0b101,
                max_graphemes: 1_000_000,
            },
            Mutation::ObserveGeometry {
                node_id: 20,
                flags: OBSERVE_GEOMETRY_FLAG_ACTIVE,
            },
            Mutation::ObserveGeometry {
                node_id: 20,
                flags: 0,
            },
        ];
        let batch = MutationBatch {
            frame_seq: 21,
            instructions: mutations
                .into_iter()
                .map(|mutation| MutationInstruction { flags: 0, mutation })
                .collect(),
        };
        assert_eq!(
            MutationBatch::decode(&batch.encode().expect("encode")),
            Ok(batch)
        );
    }

    #[test]
    fn observe_geometry_round_trips_and_rejects_reserved_flag_bits() {
        let observe = |flags| MutationBatch {
            frame_seq: 1,
            instructions: vec![MutationInstruction {
                flags: 0,
                mutation: Mutation::ObserveGeometry { node_id: 7, flags },
            }],
        };

        // Withdrawal is flags == 0, so both states must survive a round trip;
        // encoding only the active one would make "stop observing" unsendable.
        for flags in [OBSERVE_GEOMETRY_FLAG_ACTIVE, 0] {
            let batch = observe(flags);
            assert_eq!(
                MutationBatch::decode(&batch.encode().expect("encode")),
                Ok(batch)
            );
        }

        // Golden bytes: 16-byte stream header, 4-byte instruction header, then
        // node id and flags. Pinned so a layout change has to be deliberate.
        let bytes = observe(OBSERVE_GEOMETRY_FLAG_ACTIVE)
            .encode()
            .expect("encode");
        let instruction = &bytes[crate::STREAM_HEADER_BYTES..crate::STREAM_HEADER_BYTES + 12];
        assert_eq!(instruction[0], MutationOpcode::ObserveGeometry as u8);
        assert_eq!(u32::from_le_bytes(instruction[4..8].try_into().unwrap()), 7);
        assert_eq!(
            u32::from_le_bytes(instruction[8..12].try_into().unwrap()),
            1
        );

        // A newer producer's flag must fail loudly, not be masked down to zero —
        // that would read as "withdraw" and silently stop reporting geometry.
        let mut hostile = bytes.clone();
        let flags_at = crate::STREAM_HEADER_BYTES + 8;
        hostile[flags_at..flags_at + 4].copy_from_slice(&0b10_u32.to_le_bytes());
        assert!(MutationBatch::decode(&hostile).is_err());

        // Truncating the payload must not read past the end.
        for cut in 1..=8 {
            assert!(MutationBatch::decode(&bytes[..bytes.len() - cut]).is_err());
        }
    }

    #[test]
    fn rejects_overlapping_flag_masks_hostile_counts_and_truncations() {
        let valid_masks = MutationBatch {
            frame_seq: 1,
            instructions: vec![MutationInstruction {
                flags: 0,
                mutation: Mutation::SetFlags {
                    node_id: 1,
                    set: 0b01,
                    clear: 0b10,
                },
            }],
        };
        assert!(
            valid_masks
                .encode()
                .expect("encode masks")
                .len()
                .is_multiple_of(4)
        );
        // Overlapping masks are rejected by both the encoder and the decoder.
        let mut bytes = valid_masks.encode().expect("encode masks");
        bytes[28..32].copy_from_slice(&0b11_u32.to_le_bytes());
        assert!(MutationBatch::decode(&bytes).is_err());

        let batch = MutationBatch {
            frame_seq: 1,
            instructions: vec![MutationInstruction {
                flags: 0,
                mutation: Mutation::ConfigureEditable {
                    node_id: 19,
                    revision: 7,
                    flags: 1,
                    max_graphemes: 10,
                },
            }],
        };
        bytes = batch.encode().expect("encode editable");
        assert_eq!(MutationBatch::decode(&bytes), Ok(batch));
        let mut wrong_count = bytes.clone();
        wrong_count[12..16].copy_from_slice(&3_u32.to_le_bytes());
        assert!(MutationBatch::decode(&wrong_count).is_err());
        let mut huge_count = bytes.clone();
        huge_count[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(MutationBatch::decode(&huge_count).is_err());
        for cut in 0..bytes.len() {
            let _ = MutationBatch::decode(&bytes[..cut]);
        }
        for index in 0..bytes.len() {
            let mut hostile = bytes.clone();
            hostile[index] ^= 0xff;
            let _ = MutationBatch::decode(&hostile);
        }
    }

    #[test]
    fn accepts_newer_versions_but_rejects_pre_framing_ones_and_trailing_commands() {
        // Forward compatibility is the point of the self-describing framing: a
        // stream from a newer build decodes as long as every instruction it
        // carries is one this build knows, or is marked skippable.
        let mut newer = sample_batch().encode().expect("sample encodes");
        newer[4..6].copy_from_slice(&(ABI_VERSION + 1).to_le_bytes());
        assert!(MutationBatch::decode(&newer).is_ok());

        // Before that framing existed an instruction carried no length, so an
        // unknown one could not be stepped over. Such a stream is refused
        // rather than parsed into garbage.
        let mut older = sample_batch().encode().expect("sample encodes");
        older[4..6].copy_from_slice(&(MINIMUM_READABLE_ABI_VERSION - 1).to_le_bytes());
        assert!(matches!(
            MutationBatch::decode(&older),
            Err(AbiError::UnsupportedVersion { .. })
        ));

        let mut trailing = sample_batch().encode().expect("sample encodes");
        // Two words: the header plus the node id it removes.
        trailing.extend_from_slice(&[MutationOpcode::RemoveNode as u8, 0, 2, 0, 7, 0, 0, 0]);
        let length = u32::try_from(trailing.len()).expect("test length");
        trailing[8..12].copy_from_slice(&length.to_le_bytes());
        trailing[12..16].copy_from_slice(&6_u32.to_le_bytes());
        assert!(matches!(
            MutationBatch::decode(&trailing),
            Err(AbiError::CommitNotLast { .. })
        ));
    }

    #[test]
    fn rejects_wrong_prop_encoding_without_partial_result() {
        let mut bytes = sample_batch().encode().expect("sample encodes");
        let width_prop_offset = 16 + 20 + 8;
        bytes[width_prop_offset..width_prop_offset + 2]
            .copy_from_slice(&(Prop::Padding as u16).to_le_bytes());
        assert!(matches!(
            MutationBatch::decode(&bytes),
            Err(AbiError::WrongPropertyEncoding { .. })
        ));
    }

    #[test]
    fn rejects_hostile_counts_and_undefined_flags_before_allocating_commands() {
        let mut count = sample_batch().encode().expect("sample encodes");
        count[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(matches!(
            MutationBatch::decode(&count),
            Err(AbiError::InstructionCountTooLarge { .. })
        ));

        // Bit zero is the defined "skippable" flag; every other bit is still
        // undefined and must be refused rather than ignored.
        let mut flags = sample_batch().encode().expect("sample encodes");
        flags[17] = INSTRUCTION_FLAG_OPTIONAL << 1;
        assert!(matches!(
            MutationBatch::decode(&flags),
            Err(AbiError::UnsupportedFlags { .. })
        ));
    }

    #[test]
    fn an_unknown_instruction_is_skipped_only_when_the_producer_allowed_it() {
        // This is the whole point of the framing: a stream from a newer build
        // stays usable, but only for instructions its producer said were safe
        // to lose. Skipping an unmarked one could drop a CreateNode and leave
        // every later mutation addressing a node that does not exist.
        let build = |flags: u8| {
            let mut bytes = sample_batch().encode().expect("sample encodes");
            // The commit instruction is a header plus the frame sequence.
            let commit = bytes.len() - 8;
            assert_eq!(
                bytes[commit],
                MutationOpcode::Commit as u8,
                "commit is last"
            );
            // An opcode no build will ever define, two words wide.
            let unknown = [0xfe_u8, flags, 2, 0, 0, 0, 0, 0];
            bytes.splice(commit..commit, unknown);
            let length = u32::try_from(bytes.len()).expect("length");
            bytes[8..12].copy_from_slice(&length.to_le_bytes());
            let count = u32::from_le_bytes(bytes[12..16].try_into().expect("count")) + 1;
            bytes[12..16].copy_from_slice(&count.to_le_bytes());
            bytes
        };

        let (batch, report) =
            MutationBatch::decode_with_report(&build(INSTRUCTION_FLAG_OPTIONAL)).expect("skipped");
        assert_eq!(report.skipped_instructions, 1);
        assert_eq!(report.producer_abi_version, ABI_VERSION);
        assert_eq!(batch, sample_batch());

        assert!(matches!(
            MutationBatch::decode(&build(0)),
            Err(AbiError::UnknownOpcode { opcode: 0xfe, .. })
        ));
    }

    #[test]
    fn clear_and_release_round_trip() {
        let batch = MutationBatch {
            frame_seq: 7,
            instructions: vec![
                MutationInstruction {
                    flags: 0,
                    mutation: Mutation::ClearProp {
                        node_id: 5,
                        prop: Prop::BackgroundColor,
                    },
                },
                MutationInstruction {
                    flags: 0,
                    mutation: Mutation::ReleaseResource { resource_id: 9 },
                },
            ],
        };
        let encoded = batch.encode().expect("batch encodes");
        assert_eq!(MutationBatch::decode(&encoded), Ok(batch));
    }

    proptest! {
        #[test]
        fn arbitrary_bytes_never_panic(bytes in prop::collection::vec(any::<u8>(), 0..4096)) {
            let _ = MutationBatch::decode(&bytes);
        }

        #[test]
        fn resource_round_trips(bytes in prop::collection::vec(any::<u8>(), 0..2048), frame_seq in any::<u32>()) {
            let batch = MutationBatch {
                frame_seq,
                instructions: vec![MutationInstruction {
                    flags: 0,
                    mutation: Mutation::DefineResource {
                        resource_id: 1,
                        kind: ResourceKind::Utf8String,
                        bytes,
                    },
                }],
            };
            let encoded = batch.encode().expect("valid batch encodes");
            prop_assert_eq!(MutationBatch::decode(&encoded), Ok(batch));
        }
    }
}
