use crate::LayoutError;

/// A two-dimensional offset in logical pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Point {
    /// Horizontal coordinate.
    pub x: f32,
    /// Vertical coordinate.
    pub y: f32,
}

impl Point {
    /// The origin.
    pub const ZERO: Self = Self { x: 0.0, y: 0.0 };

    /// Creates a point.
    #[must_use]
    pub const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }
}

/// A logical-pixel extent.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Size {
    /// Horizontal extent.
    pub width: f32,
    /// Vertical extent.
    pub height: f32,
}

impl Size {
    /// An empty extent.
    pub const ZERO: Self = Self {
        width: 0.0,
        height: 0.0,
    };

    /// Creates a size.
    #[must_use]
    pub const fn new(width: f32, height: f32) -> Self {
        Self { width, height }
    }

    /// Returns whether both dimensions are finite and non-negative.
    #[must_use]
    pub fn is_valid(self) -> bool {
        self.width.is_finite() && self.height.is_finite() && self.width >= 0.0 && self.height >= 0.0
    }
}

/// Normalized minimum and maximum constraints for one layout invocation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BoxConstraints {
    /// Minimum width.
    pub min_width: f32,
    /// Maximum width, which may be positive infinity.
    pub max_width: f32,
    /// Minimum height.
    pub min_height: f32,
    /// Maximum height, which may be positive infinity.
    pub max_height: f32,
}

impl BoxConstraints {
    /// Creates validated constraints.
    pub fn new(
        min_width: f32,
        max_width: f32,
        min_height: f32,
        max_height: f32,
    ) -> Result<Self, LayoutError> {
        let valid_bound = |value: f32| value >= 0.0 && !value.is_nan();
        if !valid_bound(min_width)
            || !valid_bound(max_width)
            || !valid_bound(min_height)
            || !valid_bound(max_height)
            || !min_width.is_finite()
            || !min_height.is_finite()
            || min_width > max_width
            || min_height > max_height
        {
            return Err(LayoutError::InvalidConstraints {
                min_width,
                max_width,
                min_height,
                max_height,
            });
        }
        Ok(Self {
            min_width,
            max_width,
            min_height,
            max_height,
        })
    }

    /// Creates tight constraints for a finite, non-negative size.
    pub fn tight(size: Size) -> Result<Self, LayoutError> {
        Self::new(size.width, size.width, size.height, size.height)
    }

    /// Constrains a candidate size to this range.
    #[must_use]
    pub fn constrain(self, size: Size) -> Size {
        Size {
            width: size.width.clamp(self.min_width, self.max_width),
            height: size.height.clamp(self.min_height, self.max_height),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_and_constrains_sizes() {
        let constraints = BoxConstraints::new(10.0, 20.0, 5.0, 15.0).expect("constraints");
        assert_eq!(
            constraints.constrain(Size::new(1.0, 30.0)),
            Size::new(10.0, 15.0)
        );
        assert!(BoxConstraints::new(-1.0, 20.0, 0.0, 10.0).is_err());
        assert!(BoxConstraints::new(20.0, 10.0, 0.0, 10.0).is_err());
        assert!(BoxConstraints::tight(Size::new(f32::NAN, 1.0)).is_err());
    }
}
