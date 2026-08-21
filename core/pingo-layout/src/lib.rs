#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Deterministic constraint layout with topology-aligned double buffers.

mod engine;
mod error;
mod geometry;
/// The differential oracle is a test tool, not a product path: compiling it into
/// the shipped WASM would spend the size budget on code no application calls.
#[cfg(test)]
mod reference;

pub use engine::{
    EstimatedVirtualLayout, IntrinsicMeasurer, LayoutEngine, LayoutMetrics, LayoutOutcome,
    LayoutSnapshot, VirtualLayoutProvider, ZeroIntrinsicMeasurer,
};
pub use error::LayoutError;
pub use geometry::{BoxConstraints, Point, Size};
