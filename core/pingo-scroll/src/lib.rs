#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Deterministic, Core-owned scrolling, variable-height indexing, and virtual-range planning.

mod error;
mod height_index;
mod physics;
mod virtualizer;

pub use error::ScrollError;
pub use height_index::{HeightIndex, HeightIndexMetrics};
pub use physics::{
    ScrollFrame, ScrollPhysics, ScrollPhysicsConfig, ScrollPhysicsMetrics, ScrollPlatform,
};
pub use virtualizer::{VirtualFrame, Virtualizer, VirtualizerConfig, VirtualizerMetrics};
