use std::{collections::HashMap, sync::Arc};

use swash::shape::ShapeContext;

use crate::{FontFace, TextError, TextLayout, TextOptions, layout::layout_text};

/// Default retained Text Shape Cache budget (8 MiB).
pub const DEFAULT_CACHE_BYTES: usize = 8 * 1024 * 1024;

/// Observable bounded-cache counters.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TextCacheMetrics {
    /// Cache hits.
    pub hits: u64,
    /// Cache misses.
    pub misses: u64,
    /// Entries evicted by the byte budget.
    pub evictions: u64,
    /// Current entry count.
    pub entries: usize,
    /// Estimated retained bytes.
    pub retained_bytes: usize,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CacheKey {
    font_id: u32,
    font_revision: u32,
    font_fingerprint: u64,
    font_size: u32,
    line_height: u32,
    max_width: u32,
    white_space: crate::WhiteSpace,
    overflow_wrap: crate::OverflowWrap,
    text_align: crate::TextAlign,
    text_overflow: crate::TextOverflow,
    text: Arc<str>,
}

struct CacheEntry {
    layout: Arc<TextLayout>,
    bytes: usize,
    last_use: u64,
}

/// Deterministic shaper and bounded Text Shape Cache.
pub struct TextEngine {
    budget_bytes: usize,
    clock: u64,
    shape_context: ShapeContext,
    entries: HashMap<CacheKey, CacheEntry>,
    metrics: TextCacheMetrics,
}

impl Default for TextEngine {
    fn default() -> Self {
        Self::new(DEFAULT_CACHE_BYTES)
    }
}

impl TextEngine {
    /// Creates a cache with an explicit retained-byte budget.
    #[must_use]
    pub fn new(budget_bytes: usize) -> Self {
        Self {
            budget_bytes,
            clock: 0,
            shape_context: ShapeContext::new(),
            entries: HashMap::new(),
            metrics: TextCacheMetrics::default(),
        }
    }

    /// Shapes and wraps text, returning an immutable shared layout.
    ///
    /// # Errors
    ///
    /// Returns [`TextError`] when the font, text, options, or shaped offsets are invalid.
    pub fn layout(
        &mut self,
        font: &FontFace,
        text: &str,
        options: TextOptions,
    ) -> Result<Arc<TextLayout>, TextError> {
        options.validate()?;
        self.clock = self.clock.wrapping_add(1);
        let key = CacheKey {
            font_id: font.id(),
            font_revision: font.revision(),
            font_fingerprint: font.fingerprint(),
            font_size: options.font_size.to_bits(),
            line_height: options.line_height.to_bits(),
            max_width: options.max_width.to_bits(),
            white_space: options.white_space,
            overflow_wrap: options.overflow_wrap,
            text_align: options.text_align,
            text_overflow: options.text_overflow,
            text: Arc::from(text),
        };
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.last_use = self.clock;
            self.metrics.hits += 1;
            return Ok(Arc::clone(&entry.layout));
        }
        self.metrics.misses += 1;
        let layout = Arc::new(layout_text(&mut self.shape_context, font, text, options)?);
        let bytes = key.text.len().saturating_add(layout.estimated_bytes());
        if bytes <= self.budget_bytes {
            self.evict_until_fits(bytes);
            self.metrics.retained_bytes = self.metrics.retained_bytes.saturating_add(bytes);
            self.entries.insert(
                key,
                CacheEntry {
                    layout: Arc::clone(&layout),
                    bytes,
                    last_use: self.clock,
                },
            );
            self.metrics.entries = self.entries.len();
        }
        Ok(layout)
    }

    /// Removes every layout for a font resource, including older revisions.
    pub fn invalidate_font(&mut self, font_id: u32) {
        let keys = self
            .entries
            .keys()
            .filter(|key| key.font_id == font_id)
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(entry) = self.entries.remove(&key) {
                self.metrics.retained_bytes =
                    self.metrics.retained_bytes.saturating_sub(entry.bytes);
            }
        }
        self.metrics.entries = self.entries.len();
    }

    /// Current cumulative cache metrics.
    #[must_use]
    pub const fn metrics(&self) -> TextCacheMetrics {
        self.metrics
    }

    fn evict_until_fits(&mut self, incoming: usize) {
        while self.metrics.retained_bytes.saturating_add(incoming) > self.budget_bytes {
            let Some(key) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_use)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            let entry = self
                .entries
                .remove(&key)
                .expect("selected cache entry exists");
            self.metrics.retained_bytes = self.metrics.retained_bytes.saturating_sub(entry.bytes);
            self.metrics.evictions += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::{
        FontFace, MAX_TEXT_BYTES, OverflowWrap, TextAlign, TextEngine, TextError, TextOptions,
        TextOverflow, WhiteSpace,
    };

    fn font(revision: u32) -> FontFace {
        FontFace::from_bytes(9, revision, 0, crate::conformance_font()).expect("valid fixture")
    }

    fn options(max_width: f32) -> TextOptions {
        TextOptions {
            font_size: 18.0,
            line_height: 24.0,
            max_width,
            white_space: WhiteSpace::PreWrap,
            overflow_wrap: OverflowWrap::Anywhere,
            text_align: TextAlign::Start,
            text_overflow: TextOverflow::Clip,
        }
    }

    #[test]
    fn shapes_wraps_and_maps_all_editing_boundaries() {
        let mut engine = TextEngine::default();
        let text = "\u{ea60}\u{ea61} \u{ea62}\nA e\u{301} 👩‍💻 中文";
        let layout = engine
            .layout(&font(1), text, options(32.0))
            .expect("layout");
        assert!(layout.lines.len() >= 3);
        assert!(!layout.glyphs.is_empty());
        assert!(!layout.clusters.is_empty());
        assert!(layout.width.is_finite() && layout.width > 0.0);
        let expected_height =
            f32::from(u16::try_from(layout.lines.len()).expect("bounded lines")) * 24.0;
        assert!((layout.height - expected_height).abs() < f32::EPSILON);
        assert!(
            layout
                .graphemes
                .iter()
                .any(|item| &text[item.bytes.clone()] == "e\u{301}")
        );
        assert!(
            layout
                .graphemes
                .iter()
                .any(|item| &text[item.bytes.clone()] == "👩‍💻")
        );
        assert!(layout.caret_for_utf16(5).is_some());
        assert_eq!(
            layout.caret_for_utf16(u32::MAX),
            layout.carets.last().copied()
        );
        for caret in &layout.carets {
            assert!(text.is_char_boundary(caret.byte_offset));
            assert!(
                !text[..caret.byte_offset].ends_with('\u{200d}'),
                "caret split an emoji ZWJ sequence"
            );
        }
    }

    #[test]
    fn handles_empty_unbounded_trailing_newline_and_forced_breaks() {
        let face = font(1);
        let mut engine = TextEngine::default();
        let empty = engine
            .layout(&face, "", options(f32::INFINITY))
            .expect("empty");
        assert_eq!(empty.lines.len(), 1);
        assert_eq!(empty.carets.len(), 1);
        let trailing = engine
            .layout(&face, "\u{ea60}\n", options(f32::INFINITY))
            .expect("trailing newline");
        assert_eq!(trailing.lines.len(), 2);
        let forced = engine
            .layout(&face, "\u{ea60}\u{ea61}\u{ea62}", options(0.25))
            .expect("forced breaks");
        assert_eq!(forced.lines.len(), 3);
    }

    #[test]
    fn cache_hits_invalidates_by_font_and_never_exceeds_budget() {
        let face = font(1);
        let mut engine = TextEngine::new(512);
        let first = engine
            .layout(&face, "\u{ea60}", options(100.0))
            .expect("first");
        let second = engine
            .layout(&face, "\u{ea60}", options(100.0))
            .expect("hit");
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(engine.metrics().hits, 1);
        engine.invalidate_font(face.id());
        assert_eq!(engine.metrics().entries, 0);
        let third = engine
            .layout(&face, "\u{ea61}", options(100.0))
            .expect("new entry");
        assert!(!Arc::ptr_eq(&first, &third));
        for glyph in ['\u{ea62}', '\u{ea63}', '\u{ea64}', '\u{ea65}'] {
            engine
                .layout(&face, &glyph.to_string(), options(100.0))
                .expect("bounded entry");
        }
        assert!(engine.metrics().retained_bytes <= 512);
        assert!(engine.metrics().evictions > 0);

        let mut disabled = TextEngine::new(0);
        disabled
            .layout(&face, "\u{ea60}", options(100.0))
            .expect("uncached layout");
        assert_eq!(disabled.metrics().entries, 0);
        assert_eq!(disabled.metrics().retained_bytes, 0);
    }

    #[test]
    fn rejects_invalid_options_and_oversized_text_without_cache_mutation() {
        let face = font(1);
        let mut engine = TextEngine::default();
        assert_eq!(
            engine
                .layout(&face, "x", options(f32::NAN))
                .expect_err("invalid width"),
            TextError::InvalidOptions
        );
        let oversized = "x".repeat(MAX_TEXT_BYTES + 1);
        assert_eq!(
            engine
                .layout(&face, &oversized, options(100.0))
                .expect_err("oversized"),
            TextError::TextTooLarge {
                actual: MAX_TEXT_BYTES + 1,
                maximum: MAX_TEXT_BYTES,
            }
        );
        assert_eq!(engine.metrics().entries, 0);
    }
}
