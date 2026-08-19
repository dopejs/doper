use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use doper_abi::{
    DisplayCommand, DisplayInstruction, DisplayList, EditorDecorationKind,
    IMAGE_BITMAP_HEIGHT_OFFSET, IMAGE_BITMAP_WIDTH_OFFSET, NodeKind, Prop, ResourceKind,
};
use doper_layout::LayoutSnapshot;
use doper_scene::{BitSet, DirtyDomain, NodeId, Scene};

use crate::{AffineResource, PaintError, SolidPaint, TextStyleResource};

/// Immutable, shareable encoded drawing commands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Picture {
    bytes: Arc<[u8]>,
    hash: u64,
}

impl Picture {
    /// Returns canonical DisplayList bytes.
    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Returns the deterministic FNV-1a content hash.
    #[must_use]
    pub const fn hash(&self) -> u64 {
        self.hash
    }
}

/// Paint cache and invalidation counters.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PaintMetrics {
    /// Successful full Picture builds.
    pub builds: u64,
    /// Frames reusing the prior immutable Picture.
    pub cache_hits: u64,
    /// Commands in the most recent built Picture.
    pub last_command_count: usize,
    /// Dirty nodes whose rebuilt Picture hash did not change.
    pub over_invalidated_frames: u64,
    /// Immutable subtree Pictures rebuilt across successful frames.
    pub subtree_builds: u64,
    /// Unchanged child subtree Pictures reused while rebuilding an ancestor.
    pub subtree_cache_hits: u64,
}

/// Result of one paint decision.
#[derive(Clone, Debug)]
pub struct PaintOutcome {
    /// Active immutable Picture.
    pub picture: Picture,
    /// Whether the DisplayList was rebuilt.
    pub rebuilt: bool,
}

/// Core-owned shaped text reference installed before DisplayList replay.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShapedGlyphRun {
    /// Explicit SFNT font resource referenced by the Scene node.
    pub font_id: u32,
    /// Logical font size used for shaping and rasterization.
    pub font_size: f32,
    /// Derived glyph-span resource emitted through the glyph batch protocol.
    pub span_id: u32,
}

/// Core-derived local editor overlay rendered in the same transform and clip stack as text.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EditorDecoration {
    /// Local logical-pixel rectangle.
    pub rect: [f32; 4],
    /// Packed `0xRRGGBBAA` color.
    pub rgba: u32,
    /// Selection, caret, or composition semantics.
    pub kind: EditorDecorationKind,
}

/// Read-only bridge from the text subsystem into paint.
pub trait TextPaintResolver {
    /// Returns a complete shaped run, or `None` to use the whole-run fallback.
    fn glyph_run(&self, node: NodeId) -> Option<ShapedGlyphRun>;
    /// Returns a Core-owned fallback string that has not become a Scene resource.
    fn inline_fallback(&self, node: NodeId) -> Option<&str>;
    /// Returns transient selection, composition, and caret overlays for one active editor.
    fn editor_decorations(&self, node: NodeId) -> &[EditorDecoration];
}

/// One Core-authored skeleton rectangle in a scroll container's content space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlaceholderRect {
    /// Rectangle `[x, y, width, height]` in the scrolled content space.
    pub rect: [f32; 4],
    /// Straight (non-premultiplied) RGBA colour.
    pub rgba: u32,
}

/// Read-only bridge from the virtual-scrolling planner into paint.
pub trait VirtualPaintResolver {
    /// Returns skeletons for visible items the Shell has not materialized yet.
    fn placeholders(&self, node: NodeId) -> &[PlaceholderRect];
}

struct NoPlaceholders;

impl VirtualPaintResolver for NoPlaceholders {
    fn placeholders(&self, _node: NodeId) -> &[PlaceholderRect] {
        &[]
    }
}

struct FallbackTextPaint;

impl TextPaintResolver for FallbackTextPaint {
    fn glyph_run(&self, _node: NodeId) -> Option<ShapedGlyphRun> {
        None
    }

    fn inline_fallback(&self, _node: NodeId) -> Option<&str> {
        None
    }

    fn editor_decorations(&self, _node: NodeId) -> &[EditorDecoration] {
        &[]
    }
}

/// Deterministic Scene/Layout-to-DisplayList builder.
#[derive(Default)]
pub struct PaintEngine {
    current: Option<Picture>,
    subtrees: HashMap<NodeId, Arc<CachedSubtree>>,
    topology: Vec<NodeId>,
    metrics: PaintMetrics,
}

#[derive(Debug)]
struct CachedSubtree {
    children: Arc<[Arc<CachedSubtree>]>,
    /// Child identifiers this subtree was built from.
    ///
    /// A window shift removes one item and adds another, so a parent's child
    /// count can stay the same while its children change; only the identifiers
    /// reveal that its own instructions are stale.
    child_ids: Arc<[NodeId]>,
    command_count: usize,
    local: Arc<[DisplayInstruction]>,
}

impl PaintEngine {
    /// Creates an empty paint engine.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns cumulative cache/build counters.
    #[must_use]
    pub const fn metrics(&self) -> PaintMetrics {
        self.metrics
    }

    /// Builds or reuses a complete immutable Picture.
    pub fn paint(
        &mut self,
        scene: &Scene,
        layout: &LayoutSnapshot,
        geometry_changed: &BitSet,
        force_full: bool,
    ) -> Result<PaintOutcome, PaintError> {
        self.paint_frame(
            scene,
            layout,
            geometry_changed,
            force_full,
            &FallbackTextPaint,
            &NoPlaceholders,
        )
    }

    /// Builds or reuses a Picture with optional Core-shaped glyph runs.
    ///
    /// # Errors
    ///
    /// Returns a paint error when Scene, layout, and dirty state disagree.
    pub fn paint_with_text(
        &mut self,
        scene: &Scene,
        layout: &LayoutSnapshot,
        geometry_changed: &BitSet,
        force_full: bool,
        text: &impl TextPaintResolver,
    ) -> Result<PaintOutcome, PaintError> {
        self.paint_frame(
            scene,
            layout,
            geometry_changed,
            force_full,
            text,
            &NoPlaceholders,
        )
    }

    /// Builds or reuses a Picture with Core-shaped glyphs and virtual skeletons.
    pub fn paint_frame(
        &mut self,
        scene: &Scene,
        layout: &LayoutSnapshot,
        geometry_changed: &BitSet,
        force_full: bool,
        text: &impl TextPaintResolver,
        virtual_items: &impl VirtualPaintResolver,
    ) -> Result<PaintOutcome, PaintError> {
        if scene.ids() != layout.ids() {
            return Err(PaintError::LayoutTopologyMismatch);
        }
        if geometry_changed.len() < scene.len() {
            return Err(PaintError::GeometryBitmapLengthMismatch {
                actual: geometry_changed.len(),
                expected: scene.len(),
            });
        }
        let topology_unchanged = self.topology == scene.ids();
        let paint_dirty = has_dirty(scene, DirtyDomain::Paint)
            || has_dirty(scene, DirtyDomain::PaintSelf)
            || geometry_changed.iter_ones().next().is_some();
        if !force_full
            && topology_unchanged
            && !paint_dirty
            && let Some(picture) = self.current.clone()
        {
            self.metrics.cache_hits += 1;
            return Ok(PaintOutcome {
                picture,
                rebuilt: false,
            });
        }

        let rebuild = rebuild_subtrees(scene, geometry_changed, &self.subtrees, force_full);
        let (display_list, updates, subtree_builds, subtree_cache_hits) =
            build_display_list(scene, layout, &self.subtrees, &rebuild, text, virtual_items)?;
        let command_count = display_list.instructions.len();
        let bytes = display_list.encode()?;
        let picture = Picture {
            hash: fnv1a64(&bytes),
            bytes: Arc::from(bytes),
        };
        if paint_dirty
            && self
                .current
                .as_ref()
                .is_some_and(|current| current.hash == picture.hash)
        {
            self.metrics.over_invalidated_frames += 1;
        }
        self.current = Some(picture.clone());
        self.subtrees.extend(updates);
        if !topology_unchanged {
            // Keep the cache bounded by the live Scene rather than by history.
            let live: HashSet<NodeId> = scene.ids().iter().copied().collect();
            self.subtrees.retain(|node, _| live.contains(node));
        }
        self.topology.clear();
        self.topology.extend_from_slice(scene.ids());
        self.metrics.builds += 1;
        self.metrics.last_command_count = command_count;
        self.metrics.subtree_builds = self.metrics.subtree_builds.saturating_add(subtree_builds);
        self.metrics.subtree_cache_hits = self
            .metrics
            .subtree_cache_hits
            .saturating_add(subtree_cache_hits);
        Ok(PaintOutcome {
            picture,
            rebuilt: true,
        })
    }
}

fn rebuild_subtrees(
    scene: &Scene,
    geometry_changed: &BitSet,
    current: &HashMap<NodeId, Arc<CachedSubtree>>,
    force_full: bool,
) -> Vec<bool> {
    if force_full {
        return vec![true; scene.len()];
    }
    // A topology change used to rebuild every node and throw the subtree cache
    // away, which made scrolling a virtual list repaint the entire Scene every
    // frame. Cached subtrees are keyed by NodeId, so a node that survived with
    // the same children and the same paint state is still valid; only the new
    // nodes and the parents whose child list changed have to be rebuilt.
    let paint = scene.dirty(DirtyDomain::Paint);
    let paint_self = scene.dirty(DirtyDomain::PaintSelf);
    let mut rebuild = vec![false; scene.len()];
    for (index, node) in scene.ids().iter().copied().enumerate() {
        let cached = current.get(&node);
        rebuild[index] = paint.contains(index)
            || paint_self.contains(index)
            || geometry_changed.contains(index)
            || cached.is_none_or(|entry| !children_match(scene, node, entry));
    }
    for index in (0..scene.len()).rev() {
        if !rebuild[index] {
            continue;
        }
        let Some(node) = scene.ids().get(index).copied() else {
            continue;
        };
        if let Some(parent) = scene.parent(node)
            && let Some(parent_index) = scene.resolve(parent)
        {
            rebuild[parent_index] = true;
        }
    }
    rebuild
}

/// Whether a cached subtree was built from the node's current children.
fn children_match(scene: &Scene, node: NodeId, cached: &CachedSubtree) -> bool {
    let mut expected = cached.child_ids.iter().copied();
    let mut child = scene.first_child(node);
    while let Some(current) = child {
        if expected.next() != Some(current) {
            return false;
        }
        child = scene.next_sibling(current);
    }
    expected.next().is_none()
}

type SubtreeBuild = (DisplayList, HashMap<NodeId, Arc<CachedSubtree>>, u64, u64);

fn build_display_list(
    scene: &Scene,
    layout: &LayoutSnapshot,
    current: &HashMap<NodeId, Arc<CachedSubtree>>,
    rebuild: &[bool],
    text: &impl TextPaintResolver,
    virtual_items: &impl VirtualPaintResolver,
) -> Result<SubtreeBuild, PaintError> {
    let mut updates = HashMap::new();
    let mut subtree_builds = 0_u64;
    let mut subtree_cache_hits = 0_u64;
    for (index, node) in scene.ids().iter().copied().enumerate().rev() {
        if !rebuild.get(index).copied().unwrap_or(true) && current.contains_key(&node) {
            continue;
        }
        let local: Arc<[DisplayInstruction]> =
            Arc::from(build_node(scene, layout, index, node, text, virtual_items)?);
        let mut children = Vec::new();
        let mut command_count = local.len().checked_add(1).ok_or_else(overflow)?;
        let mut child = scene.first_child(node);
        while let Some(child_id) = child {
            let cached = updates
                .get(&child_id)
                .or_else(|| current.get(&child_id))
                .cloned()
                .ok_or(PaintError::MissingCachedSubtree { node: child_id })?;
            if !scene
                .resolve(child_id)
                .and_then(|child_index| rebuild.get(child_index))
                .copied()
                .unwrap_or(true)
            {
                subtree_cache_hits = subtree_cache_hits.saturating_add(1);
            }
            command_count = command_count
                .checked_add(cached.command_count)
                .ok_or_else(overflow)?;
            children.push(cached);
            child = scene.next_sibling(child_id);
        }
        let child_ids: Arc<[NodeId]> = {
            let mut ids = Vec::new();
            let mut walk = scene.first_child(node);
            while let Some(child_id) = walk {
                ids.push(child_id);
                walk = scene.next_sibling(child_id);
            }
            Arc::from(ids)
        };
        updates.insert(
            node,
            Arc::new(CachedSubtree {
                child_ids,
                children: Arc::from(children),
                command_count,
                local,
            }),
        );
        subtree_builds = subtree_builds.saturating_add(1);
    }

    let Some(root_id) = scene.ids().first().copied() else {
        return Ok((
            DisplayList {
                instructions: Vec::new(),
            },
            updates,
            subtree_builds,
            subtree_cache_hits,
        ));
    };
    let root = updates
        .get(&root_id)
        .or_else(|| current.get(&root_id))
        .ok_or(PaintError::MissingCachedSubtree { node: root_id })?;
    let mut instructions = Vec::with_capacity(root.command_count);
    let mut stack = vec![FlattenItem::Subtree(root)];
    while let Some(item) = stack.pop() {
        match item {
            FlattenItem::Subtree(subtree) => {
                instructions.extend_from_slice(&subtree.local);
                stack.push(FlattenItem::Restore);
                for child in subtree.children.iter().rev() {
                    stack.push(FlattenItem::Subtree(child));
                }
            }
            FlattenItem::Restore => push(&mut instructions, DisplayCommand::Restore),
        }
    }
    Ok((
        DisplayList { instructions },
        updates,
        subtree_builds,
        subtree_cache_hits,
    ))
}

enum FlattenItem<'a> {
    Restore,
    Subtree(&'a CachedSubtree),
}

fn build_node(
    scene: &Scene,
    layout: &LayoutSnapshot,
    index: usize,
    node: NodeId,
    text: &impl TextPaintResolver,
    virtual_items: &impl VirtualPaintResolver,
) -> Result<Vec<DisplayInstruction>, PaintError> {
    let (offset, size) = layout
        .geometry_at(index)
        .ok_or(PaintError::MissingGeometry { node })?;
    let mut instructions = Vec::with_capacity(6);
    push(&mut instructions, DisplayCommand::Save);
    push(
        &mut instructions,
        DisplayCommand::Transform([1.0, 0.0, 0.0, 1.0, offset.x, offset.y]),
    );

    if let Some(transform_id) = scene.ref_prop(node, Prop::Transform) {
        let resource = typed_resource(scene, transform_id, ResourceKind::Affine)?;
        let affine = AffineResource::decode(transform_id, resource)?;
        push(&mut instructions, DisplayCommand::Transform(affine.matrix));
    }
    if let Some(opacity) = scene.f32_prop(node, Prop::Opacity) {
        if !(0.0..=1.0).contains(&opacity) {
            return Err(PaintError::InvalidOpacity { node });
        }
        push(&mut instructions, DisplayCommand::Alpha(opacity));
    }
    // A scroll viewport clips its children; an editable clips its own value,
    // which the fallback path does not wrap and so can be arbitrarily wider than
    // the box it was measured into. Without this a long line paints across
    // whatever sits beside and below the field.
    if matches!(
        scene.kind(node),
        Some(NodeKind::Scroll | NodeKind::EditableText)
    ) {
        push(
            &mut instructions,
            DisplayCommand::ClipRect([0.0, 0.0, size.width, size.height]),
        );
    }
    if let Some(paint_id) = scene.ref_prop(node, Prop::BackgroundColor) {
        let resource = typed_resource(scene, paint_id, ResourceKind::Paint)?;
        SolidPaint::decode(paint_id, resource)?;
        push(
            &mut instructions,
            DisplayCommand::FillRect {
                rect: [0.0, 0.0, size.width, size.height],
                paint_id,
            },
        );
    }
    if let Some(image_id) = scene.ref_prop(node, Prop::Image) {
        // The whole image is drawn into the node's box. Scene validation has
        // already checked that the declared dimensions describe the pixels that
        // follow, so the source rectangle here cannot exceed the resource.
        let resource = typed_resource(scene, image_id, ResourceKind::Image)?;
        let (image_width, image_height) = image_dimensions(image_id, resource)?;
        push(
            &mut instructions,
            DisplayCommand::DrawImage {
                image_id,
                source: [0.0, 0.0, image_width, image_height],
                destination: [0.0, 0.0, size.width, size.height],
            },
        );
    }
    let editor_decorations = text.editor_decorations(node);
    for decoration in editor_decorations
        .iter()
        .filter(|decoration| decoration.kind == EditorDecorationKind::Selection)
    {
        push(
            &mut instructions,
            DisplayCommand::DrawEditorDecoration {
                rect: decoration.rect,
                rgba: decoration.rgba,
                kind: decoration.kind,
            },
        );
    }
    if let Some(text_run) = scene.text_run(node) {
        typed_resource(scene, text_run.string_id, ResourceKind::Utf8String)?;
        let style_resource = typed_resource(scene, text_run.style_id, ResourceKind::TextStyle)?;
        let style = TextStyleResource::decode(text_run.style_id, style_resource)?;
        let paint_resource = typed_resource(scene, style.paint_id, ResourceKind::Paint)?;
        SolidPaint::decode(style.paint_id, paint_resource)?;
        if let Some(glyph_run) = text.glyph_run(node) {
            push(
                &mut instructions,
                DisplayCommand::DrawGlyphRun {
                    font_id: glyph_run.font_id,
                    size: glyph_run.font_size,
                    origin: [0.0, 0.0],
                    glyph_span_id: glyph_run.span_id,
                },
            );
        } else if let Some(inline) = text.inline_fallback(node) {
            push(
                &mut instructions,
                DisplayCommand::DrawTextInlineFallback {
                    font_description_id: text_run.style_id,
                    origin: [0.0, style.font_size],
                    text: inline.to_owned(),
                },
            );
        } else {
            push(
                &mut instructions,
                DisplayCommand::DrawTextFallback {
                    string_id: text_run.string_id,
                    font_description_id: text_run.style_id,
                    origin: [0.0, style.font_size],
                },
            );
        }
    }
    for decoration in editor_decorations
        .iter()
        .filter(|decoration| decoration.kind != EditorDecorationKind::Selection)
    {
        push(
            &mut instructions,
            DisplayCommand::DrawEditorDecoration {
                rect: decoration.rect,
                rgba: decoration.rgba,
                kind: decoration.kind,
            },
        );
    }
    if scene.kind(node) == Some(NodeKind::Scroll) {
        let [scroll_x, scroll_y] = scene.scroll_position(node).unwrap_or([0.0, 0.0]);
        if scroll_x.abs() > f32::EPSILON || scroll_y.abs() > f32::EPSILON {
            push(
                &mut instructions,
                DisplayCommand::Transform([1.0, 0.0, 0.0, 1.0, -scroll_x, -scroll_y]),
            );
        }
        // Skeletons live in the scrolled content space and are emitted before
        // the children, so a materialized row always wins over its placeholder.
        for placeholder in virtual_items.placeholders(node) {
            push(
                &mut instructions,
                DisplayCommand::FillPlaceholder {
                    rect: placeholder.rect,
                    rgba: placeholder.rgba,
                },
            );
        }
    }
    Ok(instructions)
}

fn overflow() -> PaintError {
    PaintError::Abi(doper_abi::AbiError::ArithmeticOverflow)
}

fn typed_resource(
    scene: &Scene,
    resource_id: u32,
    expected: ResourceKind,
) -> Result<&doper_scene::Resource, PaintError> {
    let resource = scene
        .resource(resource_id)
        .ok_or(PaintError::MissingResource { resource_id })?;
    if resource.kind != expected {
        return Err(PaintError::WrongResourceKind {
            resource_id,
            expected,
            actual: resource.kind,
        });
    }
    Ok(resource)
}

/// Reads an image resource's pixel dimensions for the source rectangle.
fn image_dimensions(
    resource_id: u32,
    resource: &doper_scene::Resource,
) -> Result<(f32, f32), PaintError> {
    // Converted through `u16` so the cast is lossless: the resource byte budget
    // puts any real image far below this bound.
    let read = |offset: usize| -> Option<f32> {
        let bytes = resource.bytes.get(offset..offset + 4)?;
        let value = u32::from_le_bytes(bytes.try_into().ok()?);
        u16::try_from(value).ok().map(f32::from)
    };
    let (Some(width), Some(height)) = (
        read(IMAGE_BITMAP_WIDTH_OFFSET),
        read(IMAGE_BITMAP_HEIGHT_OFFSET),
    ) else {
        return Err(PaintError::MissingResource { resource_id });
    };
    Ok((width, height))
}

fn push(instructions: &mut Vec<DisplayInstruction>, command: DisplayCommand) {
    instructions.push(DisplayInstruction { flags: 0, command });
}

fn has_dirty(scene: &Scene, domain: DirtyDomain) -> bool {
    scene.dirty(domain).iter_ones().next().is_some()
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use doper_abi::{Mutation, MutationBatch, MutationInstruction, NULL_NODE_ID};
    use doper_layout::{BoxConstraints, LayoutEngine, Size, ZeroIntrinsicMeasurer};
    use doper_scene::Scene;
    use proptest::prelude::*;

    use super::*;

    fn id(index: u32) -> NodeId {
        NodeId::new(index, 1).expect("id")
    }

    fn commit(scene: &mut Scene, frame: u32, mutations: Vec<Mutation>) {
        scene
            .commit(MutationBatch {
                frame_seq: frame,
                instructions: mutations
                    .into_iter()
                    .map(|mutation| MutationInstruction { flags: 0, mutation })
                    .collect(),
            })
            .expect("scene commit");
    }

    fn create(node: NodeId, kind: NodeKind, parent: Option<NodeId>) -> Mutation {
        Mutation::CreateNode {
            node_id: node.raw(),
            kind,
            parent: parent.map_or(NULL_NODE_ID, NodeId::raw),
            before_sibling: NULL_NODE_ID,
        }
    }

    fn set_f32(node: NodeId, prop: Prop, value: f32) -> Mutation {
        Mutation::SetF32 {
            node_id: node.raw(),
            prop,
            value,
        }
    }

    fn paint_resource(id: u32, color: SolidPaint) -> Mutation {
        Mutation::DefineResource {
            resource_id: id,
            kind: ResourceKind::Paint,
            bytes: color.encode().to_vec(),
        }
    }

    fn layout(scene: &Scene) -> (LayoutEngine, BitSet) {
        let mut layout = LayoutEngine::new();
        let outcome = layout
            .layout(
                scene,
                BoxConstraints::tight(Size::new(320.0, 240.0)).expect("viewport"),
                &mut ZeroIntrinsicMeasurer,
            )
            .expect("layout");
        (layout, outcome.changed)
    }

    #[test]
    fn builds_balanced_rectangle_display_list_and_reuses_clean_picture() {
        let root = id(0);
        let child = id(1);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                paint_resource(
                    10,
                    SolidPaint {
                        red: 1,
                        green: 2,
                        blue: 3,
                        alpha: 255,
                    },
                ),
                create(root, NodeKind::Root, None),
                create(child, NodeKind::Container, Some(root)),
                set_f32(child, Prop::Width, 40.0),
                set_f32(child, Prop::Height, 20.0),
                Mutation::SetRef {
                    node_id: child.raw(),
                    prop: Prop::BackgroundColor,
                    resource_id: 10,
                },
            ],
        );
        let (layout, changed) = layout(&scene);
        let mut paint = PaintEngine::new();
        let first = paint
            .paint(&scene, layout.snapshot(), &changed, false)
            .expect("paint");
        let decoded = DisplayList::decode(first.picture.bytes()).expect("valid display list");
        assert!(decoded.instructions.iter().any(|instruction| matches!(
            instruction.command,
            DisplayCommand::FillRect { paint_id: 10, .. }
        )));
        scene.clear_dirty();
        let clean = BitSet::with_len(scene.len());
        let second = paint
            .paint(&scene, layout.snapshot(), &clean, false)
            .expect("reuse");
        assert!(!second.rebuilt);
        assert_eq!(first.picture, second.picture);
        assert_eq!(paint.metrics().cache_hits, 1);
    }

    #[test]
    fn rebuilds_only_the_dirty_ancestor_chain_and_reuses_immutable_siblings() {
        let root = id(0);
        let left = id(1);
        let right = id(2);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                create(root, NodeKind::Root, None),
                create(left, NodeKind::Container, Some(root)),
                create(right, NodeKind::Container, Some(root)),
                set_f32(left, Prop::Width, 40.0),
                set_f32(left, Prop::Height, 20.0),
                set_f32(right, Prop::Width, 40.0),
                set_f32(right, Prop::Height, 20.0),
            ],
        );
        let constraints = BoxConstraints::tight(Size::new(320.0, 240.0)).expect("viewport");
        let mut incremental_layout = LayoutEngine::new();
        let initial = incremental_layout
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("initial layout");
        let mut paint = PaintEngine::new();
        paint
            .paint(
                &scene,
                incremental_layout.snapshot(),
                &initial.changed,
                false,
            )
            .expect("initial paint");
        assert_eq!(paint.metrics().subtree_builds, 3);
        scene.clear_dirty();

        commit(&mut scene, 2, vec![set_f32(left, Prop::Opacity, 0.5)]);
        let changed = incremental_layout
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("incremental layout");
        let incremental = paint
            .paint(
                &scene,
                incremental_layout.snapshot(),
                &changed.changed,
                false,
            )
            .expect("incremental paint");
        assert_eq!(paint.metrics().subtree_builds, 5);
        assert_eq!(paint.metrics().subtree_cache_hits, 1);

        let mut full_layout = LayoutEngine::new();
        let full_changed = full_layout
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("full layout");
        let full = PaintEngine::new()
            .paint(&scene, full_layout.snapshot(), &full_changed.changed, true)
            .expect("full paint");
        assert_eq!(incremental.picture.bytes(), full.picture.bytes());
    }

    #[test]
    fn clips_an_editable_to_its_own_box() {
        // The fallback text path does not wrap, so a value can be far wider than
        // the box it was measured into. Unclipped it paints over whatever sits
        // beside and below the field.
        let root = id(0);
        let editable = id(1);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                create(root, NodeKind::Root, None),
                create(editable, NodeKind::EditableText, Some(root)),
                set_f32(editable, Prop::Width, 120.0),
                set_f32(editable, Prop::Height, 24.0),
            ],
        );
        let (layout, changed) = layout(&scene);
        let picture = PaintEngine::new()
            .paint(&scene, layout.snapshot(), &changed, false)
            .expect("paint")
            .picture;
        let decoded = DisplayList::decode(picture.bytes()).expect("display list");
        assert!(
            decoded.instructions.iter().any(|instruction| matches!(
                instruction.command,
                DisplayCommand::ClipRect(rect) if rect == [0.0, 0.0, 120.0, 24.0]
            )),
            "{:?}",
            decoded.instructions
        );
    }

    #[test]
    fn clips_scroll_viewport_and_translates_only_its_child_content() {
        let root = id(0);
        let scroll = id(1);
        let child = id(2);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                create(root, NodeKind::Root, None),
                create(scroll, NodeKind::Scroll, Some(root)),
                create(child, NodeKind::Container, Some(scroll)),
                set_f32(scroll, Prop::Width, 100.0),
                set_f32(scroll, Prop::Height, 40.0),
                set_f32(child, Prop::Width, 100.0),
                set_f32(child, Prop::Height, 100.0),
                Mutation::ScrollTo {
                    node_id: scroll.raw(),
                    x: 7.0,
                    y: 23.0,
                    behavior: 0,
                },
            ],
        );
        let (layout, changed) = layout(&scene);
        let picture = PaintEngine::new()
            .paint(&scene, layout.snapshot(), &changed, false)
            .expect("paint")
            .picture;
        let decoded = DisplayList::decode(picture.bytes()).expect("display list");
        let commands: Vec<&DisplayCommand> = decoded
            .instructions
            .iter()
            .map(|instruction| &instruction.command)
            .collect();
        let clip = commands
            .iter()
            .position(|command| matches!(command, DisplayCommand::ClipRect(_)))
            .expect("scroll clip");
        let scroll_transform = commands
            .iter()
            .position(|command| {
                let DisplayCommand::Transform(matrix) = command else {
                    return false;
                };
                matrix.map(f32::to_bits) == [1.0, 0.0, 0.0, 1.0, -7.0, -23.0].map(f32::to_bits)
            })
            .expect("scroll transform");
        assert!(clip < scroll_transform);
    }

    #[test]
    fn rejects_misaligned_geometry_bitmap_without_mutating_cache_metrics() {
        let root = id(0);
        let mut scene = Scene::new();
        commit(&mut scene, 1, vec![create(root, NodeKind::Root, None)]);
        let (layout, _) = layout(&scene);
        let mut paint = PaintEngine::new();
        let before = paint.metrics();
        assert!(matches!(
            paint.paint(&scene, layout.snapshot(), &BitSet::with_len(0), false),
            Err(PaintError::GeometryBitmapLengthMismatch {
                expected: 1,
                actual: 0,
            })
        ));
        assert_eq!(paint.metrics(), before);
    }

    #[test]
    fn accepts_removed_geometry_bits_when_the_scene_becomes_empty() {
        let root = id(0);
        let mut scene = Scene::new();
        commit(&mut scene, 1, vec![create(root, NodeKind::Root, None)]);
        let constraints = BoxConstraints::tight(Size::new(320.0, 240.0)).expect("viewport");
        let mut layout = LayoutEngine::new();
        let first = layout
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("initial layout");
        let mut paint = PaintEngine::new();
        paint
            .paint(&scene, layout.snapshot(), &first.changed, false)
            .expect("initial paint");
        scene.clear_dirty();

        commit(
            &mut scene,
            2,
            vec![Mutation::RemoveNode {
                node_id: root.raw(),
            }],
        );
        let removed = layout
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("empty layout");
        assert!(removed.changed.len() > scene.len());
        let output = paint
            .paint(&scene, layout.snapshot(), &removed.changed, false)
            .expect("empty paint");
        assert_eq!(
            DisplayList::decode(output.picture.bytes())
                .expect("empty DisplayList")
                .instructions,
            Vec::new()
        );
    }

    proptest! {
        #[test]
        fn incremental_cache_path_matches_forced_full_bytes(
            changes in prop::collection::vec((0_u8..3, 0.0_f32..300.0), 0..64),
        ) {
            let root = id(0);
            let child = id(1);
            let mut scene = Scene::new();
            commit(&mut scene, 1, vec![
                paint_resource(10, SolidPaint { red: 20, green: 40, blue: 60, alpha: 255 }),
                create(root, NodeKind::Root, None),
                create(child, NodeKind::Container, Some(root)),
                set_f32(child, Prop::Width, 20.0),
                set_f32(child, Prop::Height, 20.0),
                Mutation::SetRef {
                    node_id: child.raw(),
                    prop: Prop::BackgroundColor,
                    resource_id: 10,
                },
            ]);
            let constraints = BoxConstraints::tight(Size::new(320.0, 240.0)).expect("viewport");
            let mut incremental_layout = LayoutEngine::new();
            let mut incremental_paint = PaintEngine::new();
            let initial = incremental_layout.layout(&scene, constraints, &mut ZeroIntrinsicMeasurer).expect("layout");
            incremental_paint.paint(&scene, incremental_layout.snapshot(), &initial.changed, false).expect("paint");
            scene.clear_dirty();

            for (frame_offset, (property, value)) in changes.into_iter().enumerate() {
                let prop = match property {
                    0 => Prop::Width,
                    1 => Prop::Height,
                    _ => Prop::Opacity,
                };
                let value = if prop == Prop::Opacity { value / 300.0 } else { value };
                commit(&mut scene, u32::try_from(frame_offset + 2).expect("frame"), vec![set_f32(child, prop, value)]);
                let incremental_geometry = incremental_layout.layout(&scene, constraints, &mut ZeroIntrinsicMeasurer).expect("incremental layout");
                let incremental = incremental_paint.paint(
                    &scene,
                    incremental_layout.snapshot(),
                    &incremental_geometry.changed,
                    false,
                ).expect("incremental paint");

                let mut full_layout = LayoutEngine::new();
                let full_geometry = full_layout.layout(&scene, constraints, &mut ZeroIntrinsicMeasurer).expect("full layout");
                let mut full_paint = PaintEngine::new();
                let full = full_paint.paint(&scene, full_layout.snapshot(), &full_geometry.changed, true).expect("full paint");
                prop_assert_eq!(incremental.picture.bytes(), full.picture.bytes());
                scene.clear_dirty();
            }
        }
    }
}
