#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Scene-to-DisplayList paint orchestration and immutable pictures.

mod engine;
mod error;
mod resource;

pub use engine::{
    PaintEngine, PaintMetrics, PaintOutcome, Picture, ShapedGlyphRun, TextPaintResolver,
};
pub use error::PaintError;
pub use resource::{AffineResource, SolidPaint, TextStyleResource};
