use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use doper_abi::{
    AbiError, EditorDecorationKind, GlyphBitmapResource, GlyphPlacementResource,
    GlyphResourceBatch, GlyphResourceCommand, GlyphResourceInstruction, GlyphSpanResource,
    MAX_GLYPH_RESOURCES_BYTES, MAX_SYSTEM_TEXT_METRIC_INSTRUCTIONS, ResourceKind,
    SFNT_FONT_DATA_BYTES_OFFSET, SFNT_FONT_DATA_OFFSET, SFNT_FONT_FACE_INDEX_OFFSET,
    SystemTextMetric, SystemTextMetricBatch, SystemTextMetricCommand,
};
use doper_layout::{BoxConstraints, IntrinsicMeasurer, Size};
use doper_paint::{EditorDecoration, ShapedGlyphRun, TextPaintResolver, TextStyleResource};
use doper_scene::{NodeId, Scene, TextRun};
use doper_text::{
    CaretStop, FontFace, GlyphAtlas, TextEngine, TextLayout, TextOptions, soft_break_offsets,
};

use crate::editing::ActiveEditorVisual;

/// Cumulative explicit-font path counters.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CoreTextMetrics {
    /// Runs shaped successfully by Core.
    pub shaped_runs: u64,
    /// Runs sent to the whole-run system-font fallback.
    pub fallback_runs: u64,
    /// Browser-measured fallback runs resolved without approximation.
    pub system_metric_hits: u64,
    /// Fallback runs temporarily measured by the deterministic approximation.
    pub system_metric_misses: u64,
    /// System-font metric entries inserted or refreshed by Host.
    pub system_metric_upserts: u64,
    /// System-font metric entries released after their last active run.
    pub system_metric_releases: u64,
    /// Derived glyph spans defined for a backend.
    pub spans_defined: u64,
    /// Superseded glyph spans released from a backend.
    pub spans_released: u64,
}

#[derive(Clone)]
struct PreparedRun {
    string_id: u32,
    style_id: u32,
    font_id: u32,
    font_size: f32,
    max_width_bits: u32,
    paint_id: u32,
    layout: Arc<TextLayout>,
    span_id: u32,
    device_pixel_ratio_bits: u32,
    font: FontFace,
    content_hash: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ForcedFallbackRun {
    string: u32,
    style: u32,
    font: u32,
    content_hash: u64,
}

/// One fallback run's wrapping, produced by measurement and reused by paint.
///
/// Measurement is the only place that knows both the value and the width it has
/// to fit, so it records the result rather than making paint and hit testing
/// each re-derive it -- and each risk deriving it differently.
struct WrappedRun {
    /// Byte offsets where a soft break starts a new visual line.
    breaks: Vec<usize>,
    /// The value with those breaks materialized, for the whole-run draw.
    display: Arc<str>,
}

/// Transactional text layout, raster, and derived-resource owner.
pub(crate) struct CoreTextSystem {
    engine: TextEngine,
    atlas: GlyphAtlas,
    fonts: HashMap<u32, Option<FontFace>>,
    system_metrics: HashMap<(u32, u32), SystemTextMetric>,
    forced_fallback: HashMap<NodeId, ForcedFallbackRun>,
    edit_overrides: HashMap<NodeId, Arc<str>>,
    editor_decorations: HashMap<NodeId, Vec<EditorDecoration>>,
    editor_scroll: HashMap<NodeId, [f32; 2]>,
    /// Soft break offsets and the wrapped string each fallback run last measured.
    wrapped_fallback: HashMap<NodeId, WrappedRun>,
    /// Editable nodes that scroll horizontally instead of wrapping.
    non_wrapping: HashSet<NodeId>,
    active: HashMap<NodeId, PreparedRun>,
    candidate: Option<HashMap<NodeId, PreparedRun>>,
    staged: Vec<GlyphResourceInstruction>,
    pending_batch: Vec<u8>,
    next_span_id: u64,
    device_pixel_ratio: f32,
    metrics: CoreTextMetrics,
}

impl Default for CoreTextSystem {
    fn default() -> Self {
        Self {
            engine: TextEngine::default(),
            atlas: GlyphAtlas::default(),
            fonts: HashMap::new(),
            system_metrics: HashMap::new(),
            forced_fallback: HashMap::new(),
            edit_overrides: HashMap::new(),
            editor_decorations: HashMap::new(),
            editor_scroll: HashMap::new(),
            wrapped_fallback: HashMap::new(),
            non_wrapping: HashSet::new(),
            active: HashMap::new(),
            candidate: None,
            staged: Vec::new(),
            pending_batch: Vec::new(),
            next_span_id: 1,
            device_pixel_ratio: 1.0,
            metrics: CoreTextMetrics::default(),
        }
    }
}

impl CoreTextSystem {
    pub(crate) fn editor_caret_stops(&self, scene: &Scene, node: NodeId) -> Option<Vec<CaretStop>> {
        let source = self.candidate.as_ref().unwrap_or(&self.active);
        if let Some(run) = source.get(&node) {
            return Some(run.layout.carets.clone());
        }
        let text_run = scene.text_run(node)?;
        let style = scene
            .resource(text_run.style_id)
            .filter(|resource| resource.kind == ResourceKind::TextStyle)
            .and_then(|resource| TextStyleResource::decode(text_run.style_id, resource).ok())?;
        let value = self.text_value(scene, node)?;
        Some(self.fallback_caret_stops(scene, node, text_run, &value, &style))
    }

    pub(crate) fn set_edit_overrides(&mut self, overrides: HashMap<NodeId, Arc<str>>) {
        self.edit_overrides = overrides;
    }

    pub(crate) fn set_non_wrapping(&mut self, nodes: HashSet<NodeId>) {
        self.non_wrapping = nodes;
    }

    pub(crate) fn update_editor_decorations(
        &mut self,
        scene: &Scene,
        visual: Option<ActiveEditorVisual>,
        caret_visible: bool,
    ) {
        self.editor_decorations.clear();
        self.editor_scroll.clear();
        let Some(visual) = visual else {
            return;
        };
        self.editor_scroll.insert(visual.node, visual.scroll_offset);
        let source = self.candidate.as_ref().unwrap_or(&self.active);
        let decorations = if let Some(run) = source.get(&visual.node) {
            decorations_from_carets(&run.layout.carets, visual, caret_visible)
        } else {
            let Some(text_run) = scene.text_run(visual.node) else {
                return;
            };
            let Some(style) = scene
                .resource(text_run.style_id)
                .filter(|resource| resource.kind == ResourceKind::TextStyle)
                .and_then(|resource| TextStyleResource::decode(text_run.style_id, resource).ok())
            else {
                return;
            };
            let Some(value) = self.text_value(scene, visual.node) else {
                return;
            };
            let carets = self.fallback_caret_stops(scene, visual.node, text_run, &value, &style);
            decorations_from_carets(&carets, visual, caret_visible)
        };
        self.editor_decorations.insert(visual.node, decorations);
    }

    pub(crate) fn validate_system_metrics(
        &self,
        batch: &SystemTextMetricBatch,
    ) -> Result<(), &'static str> {
        let mut released = 0_usize;
        let mut inserted = 0_usize;
        for instruction in &batch.instructions {
            match &instruction.command {
                SystemTextMetricCommand::Release {
                    string_id,
                    style_id,
                } => {
                    if !self.system_metrics.contains_key(&(*string_id, *style_id)) {
                        return Err("system text metric release references an unavailable pair");
                    }
                    released = released.saturating_add(1);
                }
                SystemTextMetricCommand::Upsert(metric) => {
                    if !self
                        .system_metrics
                        .contains_key(&(metric.string_id, metric.style_id))
                    {
                        inserted = inserted.saturating_add(1);
                    }
                }
            }
        }
        let retained = self
            .system_metrics
            .len()
            .checked_sub(released)
            .and_then(|value| value.checked_add(inserted))
            .ok_or("system text metric cache size overflow")?;
        if retained
            > usize::try_from(MAX_SYSTEM_TEXT_METRIC_INSTRUCTIONS)
                .map_err(|_| "system text metric cache limit does not fit usize")?
        {
            return Err("system text metric cache exceeds its entry limit");
        }
        Ok(())
    }

    pub(crate) fn apply_system_metrics(&mut self, batch: SystemTextMetricBatch) -> Vec<(u32, u32)> {
        let mut changed = Vec::with_capacity(batch.instructions.len());
        for instruction in batch.instructions {
            match instruction.command {
                SystemTextMetricCommand::Upsert(metric) => {
                    let key = (metric.string_id, metric.style_id);
                    if self.system_metrics.get(&key) != Some(&metric) {
                        self.system_metrics.insert(key, metric);
                        changed.push(key);
                    }
                    self.metrics.system_metric_upserts =
                        self.metrics.system_metric_upserts.saturating_add(1);
                }
                SystemTextMetricCommand::Release {
                    string_id,
                    style_id,
                } => {
                    self.system_metrics.remove(&(string_id, style_id));
                    changed.push((string_id, style_id));
                    self.metrics.system_metric_releases =
                        self.metrics.system_metric_releases.saturating_add(1);
                }
            }
        }
        changed
    }

    pub(crate) fn begin_frame(&mut self) {
        self.candidate = Some(self.active.clone());
        self.staged.clear();
    }

    pub(crate) fn prepare_resources(&mut self, scene: &Scene) -> Vec<NodeId> {
        let edit_overrides = &self.edit_overrides;
        self.forced_fallback.retain(|node, forced| {
            scene.text_run(*node).is_some_and(|text| {
                text.string_id == forced.string && text.style_id == forced.style
            }) && scene.ref_prop(*node, doper_abi::Prop::Font) == Some(forced.font)
                && text_content_hash(scene, edit_overrides, *node) == Some(forced.content_hash)
        });
        let mut candidate = self.candidate.take().unwrap_or_else(|| self.active.clone());
        candidate.retain(|node, run| {
            scene.resolve(*node).is_some()
                && scene.text_run(*node).is_some_and(|text| {
                    text.string_id == run.string_id && text.style_id == run.style_id
                })
                && scene.ref_prop(*node, doper_abi::Prop::Font) == Some(run.font_id)
                && text_content_hash(scene, edit_overrides, *node) == Some(run.content_hash)
        });

        let removed_releases = self
            .active
            .iter()
            .filter(|(node, active)| {
                candidate.get(node).is_none_or(|next| {
                    next.span_id != active.span_id
                        || next.device_pixel_ratio_bits != self.device_pixel_ratio.to_bits()
                })
            })
            .count();
        let mut projected_bytes = 16_usize.saturating_add(removed_releases.saturating_mul(8));
        let nodes = candidate.keys().copied().collect::<Vec<_>>();
        let mut definitions = Vec::new();
        let mut fallback_nodes = Vec::new();
        for node in nodes {
            let Some(run) = candidate.get(&node).cloned() else {
                continue;
            };
            if run.span_id != 0 && run.device_pixel_ratio_bits == self.device_pixel_ratio.to_bits()
            {
                continue;
            }
            let Some(span_id) = self.allocate_span_id() else {
                self.force_fallback(node, &run);
                fallback_nodes.push(node);
                candidate.remove(&node);
                self.metrics.fallback_runs = self.metrics.fallback_runs.saturating_add(1);
                continue;
            };
            let Ok(span) = self.build_span(span_id, &run) else {
                self.force_fallback(node, &run);
                fallback_nodes.push(node);
                candidate.remove(&node);
                self.metrics.fallback_runs = self.metrics.fallback_runs.saturating_add(1);
                continue;
            };
            let Some(next_bytes) = projected_bytes.checked_add(span_wire_bytes(&span)) else {
                self.force_fallback(node, &run);
                fallback_nodes.push(node);
                candidate.remove(&node);
                self.metrics.fallback_runs = self.metrics.fallback_runs.saturating_add(1);
                continue;
            };
            if next_bytes > MAX_GLYPH_RESOURCES_BYTES {
                self.force_fallback(node, &run);
                fallback_nodes.push(node);
                candidate.remove(&node);
                self.metrics.fallback_runs = self.metrics.fallback_runs.saturating_add(1);
                continue;
            }
            projected_bytes = next_bytes;
            if let Some(next) = candidate.get_mut(&node) {
                next.span_id = span_id;
                next.device_pixel_ratio_bits = self.device_pixel_ratio.to_bits();
            }
            definitions.push(GlyphResourceInstruction {
                flags: 0,
                command: GlyphResourceCommand::Define(span),
            });
        }

        for (node, active) in &self.active {
            if candidate
                .get(node)
                .is_none_or(|next| next.span_id != active.span_id)
            {
                self.staged.push(GlyphResourceInstruction {
                    flags: 0,
                    command: GlyphResourceCommand::Release {
                        span_id: active.span_id,
                    },
                });
            }
        }
        self.staged.extend(definitions);
        self.candidate = Some(candidate);
        fallback_nodes
    }

    pub(crate) fn commit_frame(&mut self) -> Result<bool, AbiError> {
        let changed = !self.staged.is_empty();
        if changed {
            self.pending_batch = GlyphResourceBatch {
                instructions: std::mem::take(&mut self.staged),
            }
            .encode()?;
            let decoded = GlyphResourceBatch::decode(&self.pending_batch)?;
            for instruction in decoded.instructions {
                match instruction.command {
                    GlyphResourceCommand::Define(_) => {
                        self.metrics.spans_defined = self.metrics.spans_defined.saturating_add(1);
                    }
                    GlyphResourceCommand::Release { .. } => {
                        self.metrics.spans_released = self.metrics.spans_released.saturating_add(1);
                    }
                }
            }
        }
        self.active = self.candidate.take().unwrap_or_else(|| self.active.clone());
        Ok(changed)
    }

    pub(crate) fn has_staged_changes(&self) -> bool {
        !self.staged.is_empty()
    }

    pub(crate) fn take_glyph_resources(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.pending_batch)
    }

    pub(crate) fn has_pending_resources(&self) -> bool {
        !self.pending_batch.is_empty()
    }

    pub(crate) const fn metrics(&self) -> CoreTextMetrics {
        self.metrics
    }

    pub(crate) fn set_device_pixel_ratio(&mut self, value: f32) -> bool {
        if self.device_pixel_ratio.to_bits() == value.to_bits() {
            return false;
        }
        self.device_pixel_ratio = value;
        self.atlas.invalidate_device_pixel_ratio();
        true
    }

    fn font(&mut self, scene: &Scene, font_id: u32) -> Option<FontFace> {
        if let Some(cached) = self.fonts.get(&font_id) {
            return cached.clone();
        }
        let parsed = decode_font(scene, font_id).and_then(|(face_index, bytes)| {
            FontFace::from_bytes(font_id, 1, face_index, bytes).ok()
        });
        self.fonts.insert(font_id, parsed.clone());
        parsed
    }

    #[allow(clippy::cast_precision_loss)]
    fn build_span(&mut self, span_id: u32, run: &PreparedRun) -> Result<GlyphSpanResource, ()> {
        let mut bitmap_indices = HashMap::<u16, u32>::new();
        let mut bitmaps = Vec::new();
        let mut placements = Vec::new();
        for glyph in &run.layout.glyphs {
            let bitmap = self
                .atlas
                .rasterize(&run.font, run.font_size, self.device_pixel_ratio, glyph.id)
                .map_err(|_| ())?;
            if bitmap.data.is_empty() {
                continue;
            }
            let bitmap_index = if let Some(index) = bitmap_indices.get(&glyph.id).copied() {
                index
            } else {
                let index = u32::try_from(bitmaps.len()).map_err(|_| ())?;
                bitmap_indices.insert(glyph.id, index);
                bitmaps.push(GlyphBitmapResource {
                    glyph_id: bitmap.glyph_id,
                    left: bitmap.left as f32,
                    top: bitmap.top as f32,
                    width: bitmap.width,
                    height: bitmap.height,
                    device_pixel_ratio: bitmap.device_pixel_ratio(),
                    data: Arc::clone(&bitmap.data),
                });
                index
            };
            placements.push(GlyphPlacementResource {
                bitmap_index,
                x: glyph.x,
                y: glyph.y,
            });
        }
        Ok(GlyphSpanResource {
            span_id,
            paint_id: run.paint_id,
            bitmaps,
            placements,
        })
    }

    fn allocate_span_id(&mut self) -> Option<u32> {
        let result = u32::try_from(self.next_span_id).ok()?;
        self.next_span_id = self.next_span_id.saturating_add(1);
        Some(result)
    }
}

impl IntrinsicMeasurer for CoreTextSystem {
    fn measure(&mut self, scene: &Scene, node: NodeId, constraints: BoxConstraints) -> Size {
        let Some(text_run) = scene.text_run(node) else {
            // An image with no explicit box takes its pixel dimensions, so a
            // thumbnail does not silently collapse to nothing.
            return image_intrinsic_size(scene, node).unwrap_or(Size::ZERO);
        };
        let Some(font_id) = scene.ref_prop(node, doper_abi::Prop::Font) else {
            return self.measure_system_fallback(scene, node, constraints);
        };
        let forced = ForcedFallbackRun {
            string: text_run.string_id,
            style: text_run.style_id,
            font: font_id,
            content_hash: self.text_content_hash(scene, node).unwrap_or_default(),
        };
        if self.forced_fallback.get(&node) == Some(&forced) {
            self.candidate_mut().remove(&node);
            return self.measure_system_fallback(scene, node, constraints);
        }
        self.forced_fallback.remove(&node);
        let Some(string) = self.text_value(scene, node) else {
            return self.measure_system_fallback(scene, node, constraints);
        };
        let content_hash = hash_bytes(string.as_bytes());
        let Some(style) = scene
            .resource(text_run.style_id)
            .filter(|resource| resource.kind == ResourceKind::TextStyle)
            .and_then(|resource| TextStyleResource::decode(text_run.style_id, resource).ok())
        else {
            return self.measure_system_fallback(scene, node, constraints);
        };
        let Some(font) = self.font(scene, font_id) else {
            self.candidate_mut().remove(&node);
            return self.measure_system_fallback(scene, node, constraints);
        };
        let max_width = constraints.max_width.max(f32::EPSILON);
        let options = TextOptions {
            font_size: style.font_size,
            line_height: style.line_height,
            max_width,
        };
        let Ok(layout) = self.engine.layout(&font, &string, options) else {
            self.candidate_mut().remove(&node);
            return self.measure_system_fallback(scene, node, constraints);
        };
        if layout.missing_glyphs != 0 {
            self.candidate_mut().remove(&node);
            return self.measure_system_fallback(scene, node, constraints);
        }
        let previous_span = self
            .candidate_mut()
            .get(&node)
            .filter(|previous| {
                previous.string_id == text_run.string_id
                    && previous.style_id == text_run.style_id
                    && previous.font_id == font_id
                    && previous.max_width_bits == max_width.to_bits()
                    && previous.content_hash == content_hash
            })
            .map_or(0, |previous| previous.span_id);
        let device_pixel_ratio_bits = self.device_pixel_ratio.to_bits();
        self.candidate_mut().insert(
            node,
            PreparedRun {
                string_id: text_run.string_id,
                style_id: text_run.style_id,
                font_id,
                font_size: style.font_size,
                max_width_bits: max_width.to_bits(),
                paint_id: style.paint_id,
                layout: Arc::clone(&layout),
                span_id: previous_span,
                device_pixel_ratio_bits,
                font,
                content_hash,
            },
        );
        self.metrics.shaped_runs = self.metrics.shaped_runs.saturating_add(1);
        constraints.constrain(Size::new(layout.width, layout.height))
    }
}

impl TextPaintResolver for CoreTextSystem {
    fn glyph_run(&self, node: NodeId) -> Option<ShapedGlyphRun> {
        let source = self.candidate.as_ref().unwrap_or(&self.active);
        let run = source.get(&node)?;
        (run.span_id != 0).then_some(ShapedGlyphRun {
            font_id: run.font_id,
            font_size: run.font_size,
            span_id: run.span_id,
        })
    }

    fn inline_fallback(&self, node: NodeId) -> Option<&str> {
        // The wrapped form when measurement produced one: the backend draws a
        // whole-run fallback line per `\n`, so materializing the soft breaks is
        // what makes it wrap without a second draw command.
        self.edit_overrides.get(&node)?;
        Some(
            self.wrapped_fallback
                .get(&node)
                .map_or_else(
                    || self.edit_overrides.get(&node).map(Arc::as_ref),
                    |wrapped| Some(wrapped.display.as_ref()),
                )
                .unwrap_or(""),
        )
    }

    fn editor_decorations(&self, node: NodeId) -> &[EditorDecoration] {
        self.editor_decorations
            .get(&node)
            .map_or(&[], Vec::as_slice)
    }

    fn editor_scroll(&self, node: NodeId) -> [f32; 2] {
        self.editor_scroll.get(&node).copied().unwrap_or([0.0, 0.0])
    }
}

fn decorations_from_carets(
    carets: &[CaretStop],
    visual: ActiveEditorVisual,
    caret_visible: bool,
) -> Vec<EditorDecoration> {
    let mut decorations = Vec::new();
    let start = visual.selection[0].min(visual.selection[1]);
    let end = visual.selection[0].max(visual.selection[1]);
    if start == end {
        if caret_visible && let Some(caret) = closest_caret(carets, end) {
            decorations.push(EditorDecoration {
                rect: [caret.x, caret.y, 1.5, caret.height],
                rgba: 0x1111_11ff,
                kind: EditorDecorationKind::Caret,
            });
        }
    } else {
        append_range_decorations(
            &mut decorations,
            carets,
            start,
            end,
            0x3390_ff66,
            EditorDecorationKind::Selection,
            false,
        );
    }
    if let Some([start, end]) = visual.composition {
        append_range_decorations(
            &mut decorations,
            carets,
            start,
            end,
            0x2563_ebff,
            EditorDecorationKind::Composition,
            true,
        );
    }
    decorations
}

fn append_range_decorations(
    output: &mut Vec<EditorDecoration>,
    carets: &[CaretStop],
    start: u32,
    end: u32,
    rgba: u32,
    kind: EditorDecorationKind,
    underline: bool,
) {
    if start >= end {
        return;
    }
    let Some(first) = closest_caret(carets, start) else {
        return;
    };
    let Some(last) = closest_caret(carets, end) else {
        return;
    };
    for line in first.line..=last.line {
        let line_carets = carets.iter().filter(|caret| caret.line == line);
        let maximum_x = line_carets
            .clone()
            .map(|caret| caret.x)
            .fold(0.0_f32, f32::max);
        let Some(sample) = line_carets.clone().next() else {
            continue;
        };
        let left = if line == first.line { first.x } else { 0.0 };
        let right = if line == last.line { last.x } else { maximum_x };
        let width = (right - left).max(if underline { 1.0 } else { 0.0 });
        let (y, height) = if underline {
            (sample.y + sample.height - 1.5, 1.5)
        } else {
            (sample.y, sample.height)
        };
        output.push(EditorDecoration {
            rect: [left, y, width, height],
            rgba,
            kind,
        });
    }
}

fn closest_caret(carets: &[CaretStop], offset: u32) -> Option<CaretStop> {
    carets
        .iter()
        .copied()
        .min_by_key(|caret| (i64::from(caret.utf16_offset) - i64::from(offset)).unsigned_abs())
}

/// Estimated advance as a fraction of the font size, for unmeasured code points.
///
/// Roughly right for Latin and badly wrong for full-width scripts, which is why
/// every editable run is measured; this only covers the frames between typing a
/// code point and the Host reporting its advance.
const ESTIMATED_ADVANCE_RATIO: f32 = 0.6;

fn advance_for(advances: Option<&HashMap<char, f32>>, estimate: f32, character: char) -> f32 {
    advances
        .and_then(|measured| measured.get(&character).copied())
        .unwrap_or(estimate)
}

/// Rebuilds a value with its soft breaks turned into real newlines.
///
/// The whole-run fallback draw splits on `\n` and offsets by the line height, so
/// this is what makes a wrapped run paint as several lines without a second
/// display command. Offsets into this string do not match the value's, which is
/// why it is only ever handed to paint.
fn materialize_breaks(text: &str, breaks: &[usize]) -> Arc<str> {
    if breaks.is_empty() {
        return Arc::from(text);
    }
    let mut output = String::with_capacity(text.len() + breaks.len());
    let mut previous = 0;
    for offset in breaks {
        output.push_str(&text[previous..*offset]);
        output.push('\n');
        previous = *offset;
    }
    output.push_str(&text[previous..]);
    Arc::from(output)
}

/// Builds fallback caret stops from measured per-code-point advances.
///
/// A code point missing from `advances` falls back to an estimate, which is
/// roughly right for Latin and badly wrong for full-width scripts. These stops
/// both paint the caret and resolve pointer hit testing to a text offset, so an
/// unmeasured run mis-selects words as well as painting the caret off the glyph.
/// The Host measures every run a Scene node makes editable.
///
/// `breaks` are the soft breaks measurement chose. Unlike a `\n` they consume no
/// character, so the offset either side of one is the same text position on two
/// different visual lines.
fn caret_stops(text: &str, breaks: &[usize], advances: &[f32], line_height: f32) -> Vec<CaretStop> {
    let mut carets = Vec::with_capacity(text.chars().count().saturating_add(1));
    let mut utf16 = 0_u32;
    let mut line = 0_usize;
    let mut x = 0.0_f32;
    carets.push(CaretStop {
        byte_offset: 0,
        utf16_offset: 0,
        line,
        x,
        y: 0.0,
        height: line_height,
    });
    for (index, (byte_offset, character)) in text.char_indices().enumerate() {
        if breaks.contains(&byte_offset) {
            line = line.saturating_add(1);
            x = 0.0;
        }
        utf16 = utf16.saturating_add(u32::try_from(character.len_utf16()).unwrap_or(2));
        if character == '\n' {
            line = line.saturating_add(1);
            x = 0.0;
        } else {
            x += advances.get(index).copied().unwrap_or(0.0);
        }
        carets.push(CaretStop {
            byte_offset: byte_offset.saturating_add(character.len_utf8()),
            utf16_offset: utf16,
            line,
            x,
            y: usize_to_f32(line) * line_height,
            height: line_height,
        });
    }
    carets
}

impl CoreTextSystem {
    /// Caret stops for a run that has no shaped layout yet, using the Host's
    /// measured advances when it has published them for this pair.
    fn fallback_caret_stops(
        &self,
        scene: &Scene,
        node: NodeId,
        run: TextRun,
        value: &str,
        style: &TextStyleResource,
    ) -> Vec<CaretStop> {
        let advances = self.value_advances(scene, run, value, style.font_size);
        // The breaks measurement recorded, not a fresh computation: paint, hit
        // testing and the caret have to agree on where the lines are.
        let breaks = self
            .wrapped_fallback
            .get(&node)
            .map_or(&[][..], |wrapped| wrapped.breaks.as_slice());
        caret_stops(value, breaks, &advances, style.line_height)
    }

    /// One advance per code point of `value`, in order.
    ///
    /// Uses the positional measurement when the editing value still equals the
    /// string it was measured from: those advances come from prefix differences
    /// and carry contextual width, which the per-code-point table cannot — CJK
    /// fonts contract consecutive full-width punctuation, so summing isolated
    /// widths drifts the caret one notch per adjacent pair. A diverged value
    /// falls back to the table, and an unmeasured code point to the estimate.
    fn value_advances(&self, scene: &Scene, run: TextRun, value: &str, font_size: f32) -> Vec<f32> {
        let metric = self.system_metrics.get(&(run.string_id, run.style_id));
        if let Some(metric) = metric
            && !metric.positional_advances.is_empty()
            && metric.positional_advances.len() == value.chars().count()
            && scene_string(scene, run.string_id) == Some(value)
        {
            return metric.positional_advances.clone();
        }
        let estimate = font_size * ESTIMATED_ADVANCE_RATIO;
        let table = metric
            .filter(|metric| !metric.advances.is_empty())
            .map(|metric| metric.advances.iter().copied().collect::<HashMap<_, _>>());
        // Contraction is a property of the font, not of the measured string, so
        // it still applies once the editing value has diverged from it. Without
        // this the caret drifts by the removed width at every adjacent pair --
        // permanently, for an application that never writes the value back.
        let contractions = metric
            .filter(|metric| !metric.contractions.is_empty())
            .map(|metric| {
                metric
                    .contractions
                    .iter()
                    .map(|entry| {
                        (
                            (entry.first, entry.second),
                            (entry.delta, entry.first_delta),
                        )
                    })
                    .collect::<HashMap<_, _>>()
            });
        let characters = value.chars().collect::<Vec<_>>();
        (0..characters.len())
            .map(|index| {
                let character = characters[index];
                if character == '\n' {
                    return 0.0;
                }
                let mut advance = advance_for(table.as_ref(), estimate, character);
                let pair = |first: char, second: char| {
                    contractions
                        .as_ref()
                        .and_then(|table| table.get(&(first, second)).copied())
                };
                // A font trims one half of a contracting pair, and which half
                // decides where the caret between them belongs. Attributing the
                // whole adjustment to the following glyph -- what a prefix
                // difference does -- leaves that stop on top of it, and the
                // caret cannot be placed between the two marks at all.
                if let Some(next) = characters.get(index + 1).copied()
                    && next != '\n'
                    && let Some((_, first_delta)) = pair(character, next)
                {
                    advance += first_delta;
                }
                if index > 0
                    && let previous = characters[index - 1]
                    && previous != '\n'
                    && let Some((delta, first_delta)) = pair(previous, character)
                {
                    advance += delta - first_delta;
                }
                advance.max(0.0)
            })
            .collect()
    }

    /// The code points the Host measured for this pair, keyed for lookup.
    ///
    /// Keyed by code point rather than by position because the caret is placed
    /// against the live editing value while the pair names the Scene string. The
    /// two differ for the frames between a keystroke and the Shell round-trip,
    /// and during IME composition they differ by the entire preedit run, which
    /// the Shell never sees. The Host measures the preedit text into this same
    /// table, so composition underlines and the IME candidate-window rectangles
    /// land on the glyphs instead of on a 0.6em estimate.
    fn candidate_mut(&mut self) -> &mut HashMap<NodeId, PreparedRun> {
        self.candidate.get_or_insert_with(|| self.active.clone())
    }

    fn force_fallback(&mut self, node: NodeId, run: &PreparedRun) {
        self.forced_fallback.insert(
            node,
            ForcedFallbackRun {
                string: run.string_id,
                style: run.style_id,
                font: run.font_id,
                content_hash: run.content_hash,
            },
        );
    }

    fn measure_system_fallback(
        &mut self,
        scene: &Scene,
        node: NodeId,
        constraints: BoxConstraints,
    ) -> Size {
        self.metrics.fallback_runs = self.metrics.fallback_runs.saturating_add(1);
        let Some(run) = scene.text_run(node) else {
            return Size::ZERO;
        };
        let Some(style) = scene
            .resource(run.style_id)
            .filter(|resource| resource.kind == ResourceKind::TextStyle)
            .and_then(|resource| TextStyleResource::decode(run.style_id, resource).ok())
        else {
            return Size::ZERO;
        };
        let metric = self.system_metrics.get(&(run.string_id, run.style_id));
        // The browser's own line measurement is the most faithful answer, but it
        // describes the Scene string. An active editing session shows a value
        // that runs ahead of it, so it only applies while the two still agree —
        // which includes the whole time a focused field has not been typed into,
        // and is what keeps focus and blur from resizing the box.
        let metric_fresh = self
            .edit_overrides
            .get(&node)
            .is_none_or(|value| scene_string(scene, run.string_id) == Some(value.as_ref()));
        let Some(text) = self.text_value(scene, node) else {
            return Size::ZERO;
        };
        // Summed from the same measured advances the caret uses. Falling back to
        // font_size * 0.6 here would shrink a full-width run to 60% of its real
        // width for as long as it is being edited, which reads as the text
        // jumping the moment the field is typed into.
        let advances = self.value_advances(scene, run, &text, style.font_size);
        // A single-line field scrolls its value instead; wrapping one would turn
        // a long value into a paragraph inside a one-line box.
        let wrap_width = if self.non_wrapping.contains(&node) {
            f32::INFINITY
        } else {
            constraints.max_width
        };
        let breaks = soft_break_offsets(
            &text,
            |index| advances.get(index).copied().unwrap_or(0.0),
            wrap_width,
        );
        // The wrapped display is refreshed on EVERY measurement path before any
        // early return: paint serves it in place of the live value, so leaving
        // it behind shows the previous text. Undoing back to the exact Scene
        // string used to take the metric branch below without updating it, and
        // the undone edit stayed on screen while the caret moved through the
        // restored value.
        self.wrapped_fallback.insert(
            node,
            WrappedRun {
                display: materialize_breaks(&text, &breaks),
                breaks: breaks.clone(),
            },
        );
        if let Some(metric) = metric
            && metric_fresh
            && breaks.is_empty()
        {
            self.metrics.system_metric_hits = self.metrics.system_metric_hits.saturating_add(1);
            return constraints.constrain(Size::new(
                metric.max_line_width,
                system_text_height(metric.line_count, style.line_height),
            ));
        }
        self.metrics.system_metric_misses = self.metrics.system_metric_misses.saturating_add(1);
        wrapped_fallback_measure(&text, &breaks, &advances, constraints, style.line_height)
    }

    fn text_value(&self, scene: &Scene, node: NodeId) -> Option<Arc<str>> {
        if let Some(value) = self.edit_overrides.get(&node) {
            return Some(Arc::clone(value));
        }
        let run = scene.text_run(node)?;
        let string = scene
            .resource(run.string_id)
            .filter(|resource| resource.kind == ResourceKind::Utf8String)
            .and_then(|resource| std::str::from_utf8(&resource.bytes).ok())?;
        Some(Arc::from(string))
    }

    fn text_content_hash(&self, scene: &Scene, node: NodeId) -> Option<u64> {
        text_content_hash(scene, &self.edit_overrides, node)
    }
}

#[allow(clippy::cast_precision_loss)]
fn system_text_height(line_count: u32, line_height: f32) -> f32 {
    // The ABI caps line_count at 2^20, which is exactly representable by f32.
    line_count as f32 * line_height
}

fn decode_font(scene: &Scene, font_id: u32) -> Option<(u32, Arc<[u8]>)> {
    let resource = scene
        .resource(font_id)
        .filter(|resource| resource.kind == ResourceKind::Font)?;
    let bytes = resource.bytes.as_ref();
    let face_index = read_u32(bytes, SFNT_FONT_FACE_INDEX_OFFSET)?;
    let data_len = usize::try_from(read_u32(bytes, SFNT_FONT_DATA_BYTES_OFFSET)?).ok()?;
    let data_end = SFNT_FONT_DATA_OFFSET.checked_add(data_len)?;
    Some((
        face_index,
        Arc::from(bytes.get(SFNT_FONT_DATA_OFFSET..data_end)?),
    ))
}

/// Measures a fallback run against the soft breaks it will be painted with.
fn wrapped_fallback_measure(
    text: &str,
    breaks: &[usize],
    advances: &[f32],
    constraints: BoxConstraints,
    line_height: f32,
) -> Size {
    let mut line_count = 1_usize;
    let mut longest_line = 0.0_f32;
    let mut width = 0.0_f32;
    for (index, (offset, character)) in text.char_indices().enumerate() {
        if breaks.contains(&offset) {
            longest_line = longest_line.max(width);
            line_count += 1;
            width = 0.0;
        }
        if character == '\n' {
            longest_line = longest_line.max(width);
            line_count += 1;
            width = 0.0;
            continue;
        }
        width += advances.get(index).copied().unwrap_or(0.0);
    }
    longest_line = longest_line.max(width);
    let height = usize_to_f32(line_count) * line_height;
    constraints.constrain(Size::new(longest_line, height))
}

/// The immutable UTF-8 string a text run names, when it resolves.
fn scene_string(scene: &Scene, string_id: u32) -> Option<&str> {
    let resource = scene
        .resource(string_id)
        .filter(|resource| resource.kind == ResourceKind::Utf8String)?;
    std::str::from_utf8(&resource.bytes).ok()
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn text_content_hash(
    scene: &Scene,
    overrides: &HashMap<NodeId, Arc<str>>,
    node: NodeId,
) -> Option<u64> {
    if let Some(value) = overrides.get(&node) {
        return Some(hash_bytes(value.as_bytes()));
    }
    let run = scene.text_run(node)?;
    let bytes = &scene
        .resource(run.string_id)
        .filter(|resource| resource.kind == ResourceKind::Utf8String)?
        .bytes;
    Some(hash_bytes(bytes))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}

#[allow(clippy::cast_precision_loss)]
fn usize_to_f32(value: usize) -> f32 {
    value.min(1 << f32::MANTISSA_DIGITS) as f32
}

fn span_wire_bytes(span: &GlyphSpanResource) -> usize {
    let bitmap_bytes = span.bitmaps.iter().fold(0_usize, |total, bitmap| {
        total.saturating_add(28).saturating_add(
            bitmap
                .data
                .len()
                .saturating_add((4 - (bitmap.data.len() % 4)) % 4),
        )
    });
    24_usize
        .saturating_add(bitmap_bytes)
        .saturating_add(span.placements.len().saturating_mul(12))
}

/// Returns an image node's natural size from its resource, in logical pixels.
///
/// Interpreting stored pixels as logical units keeps the demo-scale case simple
/// and predictable; a device-pixel-ratio-aware image box is a separate decision.
fn image_intrinsic_size(scene: &Scene, node: NodeId) -> Option<Size> {
    let resource_id = scene.ref_prop(node, doper_abi::Prop::Image)?;
    let resource = scene.resource(resource_id)?;
    if resource.kind != doper_abi::ResourceKind::Image {
        return None;
    }
    // Converted through `u16` so the cast is lossless rather than merely
    // unlikely to lose precision: the resource byte budget puts any real image
    // far below this bound, and a larger one is rejected instead of rounded.
    let read = |offset: usize| -> Option<f32> {
        let bytes = resource.bytes.get(offset..offset + 4)?;
        let value = u32::from_le_bytes(bytes.try_into().ok()?);
        u16::try_from(value).ok().map(f32::from)
    };
    Some(Size::new(
        read(doper_abi::IMAGE_BITMAP_WIDTH_OFFSET)?,
        read(doper_abi::IMAGE_BITMAP_HEIGHT_OFFSET)?,
    ))
}
