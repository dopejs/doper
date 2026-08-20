use core::fmt;

use pingo_abi::{AbiError, DisplayOpcode, ResourceKind};
use pingo_paint::PaintError;

/// Deterministic software-oracle validation or rendering failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HeadlessError {
    /// Dimensions exceed the bounded oracle surface.
    InvalidSurface {
        /// Requested width.
        width: u32,
        /// Requested height.
        height: u32,
    },
    /// Pixel buffer size overflowed the host address space.
    SurfaceSizeOverflow,
    /// A display command is intentionally outside the M1 pixel-intersection oracle.
    UnsupportedCommand(DisplayOpcode),
    /// A paint resource was absent.
    MissingResource {
        /// Missing Scene resource identifier.
        resource_id: u32,
    },
    /// A resource did not have the required portable kind.
    WrongResourceKind {
        /// Scene resource identifier.
        resource_id: u32,
        /// Actual resource kind.
        actual: ResourceKind,
    },
    /// `DisplayList` trust-boundary validation failed.
    Abi(AbiError),
    /// Portable paint decoding failed.
    Paint(PaintError),
}

impl fmt::Display for HeadlessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "headless render rejected: {self:?}")
    }
}

impl std::error::Error for HeadlessError {}

impl From<AbiError> for HeadlessError {
    fn from(error: AbiError) -> Self {
        Self::Abi(error)
    }
}

impl From<PaintError> for HeadlessError {
    fn from(error: PaintError) -> Self {
        Self::Paint(error)
    }
}
