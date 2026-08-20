#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Deterministic, topology-ordered Scene storage for pingo Core.

mod bit_set;
mod error;
mod node_id;
mod scene;

pub use bit_set::{BitSet, SetBits};
pub use error::SceneError;
pub use node_id::{MAX_GENERATION, MAX_NODE_SLOTS, NodeId};
pub use scene::{DirtyDomain, Resource, Scene, SceneMetrics, TextRun, VirtualListConfig};
