use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use pingo_abi::{
    DisplayCommand, DisplayInstruction, DisplayList, EditorDecorationKind,
    IMAGE_BITMAP_HEIGHT_OFFSET, IMAGE_BITMAP_WIDTH_OFFSET, MAX_PICTURE_RESIDENT_BYTES, NodeKind,
    PictureResourceBatch, PictureResourceCommand, PictureResourceInstruction, Prop, ResourceKind,
    StyleKeyword, StyleLength, StyleLengthUnit, StyleProperty, StyleTransformOperation,
};
use pingo_layout::LayoutSnapshot;
use pingo_scene::{BitSet, DirtyDomain, NodeId, Scene};

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
    /// Cumulative immutable Picture definitions published to the backend.
    pub picture_defines: u64,
    /// Cumulative immutable Picture releases published to the backend.
    pub picture_releases: u64,
    /// Live immutable Picture objects after the most recent frame.
    pub picture_resident_count: usize,
    /// Live immutable Picture payload bytes after the most recent frame.
    pub picture_resident_bytes: usize,
    /// Picture resource transaction bytes emitted for the most recent frame.
    pub picture_resource_bytes: usize,
    /// Cumulative resident-budget fallbacks to the inline reference path.
    pub picture_budget_fallbacks: u64,
}

/// Result of one paint decision.
#[derive(Clone, Debug)]
pub struct PaintOutcome {
    /// Active immutable Picture.
    pub picture: Picture,
    /// Whether the DisplayList was rebuilt.
    pub rebuilt: bool,
    /// Atomic definitions and releases that must be installed before replay.
    pub picture_resources: Arc<[u8]>,
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
    /// Returns how far an editor has scrolled its own value inside its box.
    ///
    /// An editable clips to its box, so a caret past the edge would be invisible
    /// without this. The offset moves the value and its overlays together.
    fn editor_scroll(&self, _node: NodeId) -> [f32; 2] {
        [0.0, 0.0]
    }
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
pub struct PaintEngine {
    current: Option<Picture>,
    subtrees: HashMap<NodeId, Arc<CachedSubtree>>,
    topology: Vec<NodeId>,
    metrics: PaintMetrics,
    incremental_pictures_enabled: bool,
    picture_resident_budget_bytes: usize,
    next_picture_id: u32,
    retired_picture_ids: Vec<u32>,
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
    picture_id: Option<u32>,
    picture_bytes: Arc<[u8]>,
}

impl Default for PaintEngine {
    fn default() -> Self {
        Self {
            current: None,
            subtrees: HashMap::new(),
            topology: Vec::new(),
            metrics: PaintMetrics::default(),
            incremental_pictures_enabled: false,
            picture_resident_budget_bytes: MAX_PICTURE_RESIDENT_BYTES,
            next_picture_id: 1,
            retired_picture_ids: Vec::new(),
        }
    }
}

impl PaintEngine {
    /// Creates an empty paint engine.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Selects incremental Picture resources or the inline reference builder.
    ///
    /// Changing paths invalidates only paint caches. Live Picture generations
    /// are released with the next successfully produced frame.
    pub fn set_incremental_pictures_enabled(&mut self, enabled: bool) {
        if self.incremental_pictures_enabled == enabled {
            return;
        }
        self.incremental_pictures_enabled = enabled;
        self.retired_picture_ids.extend(
            self.subtrees
                .values()
                .filter_map(|subtree| subtree.picture_id),
        );
        self.current = None;
        self.subtrees.clear();
        self.topology.clear();
        self.metrics.picture_resident_count = 0;
        self.metrics.picture_resident_bytes = 0;
    }

    /// Whether frames currently use the incremental Picture resource path.
    #[must_use]
    pub const fn incremental_pictures_enabled(&self) -> bool {
        self.incremental_pictures_enabled
    }

    #[cfg(test)]
    fn set_picture_resident_budget_bytes(&mut self, bytes: usize) {
        self.picture_resident_budget_bytes = bytes;
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
                picture_resources: Arc::from([]),
            });
        }

        let rebuild = rebuild_subtrees(scene, geometry_changed, &self.subtrees, force_full);
        let mut built = if self.incremental_pictures_enabled {
            build_picture_graph(
                scene,
                layout,
                &self.subtrees,
                &rebuild,
                text,
                virtual_items,
                &mut self.next_picture_id,
            )?
        } else {
            build_display_list(scene, layout, &self.subtrees, &rebuild, text, virtual_items)?
        };
        let live: HashSet<NodeId> = scene.ids().iter().copied().collect();
        let mut prospective =
            built
                .core
                .1
                .values()
                .chain(self.subtrees.iter().filter_map(|(node, subtree)| {
                    (live.contains(node) && !built.core.1.contains_key(node)).then_some(subtree)
                }));
        let (mut resident_bytes, mut resident_count) = prospective
            .try_fold((0_usize, 0_usize), |(bytes, count), subtree| {
                Some((
                    bytes.checked_add(subtree.picture_bytes.len())?,
                    count.checked_add(usize::from(subtree.picture_id.is_some()))?,
                ))
            })
            .ok_or_else(overflow)?;
        let mut budget_fallback = false;
        if self.incremental_pictures_enabled && resident_bytes > self.picture_resident_budget_bytes
        {
            // The Scene remains the source of truth, so resource pressure can
            // always fall back to the independently-built inline DisplayList.
            // Discard definitions that were never published, release every
            // previously live generation, and stay on the reference path until
            // the host explicitly re-enables Pictures or restarts Core.
            let rebuild_all = vec![true; scene.len()];
            built = build_display_list(
                scene,
                layout,
                &HashMap::new(),
                &rebuild_all,
                text,
                virtual_items,
            )?;
            built.releases.extend(
                self.subtrees
                    .values()
                    .filter_map(|subtree| subtree.picture_id),
            );
            self.incremental_pictures_enabled = false;
            resident_bytes = 0;
            resident_count = 0;
            budget_fallback = true;
        }
        let command_count = built.command_count;
        let (display_list, updates, subtree_builds, subtree_cache_hits) = built.core;
        let bytes = display_list.encode()?;
        let picture = Picture {
            hash: fnv1a64(&bytes),
            bytes: Arc::from(bytes),
        };
        let mut release_ids = self.retired_picture_ids.clone();
        release_ids.extend(built.releases.iter().copied());
        release_ids.sort_unstable();
        release_ids.dedup();
        let mut resource_instructions = built.defines;
        resource_instructions.extend(release_ids.iter().copied().map(|picture_id| {
            PictureResourceInstruction {
                flags: 0,
                command: PictureResourceCommand::Release { picture_id },
            }
        }));
        let picture_resources: Arc<[u8]> = if resource_instructions.is_empty() {
            Arc::from([])
        } else {
            Arc::from(
                PictureResourceBatch {
                    instructions: resource_instructions,
                }
                .encode_core_owned()?,
            )
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
        self.metrics.picture_defines = self
            .metrics
            .picture_defines
            .saturating_add(u64::try_from(built.define_count).unwrap_or(u64::MAX));
        self.metrics.picture_releases = self
            .metrics
            .picture_releases
            .saturating_add(u64::try_from(release_ids.len()).unwrap_or(u64::MAX));
        self.metrics.picture_resident_count = resident_count;
        self.metrics.picture_resident_bytes = resident_bytes;
        self.metrics.picture_resource_bytes = picture_resources.len();
        self.metrics.picture_budget_fallbacks = self
            .metrics
            .picture_budget_fallbacks
            .saturating_add(u64::from(budget_fallback));
        self.retired_picture_ids.clear();
        Ok(PaintOutcome {
            picture,
            rebuilt: true,
            picture_resources,
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

type SubtreeCore = (DisplayList, HashMap<NodeId, Arc<CachedSubtree>>, u64, u64);

struct SubtreeBuild {
    core: SubtreeCore,
    command_count: usize,
    defines: Vec<PictureResourceInstruction>,
    releases: Vec<u32>,
    define_count: usize,
}

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
        let hidden = scene.display_none(node);
        let local: Arc<[DisplayInstruction]> = if hidden {
            Arc::from([])
        } else {
            Arc::from(build_node(
                scene,
                layout,
                index,
                node,
                text,
                virtual_items,
                true,
            )?)
        };
        let mut children = Vec::new();
        let mut command_count = if hidden {
            0
        } else {
            local.len().checked_add(1).ok_or_else(overflow)?
        };
        // Paint order, not document order: a child with a z-index draws above
        // or below its siblings. Hit testing asks the Scene the same question,
        // so what is drawn on top is what is hit.
        let mut painted = Vec::new();
        if !hidden {
            scene.children_in_paint_order(node, &mut painted);
        }
        for child_id in painted.iter().copied() {
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
        }
        // Cache validity is about which children exist, so this stays document
        // order regardless of how they are painted.
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
                picture_id: None,
                picture_bytes: Arc::from([]),
            }),
        );
        subtree_builds = subtree_builds.saturating_add(1);
    }

    let Some(root_id) = scene.ids().first().copied() else {
        return Ok(SubtreeBuild {
            core: (
                DisplayList {
                    instructions: Vec::new(),
                },
                updates,
                subtree_builds,
                subtree_cache_hits,
            ),
            command_count: 0,
            defines: Vec::new(),
            releases: Vec::new(),
            define_count: 0,
        });
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
                if subtree.local.is_empty() {
                    continue;
                }
                instructions.extend_from_slice(&subtree.local);
                stack.push(FlattenItem::Restore);
                for child in subtree.children.iter().rev() {
                    stack.push(FlattenItem::Subtree(child));
                }
            }
            FlattenItem::Restore => push(&mut instructions, DisplayCommand::Restore),
        }
    }
    Ok(SubtreeBuild {
        command_count: instructions.len(),
        core: (
            DisplayList { instructions },
            updates,
            subtree_builds,
            subtree_cache_hits,
        ),
        defines: Vec::new(),
        releases: Vec::new(),
        define_count: 0,
    })
}

#[allow(clippy::too_many_arguments)]
fn build_picture_graph(
    scene: &Scene,
    layout: &LayoutSnapshot,
    current: &HashMap<NodeId, Arc<CachedSubtree>>,
    rebuild: &[bool],
    text: &impl TextPaintResolver,
    virtual_items: &impl VirtualPaintResolver,
    next_picture_id: &mut u32,
) -> Result<SubtreeBuild, PaintError> {
    let mut updates = HashMap::new();
    let mut definitions = Vec::new();
    let mut releases = Vec::new();
    let mut subtree_builds = 0_u64;
    let mut subtree_cache_hits = 0_u64;
    for (index, node) in scene.ids().iter().copied().enumerate().rev() {
        if !rebuild.get(index).copied().unwrap_or(true) && current.contains_key(&node) {
            continue;
        }
        let hidden = scene.display_none(node);
        let local: Arc<[DisplayInstruction]> = if hidden {
            Arc::from([])
        } else {
            Arc::from(build_node(
                scene,
                layout,
                index,
                node,
                text,
                virtual_items,
                false,
            )?)
        };
        let mut children = Vec::new();
        let mut instructions = Vec::new();
        let mut command_count = 0_usize;
        if !hidden {
            instructions.extend_from_slice(&local);
            command_count = local.len().checked_add(1).ok_or_else(overflow)?;
        }
        let mut child_ids = Vec::new();
        // Paint order, so a z-index moves a Picture within its siblings.
        let mut painted = Vec::new();
        if !hidden {
            scene.children_in_paint_order(node, &mut painted);
        }
        for child_id in painted.iter().copied() {
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
            if let Some(picture_id) = cached.picture_id {
                let child_index = scene
                    .resolve(child_id)
                    .ok_or(PaintError::MissingCachedSubtree { node: child_id })?;
                let (offset, _) = layout
                    .geometry_at(child_index)
                    .ok_or(PaintError::MissingGeometry { node: child_id })?;
                push(
                    &mut instructions,
                    DisplayCommand::DrawPicture {
                        picture_id,
                        offset: [offset.x, offset.y],
                    },
                );
                command_count = command_count
                    .checked_add(cached.command_count)
                    .and_then(|count| count.checked_add(1))
                    .ok_or_else(overflow)?;
            }
            children.push(cached);
        }
        // Cache validity is about which children exist, so this stays document
        // order regardless of how they are painted.
        let mut walk = (!hidden).then(|| scene.first_child(node)).flatten();
        while let Some(child_id) = walk {
            child_ids.push(child_id);
            walk = scene.next_sibling(child_id);
        }
        if !hidden {
            push(&mut instructions, DisplayCommand::Restore);
        }
        let (picture_id, picture_bytes) = if hidden {
            (None, Arc::from([]))
        } else {
            let id = allocate_picture_id(next_picture_id)?;
            let bytes: Arc<[u8]> = Arc::from(DisplayList { instructions }.encode()?);
            definitions.push(PictureResourceInstruction {
                flags: 0,
                command: PictureResourceCommand::Define {
                    picture_id: id,
                    bytes: bytes.clone(),
                },
            });
            (Some(id), bytes)
        };
        if let Some(old_id) = current.get(&node).and_then(|entry| entry.picture_id) {
            releases.push(old_id);
        }
        updates.insert(
            node,
            Arc::new(CachedSubtree {
                children: Arc::from(children),
                child_ids: Arc::from(child_ids),
                command_count,
                local,
                picture_id,
                picture_bytes,
            }),
        );
        subtree_builds = subtree_builds.saturating_add(1);
    }

    let live: HashSet<NodeId> = scene.ids().iter().copied().collect();
    releases.extend(current.iter().filter_map(|(node, subtree)| {
        (!live.contains(node))
            .then_some(subtree.picture_id)
            .flatten()
    }));
    let root = scene
        .ids()
        .first()
        .and_then(|root_id| updates.get(root_id).or_else(|| current.get(root_id)));
    let mut instructions = Vec::new();
    let mut command_count = 0;
    if let Some(root) = root {
        command_count = root
            .command_count
            .saturating_add(usize::from(root.picture_id.is_some()));
        if let Some(picture_id) = root.picture_id {
            let (offset, _) = layout.geometry_at(0).ok_or(PaintError::MissingGeometry {
                node: scene.ids()[0],
            })?;
            push(
                &mut instructions,
                DisplayCommand::DrawPicture {
                    picture_id,
                    offset: [offset.x, offset.y],
                },
            );
        }
    }
    let define_count = definitions.len();
    Ok(SubtreeBuild {
        core: (
            DisplayList { instructions },
            updates,
            subtree_builds,
            subtree_cache_hits,
        ),
        command_count,
        defines: definitions,
        releases,
        define_count,
    })
}

fn allocate_picture_id(next_picture_id: &mut u32) -> Result<u32, PaintError> {
    let id = *next_picture_id;
    if id == 0 {
        return Err(overflow());
    }
    *next_picture_id = next_picture_id.checked_add(1).ok_or_else(overflow)?;
    Ok(id)
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
    include_layout_offset: bool,
) -> Result<Vec<DisplayInstruction>, PaintError> {
    let (offset, size) = layout
        .geometry_at(index)
        .ok_or(PaintError::MissingGeometry { node })?;
    let mut instructions = Vec::with_capacity(6);
    push(&mut instructions, DisplayCommand::Save);
    if include_layout_offset {
        push(
            &mut instructions,
            DisplayCommand::Transform([1.0, 0.0, 0.0, 1.0, offset.x, offset.y]),
        );
    }

    if scene.presentation_style_transform(node).is_some() {
        push_presentation_transform(scene, node, size, &mut instructions);
    } else if let Some(transform_id) = scene.ref_prop(node, Prop::Transform) {
        let resource = typed_resource(scene, transform_id, ResourceKind::Affine)?;
        let affine = AffineResource::decode(transform_id, resource)?;
        push(&mut instructions, DisplayCommand::Transform(affine.matrix));
    } else {
        push_style_transform(scene, node, size, &mut instructions);
    }
    if let Some(opacity) = scene
        .presentation_style_f32(node, StyleProperty::Opacity)
        .or_else(|| scene.f32_prop(node, Prop::Opacity))
        .or_else(|| scene.presented_style_f32(node, StyleProperty::Opacity))
    {
        if !(0.0..=1.0).contains(&opacity) {
            return Err(PaintError::InvalidOpacity { node });
        }
        push(&mut instructions, DisplayCommand::Alpha(opacity));
    }
    // A scroll viewport clips its children; an editable clips its own value,
    // which the fallback path does not wrap and so can be arbitrarily wider than
    // the box it was measured into. Without this a long line paints across
    // whatever sits beside and below the field.
    let editable_clip = matches!(scene.kind(node), Some(NodeKind::EditableText));
    let clip_x = editable_clip || scene.clips_axis(node, true);
    let clip_y = editable_clip || scene.clips_axis(node, false);
    if clip_x || clip_y {
        const UNBOUNDED_CLIP: f32 = 1_000_000_000.0;
        let x = if clip_x { 0.0 } else { -UNBOUNDED_CLIP };
        let y = if clip_y { 0.0 } else { -UNBOUNDED_CLIP };
        let width = if clip_x {
            size.width
        } else {
            UNBOUNDED_CLIP * 2.0
        };
        let height = if clip_y {
            size.height
        } else {
            UNBOUNDED_CLIP * 2.0
        };
        push(
            &mut instructions,
            DisplayCommand::ClipRect([x, y, width, height]),
        );
    }
    if scene.kind(node) == Some(NodeKind::EditableText) {
        let [offset_x, offset_y] = text.editor_scroll(node);
        // Inside the clip, so the value and its overlays move together and a
        // caret that ran past the edge comes back into view.
        if offset_x.abs() > f32::EPSILON || offset_y.abs() > f32::EPSILON {
            push(
                &mut instructions,
                DisplayCommand::Transform([1.0, 0.0, 0.0, 1.0, -offset_x, -offset_y]),
            );
        }
    }
    let visible = scene.visible(node);
    let radius = style_border_radius(scene, node, size);
    if visible {
        push_shadows(scene, node, size, radius, &mut instructions);
    }
    if visible && let Some(paint_id) = scene.ref_prop(node, Prop::BackgroundColor) {
        let resource = typed_resource(scene, paint_id, ResourceKind::Paint)?;
        SolidPaint::decode(paint_id, resource)?;
        if radius > 0.0 {
            push(
                &mut instructions,
                DisplayCommand::FillRRect {
                    rect: [0.0, 0.0, size.width, size.height],
                    radii: [radius; 4],
                    paint_id,
                },
            );
        } else {
            push(
                &mut instructions,
                DisplayCommand::FillRect {
                    rect: [0.0, 0.0, size.width, size.height],
                    paint_id,
                },
            );
        }
    } else if visible
        && let Some(rgba) = scene.presented_style_rgba(node, StyleProperty::BackgroundColor)
        && rgba & 0xff != 0
    {
        if radius > 0.0 {
            push(
                &mut instructions,
                DisplayCommand::FillColorRRect {
                    rect: [0.0, 0.0, size.width, size.height],
                    radii: [radius; 4],
                    rgba,
                },
            );
        } else {
            push(
                &mut instructions,
                DisplayCommand::FillColorRect {
                    rect: [0.0, 0.0, size.width, size.height],
                    rgba,
                },
            );
        }
    }
    if visible
        && let Some((image_id, resource_kind)) = scene
            .ref_prop(node, Prop::Image)
            .map(|id| (id, ResourceKind::Image))
            .or_else(|| {
                scene
                    .ref_prop(node, Prop::VideoFrame)
                    .map(|id| (id, ResourceKind::VideoFrame))
            })
    {
        // The whole image is drawn into the node's box. Scene validation has
        // already checked that the declared dimensions describe the pixels that
        // follow, so the source rectangle here cannot exceed the resource.
        let resource = typed_resource(scene, image_id, resource_kind)?;
        let (image_width, image_height) = if resource_kind == ResourceKind::Image {
            image_dimensions(image_id, resource)?
        } else {
            video_dimensions(image_id, resource)?
        };
        let (source, destination) = image_rects(scene, node, size, image_width, image_height);
        push(
            &mut instructions,
            DisplayCommand::DrawImage {
                image_id,
                source,
                destination,
            },
        );
    }
    if visible {
        let (widths, colors) = style_border(scene, node);
        if widths.iter().any(|width| *width > 0.0) && colors.iter().any(|color| color & 0xff != 0) {
            push(
                &mut instructions,
                DisplayCommand::FillColorBorder {
                    rect: [0.0, 0.0, size.width, size.height],
                    radii: [radius; 4],
                    widths,
                    colors,
                },
            );
        }
    }
    let editor_decorations = if visible {
        text.editor_decorations(node)
    } else {
        &[]
    };
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
    if visible && let Some(text_run) = scene.text_run(node) {
        typed_resource(scene, text_run.string_id, ResourceKind::Utf8String)?;
        let style_resource = typed_resource(scene, text_run.style_id, ResourceKind::TextStyle)?;
        let style = TextStyleResource::decode(text_run.style_id, style_resource)?;
        let paint_resource = typed_resource(scene, style.paint_id, ResourceKind::Paint)?;
        SolidPaint::decode(style.paint_id, paint_resource)?;
        let fallback_x = match style.text_align {
            StyleKeyword::End | StyleKeyword::Right | StyleKeyword::Justify => size.width,
            StyleKeyword::Center => size.width * 0.5,
            _ => 0.0,
        };
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
                    origin: [fallback_x, style.font_size],
                    text: inline.to_owned(),
                },
            );
        } else {
            push(
                &mut instructions,
                DisplayCommand::DrawTextFallback {
                    string_id: text_run.string_id,
                    font_description_id: text_run.style_id,
                    origin: [fallback_x, style.font_size],
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
    if visible && scene.is_scroll_container(node) {
        let [stored_x, stored_y] = scene.scroll_position(node).unwrap_or([0.0, 0.0]);
        let scroll_x = if scene.scrollable_axis(node, true) {
            stored_x
        } else {
            0.0
        };
        let scroll_y = if scene.scrollable_axis(node, false) {
            stored_y
        } else {
            0.0
        };
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

fn video_dimensions(
    resource_id: u32,
    resource: &pingo_scene::Resource,
) -> Result<(f32, f32), PaintError> {
    use pingo_abi::{VIDEO_FRAME_HEIGHT_OFFSET, VIDEO_FRAME_WIDTH_OFFSET};
    let read = |offset: usize| -> Option<f32> {
        let value = u32::from_le_bytes(resource.bytes.get(offset..offset + 4)?.try_into().ok()?);
        u16::try_from(value).ok().map(f32::from)
    };
    read(VIDEO_FRAME_WIDTH_OFFSET)
        .zip(read(VIDEO_FRAME_HEIGHT_OFFSET))
        .ok_or(PaintError::InvalidResource {
            resource_id,
            reason: "video dimensions are invalid",
        })
}

fn push_presentation_transform(
    scene: &Scene,
    node: NodeId,
    size: pingo_layout::Size,
    instructions: &mut Vec<DisplayInstruction>,
) {
    let Some(operations) = scene.presentation_style_transform(node) else {
        return;
    };
    push_transform_operations(operations, size, instructions);
}

fn image_rects(
    scene: &Scene,
    node: NodeId,
    box_size: pingo_layout::Size,
    image_width: f32,
    image_height: f32,
) -> ([f32; 4], [f32; 4]) {
    let fit = scene
        .presented_style_keyword(node, StyleProperty::ObjectFit)
        .unwrap_or(StyleKeyword::Fill);
    if fit == StyleKeyword::Fill
        || image_width <= f32::EPSILON
        || image_height <= f32::EPSILON
        || box_size.width <= f32::EPSILON
        || box_size.height <= f32::EPSILON
    {
        return (
            [0.0, 0.0, image_width, image_height],
            [0.0, 0.0, box_size.width, box_size.height],
        );
    }
    let contain_scale = (box_size.width / image_width).min(box_size.height / image_height);
    let scale = match fit {
        StyleKeyword::Contain => contain_scale,
        StyleKeyword::Cover => (box_size.width / image_width).max(box_size.height / image_height),
        StyleKeyword::None => 1.0,
        StyleKeyword::ScaleDown => contain_scale.min(1.0),
        _ => 1.0,
    };
    let rendered_width = image_width * scale;
    let rendered_height = image_height * scale;
    let position = scene
        .presented_style_position(node, StyleProperty::ObjectPosition)
        .map_or([0.5, 0.5], |position| {
            [
                resolve_object_position(position[0], box_size.width, rendered_width),
                resolve_object_position(position[1], box_size.height, rendered_height),
            ]
        });
    let offset_x = if scene
        .presented_style_position(node, StyleProperty::ObjectPosition)
        .is_some()
    {
        position[0]
    } else {
        (box_size.width - rendered_width) * 0.5
    };
    let offset_y = if scene
        .presented_style_position(node, StyleProperty::ObjectPosition)
        .is_some()
    {
        position[1]
    } else {
        (box_size.height - rendered_height) * 0.5
    };
    let visible_left = offset_x.max(0.0);
    let visible_top = offset_y.max(0.0);
    let visible_right = (offset_x + rendered_width)
        .min(box_size.width)
        .max(visible_left);
    let visible_bottom = (offset_y + rendered_height)
        .min(box_size.height)
        .max(visible_top);
    let source_x = (visible_left - offset_x) / scale;
    let source_y = (visible_top - offset_y) / scale;
    let source_width = (visible_right - visible_left) / scale;
    let source_height = (visible_bottom - visible_top) / scale;
    (
        [source_x, source_y, source_width, source_height],
        [
            visible_left,
            visible_top,
            visible_right - visible_left,
            visible_bottom - visible_top,
        ],
    )
}

fn resolve_object_position(length: StyleLength, container: f32, object: f32) -> f32 {
    match length.unit {
        StyleLengthUnit::Percent => (container - object) * length.value / 100.0,
        StyleLengthUnit::Px => length.value,
        StyleLengthUnit::Auto
        | StyleLengthUnit::None
        | StyleLengthUnit::Normal
        | StyleLengthUnit::Number => (container - object) * 0.5,
    }
}

/// Emits one instruction per declared shadow, behind everything the node paints.
///
/// CSS paints the first declared shadow on top, so they go out back to front.
/// Spread is folded into the rectangle and radii here: a backend has an offset,
/// a blur and a color, and no CSS spread of its own.
fn push_shadows(
    scene: &Scene,
    node: NodeId,
    size: pingo_layout::Size,
    radius: f32,
    instructions: &mut Vec<DisplayInstruction>,
) {
    let Some(shadows) = scene.presented_style_shadows(node) else {
        return;
    };
    for shadow in shadows.iter().rev() {
        if shadow.rgba & 0xff == 0 {
            continue;
        }
        let width = size.width + shadow.spread * 2.0;
        let height = size.height + shadow.spread * 2.0;
        if width <= 0.0 || height <= 0.0 {
            continue;
        }
        push(
            instructions,
            DisplayCommand::FillColorShadow {
                rect: [-shadow.spread, -shadow.spread, width, height],
                radii: [(radius + shadow.spread).max(0.0); 4],
                offset: [shadow.offset_x, shadow.offset_y],
                blur: shadow.blur,
                rgba: shadow.rgba,
            },
        );
    }
}

fn style_border_radius(scene: &Scene, node: NodeId, size: pingo_layout::Size) -> f32 {
    let Some(length) = scene.presented_style_length(node, StyleProperty::BorderRadius) else {
        return 0.0;
    };
    resolve_box_length(length, size.width.min(size.height)).max(0.0)
}

fn style_border(scene: &Scene, node: NodeId) -> ([f32; 4], [u32; 4]) {
    let sides = [
        (
            StyleProperty::BorderTopWidth,
            StyleProperty::BorderTopStyle,
            StyleProperty::BorderTopColor,
        ),
        (
            StyleProperty::BorderRightWidth,
            StyleProperty::BorderRightStyle,
            StyleProperty::BorderRightColor,
        ),
        (
            StyleProperty::BorderBottomWidth,
            StyleProperty::BorderBottomStyle,
            StyleProperty::BorderBottomColor,
        ),
        (
            StyleProperty::BorderLeftWidth,
            StyleProperty::BorderLeftStyle,
            StyleProperty::BorderLeftColor,
        ),
    ];
    let mut widths = [0.0; 4];
    let mut colors = [0; 4];
    for (index, (width, style, color)) in sides.into_iter().enumerate() {
        if scene.presented_style_keyword(node, style) != Some(StyleKeyword::Solid) {
            continue;
        }
        widths[index] = scene
            .presented_style_length(node, width)
            .map_or(0.0, |length| resolve_box_length(length, 0.0).max(0.0));
        colors[index] = scene.presented_style_rgba(node, color).unwrap_or_default();
    }
    (widths, colors)
}

fn push_style_transform(
    scene: &Scene,
    node: NodeId,
    size: pingo_layout::Size,
    instructions: &mut Vec<DisplayInstruction>,
) {
    let Some(operations) = scene
        .presented_style_transform(node)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let origin = scene
        .presented_style_position(node, StyleProperty::TransformOrigin)
        .map_or([size.width * 0.5, size.height * 0.5], |position| {
            [
                resolve_box_length(position[0], size.width),
                resolve_box_length(position[1], size.height),
            ]
        });
    push(
        instructions,
        DisplayCommand::Transform([1.0, 0.0, 0.0, 1.0, origin[0], origin[1]]),
    );
    push_transform_operations(operations, size, instructions);
    push(
        instructions,
        DisplayCommand::Transform([1.0, 0.0, 0.0, 1.0, -origin[0], -origin[1]]),
    );
}

fn push_transform_operations(
    operations: &[StyleTransformOperation],
    size: pingo_layout::Size,
    instructions: &mut Vec<DisplayInstruction>,
) {
    for operation in operations {
        let matrix = match *operation {
            StyleTransformOperation::Matrix(value) => value,
            StyleTransformOperation::Translate(x, y) => [
                1.0,
                0.0,
                0.0,
                1.0,
                resolve_box_length(x, size.width),
                resolve_box_length(y, size.height),
            ],
            StyleTransformOperation::Scale([x, y]) => [x, 0.0, 0.0, y, 0.0, 0.0],
            StyleTransformOperation::Rotate(radians) => {
                let (sin, cos) = radians.sin_cos();
                [cos, sin, -sin, cos, 0.0, 0.0]
            }
        };
        push(instructions, DisplayCommand::Transform(matrix));
    }
}

fn resolve_box_length(length: StyleLength, basis: f32) -> f32 {
    match length.unit {
        StyleLengthUnit::Px => length.value,
        StyleLengthUnit::Percent => basis * length.value / 100.0,
        StyleLengthUnit::Auto
        | StyleLengthUnit::None
        | StyleLengthUnit::Normal
        | StyleLengthUnit::Number => 0.0,
    }
}

fn overflow() -> PaintError {
    PaintError::Abi(pingo_abi::AbiError::ArithmeticOverflow)
}

fn typed_resource(
    scene: &Scene,
    resource_id: u32,
    expected: ResourceKind,
) -> Result<&pingo_scene::Resource, PaintError> {
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
    resource: &pingo_scene::Resource,
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
    use pingo_abi::{
        Mutation, MutationBatch, MutationInstruction, NULL_NODE_ID, PictureResourceBatch,
        PictureResourceCommand,
    };
    use pingo_layout::{BoxConstraints, LayoutEngine, Size, ZeroIntrinsicMeasurer};
    use pingo_scene::Scene;
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

    fn computed_style(entries: &[(pingo_abi::StyleProperty, u8, Vec<u8>)]) -> Vec<u8> {
        let payload_bytes = entries
            .iter()
            .map(|(_, _, payload)| 8 + payload.len().next_multiple_of(4))
            .sum::<usize>();
        let mut bytes = vec![0; 16];
        bytes[0] = pingo_abi::STYLE_COMPUTED_ENCODING_VERSION;
        bytes[1] = pingo_abi::STYLE_COMPUTED_ENCODING_VARIANT;
        bytes[4..8].copy_from_slice(&pingo_abi::STYLE_ALL_FEATURE_BITS.to_le_bytes());
        bytes[8..12].copy_from_slice(&u32::try_from(entries.len()).expect("entries").to_le_bytes());
        bytes[12..16]
            .copy_from_slice(&u32::try_from(payload_bytes).expect("payload").to_le_bytes());
        for (property, tag, payload) in entries {
            bytes.extend_from_slice(&(*property as u16).to_le_bytes());
            bytes.push(0);
            bytes.push(*tag);
            bytes.extend_from_slice(&u16::try_from(payload.len()).expect("payload").to_le_bytes());
            bytes.extend_from_slice(&0_u16.to_le_bytes());
            bytes.extend_from_slice(payload);
            bytes.resize(bytes.len().next_multiple_of(4), 0);
        }
        bytes
    }

    fn shadow_list(layers: &[(f32, f32, f32, f32, u32)]) -> Vec<u8> {
        let mut bytes = u32::try_from(layers.len())
            .expect("layers")
            .to_le_bytes()
            .to_vec();
        for (x, y, blur, spread, rgba) in layers {
            for value in [x, y, blur, spread] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            bytes.extend_from_slice(&rgba.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn shadows_paint_behind_the_box_back_to_front_with_spread_folded_in() {
        let root = id(0);
        let card = id(1);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                Mutation::DefineResource {
                    resource_id: 5,
                    kind: ResourceKind::ComputedStyle,
                    bytes: computed_style(&[
                        (
                            pingo_abi::StyleProperty::BackgroundColor,
                            pingo_abi::STYLE_VALUE_RGBA8,
                            0xffff_ffff_u32.to_le_bytes().to_vec(),
                        ),
                        (
                            pingo_abi::StyleProperty::BoxShadow,
                            pingo_abi::STYLE_VALUE_SHADOW_LIST,
                            shadow_list(&[
                                (0.0, 1.0, 2.0, 0.0, 0x0000_001a),
                                (0.0, 4.0, 8.0, 2.0, 0x0000_0033),
                            ]),
                        ),
                    ]),
                },
                create(root, NodeKind::Root, None),
                create(card, NodeKind::Container, Some(root)),
                Mutation::SetRef {
                    node_id: card.raw(),
                    prop: Prop::ComputedStyle,
                    resource_id: 5,
                },
                set_f32(card, Prop::Width, 100.0),
                set_f32(card, Prop::Height, 50.0),
            ],
        );
        let (layout, changed) = layout(&scene);
        let mut engine = PaintEngine::new();
        let outcome = engine
            .paint(&scene, layout.snapshot(), &changed, false)
            .expect("paint");
        let decoded = DisplayList::decode(outcome.picture.bytes()).expect("display list");

        let shadows = decoded
            .instructions
            .iter()
            .filter_map(|instruction| match instruction.command {
                DisplayCommand::FillColorShadow {
                    rect,
                    radii,
                    offset,
                    blur,
                    rgba,
                } => Some((rect, radii, offset, blur, rgba)),
                _ => None,
            })
            .collect::<Vec<_>>();

        // CSS paints the first declared shadow on top, so it is emitted last.
        assert_eq!(shadows.len(), 2);
        assert_eq!(shadows[0].4, 0x0000_0033);
        assert_eq!(shadows[1].4, 0x0000_001a);
        // Spread grows the rectangle on every side and the radii with it.
        assert_eq!(shadows[0].0, [-2.0, -2.0, 104.0, 54.0]);
        assert_eq!(shadows[0].2, [0.0, 4.0]);
        assert_eq!(shadows[0].3, 8.0);
        // No spread leaves the box alone.
        assert_eq!(shadows[1].0, [0.0, 0.0, 100.0, 50.0]);
        assert_eq!(shadows[1].1, [0.0; 4]);

        // Every shadow precedes the background it sits behind.
        let first_shadow = decoded
            .instructions
            .iter()
            .position(|instruction| {
                matches!(instruction.command, DisplayCommand::FillColorShadow { .. })
            })
            .expect("shadow");
        let background = decoded
            .instructions
            .iter()
            .position(|instruction| {
                matches!(instruction.command, DisplayCommand::FillColorRect { .. })
            })
            .expect("background");
        assert!(first_shadow < background);
    }

    #[test]
    fn a_z_index_reorders_what_is_painted_without_touching_the_cache_identity() {
        let root = id(0);
        let first = id(1);
        let second = id(2);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                paint_resource(
                    10,
                    SolidPaint {
                        red: 10,
                        green: 0,
                        blue: 0,
                        alpha: 255,
                    },
                ),
                paint_resource(
                    11,
                    SolidPaint {
                        red: 20,
                        green: 0,
                        blue: 0,
                        alpha: 255,
                    },
                ),
                Mutation::DefineResource {
                    resource_id: 12,
                    kind: ResourceKind::ComputedStyle,
                    bytes: computed_style(&[(
                        pingo_abi::StyleProperty::ZIndex,
                        pingo_abi::STYLE_VALUE_LENGTH,
                        {
                            let mut bytes = vec![pingo_abi::STYLE_LENGTH_NUMBER, 0, 0, 0];
                            bytes.extend_from_slice(&1.0_f32.to_le_bytes());
                            bytes
                        },
                    )]),
                },
                create(root, NodeKind::Root, None),
                create(first, NodeKind::Container, Some(root)),
                create(second, NodeKind::Container, Some(root)),
                set_f32(first, Prop::Width, 20.0),
                set_f32(first, Prop::Height, 20.0),
                set_f32(second, Prop::Width, 20.0),
                set_f32(second, Prop::Height, 20.0),
                Mutation::SetRef {
                    node_id: first.raw(),
                    prop: Prop::BackgroundColor,
                    resource_id: 10,
                },
                Mutation::SetRef {
                    node_id: second.raw(),
                    prop: Prop::BackgroundColor,
                    resource_id: 11,
                },
                // The first child is lifted over the second.
                Mutation::SetRef {
                    node_id: first.raw(),
                    prop: Prop::ComputedStyle,
                    resource_id: 12,
                },
            ],
        );
        let (layout, changed) = layout(&scene);
        let mut engine = PaintEngine::new();
        let outcome = engine
            .paint(&scene, layout.snapshot(), &changed, false)
            .expect("paint");
        let decoded = DisplayList::decode(outcome.picture.bytes()).expect("display list");
        let fills = decoded
            .instructions
            .iter()
            .filter_map(|instruction| match instruction.command {
                DisplayCommand::FillRect { paint_id, .. } => Some(paint_id),
                _ => None,
            })
            .collect::<Vec<_>>();
        // Document order would give 10 then 11; the z-index puts 10 last.
        assert_eq!(fills, vec![11, 10]);
    }

    #[test]
    fn a_fully_transparent_shadow_is_not_emitted_at_all() {
        let root = id(0);
        let card = id(1);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                Mutation::DefineResource {
                    resource_id: 5,
                    kind: ResourceKind::ComputedStyle,
                    bytes: computed_style(&[(
                        pingo_abi::StyleProperty::BoxShadow,
                        pingo_abi::STYLE_VALUE_SHADOW_LIST,
                        shadow_list(&[(0.0, 1.0, 2.0, 0.0, 0x0000_0000)]),
                    )]),
                },
                create(root, NodeKind::Root, None),
                create(card, NodeKind::Container, Some(root)),
                Mutation::SetRef {
                    node_id: card.raw(),
                    prop: Prop::ComputedStyle,
                    resource_id: 5,
                },
                set_f32(card, Prop::Width, 10.0),
                set_f32(card, Prop::Height, 10.0),
            ],
        );
        let (layout, changed) = layout(&scene);
        let mut engine = PaintEngine::new();
        let outcome = engine
            .paint(&scene, layout.snapshot(), &changed, false)
            .expect("paint");
        let decoded = DisplayList::decode(outcome.picture.bytes()).expect("display list");
        assert!(!decoded.instructions.iter().any(|instruction| {
            matches!(instruction.command, DisplayCommand::FillColorShadow { .. })
        }));
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
    fn incremental_pictures_publish_before_reference_and_rebuild_only_the_dirty_chain() {
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
        let mut layout = LayoutEngine::new();
        let first_layout = layout
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("initial layout");
        let mut paint = PaintEngine::new();
        paint.set_incremental_pictures_enabled(true);
        let first = paint
            .paint(&scene, layout.snapshot(), &first_layout.changed, false)
            .expect("incremental paint");
        let root_list = DisplayList::decode(first.picture.bytes()).expect("root list");
        assert_eq!(root_list.instructions.len(), 1);
        assert!(matches!(
            root_list.instructions[0].command,
            DisplayCommand::DrawPicture { .. }
        ));
        let first_batch =
            PictureResourceBatch::decode(&first.picture_resources).expect("Picture definitions");
        assert_eq!(first_batch.instructions.len(), 3);
        assert!(first_batch.instructions.iter().all(|instruction| matches!(
            instruction.command,
            PictureResourceCommand::Define { .. }
        )));
        assert_eq!(paint.metrics().picture_resident_count, 3);
        scene.clear_dirty();

        commit(&mut scene, 2, vec![set_f32(left, Prop::Opacity, 0.5)]);
        let second_layout = layout
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("incremental layout");
        let second = paint
            .paint(&scene, layout.snapshot(), &second_layout.changed, false)
            .expect("incremental repaint");
        let second_batch =
            PictureResourceBatch::decode(&second.picture_resources).expect("Picture delta");
        let defines = second_batch
            .instructions
            .iter()
            .filter(|instruction| {
                matches!(instruction.command, PictureResourceCommand::Define { .. })
            })
            .count();
        let releases = second_batch
            .instructions
            .iter()
            .filter(|instruction| {
                matches!(instruction.command, PictureResourceCommand::Release { .. })
            })
            .count();
        assert_eq!((defines, releases), (2, 2));
        assert_eq!(paint.metrics().subtree_cache_hits, 1);
        assert_eq!(paint.metrics().picture_resident_count, 3);

        scene.clear_dirty();
        let clean = BitSet::with_len(scene.len());
        let reused = paint
            .paint(&scene, layout.snapshot(), &clean, false)
            .expect("clean reuse");
        assert!(!reused.rebuilt);
        assert!(reused.picture_resources.is_empty());
    }

    #[test]
    fn picture_budget_pressure_releases_live_resources_and_falls_back_inline() {
        let root = id(0);
        let child = id(1);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                create(root, NodeKind::Root, None),
                create(child, NodeKind::Container, Some(root)),
                set_f32(child, Prop::Width, 40.0),
                set_f32(child, Prop::Height, 20.0),
            ],
        );
        let constraints = BoxConstraints::tight(Size::new(320.0, 240.0)).expect("viewport");
        let mut layout = LayoutEngine::new();
        let first_layout = layout
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("initial layout");
        let mut paint = PaintEngine::new();
        paint.set_incremental_pictures_enabled(true);
        paint
            .paint(&scene, layout.snapshot(), &first_layout.changed, false)
            .expect("initial Picture frame");
        assert_eq!(paint.metrics().picture_resident_count, 2);
        scene.clear_dirty();

        paint.set_picture_resident_budget_bytes(1);
        commit(&mut scene, 2, vec![set_f32(child, Prop::Opacity, 0.5)]);
        let changed = layout
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("incremental layout");
        let fallback = paint
            .paint(&scene, layout.snapshot(), &changed.changed, false)
            .expect("budget fallback");

        assert!(!paint.incremental_pictures_enabled());
        assert_eq!(paint.metrics().picture_budget_fallbacks, 1);
        assert_eq!(paint.metrics().picture_resident_count, 0);
        assert_eq!(paint.metrics().picture_resident_bytes, 0);
        let root_list = DisplayList::decode(fallback.picture.bytes()).expect("inline list");
        assert!(
            root_list.instructions.iter().all(|instruction| !matches!(
                instruction.command,
                DisplayCommand::DrawPicture { .. }
            ))
        );
        let releases =
            PictureResourceBatch::decode(&fallback.picture_resources).expect("release transaction");
        assert_eq!(releases.instructions.len(), 2);
        assert!(releases.instructions.iter().all(|instruction| matches!(
            instruction.command,
            PictureResourceCommand::Release { .. }
        )));
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
