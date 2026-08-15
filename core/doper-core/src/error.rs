use core::fmt;

use doper_abi::AbiError;
use doper_layout::LayoutError;
use doper_paint::PaintError;
use doper_scene::SceneError;

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
    /// Mutation bytes failed trust-boundary validation.
    Abi(AbiError),
    /// A decoded transaction violated Scene invariants and was not committed.
    Scene(SceneError),
    /// Layout failed after Scene accepted the transaction; the instance is poisoned.
    Layout(LayoutError),
    /// Paint failed after Scene accepted the transaction; the instance is poisoned.
    Paint(PaintError),
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
