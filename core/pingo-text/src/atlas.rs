use std::{collections::HashMap, sync::Arc};

use crate::{FontFace, TextError};

/// Default retained glyph bitmap budget (16 MiB).
pub const DEFAULT_ATLAS_BYTES: usize = 16 * 1024 * 1024;

/// Pixel representation emitted by the font rasterizer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GlyphContent {
    /// One 8-bit alpha value per pixel.
    Mask,
}

/// Immutable tightly bounded raster for one font glyph.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GlyphBitmap {
    /// Font-local glyph identifier.
    pub glyph_id: u16,
    /// Device-pixel placement left of the glyph origin.
    pub left: i32,
    /// Device-pixel placement above the glyph baseline.
    pub top: i32,
    /// Bitmap width in device pixels.
    pub width: u32,
    /// Bitmap height in device pixels.
    pub height: u32,
    /// Pixel encoding.
    pub content: GlyphContent,
    /// Pixel bytes with a row stride implied by width and content.
    pub data: Arc<[u8]>,
    /// Device-pixel ratio used for rasterization.
    pub device_pixel_ratio_bits: u32,
}

impl GlyphBitmap {
    /// Device-pixel ratio used for rasterization.
    #[must_use]
    pub fn device_pixel_ratio(&self) -> f32 {
        f32::from_bits(self.device_pixel_ratio_bits)
    }

    fn estimated_bytes(&self) -> usize {
        size_of::<Self>().saturating_add(self.data.len())
    }
}

/// Observable bounded atlas counters.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct GlyphAtlasMetrics {
    /// Cached raster hits.
    pub hits: u64,
    /// Raster cache misses.
    pub misses: u64,
    /// Entries evicted to respect the byte budget.
    pub evictions: u64,
    /// Glyphs with no rasterizable image (for example spaces).
    pub empty_glyphs: u64,
    /// Current cached entries.
    pub entries: usize,
    /// Estimated retained bytes.
    pub retained_bytes: usize,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct GlyphKey {
    font_id: u32,
    font_revision: u32,
    font_fingerprint: u64,
    font_size_bits: u32,
    device_pixel_ratio_bits: u32,
    glyph_id: u16,
}

struct GlyphEntry {
    bitmap: Arc<GlyphBitmap>,
    bytes: usize,
    last_use: u64,
}

/// Bounded deterministic glyph raster cache backing the Core atlas.
pub struct GlyphAtlas {
    budget_bytes: usize,
    clock: u64,
    entries: HashMap<GlyphKey, GlyphEntry>,
    metrics: GlyphAtlasMetrics,
}

impl Default for GlyphAtlas {
    fn default() -> Self {
        Self::new(DEFAULT_ATLAS_BYTES)
    }
}

impl GlyphAtlas {
    /// Creates an atlas with an explicit retained-byte budget.
    #[must_use]
    pub fn new(budget_bytes: usize) -> Self {
        Self {
            budget_bytes,
            clock: 0,
            entries: HashMap::new(),
            metrics: GlyphAtlasMetrics::default(),
        }
    }

    /// Rasterizes or reuses one monochrome outline glyph.
    ///
    /// # Errors
    ///
    /// Rejects invalid sizes or DPR values before mutating the cache.
    pub fn rasterize(
        &mut self,
        font: &FontFace,
        font_size: f32,
        device_pixel_ratio: f32,
        glyph_id: u16,
    ) -> Result<Arc<GlyphBitmap>, TextError> {
        if !font_size.is_finite()
            || font_size <= 0.0
            || !device_pixel_ratio.is_finite()
            || device_pixel_ratio <= 0.0
        {
            return Err(TextError::InvalidOptions);
        }
        let pixel_size = font_size * device_pixel_ratio;
        if !pixel_size.is_finite() || pixel_size > 16_384.0 {
            return Err(TextError::InvalidOptions);
        }
        self.clock = self.clock.wrapping_add(1);
        let key = GlyphKey {
            font_id: font.id(),
            font_revision: font.revision(),
            font_fingerprint: font.fingerprint(),
            font_size_bits: font_size.to_bits(),
            device_pixel_ratio_bits: device_pixel_ratio.to_bits(),
            glyph_id,
        };
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.last_use = self.clock;
            self.metrics.hits += 1;
            return Ok(Arc::clone(&entry.bitmap));
        }
        self.metrics.misses += 1;
        let (placement, data) = font.raster_font().rasterize_indexed(glyph_id, pixel_size);
        let width = u32::try_from(placement.width).map_err(|_| TextError::ArithmeticOverflow)?;
        let height = u32::try_from(placement.height).map_err(|_| TextError::ArithmeticOverflow)?;
        let expected_bytes = placement
            .width
            .checked_mul(placement.height)
            .ok_or(TextError::ArithmeticOverflow)?;
        if data.len() != expected_bytes {
            return Err(TextError::ArithmeticOverflow);
        }
        let height_i32 =
            i32::try_from(placement.height).map_err(|_| TextError::ArithmeticOverflow)?;
        let top = placement
            .ymin
            .checked_add(height_i32)
            .ok_or(TextError::ArithmeticOverflow)?;
        let bitmap = Arc::new(if data.is_empty() {
            self.metrics.empty_glyphs += 1;
            GlyphBitmap {
                glyph_id,
                left: 0,
                top: 0,
                width: 0,
                height: 0,
                content: GlyphContent::Mask,
                data: Arc::from([]),
                device_pixel_ratio_bits: device_pixel_ratio.to_bits(),
            }
        } else {
            GlyphBitmap {
                glyph_id,
                left: placement.xmin,
                top,
                width,
                height,
                content: GlyphContent::Mask,
                data: Arc::from(data),
                device_pixel_ratio_bits: device_pixel_ratio.to_bits(),
            }
        });
        let bytes = bitmap.estimated_bytes();
        if bytes <= self.budget_bytes {
            self.evict_until_fits(bytes);
            self.metrics.retained_bytes = self.metrics.retained_bytes.saturating_add(bytes);
            self.entries.insert(
                key,
                GlyphEntry {
                    bitmap: Arc::clone(&bitmap),
                    bytes,
                    last_use: self.clock,
                },
            );
            self.metrics.entries = self.entries.len();
        }
        Ok(bitmap)
    }

    /// Removes every glyph raster for a font resource and all its revisions.
    pub fn invalidate_font(&mut self, font_id: u32) {
        let keys = self
            .entries
            .keys()
            .filter(|key| key.font_id == font_id)
            .copied()
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(entry) = self.entries.remove(&key) {
                self.metrics.retained_bytes =
                    self.metrics.retained_bytes.saturating_sub(entry.bytes);
            }
        }
        self.metrics.entries = self.entries.len();
    }

    /// Removes every raster because DPR changes invalidate pixel placement.
    pub fn invalidate_device_pixel_ratio(&mut self) {
        self.entries.clear();
        self.metrics.entries = 0;
        self.metrics.retained_bytes = 0;
    }

    /// Current cumulative atlas metrics.
    #[must_use]
    pub const fn metrics(&self) -> GlyphAtlasMetrics {
        self.metrics
    }

    fn evict_until_fits(&mut self, incoming: usize) {
        while self.metrics.retained_bytes.saturating_add(incoming) > self.budget_bytes {
            let Some(key) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_use)
                .map(|(key, _)| *key)
            else {
                break;
            };
            let entry = self
                .entries
                .remove(&key)
                .expect("selected glyph entry exists");
            self.metrics.retained_bytes = self.metrics.retained_bytes.saturating_sub(entry.bytes);
            self.metrics.evictions += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::{
        FontFace, GlyphAtlas, GlyphAtlasMetrics, GlyphContent, TextEngine, TextError, TextOptions,
    };

    fn font() -> FontFace {
        FontFace::from_bytes(5, 1, 0, crate::conformance_font()).expect("font")
    }

    fn icon_glyph(font: &FontFace) -> u16 {
        let mut text = TextEngine::default();
        text.layout(
            font,
            "\u{ea60}",
            TextOptions {
                font_size: 18.0,
                line_height: 24.0,
                max_width: f32::INFINITY,
            },
        )
        .expect("shape icon")
        .glyphs[0]
            .id
    }

    #[test]
    fn rasterizes_real_glyph_and_reuses_cache_key() {
        let font = font();
        let glyph = icon_glyph(&font);
        let mut atlas = GlyphAtlas::default();
        let first = atlas.rasterize(&font, 18.0, 2.0, glyph).expect("raster");
        assert!(first.width > 0 && first.height > 0);
        assert!(!first.data.is_empty());
        assert_eq!(first.content, GlyphContent::Mask);
        assert!((first.device_pixel_ratio() - 2.0).abs() < f32::EPSILON);
        let second = atlas.rasterize(&font, 18.0, 2.0, glyph).expect("hit");
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(atlas.metrics().hits, 1);
        assert_eq!(atlas.metrics().misses, 1);
    }

    #[test]
    fn invalidation_and_budget_keep_retained_pixels_bounded() {
        let font = font();
        let glyph = icon_glyph(&font);
        let mut atlas = GlyphAtlas::new(256);
        for size in [16.0, 17.0, 18.0, 19.0] {
            atlas.rasterize(&font, size, 1.0, glyph).expect("size");
        }
        assert!(atlas.metrics().retained_bytes <= 256);
        assert!(atlas.metrics().evictions > 0 || atlas.metrics().entries == 0);
        atlas.invalidate_font(font.id());
        assert_eq!(atlas.metrics().entries, 0);
        atlas
            .rasterize(&font, 18.0, 1.0, glyph)
            .expect("repopulate");
        atlas.invalidate_device_pixel_ratio();
        assert_eq!(atlas.metrics().retained_bytes, 0);
    }

    #[test]
    fn rejects_hostile_raster_options_before_cache_mutation() {
        let font = font();
        let mut atlas = GlyphAtlas::default();
        for (size, dpr) in [(0.0, 1.0), (18.0, f32::NAN), (10_000.0, 2.0)] {
            assert_eq!(
                atlas.rasterize(&font, size, dpr, 1).expect_err("invalid"),
                TextError::InvalidOptions
            );
        }
        assert_eq!(atlas.metrics(), GlyphAtlasMetrics::default());
    }
}
