use core::fmt;

use pingo_abi::{Prop, StyleProperty};
use pingo_scene::NodeId;

/// A deterministic layout validation or execution failure.
#[allow(missing_docs)]
#[derive(Clone, Debug, PartialEq)]
pub enum LayoutError {
    InvalidConstraints {
        min_width: f32,
        max_width: f32,
        min_height: f32,
        max_height: f32,
    },
    InvalidStyle {
        node: NodeId,
        prop: Prop,
        value: f32,
    },
    InvalidComputedStyle {
        node: NodeId,
        property: StyleProperty,
        value: f32,
    },
    ContradictoryStyle {
        node: NodeId,
        min_prop: Prop,
        min: f32,
        max_prop: Prop,
        max: f32,
    },
    InvalidIntrinsicSize {
        node: NodeId,
        size: crate::Size,
    },
    InvalidVirtualGeometry {
        node: NodeId,
        value: f32,
    },
    SceneInvariant(&'static str),
}

impl fmt::Display for LayoutError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "layout rejected: {self:?}")
    }
}

impl std::error::Error for LayoutError {}
