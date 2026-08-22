use std::sync::Arc;

use crate::{
    AbiError, STYLE_ALL_FEATURE_BITS, STYLE_COMPUTED_ENCODING_VARIANT,
    STYLE_COMPUTED_ENCODING_VERSION, STYLE_COMPUTED_MAX_BYTES, STYLE_COMPUTED_MAX_ENTRIES,
    STYLE_INTERACTION_STATE_MASK, STYLE_LENGTH_AUTO, STYLE_LENGTH_NONE, STYLE_LENGTH_NORMAL,
    STYLE_LENGTH_NUMBER, STYLE_LENGTH_PERCENT, STYLE_LENGTH_PX, STYLE_TRANSFORM_MATRIX,
    STYLE_TRANSFORM_ROTATE, STYLE_TRANSFORM_SCALE, STYLE_TRANSFORM_TRANSLATE, STYLE_VALUE_F32,
    STYLE_VALUE_FONT_FAMILY_LIST, STYLE_VALUE_KEYWORD, STYLE_VALUE_LENGTH, STYLE_VALUE_LINE_HEIGHT,
    STYLE_VALUE_POSITION, STYLE_VALUE_RGBA8, STYLE_VALUE_SHADOW_LIST, STYLE_VALUE_TRANSFORM_LIST,
    STYLE_VALUE_U16, StyleCanonicalValue, StyleKeyword, StyleProperty, StyleValueGrammar,
};

const HEADER_BYTES: usize = 16;
const ENTRY_HEADER_BYTES: usize = 8;
const TRANSFORM_RECORD_BYTES: usize = 28;

/// Canonical unit carried by a computed length.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StyleLengthUnit {
    /// Logical pixels.
    Px,
    /// Percentage of the schema-defined reference box.
    Percent,
    /// Property-specific automatic sizing.
    Auto,
    /// Unbounded maximum.
    None,
    /// Property-specific normal value.
    Normal,
    /// Unitless line-height multiplier.
    Number,
}

/// One finite canonical length.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StyleLength {
    /// Unit or special value.
    pub unit: StyleLengthUnit,
    /// Finite numeric component; zero for keyword-like units.
    pub value: f32,
}

/// One typed transform operation; unused values remain zero.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum StyleTransformOperation {
    /// Canvas-compatible affine matrix.
    Matrix([f32; 6]),
    /// Two-axis translation with independent units.
    Translate(StyleLength, StyleLength),
    /// Two-axis scale.
    Scale([f32; 2]),
    /// Clockwise radians.
    Rotate(f32),
}

/// A decoded canonical style value.
#[derive(Clone, Debug, PartialEq)]
pub enum ComputedStyleValue {
    /// Generated stable keyword identifier.
    Keyword(StyleKeyword),
    /// Length or special sizing value.
    Length(StyleLength),
    /// Packed `0xRRGGBBAA` color.
    Rgba8(u32),
    /// Finite scalar.
    F32(f32),
    /// Normalized font-family list.
    FontFamilyList(Arc<str>),
    /// Unsigned 16-bit scalar.
    U16(u16),
    /// Typed line height.
    LineHeight(StyleLength),
    /// Ordered transform operations.
    TransformList(Arc<[StyleTransformOperation]>),
    /// Horizontal and vertical position.
    Position([StyleLength; 2]),
    /// Ordered drop shadows, outermost declaration first.
    ShadowList(Arc<[StyleShadow]>),
}

/// One outer drop shadow in border-box pixels.
///
/// `spread` stays separate from the offsets because Core folds it into the
/// painted rectangle: a backend has no CSS spread of its own.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StyleShadow {
    /// Horizontal offset.
    pub offset_x: f32,
    /// Vertical offset.
    pub offset_y: f32,
    /// Blur radius, never negative.
    pub blur: f32,
    /// Positive grows the shadow rectangle, negative shrinks it.
    pub spread: f32,
    /// Packed `0xRRGGBBAA` color.
    pub rgba: u32,
}

/// One sorted state/property value in a computed-style resource.
#[derive(Clone, Debug, PartialEq)]
pub struct ComputedStyleEntry {
    /// Stable generated property identifier.
    pub property: StyleProperty,
    /// Exact interaction-state mask; zero is the durable base value.
    pub state_mask: u8,
    /// Typed canonical value.
    pub value: ComputedStyleValue,
}

/// Transactionally decoded computed-style resource.
#[derive(Clone, Debug, PartialEq)]
pub struct ComputedStyleResource {
    feature_bits: u32,
    entries: Arc<[ComputedStyleEntry]>,
}

impl ComputedStyleResource {
    /// Validates and decodes one complete resource without partial output.
    pub fn decode(bytes: &[u8]) -> Result<Self, AbiError> {
        if bytes.len() > STYLE_COMPUTED_MAX_BYTES {
            return Err(AbiError::TooLarge {
                actual: bytes.len(),
                maximum: STYLE_COMPUTED_MAX_BYTES,
            });
        }
        if bytes.len() < HEADER_BYTES {
            return Err(AbiError::Truncated {
                offset: 0,
                needed: HEADER_BYTES,
                available: bytes.len(),
            });
        }
        if !bytes.len().is_multiple_of(4) {
            return Err(AbiError::Misaligned {
                offset: bytes.len(),
            });
        }
        if bytes[0] != STYLE_COMPUTED_ENCODING_VERSION
            || bytes[1] != STYLE_COMPUTED_ENCODING_VARIANT
        {
            return Err(AbiError::InvalidValue(
                "unsupported computed-style resource version or variant",
            ));
        }
        if bytes[2..4].iter().any(|byte| *byte != 0) {
            return Err(AbiError::NonZeroReserved { offset: 2 });
        }
        let feature_bits = read_u32(bytes, 4)?;
        if feature_bits & !STYLE_ALL_FEATURE_BITS != 0 {
            return Err(AbiError::InvalidValue(
                "computed style requires unsupported feature bits",
            ));
        }
        let entry_count =
            usize::try_from(read_u32(bytes, 8)?).map_err(|_| AbiError::ArithmeticOverflow)?;
        if entry_count > STYLE_COMPUTED_MAX_ENTRIES {
            return Err(AbiError::InstructionCountTooLarge {
                declared: u32::try_from(entry_count).unwrap_or(u32::MAX),
                maximum: u32::try_from(STYLE_COMPUTED_MAX_ENTRIES).unwrap_or(u32::MAX),
            });
        }
        let payload_bytes =
            usize::try_from(read_u32(bytes, 12)?).map_err(|_| AbiError::ArithmeticOverflow)?;
        if HEADER_BYTES.checked_add(payload_bytes) != Some(bytes.len()) {
            return Err(AbiError::LengthMismatch {
                declared: HEADER_BYTES.saturating_add(payload_bytes),
                actual: bytes.len(),
            });
        }
        if entry_count > payload_bytes / ENTRY_HEADER_BYTES {
            return Err(AbiError::InstructionCountTooLarge {
                declared: u32::try_from(entry_count).unwrap_or(u32::MAX),
                maximum: u32::try_from(payload_bytes / ENTRY_HEADER_BYTES).unwrap_or(u32::MAX),
            });
        }

        let mut entries = Vec::with_capacity(entry_count);
        let mut offset = HEADER_BYTES;
        let mut previous_key = None;
        for _ in 0..entry_count {
            let header_end = offset
                .checked_add(ENTRY_HEADER_BYTES)
                .ok_or(AbiError::ArithmeticOverflow)?;
            if header_end > bytes.len() {
                return Err(AbiError::Truncated {
                    offset,
                    needed: ENTRY_HEADER_BYTES,
                    available: bytes.len().saturating_sub(offset),
                });
            }
            let property_id = read_u16(bytes, offset)?;
            let property =
                StyleProperty::from_u16(property_id).ok_or(AbiError::UnknownIdentifier {
                    category: "style property",
                    value: u32::from(property_id),
                })?;
            let state_mask = bytes[offset + 2];
            if state_mask & !STYLE_INTERACTION_STATE_MASK != 0 {
                return Err(AbiError::InvalidValue(
                    "computed style contains unsupported interaction-state bits",
                ));
            }
            let tag = bytes[offset + 3];
            let value_bytes = usize::from(read_u16(bytes, offset + 4)?);
            if read_u16(bytes, offset + 6)? != 0 {
                return Err(AbiError::NonZeroReserved { offset: offset + 6 });
            }
            let key = (state_mask, property_id);
            if previous_key.is_some_and(|previous| previous >= key) {
                return Err(AbiError::InvalidValue(
                    "computed style entries are duplicated or not sorted",
                ));
            }
            previous_key = Some(key);
            let value_start = header_end;
            let value_end = value_start
                .checked_add(value_bytes)
                .ok_or(AbiError::ArithmeticOverflow)?;
            let aligned_end = align4(value_end).ok_or(AbiError::ArithmeticOverflow)?;
            if aligned_end > bytes.len() {
                return Err(AbiError::Truncated {
                    offset: value_start,
                    needed: value_bytes,
                    available: bytes.len().saturating_sub(value_start),
                });
            }
            if bytes[value_end..aligned_end].iter().any(|byte| *byte != 0) {
                return Err(AbiError::NonZeroReserved { offset: value_end });
            }
            // The header declares which schema features this resource needs. A
            // property whose feature is not declared cannot be interpreted, so
            // it is rejected here rather than silently ignored.
            if property.feature_bits() & feature_bits != property.feature_bits() {
                return Err(AbiError::InvalidValue(
                    "computed style entry uses a feature the resource does not declare",
                ));
            }
            let value = decode_value(property, tag, &bytes[value_start..value_end])?;
            if state_mask != 0 && !crate::STYLE_STATE_PROPERTY_IDS.contains(&(property as u16)) {
                return Err(AbiError::InvalidValue(
                    "computed style state entry targets a non-state property",
                ));
            }
            entries.push(ComputedStyleEntry {
                property,
                state_mask,
                value,
            });
            offset = aligned_end;
        }
        if offset != bytes.len() {
            return Err(AbiError::LengthMismatch {
                declared: offset,
                actual: bytes.len(),
            });
        }
        Ok(Self {
            feature_bits,
            entries: Arc::from(entries),
        })
    }

    /// Whether the resource declares a value for one property, in any state.
    ///
    /// Answered once when a resource is defined so consumers do not have to ask
    /// per node per frame: a property no resource declares cannot be in use
    /// anywhere, which is what lets the rare ones stay off the frame path.
    #[must_use]
    pub fn declares(&self, property: StyleProperty) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.property as u16 == property as u16)
    }

    /// Declared schema feature bits.
    #[must_use]
    pub const fn feature_bits(&self) -> u32 {
        self.feature_bits
    }

    /// Sorted immutable entries.
    #[must_use]
    pub fn entries(&self) -> &[ComputedStyleEntry] {
        &self.entries
    }

    /// Selects an exact state override, falling back to the durable base value.
    #[must_use]
    pub fn value(&self, property: StyleProperty, state_mask: u8) -> Option<&ComputedStyleValue> {
        let exact = self
            .entries
            .binary_search_by_key(&(state_mask, property as u16), |entry| {
                (entry.state_mask, entry.property as u16)
            })
            .ok()
            .and_then(|index| self.entries.get(index));
        exact
            .or_else(|| {
                self.entries
                    .binary_search_by_key(&(0, property as u16), |entry| {
                        (entry.state_mask, entry.property as u16)
                    })
                    .ok()
                    .and_then(|index| self.entries.get(index))
            })
            .map(|entry| &entry.value)
    }
}

fn decode_value(
    property: StyleProperty,
    tag: u8,
    payload: &[u8],
) -> Result<ComputedStyleValue, AbiError> {
    let expected = property.canonical_value();
    match tag {
        STYLE_VALUE_KEYWORD if expected == StyleCanonicalValue::Keyword => {
            require_len(payload, 4)?;
            if read_u16(payload, 2)? != 0 {
                return Err(AbiError::NonZeroReserved { offset: 2 });
            }
            let raw = read_u16(payload, 0)?;
            let keyword = StyleKeyword::from_u16(raw).ok_or(AbiError::UnknownIdentifier {
                category: "style keyword",
                value: u32::from(raw),
            })?;
            if !property.accepts_keyword(keyword) {
                return Err(AbiError::InvalidValue(
                    "style keyword does not belong to the property grammar",
                ));
            }
            Ok(ComputedStyleValue::Keyword(keyword))
        }
        STYLE_VALUE_LENGTH if expected == StyleCanonicalValue::Length => Ok(
            ComputedStyleValue::Length(decode_length(property, payload, false)?),
        ),
        STYLE_VALUE_RGBA8 if expected == StyleCanonicalValue::Rgba8 => {
            require_len(payload, 4)?;
            Ok(ComputedStyleValue::Rgba8(read_u32(payload, 0)?))
        }
        STYLE_VALUE_F32 if expected == StyleCanonicalValue::F32 => {
            require_len(payload, 4)?;
            let value = read_f32(payload, 0)?;
            if property == StyleProperty::Opacity && !(0.0..=1.0).contains(&value) {
                return Err(AbiError::InvalidValue(
                    "opacity is outside zero through one",
                ));
            }
            Ok(ComputedStyleValue::F32(value))
        }
        STYLE_VALUE_FONT_FAMILY_LIST if expected == StyleCanonicalValue::FontFamilyList => {
            let value = decode_string(payload)?;
            if value.is_empty() {
                return Err(AbiError::InvalidValue("font-family list must not be empty"));
            }
            Ok(ComputedStyleValue::FontFamilyList(Arc::from(value)))
        }
        STYLE_VALUE_U16 if expected == StyleCanonicalValue::U16 => {
            require_len(payload, 4)?;
            if read_u16(payload, 2)? != 0 {
                return Err(AbiError::NonZeroReserved { offset: 2 });
            }
            Ok(ComputedStyleValue::U16(read_u16(payload, 0)?))
        }
        STYLE_VALUE_LINE_HEIGHT if expected == StyleCanonicalValue::LineHeight => Ok(
            ComputedStyleValue::LineHeight(decode_length(property, payload, true)?),
        ),
        STYLE_VALUE_POSITION if expected == StyleCanonicalValue::Position => {
            require_len(payload, 16)?;
            Ok(ComputedStyleValue::Position([
                decode_length(property, &payload[..8], false)?,
                decode_length(property, &payload[8..], false)?,
            ]))
        }
        STYLE_VALUE_TRANSFORM_LIST if expected == StyleCanonicalValue::TransformList => Ok(
            ComputedStyleValue::TransformList(decode_transform_list(payload)?),
        ),
        STYLE_VALUE_SHADOW_LIST if expected == StyleCanonicalValue::ShadowList => {
            Ok(ComputedStyleValue::ShadowList(decode_shadow_list(payload)?))
        }
        _ => Err(AbiError::WrongPropertyEncoding {
            prop: property as u16,
            expected: canonical_name(expected),
            actual: "computed-style value tag",
        }),
    }
}

fn decode_length(
    property: StyleProperty,
    payload: &[u8],
    line_height: bool,
) -> Result<StyleLength, AbiError> {
    require_len(payload, 8)?;
    if payload[1..4].iter().any(|byte| *byte != 0) {
        return Err(AbiError::NonZeroReserved { offset: 1 });
    }
    let unit = match payload[0] {
        STYLE_LENGTH_PX => StyleLengthUnit::Px,
        STYLE_LENGTH_PERCENT => StyleLengthUnit::Percent,
        STYLE_LENGTH_AUTO
            if !line_height
                && matches!(
                    property.grammar(),
                    StyleValueGrammar::LengthAuto | StyleValueGrammar::ZIndex
                ) =>
        {
            StyleLengthUnit::Auto
        }
        STYLE_LENGTH_NONE
            if !line_height && property.grammar() == StyleValueGrammar::LengthNone =>
        {
            StyleLengthUnit::None
        }
        STYLE_LENGTH_NORMAL if line_height => StyleLengthUnit::Normal,
        STYLE_LENGTH_NORMAL
            if !line_height && property.grammar() == StyleValueGrammar::NonNegativeLengthNormal =>
        {
            StyleLengthUnit::Normal
        }
        STYLE_LENGTH_NUMBER if line_height => StyleLengthUnit::Number,
        // A unitless canonical length, which is how `z-index` travels.
        STYLE_LENGTH_NUMBER if property.grammar() == StyleValueGrammar::ZIndex => {
            StyleLengthUnit::Number
        }
        _ => {
            return Err(AbiError::InvalidValue(
                "invalid unit for computed style property",
            ));
        }
    };
    let value = read_f32(payload, 4)?;
    if matches!(
        unit,
        StyleLengthUnit::Auto | StyleLengthUnit::None | StyleLengthUnit::Normal
    ) && value != 0.0
    {
        return Err(AbiError::InvalidValue(
            "keyword-like computed length must carry zero",
        ));
    }
    if matches!(
        property.grammar(),
        StyleValueGrammar::NonNegativeLength
            | StyleValueGrammar::NonNegativeLengthNormal
            | StyleValueGrammar::PositiveLength
    ) && value < 0.0
    {
        return Err(AbiError::InvalidValue(
            "computed length violates a non-negative grammar",
        ));
    }
    if property.grammar() == StyleValueGrammar::PositiveLength && value <= 0.0 {
        return Err(AbiError::InvalidValue(
            "computed length violates a positive grammar",
        ));
    }
    Ok(StyleLength { unit, value })
}

/// Every shadow one node may declare.
///
/// The cap is what gives the decoder a place to refuse: without it the layer
/// count alone decides how much this allocates.
const MAXIMUM_SHADOWS: usize = 4;
const SHADOW_RECORD_BYTES: usize = 20;

fn decode_shadow_list(payload: &[u8]) -> Result<Arc<[StyleShadow]>, AbiError> {
    if payload.len() < 4 {
        return Err(AbiError::Truncated {
            offset: 0,
            needed: 4,
            available: payload.len(),
        });
    }
    let count = usize::try_from(read_u32(payload, 0)?).map_err(|_| AbiError::ArithmeticOverflow)?;
    if count > MAXIMUM_SHADOWS {
        return Err(AbiError::InvalidValue(
            "box-shadow declares too many layers",
        ));
    }
    let expected = count
        .checked_mul(SHADOW_RECORD_BYTES)
        .and_then(|bytes| bytes.checked_add(4))
        .ok_or(AbiError::ArithmeticOverflow)?;
    require_len(payload, expected)?;
    let mut shadows = Vec::with_capacity(count);
    for index in 0..count {
        let offset = 4 + index * SHADOW_RECORD_BYTES;
        let offset_x = read_f32(payload, offset)?;
        let offset_y = read_f32(payload, offset + 4)?;
        let blur = read_f32(payload, offset + 8)?;
        let spread = read_f32(payload, offset + 12)?;
        if [offset_x, offset_y, blur, spread]
            .iter()
            .any(|value| !value.is_finite() || value.abs() > 1_000_000.0)
        {
            return Err(AbiError::InvalidValue("box-shadow length is out of range"));
        }
        if blur < 0.0 {
            return Err(AbiError::InvalidValue("box-shadow blur is negative"));
        }
        shadows.push(StyleShadow {
            offset_x,
            offset_y,
            blur,
            spread,
            rgba: read_u32(payload, offset + 16)?,
        });
    }
    Ok(Arc::from(shadows))
}

fn decode_transform_list(payload: &[u8]) -> Result<Arc<[StyleTransformOperation]>, AbiError> {
    if payload.len() < 4 {
        return Err(AbiError::Truncated {
            offset: 0,
            needed: 4,
            available: payload.len(),
        });
    }
    let count = usize::try_from(read_u32(payload, 0)?).map_err(|_| AbiError::ArithmeticOverflow)?;
    let expected = count
        .checked_mul(TRANSFORM_RECORD_BYTES)
        .and_then(|bytes| bytes.checked_add(4))
        .ok_or(AbiError::ArithmeticOverflow)?;
    require_len(payload, expected)?;
    let mut operations = Vec::with_capacity(count);
    for index in 0..count {
        let offset = 4 + index * TRANSFORM_RECORD_BYTES;
        if payload[offset + 3] != 0 {
            return Err(AbiError::NonZeroReserved { offset: offset + 3 });
        }
        let mut values = [0.0; 6];
        for (value_index, value) in values.iter_mut().enumerate() {
            *value = read_f32(payload, offset + 4 + value_index * 4)?;
        }
        let operation = match payload[offset] {
            STYLE_TRANSFORM_MATRIX => {
                require_zero_units(payload[offset + 1], payload[offset + 2])?;
                StyleTransformOperation::Matrix(values)
            }
            STYLE_TRANSFORM_TRANSLATE => StyleTransformOperation::Translate(
                transform_length(payload[offset + 1], values[0])?,
                transform_length(payload[offset + 2], values[1])?,
            ),
            STYLE_TRANSFORM_SCALE => {
                require_zero_units(payload[offset + 1], payload[offset + 2])?;
                if values[2..].iter().any(|value| *value != 0.0) {
                    return Err(AbiError::InvalidValue("scale has non-zero unused values"));
                }
                StyleTransformOperation::Scale([values[0], values[1]])
            }
            STYLE_TRANSFORM_ROTATE => {
                require_zero_units(payload[offset + 1], payload[offset + 2])?;
                if values[1..].iter().any(|value| *value != 0.0) {
                    return Err(AbiError::InvalidValue("rotate has non-zero unused values"));
                }
                StyleTransformOperation::Rotate(values[0])
            }
            _ => return Err(AbiError::InvalidValue("unknown transform operation")),
        };
        operations.push(operation);
    }
    Ok(Arc::from(operations))
}

fn transform_length(unit: u8, value: f32) -> Result<StyleLength, AbiError> {
    let unit = match unit {
        STYLE_LENGTH_PX => StyleLengthUnit::Px,
        STYLE_LENGTH_PERCENT => StyleLengthUnit::Percent,
        _ => return Err(AbiError::InvalidValue("translation uses an invalid unit")),
    };
    Ok(StyleLength { unit, value })
}

fn require_zero_units(x: u8, y: u8) -> Result<(), AbiError> {
    if x == 0 && y == 0 {
        Ok(())
    } else {
        Err(AbiError::InvalidValue(
            "non-translation transform carries length units",
        ))
    }
}

fn decode_string(payload: &[u8]) -> Result<&str, AbiError> {
    if payload.len() < 4 {
        return Err(AbiError::Truncated {
            offset: 0,
            needed: 4,
            available: payload.len(),
        });
    }
    let length =
        usize::try_from(read_u32(payload, 0)?).map_err(|_| AbiError::ArithmeticOverflow)?;
    if 4_usize.checked_add(length) != Some(payload.len()) {
        return Err(AbiError::LengthMismatch {
            declared: 4_usize.saturating_add(length),
            actual: payload.len(),
        });
    }
    std::str::from_utf8(&payload[4..])
        .map_err(|_| AbiError::InvalidValue("invalid UTF-8 style value"))
}

const fn canonical_name(value: StyleCanonicalValue) -> &'static str {
    match value {
        StyleCanonicalValue::Keyword => "keyword",
        StyleCanonicalValue::Length => "length",
        StyleCanonicalValue::Rgba8 => "rgba8",
        StyleCanonicalValue::F32 => "f32",
        StyleCanonicalValue::FontFamilyList => "font-family-list",
        StyleCanonicalValue::U16 => "u16",
        StyleCanonicalValue::LineHeight => "line-height",
        StyleCanonicalValue::TransformList => "transform-list",
        StyleCanonicalValue::ShadowList => "shadow-list",
        StyleCanonicalValue::Position => "position",
    }
}

fn require_len(bytes: &[u8], expected: usize) -> Result<(), AbiError> {
    if bytes.len() == expected {
        Ok(())
    } else {
        Err(AbiError::LengthMismatch {
            declared: expected,
            actual: bytes.len(),
        })
    }
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, AbiError> {
    let end = offset.checked_add(2).ok_or(AbiError::ArithmeticOverflow)?;
    let value = bytes.get(offset..end).ok_or(AbiError::Truncated {
        offset,
        needed: 2,
        available: bytes.len().saturating_sub(offset),
    })?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, AbiError> {
    let end = offset.checked_add(4).ok_or(AbiError::ArithmeticOverflow)?;
    let value = bytes.get(offset..end).ok_or(AbiError::Truncated {
        offset,
        needed: 4,
        available: bytes.len().saturating_sub(offset),
    })?;
    Ok(u32::from_le_bytes(value.try_into().map_err(|_| {
        AbiError::Truncated {
            offset,
            needed: 4,
            available: value.len(),
        }
    })?))
}

fn read_f32(bytes: &[u8], offset: usize) -> Result<f32, AbiError> {
    let value = f32::from_bits(read_u32(bytes, offset)?);
    if value.is_finite() {
        Ok(value)
    } else {
        Err(AbiError::NonFiniteFloat { offset })
    }
}

fn align4(value: usize) -> Option<usize> {
    value.checked_add(3).map(|value| value & !3)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(property: StyleProperty, state: u8, tag: u8, payload: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(property as u16).to_le_bytes());
        bytes.push(state);
        bytes.push(tag);
        bytes.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(payload);
        while bytes.len() % 4 != 0 {
            bytes.push(0);
        }
        bytes
    }

    fn resource(entries: &[Vec<u8>]) -> Vec<u8> {
        let payload = entries.concat();
        let mut bytes = vec![0; HEADER_BYTES];
        bytes[0] = STYLE_COMPUTED_ENCODING_VERSION;
        bytes[1] = STYLE_COMPUTED_ENCODING_VARIANT;
        bytes[4..8].copy_from_slice(&STYLE_ALL_FEATURE_BITS.to_le_bytes());
        bytes[8..12].copy_from_slice(&(entries.len() as u32).to_le_bytes());
        bytes[12..16].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&payload);
        bytes
    }

    fn length(unit: u8, value: f32) -> [u8; 8] {
        let mut bytes = [0; 8];
        bytes[0] = unit;
        bytes[4..].copy_from_slice(&value.to_le_bytes());
        bytes
    }

    fn transform_record(opcode: u8, x_unit: u8, y_unit: u8, values: [f32; 6]) -> Vec<u8> {
        let mut bytes = vec![opcode, x_unit, y_unit, 0];
        for value in values {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    fn transform_list(records: &[Vec<u8>]) -> Vec<u8> {
        let mut bytes = (records.len() as u32).to_le_bytes().to_vec();
        bytes.extend(records.concat());
        bytes
    }

    #[test]
    fn decodes_base_and_exact_state_values() {
        let base = entry(
            StyleProperty::Display,
            0,
            STYLE_VALUE_KEYWORD,
            &[StyleKeyword::Flex as u8, 0, 0, 0],
        );
        let opacity = entry(
            StyleProperty::Opacity,
            crate::STYLE_INTERACTION_HOVER,
            STYLE_VALUE_F32,
            &0.5_f32.to_le_bytes(),
        );
        let decoded = ComputedStyleResource::decode(&resource(&[base, opacity])).expect("style");
        assert_eq!(
            decoded.value(StyleProperty::Display, crate::STYLE_INTERACTION_HOVER),
            Some(&ComputedStyleValue::Keyword(StyleKeyword::Flex))
        );
        assert_eq!(
            decoded.value(StyleProperty::Opacity, crate::STYLE_INTERACTION_HOVER),
            Some(&ComputedStyleValue::F32(0.5))
        );
        assert_eq!(decoded.feature_bits(), STYLE_ALL_FEATURE_BITS);
    }

    #[test]
    fn decodes_every_canonical_value_and_transform_operation() {
        let mut family = 11_u32.to_le_bytes().to_vec();
        family.extend_from_slice(b"Inter,serif");
        let transforms = transform_list(&[
            transform_record(STYLE_TRANSFORM_MATRIX, 0, 0, [1.0, 0.0, 0.0, 1.0, 4.0, 5.0]),
            transform_record(
                STYLE_TRANSFORM_TRANSLATE,
                STYLE_LENGTH_PX,
                STYLE_LENGTH_PERCENT,
                [6.0, 50.0, 0.0, 0.0, 0.0, 0.0],
            ),
            transform_record(STYLE_TRANSFORM_SCALE, 0, 0, [2.0, 3.0, 0.0, 0.0, 0.0, 0.0]),
            transform_record(STYLE_TRANSFORM_ROTATE, 0, 0, [0.5, 0.0, 0.0, 0.0, 0.0, 0.0]),
        ]);
        let mut position = length(STYLE_LENGTH_PERCENT, 25.0).to_vec();
        position.extend_from_slice(&length(STYLE_LENGTH_PX, 8.0));
        let entries = vec![
            entry(
                StyleProperty::Display,
                0,
                STYLE_VALUE_KEYWORD,
                &[StyleKeyword::Flex as u8, 0, 0, 0],
            ),
            entry(
                StyleProperty::Width,
                0,
                STYLE_VALUE_LENGTH,
                &length(STYLE_LENGTH_AUTO, 0.0),
            ),
            entry(
                StyleProperty::Height,
                0,
                STYLE_VALUE_LENGTH,
                &length(STYLE_LENGTH_PERCENT, 75.0),
            ),
            entry(
                StyleProperty::MaxWidth,
                0,
                STYLE_VALUE_LENGTH,
                &length(STYLE_LENGTH_NONE, 0.0),
            ),
            entry(
                StyleProperty::PaddingTop,
                0,
                STYLE_VALUE_LENGTH,
                &length(STYLE_LENGTH_PX, 4.0),
            ),
            entry(
                StyleProperty::RowGap,
                0,
                STYLE_VALUE_LENGTH,
                &length(STYLE_LENGTH_NORMAL, 0.0),
            ),
            entry(
                StyleProperty::BackgroundColor,
                0,
                STYLE_VALUE_RGBA8,
                &0x11_22_33_44_u32.to_le_bytes(),
            ),
            entry(
                StyleProperty::Opacity,
                0,
                STYLE_VALUE_F32,
                &0.75_f32.to_le_bytes(),
            ),
            entry(
                StyleProperty::FontFamily,
                0,
                STYLE_VALUE_FONT_FAMILY_LIST,
                &family,
            ),
            entry(
                StyleProperty::FontSize,
                0,
                STYLE_VALUE_LENGTH,
                &length(STYLE_LENGTH_PX, 16.0),
            ),
            entry(
                StyleProperty::FontWeight,
                0,
                STYLE_VALUE_U16,
                &[0x90, 0x01, 0, 0],
            ),
            entry(
                StyleProperty::LineHeight,
                0,
                STYLE_VALUE_LINE_HEIGHT,
                &length(STYLE_LENGTH_NUMBER, 1.5),
            ),
            entry(
                StyleProperty::Transform,
                0,
                STYLE_VALUE_TRANSFORM_LIST,
                &transforms,
            ),
            entry(
                StyleProperty::TransformOrigin,
                0,
                STYLE_VALUE_POSITION,
                &position,
            ),
        ];
        let decoded = ComputedStyleResource::decode(&resource(&entries)).expect("complete style");
        assert_eq!(decoded.entries().len(), entries.len());
        assert_eq!(
            decoded.value(StyleProperty::Height, 0),
            Some(&ComputedStyleValue::Length(StyleLength {
                unit: StyleLengthUnit::Percent,
                value: 75.0,
            }))
        );
        let Some(ComputedStyleValue::TransformList(operations)) =
            decoded.value(StyleProperty::Transform, 0)
        else {
            panic!("transform list");
        };
        assert_eq!(operations.len(), 4);

        let normal_line_height = entry(
            StyleProperty::LineHeight,
            0,
            STYLE_VALUE_LINE_HEIGHT,
            &length(STYLE_LENGTH_NORMAL, 0.0),
        );
        assert!(ComputedStyleResource::decode(&resource(&[normal_line_height])).is_ok());
    }

    #[test]
    fn canonical_value_boundaries_fail_closed() {
        assert!(
            decode_value(
                StyleProperty::Display,
                STYLE_VALUE_KEYWORD,
                &[StyleKeyword::Flex as u8, 0, 1, 0],
            )
            .is_err()
        );
        assert!(decode_value(StyleProperty::Display, STYLE_VALUE_KEYWORD, &[0, 0, 0, 0]).is_err());
        assert!(
            decode_value(
                StyleProperty::Display,
                STYLE_VALUE_KEYWORD,
                &[StyleKeyword::Italic as u8, 0, 0, 0],
            )
            .is_err()
        );
        assert!(
            decode_value(
                StyleProperty::Opacity,
                STYLE_VALUE_F32,
                &1.1_f32.to_le_bytes(),
            )
            .is_err()
        );
        assert!(
            decode_value(
                StyleProperty::FontFamily,
                STYLE_VALUE_FONT_FAMILY_LIST,
                &0_u32.to_le_bytes(),
            )
            .is_err()
        );
        assert!(
            decode_value(
                StyleProperty::FontWeight,
                STYLE_VALUE_U16,
                &[0x90, 0x01, 1, 0],
            )
            .is_err()
        );
        assert!(
            decode_value(
                StyleProperty::Opacity,
                STYLE_VALUE_RGBA8,
                &0_u32.to_le_bytes(),
            )
            .is_err()
        );

        let mut reserved_length = length(STYLE_LENGTH_PX, 1.0);
        reserved_length[1] = 1;
        assert!(decode_length(StyleProperty::Width, &reserved_length, false).is_err());
        assert!(
            decode_length(StyleProperty::Width, &length(STYLE_LENGTH_AUTO, 1.0), false,).is_err()
        );
        assert!(
            decode_length(
                StyleProperty::PaddingTop,
                &length(STYLE_LENGTH_PX, -1.0),
                false,
            )
            .is_err()
        );
        assert!(
            decode_length(
                StyleProperty::FontSize,
                &length(STYLE_LENGTH_PX, 0.0),
                false,
            )
            .is_err()
        );
        assert!(decode_length(StyleProperty::Width, &length(0xff, 0.0), false).is_err());

        assert!(decode_transform_list(&[]).is_err());
        assert!(decode_transform_list(&[1, 0, 0, 0]).is_err());
        let bad_record = |opcode, x_unit, y_unit, values| {
            transform_list(&[transform_record(opcode, x_unit, y_unit, values)])
        };
        let mut reserved = bad_record(STYLE_TRANSFORM_MATRIX, 0, 0, [0.0; 6]);
        reserved[7] = 1;
        assert!(decode_transform_list(&reserved).is_err());
        assert!(
            decode_transform_list(&bad_record(
                STYLE_TRANSFORM_MATRIX,
                STYLE_LENGTH_PX,
                0,
                [0.0; 6],
            ))
            .is_err()
        );
        assert!(
            decode_transform_list(&bad_record(
                STYLE_TRANSFORM_TRANSLATE,
                0xff,
                STYLE_LENGTH_PX,
                [0.0; 6],
            ))
            .is_err()
        );
        assert!(
            decode_transform_list(&bad_record(
                STYLE_TRANSFORM_SCALE,
                0,
                0,
                [1.0, 1.0, 1.0, 0.0, 0.0, 0.0],
            ))
            .is_err()
        );
        assert!(
            decode_transform_list(&bad_record(
                STYLE_TRANSFORM_ROTATE,
                0,
                0,
                [1.0, 1.0, 0.0, 0.0, 0.0, 0.0],
            ))
            .is_err()
        );
        assert!(decode_transform_list(&bad_record(0xff, 0, 0, [0.0; 6])).is_err());

        assert!(decode_string(&[]).is_err());
        assert!(decode_string(&[1, 0, 0, 0]).is_err());
        assert!(decode_string(&[1, 0, 0, 0, 0xff]).is_err());
    }

    #[test]
    fn resource_envelope_bounds_fail_closed() {
        assert!(ComputedStyleResource::decode(&vec![0; STYLE_COMPUTED_MAX_BYTES + 4]).is_err());

        let mut reserved = resource(&[]);
        reserved[2] = 1;
        assert!(ComputedStyleResource::decode(&reserved).is_err());

        let mut unsupported_feature = resource(&[]);
        unsupported_feature[4..8].copy_from_slice(&(1_u32 << 31).to_le_bytes());
        assert!(ComputedStyleResource::decode(&unsupported_feature).is_err());

        let mut too_many_entries = resource(&[]);
        too_many_entries[8..12]
            .copy_from_slice(&(STYLE_COMPUTED_MAX_ENTRIES as u32 + 1).to_le_bytes());
        assert!(ComputedStyleResource::decode(&too_many_entries).is_err());

        let mut wrong_payload_length = resource(&[]);
        wrong_payload_length[12..16].copy_from_slice(&4_u32.to_le_bytes());
        assert!(ComputedStyleResource::decode(&wrong_payload_length).is_err());

        let mut impossible_entry_count = resource(&[]);
        impossible_entry_count[8..12].copy_from_slice(&1_u32.to_le_bytes());
        assert!(ComputedStyleResource::decode(&impossible_entry_count).is_err());
    }

    #[test]
    fn rejects_unsorted_duplicate_invalid_and_truncated_entries() {
        let valid = entry(
            StyleProperty::Opacity,
            0,
            STYLE_VALUE_F32,
            &1.0_f32.to_le_bytes(),
        );
        assert!(ComputedStyleResource::decode(&resource(&[valid.clone(), valid.clone()])).is_err());
        let mut bad_state = valid.clone();
        bad_state[2] = 0x80;
        assert!(ComputedStyleResource::decode(&resource(&[bad_state])).is_err());
        let mut bad_float = valid.clone();
        bad_float[8..12].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(ComputedStyleResource::decode(&resource(&[bad_float])).is_err());
        let mut truncated = resource(&[valid]);
        truncated.pop();
        assert!(ComputedStyleResource::decode(&truncated).is_err());
    }

    #[test]
    fn rejects_every_malformed_entry_shape() {
        // Each case below is a byte pattern a hostile or mismatched producer can
        // hand the decoder. None may panic, read out of bounds, or half-apply.
        let valid = entry(
            StyleProperty::Opacity,
            0,
            STYLE_VALUE_F32,
            &1.0_f32.to_le_bytes(),
        );

        // An entry header that runs past the declared payload.
        let mut header_truncated = vec![0; HEADER_BYTES];
        header_truncated[0] = STYLE_COMPUTED_ENCODING_VERSION;
        header_truncated[1] = STYLE_COMPUTED_ENCODING_VARIANT;
        header_truncated[4..8].copy_from_slice(&STYLE_ALL_FEATURE_BITS.to_le_bytes());
        header_truncated[8..12].copy_from_slice(&1_u32.to_le_bytes());
        header_truncated[12..16].copy_from_slice(&4_u32.to_le_bytes());
        header_truncated.extend_from_slice(&[0; 4]);
        assert!(ComputedStyleResource::decode(&header_truncated).is_err());

        // Reserved header halfword must be zero: a future field would otherwise
        // be silently ignored by this build.
        let mut reserved_set = valid.clone();
        reserved_set[6] = 1;
        assert!(ComputedStyleResource::decode(&resource(&[reserved_set])).is_err());

        // A value length that overruns the buffer.
        let mut value_overruns = valid.clone();
        value_overruns[4..6].copy_from_slice(&0xffff_u16.to_le_bytes());
        assert!(ComputedStyleResource::decode(&resource(&[value_overruns])).is_err());

        // Alignment padding must be zero for the same reason as the reserved field.
        let mut dirty_padding = entry(StyleProperty::FontWeight, 0, STYLE_VALUE_U16, &[100, 0]);
        *dirty_padding.last_mut().expect("padding byte") = 1;
        assert!(ComputedStyleResource::decode(&resource(&[dirty_padding])).is_err());

        // A property whose feature the resource header does not declare cannot be
        // interpreted, so it is rejected rather than dropped.
        let mut undeclared_feature = resource(&[entry(
            StyleProperty::BoxShadow,
            0,
            STYLE_VALUE_SHADOW_LIST,
            &0_u32.to_le_bytes(),
        )]);
        let without_shadow = STYLE_ALL_FEATURE_BITS & !StyleProperty::BoxShadow.feature_bits();
        undeclared_feature[4..8].copy_from_slice(&without_shadow.to_le_bytes());
        assert!(ComputedStyleResource::decode(&undeclared_feature).is_err());

        // Trailing bytes past the last declared entry.
        let mut trailing = resource(&[valid.clone(), valid]);
        trailing[8..12].copy_from_slice(&1_u32.to_le_bytes());
        assert!(ComputedStyleResource::decode(&trailing).is_err());

        // `auto` is only a length on the grammars that admit it.
        assert!(
            ComputedStyleResource::decode(&resource(&[entry(
                StyleProperty::Opacity,
                0,
                STYLE_VALUE_LENGTH,
                &length(STYLE_LENGTH_AUTO, 0.0),
            )]))
            .is_err()
        );
    }

    #[test]
    fn a_wrong_value_tag_names_the_canonical_kind_it_expected() {
        // The diagnostic has to say which encoding the property wanted, or an ABI
        // mismatch reads as "some entry is bad" with no way to find the producer.
        let cases = [
            (StyleProperty::Display, "keyword"),
            (StyleProperty::Width, "length"),
            (StyleProperty::Color, "rgba8"),
            (StyleProperty::Opacity, "f32"),
            (StyleProperty::FontFamily, "font-family-list"),
            (StyleProperty::FontWeight, "u16"),
            (StyleProperty::LineHeight, "line-height"),
            (StyleProperty::Transform, "transform-list"),
            (StyleProperty::BoxShadow, "shadow-list"),
            (StyleProperty::TransformOrigin, "position"),
        ];
        for (property, expected) in cases {
            // Tag 0xff belongs to no canonical kind, so every property mismatches.
            let decoded =
                ComputedStyleResource::decode(&resource(&[entry(property, 0, 0xff, &[])]));
            let Err(AbiError::WrongPropertyEncoding {
                prop,
                expected: named,
                ..
            }) = decoded
            else {
                panic!("expected a wrong-encoding error for {property:?}");
            };
            assert_eq!(prop, property as u16);
            assert_eq!(named, expected);
        }
    }

    #[test]
    fn rejects_malformed_shadow_lists() {
        fn shadow_resource(payload: &[u8]) -> Vec<u8> {
            resource(&[entry(
                StyleProperty::BoxShadow,
                0,
                STYLE_VALUE_SHADOW_LIST,
                payload,
            )])
        }
        fn shadow_record(offset_x: f32, offset_y: f32, blur: f32, spread: f32) -> Vec<u8> {
            let mut bytes = 1_u32.to_le_bytes().to_vec();
            for value in [offset_x, offset_y, blur, spread] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            bytes.extend_from_slice(&[0, 0, 0, 255]);
            bytes
        }

        // A count word that is not even present.
        assert!(ComputedStyleResource::decode(&shadow_resource(&[0, 0])).is_err());
        // More layers than the fixed budget: the count alone decides the allocation.
        assert!(ComputedStyleResource::decode(&shadow_resource(&5_u32.to_le_bytes())).is_err());
        // A count that does not match the records that follow.
        assert!(ComputedStyleResource::decode(&shadow_resource(&2_u32.to_le_bytes())).is_err());
        // Non-finite and absurd offsets would turn into unbounded blur work.
        for bad in [f32::NAN, f32::INFINITY, 2_000_000.0] {
            assert!(
                ComputedStyleResource::decode(&shadow_resource(&shadow_record(bad, 0.0, 0.0, 0.0)))
                    .is_err()
            );
        }
        // A negative blur has no meaning and would underflow the box-blur sizing.
        assert!(
            ComputedStyleResource::decode(&shadow_resource(&shadow_record(0.0, 0.0, -1.0, 0.0)))
                .is_err()
        );
        // The same shape, valid, still decodes — the guards are not blanket rejection.
        assert!(
            ComputedStyleResource::decode(&shadow_resource(&shadow_record(1.0, 2.0, 3.0, 4.0)))
                .is_ok()
        );
    }

    #[test]
    fn arbitrary_bytes_never_panic() {
        for length in 0..512 {
            let bytes = (0..length)
                .map(|index| (index as u8).wrapping_mul(37))
                .collect::<Vec<_>>();
            let _ = ComputedStyleResource::decode(&bytes);
        }
    }

    #[test]
    fn an_entry_whose_feature_is_not_declared_is_rejected_whole() {
        use crate::{STYLE_FEATURE_FLEX_SIZING, STYLE_FEATURE_M6_FOUNDATION};

        let entries = [
            entry(
                StyleProperty::Width,
                0,
                STYLE_VALUE_LENGTH,
                &length(STYLE_LENGTH_PX, 12.0),
            ),
            entry(
                StyleProperty::FlexGrow,
                0,
                STYLE_VALUE_F32,
                &1.0_f32.to_le_bytes(),
            ),
        ];

        let mut declared = resource(&entries);
        declared[4..8].copy_from_slice(
            &(STYLE_FEATURE_M6_FOUNDATION | STYLE_FEATURE_FLEX_SIZING).to_le_bytes(),
        );
        assert_eq!(
            ComputedStyleResource::decode(&declared)
                .expect("declared features decode")
                .entries()
                .len(),
            2
        );

        // Same bytes, but the header no longer claims the flex feature. The
        // decode fails as a whole rather than dropping the entry.
        let mut undeclared = resource(&entries);
        undeclared[4..8].copy_from_slice(&STYLE_FEATURE_M6_FOUNDATION.to_le_bytes());
        assert!(ComputedStyleResource::decode(&undeclared).is_err());

        // A resource that stays inside the base feature still decodes with only
        // the base bit declared, so an older Core keeps working.
        let mut base_only = resource(&entries[..1]);
        base_only[4..8].copy_from_slice(&STYLE_FEATURE_M6_FOUNDATION.to_le_bytes());
        assert!(ComputedStyleResource::decode(&base_only).is_ok());
    }

    #[test]
    fn subset_version_is_explicit_for_contract_reports() {
        assert_eq!(crate::CSS_SUBSET_VERSION, "1.6.0");
    }
}
