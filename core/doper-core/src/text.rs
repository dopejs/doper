use std::{collections::HashMap, sync::Arc};

use doper_abi::{
    AbiError, EditorDecorationKind, GlyphBitmapResource, GlyphPlacementResource,
    GlyphResourceBatch, GlyphResourceCommand, GlyphResourceInstruction, GlyphSpanResource,
    MAX_GLYPH_RESOURCES_BYTES, MAX_SYSTEM_TEXT_METRIC_INSTRUCTIONS, ResourceKind,
    SFNT_FONT_DATA_BYTES_OFFSET, SFNT_FONT_DATA_OFFSET, SFNT_FONT_FACE_INDEX_OFFSET,
    SystemTextMetric, SystemTextMetricBatch, SystemTextMetricCommand,
};
use doper_layout::{BoxConstraints, IntrinsicMeasurer, Size};
use doper_paint::{EditorDecoration, ShapedGlyphRun, TextPaintResolver, TextStyleResource};
use doper_scene::{NodeId, Scene};
use doper_text::{CaretStop, FontFace, GlyphAtlas, TextEngine, TextLayout, TextOptions};

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

/// Transactional text layout, raster, and derived-resource owner.
pub(crate) struct CoreTextSystem {
    engine: TextEngine,
    atlas: GlyphAtlas,
    fonts: HashMap<u32, Option<FontFace>>,
    system_metrics: HashMap<(u32, u32), SystemTextMetric>,
    forced_fallback: HashMap<NodeId, ForcedFallbackRun>,
    edit_overrides: HashMap<NodeId, Arc<str>>,
    editor_decorations: HashMap<NodeId, Vec<EditorDecoration>>,
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
    pub(crate) fn set_edit_overrides(&mut self, overrides: HashMap<NodeId, Arc<str>>) {
        self.edit_overrides = overrides;
    }

    pub(crate) fn update_editor_decorations(
        &mut self,
        scene: &Scene,
        visual: Option<ActiveEditorVisual>,
        caret_visible: bool,
    ) {
        self.editor_decorations.clear();
        let Some(visual) = visual else {
            return;
        };
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
            let carets = approximate_caret_stops(&value, style.font_size, style.line_height);
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
            match instruction.command {
                SystemTextMetricCommand::Release {
                    string_id,
                    style_id,
                } => {
                    if !self.system_metrics.contains_key(&(string_id, style_id)) {
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
            return Size::ZERO;
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
        self.edit_overrides.get(&node).map(AsRef::as_ref)
    }

    fn editor_decorations(&self, node: NodeId) -> &[EditorDecoration] {
        self.editor_decorations
            .get(&node)
            .map_or(&[], Vec::as_slice)
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

fn approximate_caret_stops(text: &str, font_size: f32, line_height: f32) -> Vec<CaretStop> {
    let advance = font_size * 0.6;
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
    for (byte_offset, character) in text.char_indices() {
        utf16 = utf16.saturating_add(u32::try_from(character.len_utf16()).unwrap_or(2));
        if character == '\n' {
            line = line.saturating_add(1);
            x = 0.0;
        } else {
            x += advance;
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
        if !self.edit_overrides.contains_key(&node)
            && let Some(metric) = self.system_metrics.get(&(run.string_id, run.style_id))
        {
            self.metrics.system_metric_hits = self.metrics.system_metric_hits.saturating_add(1);
            return constraints.constrain(Size::new(
                metric.max_line_width,
                system_text_height(metric.line_count, style.line_height),
            ));
        }
        self.metrics.system_metric_misses = self.metrics.system_metric_misses.saturating_add(1);
        let Some(text) = self.text_value(scene, node) else {
            return Size::ZERO;
        };
        approximate_fallback_measure(&text, constraints, style.font_size, style.line_height)
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

fn approximate_fallback_measure(
    string: &str,
    constraints: BoxConstraints,
    font_size: f32,
    line_height: f32,
) -> Size {
    let mut line_count = 0_usize;
    let mut longest_line = 0_usize;
    for line in string.split('\n') {
        line_count += 1;
        longest_line = longest_line.max(line.chars().count());
    }
    let width = usize_to_f32(longest_line) * font_size * 0.6;
    let height = usize_to_f32(line_count) * line_height;
    constraints.constrain(Size::new(width, height))
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
