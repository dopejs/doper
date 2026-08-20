#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Bounded deterministic RGBA software oracle for M1 rendering intersections.

mod error;
mod renderer;

pub use error::HeadlessError;
pub use renderer::{HeadlessImage, HeadlessMetrics, HeadlessRenderer};
