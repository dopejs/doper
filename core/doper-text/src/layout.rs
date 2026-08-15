use std::{collections::BTreeSet, ops::Range};

use rustybuzz::{BufferClusterLevel, Direction, UnicodeBuffer};
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

    let face = font.rustybuzz_face()?;
    let scale = options.font_size / f32::from(font.units_per_em());
    let graphemes = grapheme_table(text)?;
    let ranges = line_ranges(&face, text, options.max_width, scale)?;
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
        append_line(&face, &mut layout, line_index, bytes, options, scale)?;
    }
    if layout.lines.is_empty() {
        append_line(&face, &mut layout, 0, 0..0, options, scale)?;
    }
    layout.height = usize_to_f32(layout.lines.len()) * options.line_height;
    build_carets(&mut layout, options.line_height)?;
    Ok(layout)
}

fn line_ranges(
    face: &rustybuzz::Face<'_>,
    text: &str,
    max_width: f32,
    scale: f32,
) -> Result<Vec<Range<usize>>, TextError> {
    let mut result = Vec::new();
    let mut paragraph_start = 0_usize;
    for segment in text.split_inclusive('\n') {
        let content_len = segment.strip_suffix('\n').map_or(segment.len(), str::len);
        let paragraph_end = paragraph_start
            .checked_add(content_len)
            .ok_or(TextError::ArithmeticOverflow)?;
        wrap_paragraph(
            face,
            text,
            paragraph_start..paragraph_end,
            max_width,
            scale,
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
            face,
            text,
            paragraph_start..text.len(),
            max_width,
            scale,
            &mut result,
        )?;
    }
    Ok(result)
}

fn wrap_paragraph(
    face: &rustybuzz::Face<'_>,
    text: &str,
    paragraph: Range<usize>,
    max_width: f32,
    scale: f32,
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
    let shaped = shape(face, value);
    let mut clusters = cluster_advances(value, &shaped, scale)?;
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

fn cluster_advances(
    text: &str,
    shaped: &rustybuzz::GlyphBuffer,
    scale: f32,
) -> Result<Vec<ClusterAdvance>, TextError> {
    let mut starts = shaped
        .glyph_infos()
        .iter()
        .map(|info| usize::try_from(info.cluster).map_err(|_| TextError::ArithmeticOverflow))
        .collect::<Result<Vec<_>, _>>()?;
    starts.push(text.len());
    starts.sort_unstable();
    starts.dedup();
    let mut result = Vec::with_capacity(starts.len().saturating_sub(1));
    for pair in starts.windows(2) {
        let start = pair[0];
        let end = pair[1];
        if start > text.len() || end > text.len() || !text.is_char_boundary(start) {
            return Err(TextError::ArithmeticOverflow);
        }
        let advance = shaped
            .glyph_infos()
            .iter()
            .zip(shaped.glyph_positions())
            .filter(|(info, _)| usize::try_from(info.cluster).ok() == Some(start))
            .map(|(_, position)| design_to_px(position.x_advance, scale))
            .sum();
        result.push(ClusterAdvance {
            start,
            end,
            advance,
            break_allowed: false,
        });
    }
    Ok(result)
}

fn append_line(
    face: &rustybuzz::Face<'_>,
    layout: &mut TextLayout,
    line_index: usize,
    bytes: Range<usize>,
    options: TextOptions,
    scale: f32,
) -> Result<(), TextError> {
    let shaped = shape(face, &layout.text[bytes.clone()]);
    let glyph_start = layout.glyphs.len();
    let cluster_start = layout.clusters.len();
    let baseline = options.font_size + usize_to_f32(line_index) * options.line_height;
    let mut x = 0.0_f32;
    let mut current_cluster = None;
    for (info, position) in shaped.glyph_infos().iter().zip(shaped.glyph_positions()) {
        let local_cluster =
            usize::try_from(info.cluster).map_err(|_| TextError::ArithmeticOverflow)?;
        let global_cluster = bytes
            .start
            .checked_add(local_cluster)
            .ok_or(TextError::ArithmeticOverflow)?;
        if current_cluster != Some(global_cluster) {
            let next_index = layout.clusters.len();
            if let Some(previous) = layout.clusters.last_mut() {
                previous.bytes.end = global_cluster;
                previous.utf16.end = utf16_offset(&layout.text, global_cluster)?;
                previous.glyphs.end = layout.glyphs.len();
            }
            layout.clusters.push(ShapeCluster {
                bytes: global_cluster..bytes.end,
                utf16: utf16_offset(&layout.text, global_cluster)?
                    ..utf16_offset(&layout.text, bytes.end)?,
                glyphs: layout.glyphs.len()..layout.glyphs.len(),
            });
            current_cluster = Some(global_cluster);
            debug_assert_eq!(next_index, layout.clusters.len() - 1);
        }
        let advance = design_to_px(position.x_advance, scale);
        layout.glyphs.push(PositionedGlyph {
            id: u16::try_from(info.glyph_id).map_err(|_| TextError::ArithmeticOverflow)?,
            cluster: layout.clusters.len() - 1,
            line: line_index,
            x: x + design_to_px(position.x_offset, scale),
            y: baseline - design_to_px(position.y_offset, scale),
            advance,
        });
        if info.glyph_id == 0 {
            layout.missing_glyphs += 1;
        }
        x += advance;
    }
    if cluster_start < layout.clusters.len()
        && let Some(last) = layout.clusters.last_mut()
    {
        last.bytes.end = bytes.end;
        last.utf16.end = utf16_offset(&layout.text, bytes.end)?;
        last.glyphs.end = layout.glyphs.len();
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

fn shape(face: &rustybuzz::Face<'_>, text: &str) -> rustybuzz::GlyphBuffer {
    let mut buffer = UnicodeBuffer::new();
    buffer.push_str(text);
    buffer.set_direction(Direction::LeftToRight);
    buffer.set_cluster_level(BufferClusterLevel::MonotoneGraphemes);
    rustybuzz::shape(face, &[], buffer)
}

#[allow(clippy::cast_precision_loss)]
fn design_to_px(value: i32, scale: f32) -> f32 {
    value as f32 * scale
}

#[allow(clippy::cast_precision_loss)]
fn usize_to_f32(value: usize) -> f32 {
    value.min(1 << f32::MANTISSA_DIGITS) as f32
}

#[cfg(test)]
mod tests {
    use super::{TextOptions, grapheme_table, utf16_offset};
    use crate::TextError;

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
