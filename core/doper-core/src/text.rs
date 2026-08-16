use std::{collections::HashMap, sync::Arc};

use doper_abi::{
    AbiError, GlyphBitmapResource, GlyphPlacementResource, GlyphResourceBatch,
    GlyphResourceCommand, GlyphResourceInstruction, GlyphSpanResource, MAX_GLYPH_RESOURCES_BYTES,
    ResourceKind, SFNT_FONT_DATA_BYTES_OFFSET, SFNT_FONT_DATA_OFFSET, SFNT_FONT_FACE_INDEX_OFFSET,
};
use doper_layout::{BoxConstraints, IntrinsicMeasurer, Size};
use doper_paint::{ShapedGlyphRun, TextPaintResolver, TextStyleResource};
use doper_scene::{NodeId, Scene};
use doper_text::{FontFace, GlyphAtlas, TextEngine, TextLayout, TextOptions};

/// Cumulative explicit-font path counters.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CoreTextMetrics {
    /// Runs shaped successfully by Core.
    pub shaped_runs: u64,
    /// Runs sent to the whole-run system-font fallback.
    pub fallback_runs: u64,
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
}

/// Transactional text layout, raster, and derived-resource owner.
pub(crate) struct CoreTextSystem {
    engine: TextEngine,
    atlas: GlyphAtlas,
    fonts: HashMap<u32, Option<FontFace>>,
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
    pub(crate) fn begin_frame(&mut self) {
        self.candidate = Some(self.active.clone());
        self.staged.clear();
    }

    pub(crate) fn prepare_resources(&mut self, scene: &Scene) {
        let mut candidate = self.candidate.take().unwrap_or_else(|| self.active.clone());
        candidate.retain(|node, run| {
            scene.resolve(*node).is_some()
                && scene.text_run(*node).is_some_and(|text| {
                    text.string_id == run.string_id && text.style_id == run.style_id
                })
                && scene.ref_prop(*node, doper_abi::Prop::Font) == Some(run.font_id)
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
        for node in nodes {
            let Some(run) = candidate.get(&node).cloned() else {
                continue;
            };
            if run.span_id != 0 && run.device_pixel_ratio_bits == self.device_pixel_ratio.to_bits()
            {
                continue;
            }
            let Some(span_id) = self.allocate_span_id() else {
                candidate.remove(&node);
                self.metrics.fallback_runs = self.metrics.fallback_runs.saturating_add(1);
                continue;
            };
            let Ok(span) = self.build_span(span_id, &run) else {
                candidate.remove(&node);
                self.metrics.fallback_runs = self.metrics.fallback_runs.saturating_add(1);
                continue;
            };
            let Some(next_bytes) = projected_bytes.checked_add(span_wire_bytes(&span)) else {
                candidate.remove(&node);
                self.metrics.fallback_runs = self.metrics.fallback_runs.saturating_add(1);
                continue;
            };
            if next_bytes > MAX_GLYPH_RESOURCES_BYTES {
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
        let fallback = || fallback_measure(scene, node, constraints);
        let Some(font_id) = scene.ref_prop(node, doper_abi::Prop::Font) else {
            return fallback();
        };
        let Some(string) = scene
            .resource(text_run.string_id)
            .filter(|resource| resource.kind == ResourceKind::Utf8String)
            .and_then(|resource| std::str::from_utf8(&resource.bytes).ok())
        else {
            return fallback();
        };
        let Some(style) = scene
            .resource(text_run.style_id)
            .filter(|resource| resource.kind == ResourceKind::TextStyle)
            .and_then(|resource| TextStyleResource::decode(text_run.style_id, resource).ok())
        else {
            return fallback();
        };
        let Some(font) = self.font(scene, font_id) else {
            self.candidate_mut().remove(&node);
            self.metrics.fallback_runs = self.metrics.fallback_runs.saturating_add(1);
            return fallback();
        };
        let max_width = constraints.max_width.max(f32::EPSILON);
        let options = TextOptions {
            font_size: style.font_size,
            line_height: style.line_height,
            max_width,
        };
        let Ok(layout) = self.engine.layout(&font, string, options) else {
            self.candidate_mut().remove(&node);
            self.metrics.fallback_runs = self.metrics.fallback_runs.saturating_add(1);
            return fallback();
        };
        if layout.missing_glyphs != 0 {
            self.candidate_mut().remove(&node);
            self.metrics.fallback_runs = self.metrics.fallback_runs.saturating_add(1);
            return fallback();
        }
        let previous_span = self
            .candidate_mut()
            .get(&node)
            .filter(|previous| {
                previous.string_id == text_run.string_id
                    && previous.style_id == text_run.style_id
                    && previous.font_id == font_id
                    && previous.max_width_bits == max_width.to_bits()
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
}

impl CoreTextSystem {
    fn candidate_mut(&mut self) -> &mut HashMap<NodeId, PreparedRun> {
        self.candidate.get_or_insert_with(|| self.active.clone())
    }
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

fn fallback_measure(scene: &Scene, node: NodeId, constraints: BoxConstraints) -> Size {
    let Some(run) = scene.text_run(node) else {
        return Size::ZERO;
    };
    let Some(string) = scene
        .resource(run.string_id)
        .filter(|resource| resource.kind == ResourceKind::Utf8String)
        .and_then(|resource| std::str::from_utf8(&resource.bytes).ok())
    else {
        return Size::ZERO;
    };
    let Some(style) = scene
        .resource(run.style_id)
        .filter(|resource| resource.kind == ResourceKind::TextStyle)
        .and_then(|resource| TextStyleResource::decode(run.style_id, resource).ok())
    else {
        return Size::ZERO;
    };
    let mut line_count = 0_usize;
    let mut longest_line = 0_usize;
    for line in string.split('\n') {
        line_count += 1;
        longest_line = longest_line.max(line.chars().count());
    }
    let width = usize_to_f32(longest_line) * style.font_size * 0.6;
    let height = usize_to_f32(line_count) * style.line_height;
    constraints.constrain(Size::new(width, height))
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
