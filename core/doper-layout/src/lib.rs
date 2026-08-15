#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Deterministic constraint layout with topology-aligned double buffers.

mod engine;
mod error;
mod geometry;

pub use engine::{
    IntrinsicMeasurer, LayoutEngine, LayoutMetrics, LayoutOutcome, LayoutSnapshot,
    ZeroIntrinsicMeasurer,
};
pub use error::LayoutError;
pub use geometry::{BoxConstraints, Point, Size};
