#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Deterministic, Core-owned scrolling, variable-extent indexing, and virtual-range planning.

mod error;
mod extent_index;
mod physics;
mod virtualizer;

pub use error::ScrollError;
pub use extent_index::{ExtentIndex, ExtentIndexMetrics};
pub use physics::{
    ScrollFrame, ScrollPhysics, ScrollPhysicsConfig, ScrollPhysicsMetrics, ScrollPlatform,
};
pub use virtualizer::{VirtualFrame, Virtualizer, VirtualizerConfig, VirtualizerMetrics};
