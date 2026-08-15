use core::fmt;

use doper_abi::{AbiError, Prop, ResourceKind};
use doper_scene::NodeId;

/// A paint build failure. The prior immutable Picture remains active.
#[allow(missing_docs)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PaintError {
    LayoutTopologyMismatch,
    MissingGeometry {
        node: NodeId,
    },
    MissingResource {
        resource_id: u32,
    },
    WrongResourceKind {
        resource_id: u32,
        expected: ResourceKind,
        actual: ResourceKind,
    },
    InvalidResource {
        resource_id: u32,
        reason: &'static str,
    },
    InvalidOpacity {
        node: NodeId,
    },
    WrongPropertyResource {
        node: NodeId,
        prop: Prop,
    },
    Abi(AbiError),
}

impl fmt::Display for PaintError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "paint build rejected: {self:?}")
    }
}

impl std::error::Error for PaintError {}

impl From<AbiError> for PaintError {
    fn from(error: AbiError) -> Self {
        Self::Abi(error)
    }
}
