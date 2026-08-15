#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Deterministic top-level orchestration for the doper rendering Core.

mod engine;
mod error;
mod scroll;

pub use engine::{CoreEngine, CoreMetrics, FrameDiagnostics, FrameOutput};
pub use error::CoreError;
pub use scroll::{CoreScrollMetrics, VirtualRefillRequest};

#[cfg(target_arch = "wasm32")]
mod wasm;
