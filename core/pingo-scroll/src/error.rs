use core::fmt;

/// Validation or arithmetic failure in the scrolling subsystem.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ScrollError {
    /// An item extent was negative or non-finite.
    InvalidExtent {
        /// Item index, when the item already belongs to an index.
        index: Option<usize>,
        /// Rejected logical-pixel extent.
        value: f32,
    },
    /// An item index was outside the current sequence.
    IndexOutOfBounds {
        /// Requested item index.
        index: usize,
        /// Current item count.
        len: usize,
    },
    /// An offset, extent, duration, or velocity was non-finite or outside its valid range.
    InvalidScalar {
        /// Operator-facing field name.
        field: &'static str,
        /// Rejected value.
        value: f64,
    },
    /// Prefix-sum state could not be represented safely.
    ArithmeticOverflow,
}

impl fmt::Display for ScrollError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidExtent { index, value } => match index {
                Some(index) => write!(formatter, "extent at index {index} is invalid: {value}"),
                None => write!(formatter, "extent is invalid: {value}"),
            },
            Self::IndexOutOfBounds { index, len } => {
                write!(formatter, "item index {index} is outside length {len}")
            }
            Self::InvalidScalar { field, value } => {
                write!(formatter, "{field} is invalid: {value}")
            }
            Self::ArithmeticOverflow => formatter.write_str("scroll arithmetic overflow"),
        }
    }
}

impl std::error::Error for ScrollError {}

#[cfg(test)]
mod tests {
    use super::ScrollError;

    #[test]
    fn every_error_variant_has_operator_facing_context() {
        assert_eq!(
            ScrollError::InvalidExtent {
                index: Some(3),
                value: -1.0,
            }
            .to_string(),
            "extent at index 3 is invalid: -1"
        );
        assert_eq!(
            ScrollError::InvalidExtent {
                index: None,
                value: f32::INFINITY,
            }
            .to_string(),
            "extent is invalid: inf"
        );
        assert_eq!(
            ScrollError::IndexOutOfBounds { index: 4, len: 2 }.to_string(),
            "item index 4 is outside length 2"
        );
        assert_eq!(
            ScrollError::InvalidScalar {
                field: "duration",
                value: -1.0,
            }
            .to_string(),
            "duration is invalid: -1"
        );
        assert_eq!(
            ScrollError::ArithmeticOverflow.to_string(),
            "scroll arithmetic overflow"
        );
    }
}
