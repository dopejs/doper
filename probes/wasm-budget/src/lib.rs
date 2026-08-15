//! Disposable M0 size-envelope probe for text-heavy Core dependencies.
//!
//! This crate is intentionally separate from the product Core. Linking a real
//! shaper, rasterizer and grapheme segmenter gives a conservative measured
//! envelope for the selected M3 text foundation.

use std::{cell::RefCell, str};

use swash::{FontRef, shape::ShapeContext};
use unicode_segmentation::UnicodeSegmentation;

const INVALID_INPUT: u32 = u32::MAX;
const MAX_FONT_BYTES: usize = 4 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 1024 * 1024;

thread_local! {
    static FONT_INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static TEXT_INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn grapheme_count(text: &str) -> u32 {
    u32::try_from(text.graphemes(true).count()).unwrap_or(INVALID_INPUT)
}

fn push_bounded(
    target: &'static std::thread::LocalKey<RefCell<Vec<u8>>>,
    value: u32,
    limit: usize,
) -> u32 {
    let Ok(byte) = u8::try_from(value) else {
        return 0;
    };
    target.with_borrow_mut(|buffer| {
        if buffer.len() >= limit {
            return 0;
        }
        buffer.push(byte);
        1
    })
}

/// Clears the bounded font and text input buffers.
// SAFETY: This crate owns this globally unique probe export name.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn doper_budget_reset_inputs() {
    FONT_INPUT.with_borrow_mut(Vec::clear);
    TEXT_INPUT.with_borrow_mut(Vec::clear);
}

/// Appends one byte to the font buffer, returning one on success and zero for
/// a value outside `u8` or when the 4 MiB limit has been reached.
// SAFETY: This crate owns this globally unique probe export name.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn doper_budget_push_font_byte(value: u32) -> u32 {
    push_bounded(&FONT_INPUT, value, MAX_FONT_BYTES)
}

/// Appends one byte to the text buffer, returning one on success and zero for
/// a value outside `u8` or when the 1 MiB limit has been reached.
// SAFETY: This crate owns this globally unique probe export name.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn doper_budget_push_text_byte(value: u32) -> u32 {
    push_bounded(&TEXT_INPUT, value, MAX_TEXT_BYTES)
}

/// Counts extended grapheme clusters in the buffered UTF-8 text.
///
/// Returns `u32::MAX` for malformed UTF-8. All memory access remains inside
/// bounded Rust-owned buffers, so arbitrary scalar inputs cannot forge a
/// pointer into WASM linear memory.
// SAFETY: This crate owns this globally unique probe export name.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn doper_budget_grapheme_count() -> u32 {
    TEXT_INPUT
        .with_borrow(|bytes| str::from_utf8(bytes.as_slice()).map_or(INVALID_INPUT, grapheme_count))
}

/// Shapes buffered UTF-8 text with the buffered OpenType font and returns the
/// glyph count, or `u32::MAX` when either input is invalid.
///
/// The exported path deliberately retains representative shaping code in the
/// optimized WASM binary so its gzip size can be measured.
// SAFETY: This crate owns this globally unique probe export name.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn doper_budget_shape_count() -> u32 {
    FONT_INPUT.with_borrow(|font| {
        TEXT_INPUT.with_borrow(|text_bytes| {
            let Ok(text) = str::from_utf8(text_bytes.as_slice()) else {
                return INVALID_INPUT;
            };
            let Some(face) = FontRef::from_index(font.as_slice(), 0) else {
                return INVALID_INPUT;
            };
            let mut context = ShapeContext::new();
            let mut shaper = context.builder(face).size(16.0).build();
            shaper.add_str(text);
            let mut glyphs = 0_u32;
            shaper.shape_with(|cluster| {
                glyphs =
                    glyphs.saturating_add(u32::try_from(cluster.glyphs.len()).unwrap_or(u32::MAX));
            });
            glyphs
        })
    })
}

/// Rasterizes one buffered font glyph and returns its pixel byte count.
///
/// `size_bits` contains a finite positive `f32` pixel size. Returns `u32::MAX`
/// for malformed font data, unsupported glyphs, or invalid sizes. This keeps
/// the selected production rasterizer in the optimized WASM size envelope.
// SAFETY: This crate owns this globally unique probe export name.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn doper_budget_raster_bytes(glyph_id: u32, size_bits: u32) -> u32 {
    let size = f32::from_bits(size_bits);
    let Ok(glyph_id) = u16::try_from(glyph_id) else {
        return INVALID_INPUT;
    };
    if !size.is_finite() || size <= 0.0 || size > 16_384.0 {
        return INVALID_INPUT;
    }
    FONT_INPUT.with_borrow(|font| {
        let Ok(face) = fontdue::Font::from_bytes(
            font.as_slice(),
            fontdue::FontSettings {
                collection_index: 0,
                ..fontdue::FontSettings::default()
            },
        ) else {
            return INVALID_INPUT;
        };
        let (_, pixels) = face.rasterize_indexed(glyph_id, size);
        u32::try_from(pixels.len()).unwrap_or(INVALID_INPUT)
    })
}

#[cfg(test)]
mod tests {
    use super::{
        INVALID_INPUT, doper_budget_grapheme_count, doper_budget_push_text_byte,
        doper_budget_raster_bytes, doper_budget_reset_inputs,
    };

    #[test]
    fn counts_user_perceived_characters_from_bounded_input() {
        doper_budget_reset_inputs();
        for byte in "a\u{0301}👨‍👩‍👧‍👦한".bytes() {
            assert_eq!(doper_budget_push_text_byte(u32::from(byte)), 1);
        }
        assert_eq!(doper_budget_grapheme_count(), 3);
    }

    #[test]
    fn rejects_non_byte_and_malformed_utf8_inputs() {
        doper_budget_reset_inputs();
        assert_eq!(doper_budget_push_text_byte(256), 0);
        assert_eq!(doper_budget_push_text_byte(0xFF), 1);
        assert_eq!(doper_budget_grapheme_count(), INVALID_INPUT);
        assert_eq!(
            doper_budget_raster_bytes(1, 0.0_f32.to_bits()),
            INVALID_INPUT
        );
        assert_eq!(
            doper_budget_raster_bytes(u32::MAX, 12.0_f32.to_bits()),
            INVALID_INPUT
        );
    }
}
