use core::fmt;

use doper_abi::AbiError;
use doper_layout::LayoutError;
use doper_paint::PaintError;
use doper_scene::NodeId;
use doper_scene::SceneError;
use doper_scroll::ScrollError;

/// Failure returned by the top-level deterministic Core pipeline.
#[derive(Clone, Debug, PartialEq)]
pub enum CoreError {
    /// The Core instance cannot continue after a derived-state invariant failed.
    Poisoned,
    /// Viewport dimensions were invalid.
    InvalidViewport {
        /// Requested logical width.
        width: f32,
        /// Requested logical height.
        height: f32,
    },
    /// Device pixel ratio was zero, negative, NaN, or infinite.
    InvalidDevicePixelRatio(f32),
    /// Mutation bytes failed trust-boundary validation.
    Abi(AbiError),
    /// A decoded transaction violated Scene invariants and was not committed.
    Scene(SceneError),
    /// Layout failed after Scene accepted the transaction; the instance is poisoned.
    Layout(LayoutError),
    /// Paint failed after Scene accepted the transaction; the instance is poisoned.
    Paint(PaintError),
    /// Core produced an invalid glyph-resource batch; the instance is poisoned.
    GlyphResources(AbiError),
    /// The caller requested another resource-producing frame before draining DOPG.
    GlyphResourcesNotDrained,
    /// A scrolling coefficient, extent, or physics operation was invalid.
    Scroll(ScrollError),
    /// An Input Stream transaction was not strictly newer than the accepted sequence.
    InputSequenceNotNewer {
        /// Last accepted sequence.
        previous: u32,
        /// Rejected sequence.
        incoming: u32,
    },
    /// The current Core pipeline does not own this Input Stream command family.
    UnsupportedInputCommand,
    /// A direct-manipulation command did not target an active Scroll node.
    InvalidScrollTarget {
        /// Generation-bearing rejected node.
        node: NodeId,
    },
    /// Layout did not contain geometry required by a scroll runtime.
    MissingScrollGeometry {
        /// Scroll node or direct child missing geometry.
        node: NodeId,
    },
    /// A Worker frame delta was negative or non-finite.
    InvalidFrameDelta(f64),
    /// A physics position could not be represented by the f32 Scene ABI.
    InvalidScrollPosition(f64),
    /// Input or animation was requested before the first Mutation frame.
    MissingCommittedFrame,
}

impl fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Core frame rejected: {self:?}")
    }
}

impl std::error::Error for CoreError {}

impl From<AbiError> for CoreError {
    fn from(error: AbiError) -> Self {
        Self::Abi(error)
    }
}

impl From<SceneError> for CoreError {
    fn from(error: SceneError) -> Self {
        Self::Scene(error)
    }
}

impl From<ScrollError> for CoreError {
    fn from(error: ScrollError) -> Self {
        Self::Scroll(error)
    }
}
