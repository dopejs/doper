use core::fmt;

/// A rejected font or text-layout request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TextError {
    /// Font data exceeded the protocol resource limit.
    FontTooLarge {
        /// Received byte count.
        actual: usize,
        /// Accepted byte limit.
        maximum: usize,
    },
    /// The container is not an SFNT font supported by the deterministic Core path.
    UnsupportedFontContainer,
    /// The bytes or collection face index do not describe a valid OpenType face.
    InvalidFont {
        /// Requested face in a font collection.
        face_index: u32,
    },
    /// The text exceeds the bounded layout input size.
    TextTooLarge {
        /// Received UTF-8 byte count.
        actual: usize,
        /// Accepted byte limit.
        maximum: usize,
    },
    /// The first text path supports deterministic left-to-right layout only.
    UnsupportedDirection,
    /// A numeric layout option is zero, negative, NaN, or infinite where disallowed.
    InvalidOptions,
    /// A shaped position could not be represented safely.
    ArithmeticOverflow,
}

impl fmt::Display for TextError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "text request rejected: {self:?}")
    }
}

impl std::error::Error for TextError {}

#[cfg(test)]
mod tests {
    use super::TextError;

    #[test]
    fn display_is_operator_facing() {
        let error = TextError::InvalidOptions;
        assert!(error.to_string().contains("InvalidOptions"));
        assert!(std::error::Error::source(&error).is_none());
    }
}
