use pingo_abi::{
    AFFINE_A_OFFSET, AFFINE_B_OFFSET, AFFINE_C_OFFSET, AFFINE_D_OFFSET, AFFINE_E_OFFSET,
    AFFINE_F_OFFSET, AFFINE_RESOURCE_FIXED_BYTES, AFFINE_RESOURCE_MINIMUM_BYTES,
    AFFINE_RESOURCE_VARIANT, AFFINE_VARIANT_OFFSET, AFFINE_VERSION_OFFSET, PATH_FILL_RULE_OFFSET,
    PATH_POINT_COUNT_OFFSET, PATH_RESERVED_OFFSET, PATH_RESOURCE_MINIMUM_BYTES,
    PATH_RESOURCE_VARIANT, PATH_VARIANT_OFFSET, PATH_VERB_COUNT_OFFSET, PATH_VERSION_OFFSET,
    PATH_VIEW_BOX_HEIGHT_OFFSET, PATH_VIEW_BOX_WIDTH_OFFSET, PATH_VIEW_BOX_X_OFFSET,
    PATH_VIEW_BOX_Y_OFFSET, RESOURCE_ENCODING_VERSION, SOLID_PAINT_ALPHA_OFFSET,
    SOLID_PAINT_BLUE_OFFSET, SOLID_PAINT_GREEN_OFFSET, SOLID_PAINT_RED_OFFSET,
    SOLID_PAINT_RESOURCE_FIXED_BYTES, SOLID_PAINT_RESOURCE_MINIMUM_BYTES,
    SOLID_PAINT_RESOURCE_VARIANT, SOLID_PAINT_VARIANT_OFFSET, SOLID_PAINT_VERSION_OFFSET,
    StyleKeyword, TEXT_STYLE_FAMILY_BYTES_OFFSET, TEXT_STYLE_FAMILY_OFFSET,
    TEXT_STYLE_FONT_SIZE_OFFSET, TEXT_STYLE_LINE_HEIGHT_OFFSET, TEXT_STYLE_PAINT_ID_OFFSET,
    TEXT_STYLE_RESOURCE_MINIMUM_BYTES, TEXT_STYLE_RESOURCE_VARIANT,
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
mod path_tests {
    use super::*;

    fn circle_ish() -> PathResource {
        PathResource {
            verbs: vec![
                PathVerb::Move,
                PathVerb::Cubic,
                PathVerb::Quad,
                PathVerb::Line,
                PathVerb::Close,
            ],
            points: vec![
                0.0, 0.0, // move
                1.0, 0.0, 2.0, 1.0, 2.0, 2.0, // cubic
                1.0, 3.0, 0.0, 3.0, // quad
                0.0, 1.0, // line
            ],
            fill_rule: FillRule::EvenOdd,
            view_box: [0.0, 0.0, 24.0, 24.0],
        }
    }

    #[test]
    fn round_trips_every_verb_and_both_fill_rules() {
        for rule in [FillRule::NonZero, FillRule::EvenOdd] {
            let path = PathResource {
                fill_rule: rule,
                ..circle_ish()
            };
            let bytes = path.encode(1).expect("encode");
            // Points start four-byte aligned so a decoder never reads across a
            // boundary; five verbs means three bytes of padding here.
            assert_eq!(bytes.len() % 4, 0);
            assert_eq!(PathResource::decode(1, &bytes), Ok(path));
        }
    }

    #[test]
    fn rejects_a_path_that_does_not_begin_with_a_move() {
        // Without an opening move there is no current point, and every consumer
        // would have to invent one.
        let mut bytes = circle_ish().encode(1).expect("encode");
        bytes[PATH_RESOURCE_MINIMUM_BYTES] = PathVerb::Line as u8;
        assert!(PathResource::decode(1, &bytes).is_err());
    }

    #[test]
    fn rejects_verbs_and_points_that_disagree() {
        let mut path = circle_ish();
        path.points.pop();
        assert!(path.encode(1).is_err());

        let mut bytes = circle_ish().encode(1).expect("encode");
        bytes[PATH_POINT_COUNT_OFFSET] = 2;
        assert!(PathResource::decode(1, &bytes).is_err());
    }

    #[test]
    fn rejects_malformed_headers_and_payloads() {
        let valid = circle_ish().encode(1).expect("encode");
        for mutate in [
            |bytes: &mut Vec<u8>| bytes[PATH_VERSION_OFFSET] = 99,
            |bytes: &mut Vec<u8>| bytes[PATH_VARIANT_OFFSET] = 99,
            |bytes: &mut Vec<u8>| bytes[PATH_FILL_RULE_OFFSET] = 9,
            |bytes: &mut Vec<u8>| bytes[PATH_RESERVED_OFFSET] = 1,
            // A zero-extent view box would divide by zero when scaling.
            |bytes: &mut Vec<u8>| {
                bytes[PATH_VIEW_BOX_WIDTH_OFFSET..PATH_VIEW_BOX_WIDTH_OFFSET + 4]
                    .copy_from_slice(&0.0_f32.to_le_bytes());
            },
            |bytes: &mut Vec<u8>| {
                bytes[PATH_VIEW_BOX_X_OFFSET..PATH_VIEW_BOX_X_OFFSET + 4]
                    .copy_from_slice(&f32::NAN.to_le_bytes());
            },
            |bytes: &mut Vec<u8>| {
                let start = bytes.len() - 4;
                bytes[start..].copy_from_slice(&f32::INFINITY.to_le_bytes());
            },
            |bytes: &mut Vec<u8>| {
                bytes[PATH_RESOURCE_MINIMUM_BYTES] = 9;
            },
            |bytes: &mut Vec<u8>| {
                bytes.push(0);
            },
            |bytes: &mut Vec<u8>| {
                bytes.truncate(bytes.len() - 1);
            },
        ] {
            let mut bytes = valid.clone();
            mutate(&mut bytes);
            assert!(
                PathResource::decode(1, &bytes).is_err(),
                "a mutated path decoded cleanly"
            );
        }
        assert!(PathResource::decode(1, &valid).is_ok());
    }

    #[test]
    fn rejects_padding_that_is_not_zero() {
        // The padding is where a producer could smuggle bytes past a decoder
        // that trusted the counts.
        let mut bytes = circle_ish().encode(1).expect("encode");
        bytes[PATH_RESOURCE_MINIMUM_BYTES + 5] = 1;
        assert!(PathResource::decode(1, &bytes).is_err());
    }

    #[test]
    fn arbitrary_bytes_never_panic() {
        for length in 0..256 {
            let bytes = (0..length)
                .map(|index| (index as u8).wrapping_mul(31))
                .collect::<Vec<_>>();
            let _ = PathResource::decode(1, &bytes);
        }
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

/// How a filled path decides what is inside it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FillRule {
    /// Winding-number rule; the SVG and Canvas2D default.
    NonZero,
    /// Parity rule.
    EvenOdd,
}

/// One step of a path outline.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PathVerb {
    /// Starts a new subpath at the next point.
    Move,
    /// Straight segment to the next point.
    Line,
    /// Quadratic segment through the next two points.
    Quad,
    /// Cubic segment through the next three points.
    Cubic,
    /// Closes the current subpath; consumes no points.
    Close,
}

impl PathVerb {
    const fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Move),
            1 => Some(Self::Line),
            2 => Some(Self::Quad),
            3 => Some(Self::Cubic),
            4 => Some(Self::Close),
            _ => None,
        }
    }

    /// Points this verb consumes.
    #[must_use]
    pub const fn point_count(self) -> usize {
        match self {
            Self::Move | Self::Line => 1,
            Self::Quad => 2,
            Self::Cubic => 3,
            Self::Close => 0,
        }
    }
}

/// Immutable vector outline shared by every node that draws it.
///
/// Verbs and points are separate arrays rather than interleaved records: the
/// shapes differ per verb, and a flat point array is what both `Path2D` and a
/// scanline rasteriser want to walk.
#[derive(Clone, Debug, PartialEq)]
pub struct PathResource {
    /// Outline steps in order.
    pub verbs: Vec<PathVerb>,
    /// Flat `x, y` pairs consumed by the verbs in order.
    pub points: Vec<f32>,
    /// Inside-ness rule for filling.
    pub fill_rule: FillRule,
    /// Author coordinate space as `x, y, width, height`.
    pub view_box: [f32; 4],
}

impl PathResource {
    /// Encodes the aligned v1 resource payload.
    ///
    /// # Errors
    /// Returns [`PaintError::InvalidResource`] when a coordinate is not finite
    /// or the counts overflow.
    pub fn encode(&self, resource_id: u32) -> Result<Vec<u8>, PaintError> {
        if self.verbs.len() > u32::MAX as usize || self.points.len() > u32::MAX as usize {
            return Err(invalid(resource_id, "path is too large to encode"));
        }
        let expected: usize = self.verbs.iter().map(|verb| verb.point_count()).sum();
        if expected * 2 != self.points.len() {
            return Err(invalid(resource_id, "path verbs and points disagree"));
        }
        let mut bytes = vec![0_u8; PATH_RESOURCE_MINIMUM_BYTES];
        bytes[PATH_VERSION_OFFSET] = RESOURCE_ENCODING_VERSION;
        bytes[PATH_VARIANT_OFFSET] = PATH_RESOURCE_VARIANT;
        bytes[PATH_FILL_RULE_OFFSET] = match self.fill_rule {
            FillRule::NonZero => 0,
            FillRule::EvenOdd => 1,
        };
        let verb_count = u32::try_from(self.verbs.len()).unwrap_or(0);
        let point_count = u32::try_from(self.points.len()).unwrap_or(0);
        bytes[PATH_VERB_COUNT_OFFSET..PATH_VERB_COUNT_OFFSET + 4]
            .copy_from_slice(&verb_count.to_le_bytes());
        bytes[PATH_POINT_COUNT_OFFSET..PATH_POINT_COUNT_OFFSET + 4]
            .copy_from_slice(&point_count.to_le_bytes());
        for (index, offset) in [
            PATH_VIEW_BOX_X_OFFSET,
            PATH_VIEW_BOX_Y_OFFSET,
            PATH_VIEW_BOX_WIDTH_OFFSET,
            PATH_VIEW_BOX_HEIGHT_OFFSET,
        ]
        .into_iter()
        .enumerate()
        {
            let value = self.view_box[index];
            if !value.is_finite() {
                return Err(invalid(resource_id, "path view box is not finite"));
            }
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        for verb in &self.verbs {
            bytes.push(*verb as u8);
        }
        // Points start four-byte aligned so a decoder can read them without a
        // copy; the verb array is bytes and rarely lands on a boundary.
        while !bytes.len().is_multiple_of(4) {
            bytes.push(0);
        }
        for value in &self.points {
            if !value.is_finite() {
                return Err(invalid(resource_id, "path coordinate is not finite"));
            }
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        Ok(bytes)
    }

    /// Decodes a validated outline.
    ///
    /// # Errors
    /// Returns [`PaintError::InvalidResource`] for a truncated, misaligned or
    /// self-inconsistent path.
    pub fn decode(resource_id: u32, bytes: &[u8]) -> Result<Self, PaintError> {
        if bytes.len() < PATH_RESOURCE_MINIMUM_BYTES {
            return Err(invalid(resource_id, "path resource is truncated"));
        }
        if bytes[PATH_VERSION_OFFSET] != RESOURCE_ENCODING_VERSION
            || bytes[PATH_VARIANT_OFFSET] != PATH_RESOURCE_VARIANT
        {
            return Err(invalid(resource_id, "path resource version"));
        }
        if bytes[PATH_RESERVED_OFFSET] != 0 {
            return Err(invalid(resource_id, "path reserved byte is not zero"));
        }
        let fill_rule = match bytes[PATH_FILL_RULE_OFFSET] {
            0 => FillRule::NonZero,
            1 => FillRule::EvenOdd,
            _ => return Err(invalid(resource_id, "path fill rule is unknown")),
        };
        let read_u32 = |offset: usize| -> u32 {
            u32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ])
        };
        let verb_count = read_u32(PATH_VERB_COUNT_OFFSET) as usize;
        let point_count = read_u32(PATH_POINT_COUNT_OFFSET) as usize;
        let verbs_end = PATH_RESOURCE_MINIMUM_BYTES
            .checked_add(verb_count)
            .ok_or(invalid(resource_id, "path verb count overflows"))?;
        let points_start = verbs_end
            .checked_add((4 - verbs_end % 4) % 4)
            .ok_or(invalid(resource_id, "path padding overflows"))?;
        let points_end = point_count
            .checked_mul(4)
            .and_then(|size| points_start.checked_add(size))
            .ok_or(invalid(resource_id, "path point count overflows"))?;
        if bytes.len() != points_end {
            return Err(invalid(
                resource_id,
                "path length does not match its counts",
            ));
        }
        if bytes[verbs_end..points_start].iter().any(|byte| *byte != 0) {
            return Err(invalid(resource_id, "path padding is not zero"));
        }
        let mut verbs = Vec::with_capacity(verb_count);
        let mut expected = 0_usize;
        for raw in &bytes[PATH_RESOURCE_MINIMUM_BYTES..verbs_end] {
            let verb =
                PathVerb::from_u8(*raw).ok_or(invalid(resource_id, "path verb is unknown"))?;
            // A path that does not open with a move has no current point, and
            // every consumer would have to invent one.
            if verbs.is_empty() && verb != PathVerb::Move {
                return Err(invalid(resource_id, "path must begin with a move"));
            }
            expected += verb.point_count();
            verbs.push(verb);
        }
        if expected * 2 != point_count {
            return Err(invalid(resource_id, "path verbs and points disagree"));
        }
        let mut points = Vec::with_capacity(point_count);
        for offset in (points_start..points_end).step_by(4) {
            let value = f32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ]);
            if !value.is_finite() {
                return Err(invalid(resource_id, "path coordinate is not finite"));
            }
            points.push(value);
        }
        let mut view_box = [0.0_f32; 4];
        for (index, offset) in [
            PATH_VIEW_BOX_X_OFFSET,
            PATH_VIEW_BOX_Y_OFFSET,
            PATH_VIEW_BOX_WIDTH_OFFSET,
            PATH_VIEW_BOX_HEIGHT_OFFSET,
        ]
        .into_iter()
        .enumerate()
        {
            let value = f32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ]);
            if !value.is_finite() {
                return Err(invalid(resource_id, "path view box is not finite"));
            }
            view_box[index] = value;
        }
        if view_box[2] <= 0.0 || view_box[3] <= 0.0 {
            return Err(invalid(resource_id, "path view box must be positive"));
        }
        Ok(Self {
            verbs,
            points,
            fill_rule,
            view_box,
        })
    }
}
