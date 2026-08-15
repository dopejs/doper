use std::sync::Arc;

use crate::TextError;

/// Maximum font payload accepted by the shared resource protocol.
pub const MAX_FONT_BYTES: usize = 8 * 1024 * 1024;

/// An immutable, validated font face for deterministic Core shaping.
#[derive(Clone, Debug)]
pub struct FontFace {
    id: u32,
    revision: u32,
    face_index: u32,
    fingerprint: u64,
    units_per_em: u16,
    bytes: Arc<[u8]>,
}

impl FontFace {
    /// Parses an SFNT OpenType/TrueType face. WOFF/WOFF2 must be decoded by the
    /// font loader before crossing the Core boundary.
    ///
    /// # Errors
    ///
    /// Rejects oversized, unsupported, malformed, or missing collection faces.
    pub fn from_bytes(
        id: u32,
        revision: u32,
        face_index: u32,
        bytes: Arc<[u8]>,
    ) -> Result<Self, TextError> {
        if bytes.len() > MAX_FONT_BYTES {
            return Err(TextError::FontTooLarge {
                actual: bytes.len(),
                maximum: MAX_FONT_BYTES,
            });
        }
        if !is_sfnt(&bytes) {
            return Err(TextError::UnsupportedFontContainer);
        }
        let face = rustybuzz::Face::from_slice(&bytes, face_index)
            .ok_or(TextError::InvalidFont { face_index })?;
        let units_per_em = u16::try_from(face.units_per_em())
            .map_err(|_| TextError::InvalidFont { face_index })?;
        if units_per_em == 0 {
            return Err(TextError::InvalidFont { face_index });
        }
        let fingerprint = fingerprint(&bytes, face_index);
        drop(face);
        Ok(Self {
            id,
            revision,
            face_index,
            fingerprint,
            units_per_em,
            bytes,
        })
    }

    /// Application-visible font resource identifier.
    #[must_use]
    pub const fn id(&self) -> u32 {
        self.id
    }

    /// Monotonic font-load revision used for cache invalidation.
    #[must_use]
    pub const fn revision(&self) -> u32 {
        self.revision
    }

    /// Stable content fingerprint, including the collection face index.
    #[must_use]
    pub const fn fingerprint(&self) -> u64 {
        self.fingerprint
    }

    /// Font design units per em.
    #[must_use]
    pub const fn units_per_em(&self) -> u16 {
        self.units_per_em
    }

    pub(crate) fn rustybuzz_face(&self) -> Result<rustybuzz::Face<'_>, TextError> {
        rustybuzz::Face::from_slice(&self.bytes, self.face_index).ok_or(TextError::InvalidFont {
            face_index: self.face_index,
        })
    }
}

fn is_sfnt(bytes: &[u8]) -> bool {
    matches!(
        bytes.get(..4),
        Some([0x00, 0x01, 0x00, 0x00] | b"OTTO" | b"true" | b"typ1" | b"ttcf")
    )
}

fn fingerprint(bytes: &[u8], face_index: u32) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes.iter().copied().chain(face_index.to_le_bytes()) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{FontFace, MAX_FONT_BYTES};
    use crate::TextError;

    #[test]
    fn rejects_non_sfnt_and_oversized_fonts() {
        assert_eq!(
            FontFace::from_bytes(1, 1, 0, Arc::from(*b"wOF2invalid"))
                .expect_err("WOFF2 requires loader decode"),
            TextError::UnsupportedFontContainer
        );
        assert_eq!(
            FontFace::from_bytes(1, 1, 0, Arc::from(vec![0_u8; MAX_FONT_BYTES + 1]))
                .expect_err("oversized"),
            TextError::FontTooLarge {
                actual: MAX_FONT_BYTES + 1,
                maximum: MAX_FONT_BYTES,
            }
        );
    }

    #[test]
    fn rejects_invalid_sfnt_without_panicking() {
        let mut bytes = vec![0_u8; 32];
        bytes[..4].copy_from_slice(&[0, 1, 0, 0]);
        assert_eq!(
            FontFace::from_bytes(7, 3, 0, Arc::from(bytes)).expect_err("invalid tables"),
            TextError::InvalidFont { face_index: 0 }
        );
    }

    #[test]
    fn exposes_validated_identity_and_font_metrics() {
        let bytes = crate::conformance_font();
        let font = FontFace::from_bytes(42, 7, 0, Arc::clone(&bytes)).expect("valid font");
        assert_eq!(font.id(), 42);
        assert_eq!(font.revision(), 7);
        assert!(font.units_per_em() > 0);
        assert_ne!(font.fingerprint(), 0);
        assert_eq!(
            FontFace::from_bytes(42, 7, u32::MAX, bytes).expect_err("missing collection face"),
            TextError::InvalidFont {
                face_index: u32::MAX,
            }
        );
    }
}
