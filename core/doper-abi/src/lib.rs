#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Versioned, transactional codecs for doper's cross-thread binary protocols.
//!
//! Decoders in this crate are trust boundaries. They validate a complete stream
//! before returning any command to a caller, so malformed input cannot partially
//! mutate the Scene or reach a rendering backend.

mod codec;
mod display_list;
mod error;
mod input;
mod mutation;
mod recording;

use core::fmt;

pub use display_list::{DisplayCommand, DisplayInstruction, DisplayList};
pub use error::{AbiError, StreamKind};
pub use input::{
    InputAffinity, InputBatch, InputCommand, InputInstruction, InputPosition, InputSelection,
};
pub use mutation::{Mutation, MutationBatch, MutationInstruction};
pub use recording::{ReplayRecord, ReplayRecording};

/// Semantic invalidation domains associated with a property.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct Invalidation(u8);

impl Invalidation {
    /// No derived state changes.
    pub const NONE: Self = Self(0);
    /// Layout must be recomputed.
    pub const LAYOUT: Self = Self(1 << 0);
    /// The affected subtree must be repainted.
    pub const PAINT: Self = Self(1 << 1);
    /// Only the node's compositing state must be repainted.
    pub const PAINT_SELF: Self = Self(1 << 2);
    /// Hit-test geometry must be refreshed.
    pub const HIT: Self = Self(1 << 3);
    /// Accessibility semantics must be refreshed.
    pub const SEMANTICS: Self = Self(1 << 4);

    /// Constructs a generated invalidation mask.
    #[must_use]
    pub const fn from_bits(bits: u8) -> Self {
        Self(bits)
    }

    /// Returns the raw bit mask.
    #[must_use]
    pub const fn bits(self) -> u8 {
        self.0
    }

    /// Returns whether this mask contains every bit in `other`.
    #[must_use]
    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }
}

impl fmt::Debug for Invalidation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("Invalidation")
            .field(&self.0)
            .finish()
    }
}

/// Wire representation required by a generated property.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PropValueType {
    /// A single IEEE-754 number.
    F32,
    /// Four IEEE-754 numbers.
    Vec4,
    /// An interned resource identifier.
    Ref,
}

#[allow(missing_docs)]
mod generated {
    use super::{Invalidation, PropValueType};

    include!("generated.rs");
}

pub use generated::*;

/// Result of negotiating a peer ABI version.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NegotiatedVersion {
    /// Both endpoints support this version.
    Compatible(u16),
    /// The peer must use a fallback implementation.
    Incompatible {
        /// Version supported by this build.
        local: u16,
        /// Version requested by the peer.
        peer: u16,
    },
}

/// Negotiates the exact binary ABI version.
#[must_use]
pub const fn negotiate_version(peer: u16) -> NegotiatedVersion {
    if peer == ABI_VERSION {
        NegotiatedVersion::Compatible(ABI_VERSION)
    } else {
        NegotiatedVersion::Incompatible {
            local: ABI_VERSION,
            peer,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_negotiation_and_invalidation_masks_are_explicit() {
        assert_eq!(
            negotiate_version(ABI_VERSION),
            NegotiatedVersion::Compatible(ABI_VERSION)
        );
        assert_eq!(
            negotiate_version(ABI_VERSION + 1),
            NegotiatedVersion::Incompatible {
                local: ABI_VERSION,
                peer: ABI_VERSION + 1,
            }
        );
        let mask =
            Invalidation::from_bits(Invalidation::LAYOUT.bits() | Invalidation::PAINT.bits());
        assert!(mask.contains(Invalidation::LAYOUT));
        assert!(mask.contains(Invalidation::PAINT));
        assert!(!mask.contains(Invalidation::HIT));
        assert_eq!(format!("{mask:?}"), "Invalidation(3)");
    }

    #[test]
    fn every_generated_identifier_exposes_complete_metadata() {
        for kind in [RecordingRecordKind::Mutation, RecordingRecordKind::Input] {
            assert_eq!(RecordingRecordKind::from_u8(kind as u8), Some(kind));
        }
        assert_eq!(RecordingRecordKind::from_u8(0), None);

        let mutations = [
            MutationOpcode::CreateNode,
            MutationOpcode::RemoveNode,
            MutationOpcode::Reparent,
            MutationOpcode::SetF32,
            MutationOpcode::SetVec4,
            MutationOpcode::SetRef,
            MutationOpcode::SetFlags,
            MutationOpcode::ClearProp,
            MutationOpcode::SetTextRun,
            MutationOpcode::DefineResource,
            MutationOpcode::ReleaseResource,
            MutationOpcode::ScrollTo,
            MutationOpcode::Commit,
        ];
        for opcode in mutations {
            assert_eq!(MutationOpcode::from_u8(opcode as u8), Some(opcode));
            assert!(opcode.minimum_bytes() >= INSTRUCTION_HEADER_BYTES);
            assert!(
                opcode
                    .fixed_bytes()
                    .is_none_or(|fixed| fixed == opcode.minimum_bytes())
            );
        }
        assert_eq!(MutationOpcode::from_u8(0), None);

        let inputs = [
            InputOpcode::Replace,
            InputOpcode::Insert,
            InputOpcode::DeleteBackward,
            InputOpcode::DeleteForward,
            InputOpcode::SetSelection,
            InputOpcode::BeginComposition,
            InputOpcode::UpdateComposition,
            InputOpcode::CommitComposition,
            InputOpcode::CancelComposition,
            InputOpcode::Undo,
            InputOpcode::Redo,
            InputOpcode::ScrollBegin,
            InputOpcode::ScrollDelta,
            InputOpcode::ScrollEnd,
            InputOpcode::ScrollCancel,
            InputOpcode::Commit,
        ];
        for opcode in inputs {
            assert_eq!(InputOpcode::from_u8(opcode as u8), Some(opcode));
            assert!(opcode.minimum_bytes() >= INSTRUCTION_HEADER_BYTES);
            assert!(
                opcode
                    .fixed_bytes()
                    .is_none_or(|fixed| fixed == opcode.minimum_bytes())
            );
        }
        assert_eq!(InputOpcode::from_u8(0), None);

        let displays = [
            DisplayOpcode::Save,
            DisplayOpcode::Restore,
            DisplayOpcode::Transform,
            DisplayOpcode::ClipRect,
            DisplayOpcode::Alpha,
            DisplayOpcode::FillRect,
            DisplayOpcode::FillRRect,
            DisplayOpcode::FillPath,
            DisplayOpcode::DrawGlyphRun,
            DisplayOpcode::DrawTextFallback,
            DisplayOpcode::DrawImage,
            DisplayOpcode::DrawPicture,
        ];
        for opcode in displays {
            assert_eq!(DisplayOpcode::from_u8(opcode as u8), Some(opcode));
            assert_eq!(opcode.fixed_bytes(), Some(opcode.minimum_bytes()));
        }
        assert_eq!(DisplayOpcode::from_u8(0), None);

        for kind in [
            NodeKind::Root,
            NodeKind::Container,
            NodeKind::Text,
            NodeKind::Image,
            NodeKind::EditableText,
            NodeKind::Scroll,
        ] {
            assert_eq!(NodeKind::from_u16(kind as u16), Some(kind));
        }
        assert_eq!(NodeKind::from_u16(0), None);
        for kind in [
            ResourceKind::Utf8String,
            ResourceKind::Image,
            ResourceKind::Path,
            ResourceKind::Font,
            ResourceKind::GlyphSpan,
            ResourceKind::Paint,
            ResourceKind::TextStyle,
            ResourceKind::Affine,
        ] {
            assert_eq!(ResourceKind::from_u16(kind as u16), Some(kind));
        }
        assert_eq!(ResourceKind::from_u16(0), None);

        let props = [
            Prop::Width,
            Prop::Height,
            Prop::MinWidth,
            Prop::MinHeight,
            Prop::MaxWidth,
            Prop::MaxHeight,
            Prop::Padding,
            Prop::Color,
            Prop::BackgroundColor,
            Prop::Opacity,
            Prop::Transform,
            Prop::Text,
            Prop::FontSize,
            Prop::OnTap,
            Prop::SemanticRole,
            Prop::SemanticLabel,
            Prop::SemanticValue,
        ];
        for prop in props {
            assert_eq!(Prop::from_u16(prop as u16), Some(prop));
            let _ = (prop.invalidation(), prop.value_type(), prop.resource_kind());
        }
        assert_eq!(Prop::from_u16(0), None);
    }
}
