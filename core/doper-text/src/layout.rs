use std::{collections::BTreeSet, ops::Range};

use swash::{
    shape::ShapeContext,
    text::{BidiClass, Codepoint, Script},
};
use unicode_linebreak::{BreakOpportunity, linebreaks};
use unicode_segmentation::UnicodeSegmentation;

use crate::{FontFace, TextError};

/// Maximum UTF-8 bytes accepted by one text layout request.
pub const MAX_TEXT_BYTES: usize = 1_048_576;

/// Validated layout options in logical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextOptions {
    /// Font size in logical pixels.
    pub font_size: f32,
    /// Line box height in logical pixels.
    pub line_height: f32,
    /// Maximum line width. Positive infinity disables wrapping.
    pub max_width: f32,
}

impl TextOptions {
    pub(crate) fn validate(self) -> Result<(), TextError> {
        if !self.font_size.is_finite()
            || self.font_size <= 0.0
            || !self.line_height.is_finite()
            || self.line_height <= 0.0
            || self.max_width.is_nan()
            || self.max_width <= 0.0
        {
            return Err(TextError::InvalidOptions);
        }
        Ok(())
    }
}

/// One Unicode grapheme and its corresponding browser/Rust offsets.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Grapheme {
    /// UTF-8 byte range.
    pub bytes: Range<usize>,
    /// UTF-16 code-unit range used by browser editing APIs.
    pub utf16: Range<u32>,
}

/// One shaping cluster and the glyphs produced from it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShapeCluster {
    /// UTF-8 byte range.
    pub bytes: Range<usize>,
    /// UTF-16 code-unit range.
    pub utf16: Range<u32>,
    /// Range in [`TextLayout::glyphs`].
    pub glyphs: Range<usize>,
}

/// One positioned font glyph.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PositionedGlyph {
    /// Font-local glyph identifier.
    pub id: u16,
    /// Index in [`TextLayout::clusters`].
    pub cluster: usize,
    /// Index in [`TextLayout::lines`].
    pub line: usize,
    /// Logical X origin including shaping offset.
    pub x: f32,
    /// Logical Y origin including shaping offset.
    pub y: f32,
    /// Horizontal advance.
    pub advance: f32,
}

/// One laid-out visual line.
#[derive(Clone, Debug, PartialEq)]
pub struct TextLine {
    /// UTF-8 byte range, excluding the newline delimiter.
    pub bytes: Range<usize>,
    /// UTF-16 code-unit range, excluding the newline delimiter.
    pub utf16: Range<u32>,
    /// Graphemes intersecting the line.
    pub graphemes: Range<usize>,
    /// Shaping clusters intersecting the line.
    pub clusters: Range<usize>,
    /// Positioned glyphs on the line.
    pub glyphs: Range<usize>,
    /// Advance width.
    pub width: f32,
    /// Alphabetic baseline in logical coordinates.
    pub baseline: f32,
}

/// A legal caret position that never splits a grapheme or shaping cluster.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CaretStop {
    /// UTF-8 byte offset.
    pub byte_offset: usize,
    /// UTF-16 code-unit offset.
    pub utf16_offset: u32,
    /// Visual line index.
    pub line: usize,
    /// Logical X position.
    pub x: f32,
    /// Top of the caret.
    pub y: f32,
    /// Caret height.
    pub height: f32,
}

/// Deterministic LTR text output shared by layout, paint, hit testing and editing.
#[derive(Clone, Debug, PartialEq)]
pub struct TextLayout {
    /// Source text retained for stable offset lookup and cache ownership.
    pub text: String,
    /// Unicode grapheme table.
    pub graphemes: Vec<Grapheme>,
    /// Shaping cluster table.
    pub clusters: Vec<ShapeCluster>,
    /// Positioned glyph stream.
    pub glyphs: Vec<PositionedGlyph>,
    /// Visual line table.
    pub lines: Vec<TextLine>,
    /// Legal caret positions.
    pub carets: Vec<CaretStop>,
    /// Maximum line width.
    pub width: f32,
    /// Total line-box height.
    pub height: f32,
    /// Number of glyphs whose font identifier is zero (`.notdef`).
    pub missing_glyphs: usize,
}

impl TextLayout {
    /// Returns the closest legal caret for a browser UTF-16 offset.
    #[must_use]
    pub fn caret_for_utf16(&self, offset: u32) -> Option<CaretStop> {
        self.carets
            .iter()
            .copied()
            .min_by_key(|caret| (i64::from(caret.utf16_offset) - i64::from(offset)).unsigned_abs())
    }

    pub(crate) fn estimated_bytes(&self) -> usize {
        self.text
            .len()
            .saturating_add(self.graphemes.len().saturating_mul(size_of::<Grapheme>()))
            .saturating_add(
                self.clusters
                    .len()
                    .saturating_mul(size_of::<ShapeCluster>()),
            )
            .saturating_add(
                self.glyphs
                    .len()
                    .saturating_mul(size_of::<PositionedGlyph>()),
            )
            .saturating_add(self.lines.len().saturating_mul(size_of::<TextLine>()))
            .saturating_add(self.carets.len().saturating_mul(size_of::<CaretStop>()))
    }
}

pub(crate) fn layout_text(
    context: &mut ShapeContext,
    font: &FontFace,
    text: &str,
    options: TextOptions,
) -> Result<TextLayout, TextError> {
    options.validate()?;
    if text.len() > MAX_TEXT_BYTES {
        return Err(TextError::TextTooLarge {
            actual: text.len(),
            maximum: MAX_TEXT_BYTES,
        });
    }
    if text.chars().any(|character| {
        matches!(
            character.bidi_class(),
            BidiClass::AL
                | BidiClass::AN
                | BidiClass::FSI
                | BidiClass::LRE
                | BidiClass::LRI
                | BidiClass::LRO
                | BidiClass::PDF
                | BidiClass::PDI
                | BidiClass::R
                | BidiClass::RLE
                | BidiClass::RLI
                | BidiClass::RLO
        )
    }) {
        return Err(TextError::UnsupportedDirection);
    }

    let graphemes = grapheme_table(text)?;
    let ranges = line_ranges(context, font, text, options.max_width, options.font_size)?;
    let mut layout = TextLayout {
        text: text.to_owned(),
        graphemes,
        clusters: Vec::new(),
        glyphs: Vec::new(),
        lines: Vec::with_capacity(ranges.len()),
        carets: Vec::new(),
        width: 0.0,
        height: 0.0,
        missing_glyphs: 0,
    };

    for (line_index, bytes) in ranges.into_iter().enumerate() {
        append_line(context, font, &mut layout, line_index, bytes, options)?;
    }
    if layout.lines.is_empty() {
        append_line(context, font, &mut layout, 0, 0..0, options)?;
    }
    layout.height = usize_to_f32(layout.lines.len()) * options.line_height;
    build_carets(&mut layout, options.line_height)?;
    Ok(layout)
}

fn line_ranges(
    context: &mut ShapeContext,
    font: &FontFace,
    text: &str,
    max_width: f32,
    font_size: f32,
) -> Result<Vec<Range<usize>>, TextError> {
    let mut result = Vec::new();
    let mut paragraph_start = 0_usize;
    for segment in text.split_inclusive('\n') {
        let content_len = segment.strip_suffix('\n').map_or(segment.len(), str::len);
        let paragraph_end = paragraph_start
            .checked_add(content_len)
            .ok_or(TextError::ArithmeticOverflow)?;
        wrap_paragraph(
            context,
            font,
            text,
            paragraph_start..paragraph_end,
            max_width,
            font_size,
            &mut result,
        )?;
        paragraph_start = paragraph_start
            .checked_add(segment.len())
            .ok_or(TextError::ArithmeticOverflow)?;
        if segment.ends_with('\n') && paragraph_start == text.len() {
            result.push(paragraph_start..paragraph_start);
        }
    }
    if text.is_empty() {
        result.push(0..0);
    } else if paragraph_start < text.len() {
        wrap_paragraph(
            context,
            font,
            text,
            paragraph_start..text.len(),
            max_width,
            font_size,
            &mut result,
        )?;
    }
    Ok(result)
}

fn wrap_paragraph(
    context: &mut ShapeContext,
    font: &FontFace,
    text: &str,
    paragraph: Range<usize>,
    max_width: f32,
    font_size: f32,
    output: &mut Vec<Range<usize>>,
) -> Result<(), TextError> {
    let value = &text[paragraph.clone()];
    if value.is_empty() {
        output.push(paragraph.start..paragraph.start);
        return Ok(());
    }
    if !max_width.is_finite() {
        output.push(paragraph);
        return Ok(());
    }
    let shaped = shape(context, font, value, font_size)?;
    let mut clusters = cluster_advances(&shaped);
    let allowed = linebreaks(value)
        .filter_map(|(offset, opportunity)| {
            matches!(
                opportunity,
                BreakOpportunity::Allowed | BreakOpportunity::Mandatory
            )
            .then_some(offset)
        })
        .collect::<BTreeSet<_>>();
    for cluster in &mut clusters {
        cluster.break_allowed = allowed.contains(&cluster.end);
    }
    let mut start = 0;
    while start < value.len() {
        let mut width = 0.0_f32;
        let mut last_allowed = None;
        let mut end = start;
        for cluster in clusters.iter().filter(|cluster| cluster.end > start) {
            if cluster.start < start {
                continue;
            }
            if width + cluster.advance > max_width && end > start {
                end = last_allowed
                    .filter(|candidate| *candidate > start)
                    .unwrap_or(end);
                break;
            }
            width += cluster.advance;
            end = cluster.end;
            if cluster.break_allowed {
                last_allowed = Some(cluster.end);
            }
            if width > max_width {
                break;
            }
        }
        if end <= start {
            end = value[start..]
                .grapheme_indices(true)
                .nth(1)
                .map_or(value.len(), |(offset, _)| start + offset);
        }
        output.push(paragraph.start + start..paragraph.start + end);
        start = end;
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct ClusterAdvance {
    start: usize,
    end: usize,
    advance: f32,
    break_allowed: bool,
}

fn cluster_advances(shaped: &[RawCluster]) -> Vec<ClusterAdvance> {
    shaped
        .iter()
        .map(|cluster| ClusterAdvance {
            start: cluster.bytes.start,
            end: cluster.bytes.end,
            advance: cluster.glyphs.iter().map(|glyph| glyph.advance).sum(),
            break_allowed: false,
        })
        .collect()
}

fn append_line(
    context: &mut ShapeContext,
    font: &FontFace,
    layout: &mut TextLayout,
    line_index: usize,
    bytes: Range<usize>,
    options: TextOptions,
) -> Result<(), TextError> {
    let shaped = shape(
        context,
        font,
        &layout.text[bytes.clone()],
        options.font_size,
    )?;
    let glyph_start = layout.glyphs.len();
    let cluster_start = layout.clusters.len();
    let baseline = options.font_size + usize_to_f32(line_index) * options.line_height;
    let mut x = 0.0_f32;
    for raw_cluster in shaped {
        let global_start = bytes
            .start
            .checked_add(raw_cluster.bytes.start)
            .ok_or(TextError::ArithmeticOverflow)?;
        let global_end = bytes
            .start
            .checked_add(raw_cluster.bytes.end)
            .ok_or(TextError::ArithmeticOverflow)?;
        let cluster_index = layout.clusters.len();
        let cluster_glyph_start = layout.glyphs.len();
        for glyph in raw_cluster.glyphs {
            layout.glyphs.push(PositionedGlyph {
                id: glyph.id,
                cluster: cluster_index,
                line: line_index,
                x: x + glyph.x,
                y: baseline - glyph.y,
                advance: glyph.advance,
            });
            if glyph.id == 0 {
                layout.missing_glyphs += 1;
            }
            x += glyph.advance;
        }
        layout.clusters.push(ShapeCluster {
            bytes: global_start..global_end,
            utf16: utf16_offset(&layout.text, global_start)?
                ..utf16_offset(&layout.text, global_end)?,
            glyphs: cluster_glyph_start..layout.glyphs.len(),
        });
    }
    let grapheme_start = layout
        .graphemes
        .partition_point(|item| item.bytes.end <= bytes.start);
    let grapheme_end = layout
        .graphemes
        .partition_point(|item| item.bytes.start < bytes.end);
    let line = TextLine {
        utf16: utf16_offset(&layout.text, bytes.start)?..utf16_offset(&layout.text, bytes.end)?,
        bytes,
        graphemes: grapheme_start..grapheme_end,
        clusters: cluster_start..layout.clusters.len(),
        glyphs: glyph_start..layout.glyphs.len(),
        width: x,
        baseline,
    };
    layout.width = layout.width.max(x);
    layout.lines.push(line);
    Ok(())
}

fn build_carets(layout: &mut TextLayout, line_height: f32) -> Result<(), TextError> {
    for (line_index, line) in layout.lines.iter().enumerate() {
        let mut cluster_boundaries = BTreeSet::new();
        cluster_boundaries.insert(line.bytes.start);
        cluster_boundaries.insert(line.bytes.end);
        for cluster in &layout.clusters[line.clusters.clone()] {
            cluster_boundaries.insert(cluster.bytes.start);
            cluster_boundaries.insert(cluster.bytes.end);
        }
        let mut boundaries = layout.graphemes[line.graphemes.clone()]
            .iter()
            .flat_map(|grapheme| [grapheme.bytes.start, grapheme.bytes.end])
            .filter(|offset| cluster_boundaries.contains(offset))
            .collect::<BTreeSet<_>>();
        boundaries.insert(line.bytes.start);
        boundaries.insert(line.bytes.end);
        for boundary in boundaries {
            let x = layout.glyphs[line.glyphs.clone()]
                .iter()
                .filter(|glyph| layout.clusters[glyph.cluster].bytes.start < boundary)
                .map(|glyph| glyph.advance)
                .sum();
            layout.carets.push(CaretStop {
                byte_offset: boundary,
                utf16_offset: utf16_offset(&layout.text, boundary)?,
                line: line_index,
                x,
                y: usize_to_f32(line_index) * line_height,
                height: line_height,
            });
        }
    }
    Ok(())
}

fn grapheme_table(text: &str) -> Result<Vec<Grapheme>, TextError> {
    text.grapheme_indices(true)
        .map(|(start, value)| {
            let end = start
                .checked_add(value.len())
                .ok_or(TextError::ArithmeticOverflow)?;
            Ok(Grapheme {
                bytes: start..end,
                utf16: utf16_offset(text, start)?..utf16_offset(text, end)?,
            })
        })
        .collect()
}

fn utf16_offset(text: &str, byte_offset: usize) -> Result<u32, TextError> {
    if !text.is_char_boundary(byte_offset) {
        return Err(TextError::ArithmeticOverflow);
    }
    u32::try_from(text[..byte_offset].encode_utf16().count())
        .map_err(|_| TextError::ArithmeticOverflow)
}

#[derive(Clone, Copy)]
struct RawGlyph {
    id: u16,
    x: f32,
    y: f32,
    advance: f32,
}

struct RawCluster {
    bytes: Range<usize>,
    glyphs: Vec<RawGlyph>,
}

fn shape(
    context: &mut ShapeContext,
    font: &FontFace,
    text: &str,
    font_size: f32,
) -> Result<Vec<RawCluster>, TextError> {
    let face = font.swash_face()?;
    let mut shaper = context
        .builder_with_id(face, [font.fingerprint(), u64::from(font.revision())])
        .script(script_for(text))
        .size(font_size)
        .build();
    shaper.add_str(text);
    let mut clusters = Vec::new();
    shaper.shape_with(|cluster| {
        clusters.push(RawCluster {
            bytes: cluster.source.to_range(),
            glyphs: cluster
                .glyphs
                .iter()
                .map(|glyph| RawGlyph {
                    id: glyph.id,
                    x: glyph.x,
                    y: glyph.y,
                    advance: glyph.advance,
                })
                .collect(),
        });
    });
    if clusters.iter().any(|cluster| {
        cluster.bytes.start > cluster.bytes.end
            || cluster.bytes.end > text.len()
            || !text.is_char_boundary(cluster.bytes.start)
            || !text.is_char_boundary(cluster.bytes.end)
            || cluster.glyphs.iter().any(|glyph| {
                !glyph.x.is_finite() || !glyph.y.is_finite() || !glyph.advance.is_finite()
            })
    }) {
        return Err(TextError::ArithmeticOverflow);
    }
    Ok(clusters)
}

fn script_for(text: &str) -> Script {
    text.chars()
        .map(Codepoint::script)
        .find(|script| !matches!(script, Script::Common | Script::Inherited | Script::Unknown))
        .unwrap_or(Script::Latin)
}

#[allow(clippy::cast_precision_loss)]
fn usize_to_f32(value: usize) -> f32 {
    value.min(1 << f32::MANTISSA_DIGITS) as f32
}

#[cfg(test)]
mod tests {
    use super::{TextOptions, grapheme_table, layout_text, utf16_offset};
    use crate::TextError;
    use swash::shape::ShapeContext;

    #[test]
    fn offset_table_keeps_emoji_zwj_and_combining_sequences_atomic() {
        let text = "a e\u{301} 👩‍💻 中";
        let table = grapheme_table(text).expect("table");
        assert!(
            table
                .iter()
                .any(|item| &text[item.bytes.clone()] == "e\u{301}")
        );
        assert!(table.iter().any(|item| &text[item.bytes.clone()] == "👩‍💻"));
        for item in &table {
            assert_eq!(
                item.utf16.start,
                utf16_offset(text, item.bytes.start).expect("start")
            );
            assert_eq!(
                item.utf16.end,
                utf16_offset(text, item.bytes.end).expect("end")
            );
        }
    }

    #[test]
    fn explicit_path_rejects_rtl_before_producing_incorrect_visual_order() {
        let font = crate::FontFace::from_bytes(1, 1, 0, crate::conformance_font())
            .expect("conformance font");
        for text in ["English שלום", "\u{2066}English\u{2069}", "١٢٣"] {
            assert_eq!(
                layout_text(
                    &mut ShapeContext::new(),
                    &font,
                    text,
                    TextOptions {
                        font_size: 16.0,
                        line_height: 20.0,
                        max_width: 200.0,
                    },
                ),
                Err(TextError::UnsupportedDirection)
            );
        }
    }

    #[test]
    fn options_reject_non_finite_and_non_positive_values() {
        for options in [
            TextOptions {
                font_size: 0.0,
                line_height: 16.0,
                max_width: 10.0,
            },
            TextOptions {
                font_size: 12.0,
                line_height: f32::NAN,
                max_width: 10.0,
            },
            TextOptions {
                font_size: 12.0,
                line_height: 16.0,
                max_width: 0.0,
            },
        ] {
            assert_eq!(options.validate(), Err(TextError::InvalidOptions));
        }
        assert!(
            TextOptions {
                font_size: 12.0,
                line_height: 16.0,
                max_width: f32::INFINITY
            }
            .validate()
            .is_ok()
        );
    }
}

/// Byte offsets at which a run of text has to start a new visual line.
///
/// The whole-run system-font fallback has no shaper, so it cannot use
/// [`wrap_paragraph`]; it does have the browser's per-code-point advances. This
/// applies the same UAX #14 break opportunities to those advances, so a run
/// wraps at the same places whether or not an explicit font was supplied.
///
/// Only soft breaks are returned. A `\n` in the source is a hard break the
/// caller already handles, and it is never reported here. When a single word
/// cannot fit at all the run breaks on a grapheme boundary rather than
/// overflowing, matching `overflow-wrap: anywhere`.
///
/// A non-finite or non-positive `max_width` disables wrapping.
pub fn soft_break_offsets(
    text: &str,
    advance_of: impl Fn(char) -> f32,
    max_width: f32,
) -> Vec<usize> {
    let mut breaks = Vec::new();
    if !max_width.is_finite() || max_width <= 0.0 || text.is_empty() {
        return breaks;
    }
    let allowed = linebreaks(text)
        .filter_map(|(offset, opportunity)| {
            matches!(opportunity, BreakOpportunity::Allowed).then_some(offset)
        })
        .collect::<BTreeSet<_>>();
    let mut line_start = 0_usize;
    let mut width = 0.0_f32;
    let mut last_allowed: Option<usize> = None;
    for (offset, character) in text.char_indices() {
        if character == '\n' {
            line_start = offset + character.len_utf8();
            width = 0.0;
            last_allowed = None;
            continue;
        }
        let advance = advance_of(character);
        if width + advance > max_width && offset > line_start {
            // Prefer the last opportunity on this line; with none, break right
            // here so a single long word is split instead of overflowing.
            let split = last_allowed
                .filter(|candidate| *candidate > line_start && *candidate <= offset)
                .unwrap_or(offset);
            breaks.push(split);
            line_start = split;
            width = text[split..offset].chars().map(&advance_of).sum::<f32>();
            last_allowed = None;
        }
        width += advance;
        let end = offset + character.len_utf8();
        if allowed.contains(&end) {
            last_allowed = Some(end);
        }
    }
    breaks
}

#[cfg(test)]
mod soft_break_tests {
    use super::soft_break_offsets;

    /// Ten units per code point keeps the arithmetic readable in the assertions.
    fn uniform(_character: char) -> f32 {
        10.0
    }

    #[test]
    fn breaks_latin_at_word_opportunities() {
        // "alpha beta" is 10 code points; at 60 units only "alpha " fits, and
        // the break belongs after the space, not mid-word.
        assert_eq!(soft_break_offsets("alpha beta", uniform, 60.0), vec![6]);
    }

    #[test]
    fn splits_a_word_that_cannot_fit_on_its_own_line() {
        // No opportunity inside it, so overflowing is the only alternative.
        assert_eq!(soft_break_offsets("abcdefgh", uniform, 30.0), vec![3, 6]);
    }

    #[test]
    fn treats_a_hard_break_as_a_fresh_line_and_never_reports_it() {
        assert_eq!(soft_break_offsets("abc\nabc", uniform, 40.0), Vec::new());
        assert_eq!(
            soft_break_offsets("abcde\nabcde", uniform, 30.0),
            vec![3, 9]
        );
    }

    #[test]
    fn wrapping_is_disabled_by_a_non_positive_or_infinite_width() {
        for width in [f32::INFINITY, 0.0, -1.0, f32::NAN] {
            assert_eq!(soft_break_offsets("abcdefgh", uniform, width), Vec::new());
        }
    }

    #[test]
    fn breaks_between_han_code_points_which_have_no_spaces() {
        // Every boundary is an opportunity, so this is a pure width fit: two
        // code points per line at 25 units, three bytes each.
        assert_eq!(
            soft_break_offsets("\u{4e2d}\u{6587}\u{5907}\u{6ce8}", uniform, 25.0),
            vec![6]
        );
        assert_eq!(
            soft_break_offsets("\u{4e2d}\u{6587}\u{5907}\u{6ce8}", uniform, 15.0),
            vec![3, 6, 9]
        );
    }
}
