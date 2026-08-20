use std::{borrow::Cow, collections::BTreeSet, ops::Range};

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
    /// CSS whitespace collapsing and wrapping behavior.
    pub white_space: WhiteSpace,
    /// Whether an otherwise-unbreakable token may be split.
    pub overflow_wrap: OverflowWrap,
    /// LTR inline-axis alignment inside a finite maximum width.
    pub text_align: TextAlign,
    /// Inline overflow marker behavior for non-wrapping finite lines.
    pub text_overflow: TextOverflow,
}

/// Supported CSS `white-space` values.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum WhiteSpace {
    /// Collapse runs and wrap at normal opportunities.
    Normal,
    /// Collapse runs without soft wrapping.
    Nowrap,
    /// Preserve runs and hard line breaks without soft wrapping.
    Pre,
    /// Collapse runs, preserve hard line breaks, and soft wrap.
    PreLine,
    /// Preserve runs and hard line breaks while soft wrapping.
    PreWrap,
}

impl WhiteSpace {
    const fn collapses(self) -> bool {
        matches!(self, Self::Normal | Self::Nowrap | Self::PreLine)
    }

    const fn wraps(self) -> bool {
        matches!(self, Self::Normal | Self::PreLine | Self::PreWrap)
    }

    const fn preserves_newlines(self) -> bool {
        matches!(self, Self::Pre | Self::PreLine | Self::PreWrap)
    }
}

/// Supported CSS `overflow-wrap` behavior.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum OverflowWrap {
    /// Only use Unicode line-break opportunities.
    Normal,
    /// Split an otherwise-unbreakable word when necessary.
    BreakWord,
    /// Permit emergency grapheme-boundary breaks.
    Anywhere,
}

/// Supported LTR CSS `text-align` behavior.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum TextAlign {
    /// Align to the logical inline start.
    Start,
    /// Align to the logical inline end.
    End,
    /// Align to the physical left edge.
    Left,
    /// Align to the physical right edge.
    Right,
    /// Center each line.
    Center,
    /// Expand inter-word space on non-final lines.
    Justify,
}

/// Supported CSS `text-overflow` values.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum TextOverflow {
    /// Clip overflow at the box edge.
    Clip,
    /// Replace the clipped suffix with U+2026.
    Ellipsis,
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

    let mut transformed = transform_whitespace(text, options.white_space);
    let max_width = if options.white_space.wraps() {
        options.max_width
    } else {
        f32::INFINITY
    };
    let graphemes = grapheme_table(text)?;
    let ranges = line_ranges(
        context,
        font,
        transformed.text.as_ref(),
        WrapConfig {
            max_width,
            font_size: options.font_size,
            emergency: options.overflow_wrap != OverflowWrap::Normal,
        },
    )?;
    if options.white_space.collapses() {
        suppress_line_edge_spaces(&mut transformed, &ranges);
    }
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
        append_line(
            context,
            font,
            &transformed,
            &mut layout,
            line_index,
            bytes,
            options,
        )?;
    }
    if layout.lines.is_empty() {
        append_line(context, font, &transformed, &mut layout, 0, 0..0, options)?;
    }
    layout.height = usize_to_f32(layout.lines.len()) * options.line_height;
    if options.text_overflow == TextOverflow::Ellipsis
        && !options.white_space.wraps()
        && options.max_width.is_finite()
    {
        apply_ellipsis(context, font, &mut layout, options)?;
    }
    build_carets(&mut layout, options.line_height)?;
    apply_alignment(&mut layout, transformed.text.as_ref(), options);
    Ok(layout)
}

fn suppress_line_edge_spaces(transformed: &mut WhitespaceTransform<'_>, ranges: &[Range<usize>]) {
    for range in ranges {
        let value = &transformed.text[range.clone()];
        for (relative, character) in value.char_indices() {
            if character != ' ' {
                break;
            }
            transformed.suppressed.insert(range.start + relative);
        }
        for (relative, character) in value.char_indices().rev() {
            if character != ' ' {
                break;
            }
            transformed.suppressed.insert(range.start + relative);
        }
    }
}

struct WhitespaceTransform<'a> {
    text: Cow<'a, str>,
    suppressed: BTreeSet<usize>,
}

fn transform_whitespace(text: &str, mode: WhiteSpace) -> WhitespaceTransform<'_> {
    if !mode.collapses() {
        return WhitespaceTransform {
            text: Cow::Borrowed(text),
            suppressed: BTreeSet::new(),
        };
    }
    let mut bytes = text.as_bytes().to_vec();
    let mut suppressed = BTreeSet::new();
    let mut in_collapsible_run = false;
    for (offset, character) in text.char_indices() {
        let collapsible = matches!(character, ' ' | '\t' | '\r')
            || (character == '\n' && !mode.preserves_newlines());
        if !collapsible {
            in_collapsible_run = false;
            continue;
        }
        // Every collapsed ASCII whitespace has one byte, so replacing it with
        // U+0020 preserves all source byte/UTF-16 offsets used by editing.
        bytes[offset] = b' ';
        if in_collapsible_run {
            suppressed.insert(offset);
        }
        in_collapsible_run = true;
    }
    WhitespaceTransform {
        text: Cow::Owned(String::from_utf8(bytes).expect("ASCII whitespace replacement is UTF-8")),
        suppressed,
    }
}

fn line_ranges(
    context: &mut ShapeContext,
    font: &FontFace,
    text: &str,
    config: WrapConfig,
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
            config,
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
            config,
            &mut result,
        )?;
    }
    Ok(result)
}

#[derive(Clone, Copy)]
struct WrapConfig {
    max_width: f32,
    font_size: f32,
    emergency: bool,
}

fn wrap_paragraph(
    context: &mut ShapeContext,
    font: &FontFace,
    text: &str,
    paragraph: Range<usize>,
    config: WrapConfig,
    output: &mut Vec<Range<usize>>,
) -> Result<(), TextError> {
    let value = &text[paragraph.clone()];
    if value.is_empty() {
        output.push(paragraph.start..paragraph.start);
        return Ok(());
    }
    if !config.max_width.is_finite() {
        output.push(paragraph);
        return Ok(());
    }
    let shaped = shape(context, font, value, config.font_size)?;
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
            if width + cluster.advance > config.max_width && end > start {
                if let Some(candidate) = last_allowed.filter(|candidate| *candidate > start) {
                    end = candidate;
                } else if !config.emergency {
                    // `overflow-wrap: normal` lets an unbreakable token exceed
                    // the line box; consume through the next legal break/end.
                    continue;
                }
                break;
            }
            width += cluster.advance;
            end = cluster.end;
            if cluster.break_allowed {
                last_allowed = Some(cluster.end);
            }
            if width > config.max_width {
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
    transformed: &WhitespaceTransform<'_>,
    layout: &mut TextLayout,
    line_index: usize,
    bytes: Range<usize>,
    options: TextOptions,
) -> Result<(), TextError> {
    let shaped = shape(
        context,
        font,
        &transformed.text[bytes.clone()],
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
        let suppressed_cluster = transformed.suppressed.contains(&global_start);
        for glyph in raw_cluster.glyphs {
            if suppressed_cluster {
                continue;
            }
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

fn apply_alignment(layout: &mut TextLayout, shaping_text: &str, options: TextOptions) {
    if !options.max_width.is_finite() || options.max_width <= 0.0 {
        return;
    }
    let last_line = layout.lines.len().saturating_sub(1);
    for (line_index, line) in layout.lines.iter_mut().enumerate() {
        let extra = (options.max_width - line.width).max(0.0);
        if extra <= f32::EPSILON {
            continue;
        }
        let offset = match options.text_align {
            TextAlign::Start | TextAlign::Left | TextAlign::Justify => 0.0,
            TextAlign::End | TextAlign::Right => extra,
            TextAlign::Center => extra * 0.5,
        };
        if offset != 0.0 {
            for glyph in &mut layout.glyphs[line.glyphs.clone()] {
                glyph.x += offset;
            }
            for caret in layout
                .carets
                .iter_mut()
                .filter(|caret| caret.line == line_index)
            {
                caret.x += offset;
            }
        } else if options.text_align == TextAlign::Justify && line_index != last_line {
            let spaces = layout.clusters[line.clusters.clone()]
                .iter()
                .filter(|cluster| {
                    shaping_text[cluster.bytes.clone()]
                        .chars()
                        .all(char::is_whitespace)
                })
                .map(|cluster| cluster.bytes.end)
                .collect::<Vec<_>>();
            if !spaces.is_empty() {
                let gap = extra / usize_to_f32(spaces.len());
                for glyph in &mut layout.glyphs[line.glyphs.clone()] {
                    let byte = layout.clusters[glyph.cluster].bytes.start;
                    glyph.x += usize_to_f32(spaces.partition_point(|end| *end <= byte)) * gap;
                }
                for caret in layout
                    .carets
                    .iter_mut()
                    .filter(|caret| caret.line == line_index)
                {
                    caret.x +=
                        usize_to_f32(spaces.partition_point(|end| *end <= caret.byte_offset)) * gap;
                }
                line.width = options.max_width;
            }
        }
    }
    layout.width = layout
        .lines
        .iter()
        .map(|line| line.width)
        .fold(0.0, f32::max);
}

fn apply_ellipsis(
    context: &mut ShapeContext,
    font: &FontFace,
    layout: &mut TextLayout,
    options: TextOptions,
) -> Result<(), TextError> {
    let ellipsis = shape(context, font, "…", options.font_size)?;
    let ellipsis_glyphs = ellipsis
        .first()
        .map_or(&[][..], |cluster| cluster.glyphs.as_slice());
    let ellipsis_width = ellipsis_glyphs
        .iter()
        .map(|glyph| glyph.advance)
        .sum::<f32>();
    if ellipsis_glyphs.is_empty() || ellipsis_width > options.max_width {
        return Ok(());
    }
    let original = std::mem::take(&mut layout.glyphs);
    let mut replacement = Vec::with_capacity(original.len());
    layout.missing_glyphs = 0;
    for (line_index, line) in layout.lines.iter_mut().enumerate() {
        let line_start = replacement.len();
        if line.width <= options.max_width {
            for cluster_index in line.clusters.clone() {
                let cluster = &mut layout.clusters[cluster_index];
                let start = replacement.len();
                replacement.extend_from_slice(&original[cluster.glyphs.clone()]);
                cluster.glyphs = start..replacement.len();
            }
        } else {
            let mut x = 0.0_f32;
            let mut truncated = false;
            for cluster_index in line.clusters.clone() {
                let cluster = &mut layout.clusters[cluster_index];
                let source = &original[cluster.glyphs.clone()];
                let cluster_width = source.iter().map(|glyph| glyph.advance).sum::<f32>();
                let start = replacement.len();
                if !truncated && x + cluster_width + ellipsis_width <= options.max_width {
                    replacement.extend_from_slice(source);
                    x += cluster_width;
                } else if !truncated {
                    for glyph in ellipsis_glyphs {
                        replacement.push(PositionedGlyph {
                            id: glyph.id,
                            cluster: cluster_index,
                            line: line_index,
                            x: x + glyph.x,
                            y: line.baseline - glyph.y,
                            advance: glyph.advance,
                        });
                        x += glyph.advance;
                    }
                    truncated = true;
                }
                cluster.glyphs = start..replacement.len();
            }
            line.width = x;
        }
        line.glyphs = line_start..replacement.len();
    }
    layout.glyphs = replacement;
    layout.missing_glyphs = layout.glyphs.iter().filter(|glyph| glyph.id == 0).count();
    layout.width = layout
        .lines
        .iter()
        .map(|line| line.width)
        .fold(0.0, f32::max);
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
    use super::{
        OverflowWrap, TextAlign, TextOptions, TextOverflow, WhiteSpace, grapheme_table,
        layout_text, utf16_offset,
    };
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
                        white_space: WhiteSpace::PreWrap,
                        overflow_wrap: OverflowWrap::Anywhere,
                        text_align: TextAlign::Start,
                        text_overflow: TextOverflow::Clip,
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
                white_space: WhiteSpace::PreWrap,
                overflow_wrap: OverflowWrap::Anywhere,
                text_align: TextAlign::Start,
                text_overflow: TextOverflow::Clip,
            },
            TextOptions {
                font_size: 12.0,
                line_height: f32::NAN,
                max_width: 10.0,
                white_space: WhiteSpace::PreWrap,
                overflow_wrap: OverflowWrap::Anywhere,
                text_align: TextAlign::Start,
                text_overflow: TextOverflow::Clip,
            },
            TextOptions {
                font_size: 12.0,
                line_height: 16.0,
                max_width: 0.0,
                white_space: WhiteSpace::PreWrap,
                overflow_wrap: OverflowWrap::Anywhere,
                text_align: TextAlign::Start,
                text_overflow: TextOverflow::Clip,
            },
        ] {
            assert_eq!(options.validate(), Err(TextError::InvalidOptions));
        }
        assert!(
            TextOptions {
                font_size: 12.0,
                line_height: 16.0,
                max_width: f32::INFINITY,
                white_space: WhiteSpace::PreWrap,
                overflow_wrap: OverflowWrap::Anywhere,
                text_align: TextAlign::Start,
                text_overflow: TextOverflow::Clip,
            }
            .validate()
            .is_ok()
        );
    }

    #[test]
    fn m6_whitespace_wrap_alignment_and_ellipsis_keep_source_carets() {
        let font = crate::FontFace::from_bytes(1, 1, 0, crate::conformance_font())
            .expect("conformance font");
        let source = "\u{ea60}  \u{ea61}\n\u{ea62}";
        let normal = layout_text(
            &mut ShapeContext::new(),
            &font,
            source,
            TextOptions {
                font_size: 16.0,
                line_height: 20.0,
                max_width: 200.0,
                white_space: WhiteSpace::Normal,
                overflow_wrap: OverflowWrap::Normal,
                text_align: TextAlign::Center,
                text_overflow: TextOverflow::Clip,
            },
        )
        .expect("normal layout");
        assert_eq!(normal.lines.len(), 1, "normal collapses the hard break");
        assert!(normal.glyphs.first().is_some_and(|glyph| glyph.x > 0.0));
        assert_eq!(
            normal.carets.last().map(|caret| caret.byte_offset),
            Some(source.len())
        );
        assert!(normal.carets.iter().any(|caret| caret.byte_offset == 4));

        let edge_spaces = layout_text(
            &mut ShapeContext::new(),
            &font,
            "  \u{ea60}  ",
            TextOptions {
                font_size: 16.0,
                line_height: 20.0,
                max_width: 200.0,
                white_space: WhiteSpace::Normal,
                overflow_wrap: OverflowWrap::Normal,
                text_align: TextAlign::Start,
                text_overflow: TextOverflow::Clip,
            },
        )
        .expect("edge-space layout");
        let icon = layout_text(
            &mut ShapeContext::new(),
            &font,
            "\u{ea60}",
            TextOptions {
                font_size: 16.0,
                line_height: 20.0,
                max_width: 200.0,
                white_space: WhiteSpace::Normal,
                overflow_wrap: OverflowWrap::Normal,
                text_align: TextAlign::Start,
                text_overflow: TextOverflow::Clip,
            },
        )
        .expect("icon layout");
        assert!((edge_spaces.width - icon.width).abs() <= f32::EPSILON);
        assert_eq!(
            edge_spaces.carets.last().map(|caret| caret.byte_offset),
            Some("  \u{ea60}  ".len())
        );

        let ellipsis = layout_text(
            &mut ShapeContext::new(),
            &font,
            "\u{ea60}\u{ea61}\u{ea62}\u{ea63}",
            TextOptions {
                font_size: 16.0,
                line_height: 20.0,
                max_width: 24.0,
                white_space: WhiteSpace::Nowrap,
                overflow_wrap: OverflowWrap::Normal,
                text_align: TextAlign::Start,
                text_overflow: TextOverflow::Ellipsis,
            },
        )
        .expect("ellipsis layout");
        assert_eq!(ellipsis.lines.len(), 1);
        assert!(ellipsis.width <= 24.0);
        assert_eq!(
            ellipsis.carets.last().map(|caret| caret.utf16_offset),
            Some(4)
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
    advance_of: impl Fn(usize) -> f32,
    max_width: f32,
) -> Vec<usize> {
    soft_break_offsets_with_mode(text, advance_of, max_width, true)
}

/// Equivalent to [`soft_break_offsets`] with explicit emergency-wrap policy.
pub fn soft_break_offsets_with_mode(
    text: &str,
    advance_of: impl Fn(usize) -> f32,
    max_width: f32,
    emergency_wrap: bool,
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
    // Byte offset and code-point index of the last break opportunity.
    let mut last_allowed: Option<(usize, usize)> = None;
    for (index, (offset, character)) in text.char_indices().enumerate() {
        if character == '\n' {
            line_start = offset + character.len_utf8();
            width = 0.0;
            last_allowed = None;
            continue;
        }
        let advance = advance_of(index);
        if width + advance > max_width && offset > line_start {
            // Prefer the last opportunity on this line; with none, break right
            // here so a single long word is split instead of overflowing.
            let candidate = last_allowed
                .filter(|(candidate, _)| *candidate > line_start && *candidate <= offset);
            let Some((split, split_index)) =
                candidate.or_else(|| emergency_wrap.then_some((offset, index)))
            else {
                width += advance;
                continue;
            };
            breaks.push(split);
            line_start = split;
            width = (split_index..index).map(&advance_of).sum::<f32>();
            last_allowed = None;
        }
        width += advance;
        let end = offset + character.len_utf8();
        if allowed.contains(&end) {
            last_allowed = Some((end, index + 1));
        }
    }
    breaks
}

#[cfg(test)]
mod soft_break_tests {
    use super::soft_break_offsets;

    /// Ten units per code point keeps the arithmetic readable in the assertions.
    fn uniform(_index: usize) -> f32 {
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
