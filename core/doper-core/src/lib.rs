#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Deterministic top-level orchestration for the doper rendering Core.

mod editing;
mod engine;
mod error;
mod scroll;
mod text;

pub use doper_scroll::ScrollPlatform;
pub use engine::{CoreEngine, CoreMetrics, FrameDiagnostics, FrameOutput};
pub use error::CoreError;
pub use scroll::{CoreScrollMetrics, VirtualRefillRequest};
pub use text::CoreTextMetrics;

#[cfg(target_arch = "wasm32")]
mod wasm;
