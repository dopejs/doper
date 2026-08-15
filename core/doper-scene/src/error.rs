use core::fmt;

use doper_abi::{NodeKind, Prop, PropValueType, ResourceKind};

use crate::NodeId;

/// A transaction validation failure. The Scene remains unchanged on error.
#[allow(missing_docs)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SceneError {
    NullNodeId,
    NodeIndexOutOfRange {
        index: u32,
    },
    InvalidGeneration {
        generation: u16,
    },
    SlotGap {
        index: u32,
        next_index: u32,
    },
    StaleNode {
        node: NodeId,
    },
    DuplicateNode {
        node: NodeId,
    },
    RetiredSlot {
        index: u32,
    },
    UnexpectedGeneration {
        index: u32,
        expected: u16,
        actual: u16,
    },
    MissingParent {
        node: NodeId,
        parent: NodeId,
    },
    InvalidRoot {
        node: NodeId,
    },
    MultipleRoots,
    MissingRoot,
    InvalidBeforeSibling {
        sibling: NodeId,
    },
    ReparentRoot {
        node: NodeId,
    },
    Cycle {
        node: NodeId,
        parent: NodeId,
    },
    DepthOverflow {
        node: NodeId,
    },
    FrameSequenceNotNewer {
        previous: u32,
        incoming: u32,
    },
    DuplicateResource {
        resource_id: u32,
    },
    MissingResource {
        resource_id: u32,
    },
    ResourceInUse {
        resource_id: u32,
    },
    DuplicateResourceRelease {
        resource_id: u32,
    },
    WrongResourceKind {
        resource_id: u32,
        expected: ResourceKind,
        actual: ResourceKind,
    },
    InvalidUtf8Resource {
        resource_id: u32,
    },
    InvalidResourceEncoding {
        resource_id: u32,
    },
    ResourceTooLarge {
        resource_id: u32,
        actual: usize,
        maximum: usize,
    },
    NonFiniteValue {
        node: NodeId,
        field: &'static str,
    },
    WrongPropValueType {
        prop: Prop,
        expected: PropValueType,
        actual: PropValueType,
    },
    InvalidParentKind {
        node: NodeId,
        parent: NodeId,
        actual: NodeKind,
    },
    UnsupportedNodeOperation {
        node: NodeId,
        kind: NodeKind,
        operation: &'static str,
    },
    InvalidVirtualListConfig {
        node: NodeId,
        field: &'static str,
    },
    MissingVirtualListParent {
        node: NodeId,
    },
    InvalidVirtualItemIndex {
        node: NodeId,
        index: u32,
        item_count: u32,
    },
    DuplicateVirtualItemIndex {
        list: NodeId,
        index: u32,
    },
    InternalInvariant(&'static str),
}

impl fmt::Display for SceneError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Scene transaction rejected: {self:?}")
    }
}

impl std::error::Error for SceneError {}

#[cfg(test)]
mod tests {
    use std::error::Error;

    use super::*;

    #[test]
    fn display_is_operator_facing_and_error_has_no_hidden_source() {
        let error = SceneError::MultipleRoots;
        assert_eq!(
            error.to_string(),
            "Scene transaction rejected: MultipleRoots"
        );
        assert!(error.source().is_none());
    }
}
