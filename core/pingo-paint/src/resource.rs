use pingo_abi::{
    AFFINE_A_OFFSET, AFFINE_B_OFFSET, AFFINE_C_OFFSET, AFFINE_D_OFFSET, AFFINE_E_OFFSET,
    AFFINE_F_OFFSET, AFFINE_RESOURCE_FIXED_BYTES, AFFINE_RESOURCE_MINIMUM_BYTES,
    AFFINE_RESOURCE_VARIANT, AFFINE_VARIANT_OFFSET, AFFINE_VERSION_OFFSET,
    RESOURCE_ENCODING_VERSION, SOLID_PAINT_ALPHA_OFFSET, SOLID_PAINT_BLUE_OFFSET,
    SOLID_PAINT_GREEN_OFFSET, SOLID_PAINT_RED_OFFSET, SOLID_PAINT_RESOURCE_FIXED_BYTES,
    SOLID_PAINT_RESOURCE_MINIMUM_BYTES, SOLID_PAINT_RESOURCE_VARIANT, SOLID_PAINT_VARIANT_OFFSET,
    SOLID_PAINT_VERSION_OFFSET, StyleKeyword, TEXT_STYLE_FAMILY_BYTES_OFFSET,
    TEXT_STYLE_FAMILY_OFFSET, TEXT_STYLE_FONT_SIZE_OFFSET, TEXT_STYLE_LINE_HEIGHT_OFFSET,
    TEXT_STYLE_PAINT_ID_OFFSET, TEXT_STYLE_RESOURCE_MINIMUM_BYTES, TEXT_STYLE_RESOURCE_VARIANT,
    TEXT_STYLE_V2_FAMILY_BYTES_OFFSET, TEXT_STYLE_V2_FAMILY_OFFSET, TEXT_STYLE_V2_FONT_SIZE_OFFSET,
    TEXT_STYLE_V2_FONT_STYLE_OFFSET, TEXT_STYLE_V2_LINE_HEIGHT_OFFSET,
    TEXT_STYLE_V2_OVERFLOW_WRAP_OFFSET, TEXT_STYLE_V2_PAINT_ID_OFFSET,
    TEXT_STYLE_V2_RESERVED_OFFSET, TEXT_STYLE_V2_RESOURCE_MINIMUM_BYTES,
    TEXT_STYLE_V2_RESOURCE_VARIANT, TEXT_STYLE_V2_TEXT_ALIGN_OFFSET,
    TEXT_STYLE_V2_TEXT_OVERFLOW_OFFSET, TEXT_STYLE_V2_VARIANT_OFFSET, TEXT_STYLE_V2_VERSION_OFFSET,
    TEXT_STYLE_V2_WEIGHT_OFFSET, TEXT_STYLE_V2_WHITE_SPACE_OFFSET, TEXT_STYLE_VARIANT_OFFSET,
    TEXT_STYLE_VERSION_OFFSET, TEXT_STYLE_WEIGHT_OFFSET,
};
use pingo_scene::Resource;

use crate::PaintError;

/// Canonical v1 solid RGBA paint payload.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SolidPaint {
    /// Red channel.
    pub red: u8,
    /// Green channel.
    pub green: u8,
    /// Blue channel.
    pub blue: u8,
    /// Alpha channel.
    pub alpha: u8,
}

impl SolidPaint {
    /// Encodes the aligned v1 resource payload.
    #[must_use]
    pub const fn encode(self) -> [u8; SOLID_PAINT_RESOURCE_MINIMUM_BYTES] {
        let mut bytes = [0; SOLID_PAINT_RESOURCE_MINIMUM_BYTES];
        bytes[SOLID_PAINT_VERSION_OFFSET] = RESOURCE_ENCODING_VERSION;
        bytes[SOLID_PAINT_VARIANT_OFFSET] = SOLID_PAINT_RESOURCE_VARIANT;
        bytes[SOLID_PAINT_RED_OFFSET] = self.red;
        bytes[SOLID_PAINT_GREEN_OFFSET] = self.green;
        bytes[SOLID_PAINT_BLUE_OFFSET] = self.blue;
        bytes[SOLID_PAINT_ALPHA_OFFSET] = self.alpha;
        bytes
    }

    /// Decodes a validated portable resource for backend and oracle consumers.
    ///
    /// # Errors
    ///
    /// Returns [`PaintError::InvalidResource`] when the versioned payload is
    /// malformed or is not the fixed-size solid-paint variant.
    pub fn decode(resource_id: u32, resource: &Resource) -> Result<Self, PaintError> {
        let bytes = resource.bytes.as_ref();
        validate_header(
            resource_id,
            bytes,
            SOLID_PAINT_RESOURCE_VARIANT,
            SOLID_PAINT_VERSION_OFFSET,
            SOLID_PAINT_VARIANT_OFFSET,
            SOLID_PAINT_RED_OFFSET,
        )?;
        if Some(bytes.len()) != SOLID_PAINT_RESOURCE_FIXED_BYTES {
            return Err(invalid(
                resource_id,
                "solid paint must be exactly eight bytes",
            ));
        }
        Ok(Self {
            red: bytes[SOLID_PAINT_RED_OFFSET],
            green: bytes[SOLID_PAINT_GREEN_OFFSET],
            blue: bytes[SOLID_PAINT_BLUE_OFFSET],
            alpha: bytes[SOLID_PAINT_ALPHA_OFFSET],
        })
    }
}

/// Canonical v1 affine matrix `[a, b, c, d, e, f]`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AffineResource {
    /// Matrix components in Canvas2D order.
    pub matrix: [f32; 6],
}

impl AffineResource {
    /// Encodes the aligned v1 resource payload.
    #[must_use]
    pub fn encode(self) -> [u8; AFFINE_RESOURCE_MINIMUM_BYTES] {
        let mut bytes = [0_u8; AFFINE_RESOURCE_MINIMUM_BYTES];
        bytes[AFFINE_VERSION_OFFSET] = RESOURCE_ENCODING_VERSION;
        bytes[AFFINE_VARIANT_OFFSET] = AFFINE_RESOURCE_VARIANT;
        for (offset, value) in affine_offsets().into_iter().zip(self.matrix) {
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    /// Decodes a validated affine transform for layout and paint consumers.
    ///
    /// # Errors
    ///
    /// Returns [`PaintError::InvalidResource`] for malformed or unsupported payloads.
    pub fn decode(resource_id: u32, resource: &Resource) -> Result<Self, PaintError> {
        let bytes = resource.bytes.as_ref();
        validate_header(
            resource_id,
            bytes,
            AFFINE_RESOURCE_VARIANT,
            AFFINE_VERSION_OFFSET,
            AFFINE_VARIANT_OFFSET,
            AFFINE_A_OFFSET,
        )?;
        if Some(bytes.len()) != AFFINE_RESOURCE_FIXED_BYTES {
            return Err(invalid(
                resource_id,
                "affine resource must be exactly 28 bytes",
            ));
        }
        let mut matrix = [0.0; 6];
        for (start, value) in affine_offsets().into_iter().zip(&mut matrix) {
            *value = f32::from_le_bytes(
                bytes[start..start + 4]
                    .try_into()
                    .expect("validated affine field length"),
            );
            if !value.is_finite() {
                return Err(invalid(resource_id, "affine component must be finite"));
            }
        }
        Ok(Self { matrix })
    }
}

/// Canonical minimal fallback-text style.
#[derive(Clone, Debug, PartialEq)]
pub struct TextStyleResource {
    /// Referenced solid paint.
    pub paint_id: u32,
    /// Font size in logical pixels.
    pub font_size: f32,
    /// Line height in logical pixels.
    pub line_height: f32,
    /// CSS numeric font weight.
    pub weight: u16,
    /// UTF-8 font family.
    pub family: String,
    /// Font face posture.
    pub font_style: StyleKeyword,
    /// Inline-axis line alignment.
    pub text_align: StyleKeyword,
    /// Whitespace collapsing and wrapping mode.
    pub white_space: StyleKeyword,
    /// Emergency word breaking mode.
    pub overflow_wrap: StyleKeyword,
    /// Inline overflow marker behavior.
    pub text_overflow: StyleKeyword,
}

impl TextStyleResource {
    /// Encodes v1 for the legacy defaults and v2 when M6 text semantics are used.
    pub fn encode(&self) -> Result<Vec<u8>, PaintError> {
        if !self.font_size.is_finite()
            || self.font_size <= 0.0
            || !self.line_height.is_finite()
            || self.line_height <= 0.0
            || !(1..=1000).contains(&self.weight)
        {
            return Err(invalid(0, "invalid text style numeric field"));
        }
        validate_text_keywords(self).map_err(|reason| invalid(0, reason))?;
        let family_len =
            u32::try_from(self.family.len()).map_err(|_| invalid(0, "font family is too large"))?;
        let legacy = self.font_style == StyleKeyword::Normal
            && self.text_align == StyleKeyword::Start
            && self.white_space == StyleKeyword::Normal
            && self.overflow_wrap == StyleKeyword::Normal
            && self.text_overflow == StyleKeyword::Clip;
        let (minimum_bytes, family_offset) = if legacy {
            (TEXT_STYLE_RESOURCE_MINIMUM_BYTES, TEXT_STYLE_FAMILY_OFFSET)
        } else {
            (
                TEXT_STYLE_V2_RESOURCE_MINIMUM_BYTES,
                TEXT_STYLE_V2_FAMILY_OFFSET,
            )
        };
        let aligned_len = minimum_bytes
            .checked_add(self.family.len())
            .and_then(|length| length.checked_add(3))
            .map(|length| length & !3)
            .ok_or_else(|| invalid(0, "text style length overflow"))?;
        let mut bytes = vec![0_u8; aligned_len];
        let (
            version_offset,
            variant_offset,
            paint_offset,
            size_offset,
            line_offset,
            weight_offset,
            family_bytes_offset,
        ) = if legacy {
            (
                TEXT_STYLE_VERSION_OFFSET,
                TEXT_STYLE_VARIANT_OFFSET,
                TEXT_STYLE_PAINT_ID_OFFSET,
                TEXT_STYLE_FONT_SIZE_OFFSET,
                TEXT_STYLE_LINE_HEIGHT_OFFSET,
                TEXT_STYLE_WEIGHT_OFFSET,
                TEXT_STYLE_FAMILY_BYTES_OFFSET,
            )
        } else {
            bytes[TEXT_STYLE_V2_FONT_STYLE_OFFSET] = self.font_style as u8;
            bytes[TEXT_STYLE_V2_TEXT_ALIGN_OFFSET] = self.text_align as u8;
            bytes[TEXT_STYLE_V2_WHITE_SPACE_OFFSET] = self.white_space as u8;
            bytes[TEXT_STYLE_V2_OVERFLOW_WRAP_OFFSET] = self.overflow_wrap as u8;
            bytes[TEXT_STYLE_V2_TEXT_OVERFLOW_OFFSET] = self.text_overflow as u8;
            (
                TEXT_STYLE_V2_VERSION_OFFSET,
                TEXT_STYLE_V2_VARIANT_OFFSET,
                TEXT_STYLE_V2_PAINT_ID_OFFSET,
                TEXT_STYLE_V2_FONT_SIZE_OFFSET,
                TEXT_STYLE_V2_LINE_HEIGHT_OFFSET,
                TEXT_STYLE_V2_WEIGHT_OFFSET,
                TEXT_STYLE_V2_FAMILY_BYTES_OFFSET,
            )
        };
        bytes[version_offset] = RESOURCE_ENCODING_VERSION;
        bytes[variant_offset] = if legacy {
            TEXT_STYLE_RESOURCE_VARIANT
        } else {
            TEXT_STYLE_V2_RESOURCE_VARIANT
        };
        write_bytes(&mut bytes, paint_offset, &self.paint_id.to_le_bytes());
        write_bytes(&mut bytes, size_offset, &self.font_size.to_le_bytes());
        write_bytes(&mut bytes, line_offset, &self.line_height.to_le_bytes());
        write_bytes(&mut bytes, weight_offset, &self.weight.to_le_bytes());
        write_bytes(&mut bytes, family_bytes_offset, &family_len.to_le_bytes());
        bytes[family_offset..family_offset + self.family.len()]
            .copy_from_slice(self.family.as_bytes());
        Ok(bytes)
    }

    /// Decodes a validated fallback style for layout and paint consumers.
    ///
    /// # Errors
    ///
    /// Returns [`PaintError::InvalidResource`] for malformed or unsupported payloads.
    pub fn decode(resource_id: u32, resource: &Resource) -> Result<Self, PaintError> {
        let bytes = resource.bytes.as_ref();
        if bytes.get(TEXT_STYLE_VARIANT_OFFSET) == Some(&TEXT_STYLE_V2_RESOURCE_VARIANT) {
            return Self::decode_v2(resource_id, bytes);
        }
        validate_header(
            resource_id,
            bytes,
            TEXT_STYLE_RESOURCE_VARIANT,
            TEXT_STYLE_VERSION_OFFSET,
            TEXT_STYLE_VARIANT_OFFSET,
            TEXT_STYLE_PAINT_ID_OFFSET,
        )?;
        if bytes.len() < TEXT_STYLE_RESOURCE_MINIMUM_BYTES
            || !bytes.len().is_multiple_of(4)
            || bytes[TEXT_STYLE_WEIGHT_OFFSET + 2..TEXT_STYLE_FAMILY_BYTES_OFFSET] != [0, 0]
        {
            return Err(invalid(
                resource_id,
                "invalid text style header or alignment",
            ));
        }
        let paint_id = read_u32(bytes, TEXT_STYLE_PAINT_ID_OFFSET);
        let font_size = read_f32(bytes, TEXT_STYLE_FONT_SIZE_OFFSET);
        let line_height = read_f32(bytes, TEXT_STYLE_LINE_HEIGHT_OFFSET);
        let weight = u16::from_le_bytes([
            bytes[TEXT_STYLE_WEIGHT_OFFSET],
            bytes[TEXT_STYLE_WEIGHT_OFFSET + 1],
        ]);
        let family_len = usize::try_from(read_u32(bytes, TEXT_STYLE_FAMILY_BYTES_OFFSET))
            .map_err(|_| invalid(resource_id, "font family length overflow"))?;
        let family_end = TEXT_STYLE_FAMILY_OFFSET
            .checked_add(family_len)
            .ok_or_else(|| invalid(resource_id, "font family length overflow"))?;
        if family_end > bytes.len()
            || bytes[family_end..].iter().any(|padding| *padding != 0)
            || !font_size.is_finite()
            || font_size <= 0.0
            || !line_height.is_finite()
            || line_height <= 0.0
            || !(1..=1000).contains(&weight)
        {
            return Err(invalid(resource_id, "invalid text style payload"));
        }
        let family = std::str::from_utf8(&bytes[TEXT_STYLE_FAMILY_OFFSET..family_end])
            .map_err(|_| invalid(resource_id, "font family is not UTF-8"))?
            .to_owned();
        if family.is_empty() {
            return Err(invalid(resource_id, "font family must not be empty"));
        }
        Ok(Self {
            paint_id,
            font_size,
            line_height,
            weight,
            family,
            font_style: StyleKeyword::Normal,
            text_align: StyleKeyword::Start,
            white_space: StyleKeyword::Normal,
            overflow_wrap: StyleKeyword::Normal,
            text_overflow: StyleKeyword::Clip,
        })
    }

    fn decode_v2(resource_id: u32, bytes: &[u8]) -> Result<Self, PaintError> {
        if bytes.len() < TEXT_STYLE_V2_RESOURCE_MINIMUM_BYTES
            || !bytes.len().is_multiple_of(4)
            || bytes[TEXT_STYLE_V2_VERSION_OFFSET] != RESOURCE_ENCODING_VERSION
            || bytes[TEXT_STYLE_V2_VARIANT_OFFSET] != TEXT_STYLE_V2_RESOURCE_VARIANT
            || bytes[TEXT_STYLE_V2_RESERVED_OFFSET..TEXT_STYLE_V2_FAMILY_BYTES_OFFSET]
                .iter()
                .any(|reserved| *reserved != 0)
        {
            return Err(invalid(
                resource_id,
                "invalid text style v2 header or alignment",
            ));
        }
        let keyword = |offset: usize| {
            StyleKeyword::from_u16(u16::from(bytes[offset]))
                .ok_or_else(|| invalid(resource_id, "unknown text style keyword"))
        };
        let paint_id = read_u32(bytes, TEXT_STYLE_V2_PAINT_ID_OFFSET);
        let font_size = read_f32(bytes, TEXT_STYLE_V2_FONT_SIZE_OFFSET);
        let line_height = read_f32(bytes, TEXT_STYLE_V2_LINE_HEIGHT_OFFSET);
        let weight = u16::from_le_bytes([
            bytes[TEXT_STYLE_V2_WEIGHT_OFFSET],
            bytes[TEXT_STYLE_V2_WEIGHT_OFFSET + 1],
        ]);
        let family_len = usize::try_from(read_u32(bytes, TEXT_STYLE_V2_FAMILY_BYTES_OFFSET))
            .map_err(|_| invalid(resource_id, "font family length overflow"))?;
        let family_end = TEXT_STYLE_V2_FAMILY_OFFSET
            .checked_add(family_len)
            .ok_or_else(|| invalid(resource_id, "font family length overflow"))?;
        let result = Self {
            paint_id,
            font_size,
            line_height,
            weight,
            family: if family_end <= bytes.len() {
                std::str::from_utf8(&bytes[TEXT_STYLE_V2_FAMILY_OFFSET..family_end])
                    .map_err(|_| invalid(resource_id, "font family is not UTF-8"))?
                    .to_owned()
            } else {
                return Err(invalid(resource_id, "font family length overflow"));
            },
            font_style: keyword(TEXT_STYLE_V2_FONT_STYLE_OFFSET)?,
            text_align: keyword(TEXT_STYLE_V2_TEXT_ALIGN_OFFSET)?,
            white_space: keyword(TEXT_STYLE_V2_WHITE_SPACE_OFFSET)?,
            overflow_wrap: keyword(TEXT_STYLE_V2_OVERFLOW_WRAP_OFFSET)?,
            text_overflow: keyword(TEXT_STYLE_V2_TEXT_OVERFLOW_OFFSET)?,
        };
        if family_end > bytes.len()
            || bytes[family_end..].iter().any(|padding| *padding != 0)
            || !result.font_size.is_finite()
            || result.font_size <= 0.0
            || !result.line_height.is_finite()
            || result.line_height <= 0.0
            || !(1..=1000).contains(&result.weight)
            || result.family.is_empty()
        {
            return Err(invalid(resource_id, "invalid text style v2 payload"));
        }
        validate_text_keywords(&result).map_err(|reason| invalid(resource_id, reason))?;
        Ok(result)
    }
}

fn validate_text_keywords(style: &TextStyleResource) -> Result<(), &'static str> {
    if !matches!(
        style.font_style,
        StyleKeyword::Normal | StyleKeyword::Italic
    ) {
        return Err("invalid font-style keyword");
    }
    if !matches!(
        style.text_align,
        StyleKeyword::Start
            | StyleKeyword::End
            | StyleKeyword::Left
            | StyleKeyword::Right
            | StyleKeyword::Center
            | StyleKeyword::Justify
    ) {
        return Err("invalid text-align keyword");
    }
    if !matches!(
        style.white_space,
        StyleKeyword::Normal
            | StyleKeyword::Nowrap
            | StyleKeyword::Pre
            | StyleKeyword::PreLine
            | StyleKeyword::PreWrap
    ) {
        return Err("invalid white-space keyword");
    }
    if !matches!(
        style.overflow_wrap,
        StyleKeyword::Normal | StyleKeyword::BreakWord | StyleKeyword::Anywhere
    ) {
        return Err("invalid overflow-wrap keyword");
    }
    if !matches!(
        style.text_overflow,
        StyleKeyword::Clip | StyleKeyword::Ellipsis
    ) {
        return Err("invalid text-overflow keyword");
    }
    Ok(())
}

fn validate_header(
    resource_id: u32,
    bytes: &[u8],
    variant: u8,
    version_offset: usize,
    variant_offset: usize,
    payload_offset: usize,
) -> Result<(), PaintError> {
    if bytes.len() < payload_offset
        || bytes[version_offset] != RESOURCE_ENCODING_VERSION
        || bytes[variant_offset] != variant
        || bytes[variant_offset + 1..payload_offset]
            .iter()
            .any(|reserved| *reserved != 0)
    {
        return Err(invalid(
            resource_id,
            "invalid resource version, kind, or reserved bytes",
        ));
    }
    Ok(())
}

const fn affine_offsets() -> [usize; 6] {
    [
        AFFINE_A_OFFSET,
        AFFINE_B_OFFSET,
        AFFINE_C_OFFSET,
        AFFINE_D_OFFSET,
        AFFINE_E_OFFSET,
        AFFINE_F_OFFSET,
    ]
}

fn write_bytes(destination: &mut [u8], offset: usize, value: &[u8]) {
    destination[offset..offset + value.len()].copy_from_slice(value);
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("validated resource field length"),
    )
}

fn read_f32(bytes: &[u8], offset: usize) -> f32 {
    f32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("validated resource field length"),
    )
}

fn invalid(resource_id: u32, reason: &'static str) -> PaintError {
    PaintError::InvalidResource {
        resource_id,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use pingo_abi::ResourceKind;

    use super::*;

    fn resource(kind: ResourceKind, bytes: Vec<u8>) -> Resource {
        Resource {
            kind,
            bytes: Arc::from(bytes),
            computed_style: None,
            animation: None,
        }
    }

    #[test]
    fn solid_paint_matches_the_cross_language_fixture() {
        let paint = SolidPaint {
            red: 0x12,
            green: 0x34,
            blue: 0x56,
            alpha: 0x80,
        };
        let encoded = paint.encode();
        assert_eq!(encoded, [1, 1, 0, 0, 0x12, 0x34, 0x56, 0x80]);
        assert_eq!(
            SolidPaint::decode(7, &resource(ResourceKind::Paint, encoded.to_vec())),
            Ok(paint)
        );
    }

    #[test]
    fn text_style_matches_the_cross_language_fixture() {
        let style = TextStyleResource {
            paint_id: 1,
            font_size: 16.0,
            line_height: 20.0,
            weight: 400,
            family: "Inter".to_owned(),
            font_style: StyleKeyword::Normal,
            text_align: StyleKeyword::Start,
            white_space: StyleKeyword::Normal,
            overflow_wrap: StyleKeyword::Normal,
            text_overflow: StyleKeyword::Clip,
        };
        let encoded = style.encode().expect("style encodes");
        assert_eq!(
            to_hex(&encoded),
            "0101000001000000000080410000a0419001000005000000496e746572000000"
        );
        assert_eq!(
            TextStyleResource::decode(9, &resource(ResourceKind::TextStyle, encoded),),
            Ok(style)
        );
    }

    #[test]
    fn text_style_v2_round_trips_m6_semantics_and_rejects_unknown_keywords() {
        let style = TextStyleResource {
            paint_id: 1,
            font_size: 16.0,
            line_height: 20.0,
            weight: 400,
            family: "Inter".to_owned(),
            font_style: StyleKeyword::Italic,
            text_align: StyleKeyword::Center,
            white_space: StyleKeyword::Nowrap,
            overflow_wrap: StyleKeyword::Anywhere,
            text_overflow: StyleKeyword::Ellipsis,
        };
        let encoded = style.encode().expect("v2 style encodes");
        assert_eq!(
            encoded[TEXT_STYLE_V2_VARIANT_OFFSET],
            TEXT_STYLE_V2_RESOURCE_VARIANT
        );
        assert_eq!(
            to_hex(&encoded),
            "0102180601000000000080410000a04190011f010f00000005000000496e746572000000"
        );
        assert_eq!(
            TextStyleResource::decode(10, &resource(ResourceKind::TextStyle, encoded.clone())),
            Ok(style)
        );
        let mut malformed = encoded;
        malformed[TEXT_STYLE_V2_WHITE_SPACE_OFFSET] = u8::MAX;
        assert!(
            TextStyleResource::decode(10, &resource(ResourceKind::TextStyle, malformed)).is_err()
        );
    }

    fn to_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}
