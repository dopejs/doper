use std::collections::{HashMap, HashSet};

use pingo_abi::{NodeKind, Prop, StyleKeyword, StyleLength, StyleLengthUnit, StyleProperty};
use pingo_scene::{BitSet, DirtyDomain, NodeId, Scene};

use crate::{BoxConstraints, LayoutError, Point, Size};

/// Supplies deterministic intrinsic dimensions for leaf nodes.
pub trait IntrinsicMeasurer {
    /// Measures a leaf within the maximum content-box constraints.
    fn measure(&mut self, scene: &Scene, node: NodeId, constraints: BoxConstraints) -> Size;
}

/// Supplies variable-size single-axis virtual-list geometry owned by scrolling.
///
/// Returning `None` uses the Scene's validated uniform-height estimate. This keeps
/// the reference layout path deterministic before a Core scroll state is created.
pub trait VirtualLayoutProvider {
    /// Returns the leading logical offset for one item in its virtual list.
    fn item_offset(&self, list: NodeId, item_index: u32) -> Option<f32>;

    /// Returns the current total logical content extent along the configured axis.
    fn content_extent(&self, list: NodeId) -> Option<f32>;
}

/// Uniform-estimate virtual geometry used by standalone layout callers.
#[derive(Default)]
pub struct EstimatedVirtualLayout;

impl VirtualLayoutProvider for EstimatedVirtualLayout {
    fn item_offset(&self, _list: NodeId, _item_index: u32) -> Option<f32> {
        None
    }

    fn content_extent(&self, _list: NodeId) -> Option<f32> {
        None
    }
}

/// A measurer that gives every leaf an empty intrinsic size.
#[derive(Default)]
pub struct ZeroIntrinsicMeasurer;

impl IntrinsicMeasurer for ZeroIntrinsicMeasurer {
    fn measure(&mut self, _scene: &Scene, _node: NodeId, _constraints: BoxConstraints) -> Size {
        Size::ZERO
    }
}

/// Topology-aligned immutable results from the last successful pass.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LayoutSnapshot {
    ids: Vec<NodeId>,
    offsets: Vec<Point>,
    sizes: Vec<Size>,
    /// Whether each entry was a virtual list item or lived inside one.
    ///
    /// An item is usually a wrapper around an application subtree, so a window
    /// shift adds and removes whole subtrees, not single nodes. Removed nodes
    /// are gone from the Scene, so their former role can only be recovered from
    /// the previous snapshot.
    virtual_items: Vec<bool>,
}

impl LayoutSnapshot {
    /// Returns the number of laid-out nodes.
    #[must_use]
    pub fn len(&self) -> usize {
        self.ids.len()
    }

    /// Returns whether this snapshot contains no nodes.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    /// Returns topology-ordered node identifiers.
    #[must_use]
    pub fn ids(&self) -> &[NodeId] {
        &self.ids
    }

    /// Resolves geometry by current topology index.
    #[must_use]
    pub fn geometry_at(&self, index: usize) -> Option<(Point, Size)> {
        Some((*self.offsets.get(index)?, *self.sizes.get(index)?))
    }

    /// Resolves geometry for a generation-bearing node identifier.
    #[must_use]
    pub fn geometry(&self, node: NodeId) -> Option<(Point, Size)> {
        let index = self.ids.iter().position(|candidate| *candidate == node)?;
        self.geometry_at(index)
    }
}

/// Observability counters for layout work.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct LayoutMetrics {
    /// Successful non-empty passes.
    pub passes: u64,
    /// Passes that recomputed every node.
    pub full_passes: u64,
    /// Passes contained to one or more fixed-size relayout boundaries.
    pub incremental_passes: u64,
    /// Fixed-size boundary subtrees recomputed across incremental passes.
    pub boundary_subtrees: u64,
    /// Clean passes skipped without touching geometry buffers.
    pub clean_skips: u64,
    /// Total node visits in successful passes.
    pub node_visits: u64,
    /// Total nodes whose committed geometry changed.
    pub geometry_changes: u64,
}

/// Summary of one committed layout decision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LayoutOutcome {
    /// Geometry changes compared with the prior committed snapshot.
    pub changed: BitSet,
    /// Whether all nodes were visited.
    pub full: bool,
    /// Number of nodes visited by this pass.
    pub visited: usize,
}

/// Deterministic layout orchestration with front/back SoA buffers.
#[derive(Default)]
pub struct LayoutEngine {
    front: LayoutSnapshot,
    back: LayoutSnapshot,
    last_constraints: Option<BoxConstraints>,
    last_topology_compactions: u64,
    stack: Vec<Frame>,
    candidate_roots: Vec<NodeId>,
    boundary_roots: Vec<NodeId>,
    external_roots: Vec<NodeId>,
    metrics: LayoutMetrics,
}

impl LayoutEngine {
    /// Creates an empty engine.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns the most recently committed snapshot.
    #[must_use]
    pub const fn snapshot(&self) -> &LayoutSnapshot {
        &self.front
    }

    /// Returns cumulative work counters.
    #[must_use]
    pub const fn metrics(&self) -> LayoutMetrics {
        self.metrics
    }

    /// Schedules a corrective pass for virtual lists whose external height index changed.
    ///
    /// These roots replace Scene dirty bits for the next pass because those bits
    /// were already consumed by the immediately preceding layout. Fixed-size
    /// lists remain localized; non-fixed lists expand to their safe ancestor.
    pub fn mark_virtual_measurements_changed(&mut self, lists: &[NodeId]) {
        self.mark_external_measurements_changed(lists);
    }

    /// Schedules layout for text nodes whose Host-provided intrinsic metrics changed.
    pub fn mark_text_measurements_changed(&mut self, nodes: &[NodeId]) {
        self.mark_external_measurements_changed(nodes);
    }

    fn mark_external_measurements_changed(&mut self, nodes: &[NodeId]) {
        self.external_roots.clear();
        self.external_roots.extend_from_slice(nodes);
    }

    /// Computes and atomically commits geometry for the Scene.
    pub fn layout(
        &mut self,
        scene: &Scene,
        constraints: BoxConstraints,
        measurer: &mut impl IntrinsicMeasurer,
    ) -> Result<LayoutOutcome, LayoutError> {
        self.layout_with_virtual(scene, constraints, measurer, &EstimatedVirtualLayout)
    }

    /// Computes geometry using current Core-owned variable-height virtual offsets.
    pub fn layout_with_virtual(
        &mut self,
        scene: &Scene,
        constraints: BoxConstraints,
        measurer: &mut impl IntrinsicMeasurer,
        virtual_layout: &impl VirtualLayoutProvider,
    ) -> Result<LayoutOutcome, LayoutError> {
        if scene.is_empty() {
            let changed = changed_geometry(&self.front, &LayoutSnapshot::default());
            self.front = LayoutSnapshot::default();
            self.back = LayoutSnapshot::default();
            self.last_constraints = Some(constraints);
            self.last_topology_compactions = scene.metrics().topology_compactions;
            self.external_roots.clear();
            self.metrics.geometry_changes += changed.iter_ones().count() as u64;
            return Ok(LayoutOutcome {
                changed,
                full: true,
                visited: 0,
            });
        }

        let topology_unchanged = self.front.ids == scene.ids()
            && self.last_topology_compactions == scene.metrics().topology_compactions;
        let clean = self.external_roots.is_empty()
            && scene
                .dirty(DirtyDomain::Layout)
                .iter_ones()
                .next()
                .is_none();
        if topology_unchanged && clean && self.last_constraints == Some(constraints) {
            self.metrics.clean_skips += 1;
            return Ok(LayoutOutcome {
                changed: BitSet::with_len(scene.len()),
                full: false,
                visited: 0,
            });
        }

        let constraints_unchanged = self.last_constraints == Some(constraints);
        // Moving a scroll window adds and removes items every frame, and the
        // topology gate sent every one of those frames down the full-layout
        // path, so scrolling cost a pass over the whole Scene. Items take their
        // offset from the height index rather than from their siblings, so the
        // nodes that stayed keep their geometry and only the new ones are laid
        // out.
        let window_shift =
            !topology_unchanged && constraints_unchanged && self.only_virtual_items_changed(scene);
        let can_increment = topology_unchanged && constraints_unchanged;
        let (full, visited, boundary_count) = if window_shift {
            let added = self.remap_for_window_shift(scene);
            let mut visited = 0;
            self.boundary_roots.clear();
            for node in added {
                // Descendants of a new item are laid out with it, so only the
                // item itself is a boundary.
                if scene.virtual_item_index(node).is_none() {
                    continue;
                }
                visited += self.layout_new_virtual_item(scene, node, measurer, virtual_layout)?;
                self.boundary_roots.push(node);
            }
            (false, visited, self.boundary_roots.len())
        } else if can_increment {
            self.prepare_incremental();
            self.collect_boundaries(scene)?;
            let roots = &self.boundary_roots;
            let recomputes_root = roots.len() == 1 && scene.parent(roots[0]).is_none();
            let mut visited = 0;
            for boundary in roots.iter().copied() {
                let boundary_constraints = if scene.parent(boundary).is_none() {
                    constraints
                } else {
                    let (_, prior_size) =
                        self.front
                            .geometry(boundary)
                            .ok_or(LayoutError::SceneInvariant(
                                "relayout boundary has no prior geometry",
                            ))?;
                    BoxConstraints::tight(prior_size)?
                };
                compute_subtree(
                    scene,
                    boundary,
                    boundary_constraints,
                    PercentBasis::from_constraints(boundary_constraints),
                    measurer,
                    virtual_layout,
                    &mut self.back,
                    &mut self.stack,
                )?;
                visited += subtree_len(scene, boundary)?;
            }
            (
                recomputes_root,
                visited,
                if recomputes_root { 0 } else { roots.len() },
            )
        } else {
            self.prepare_full(scene);
            let root = *scene
                .ids()
                .first()
                .ok_or(LayoutError::SceneInvariant("non-empty Scene has no root"))?;
            compute_subtree(
                scene,
                root,
                constraints,
                PercentBasis::from_constraints(constraints),
                measurer,
                virtual_layout,
                &mut self.back,
                &mut self.stack,
            )?;
            (true, scene.len(), 0)
        };
        let changed = changed_geometry(&self.front, &self.back);
        let change_count = changed.iter_ones().count();
        core::mem::swap(&mut self.front, &mut self.back);
        self.last_constraints = Some(constraints);
        self.last_topology_compactions = scene.metrics().topology_compactions;
        self.external_roots.clear();
        self.metrics.passes += 1;
        if full {
            self.metrics.full_passes += 1;
        } else {
            self.metrics.incremental_passes += 1;
            self.metrics.boundary_subtrees += boundary_count as u64;
        }
        self.metrics.node_visits += visited as u64;
        self.metrics.geometry_changes += change_count as u64;
        Ok(LayoutOutcome {
            changed,
            full,
            visited,
        })
    }

    fn prepare_full(&mut self, scene: &Scene) {
        self.back.ids.clear();
        self.back.ids.extend_from_slice(scene.ids());
        self.back.offsets.clear();
        self.back.offsets.resize(scene.len(), Point::ZERO);
        self.back.sizes.clear();
        self.back.sizes.resize(scene.len(), Size::ZERO);
        self.record_virtual_items(scene);
    }

    /// Records which nodes sit inside a virtual item, for next frame's classification.
    ///
    /// Scene order is topological, so a single forward pass can inherit the flag
    /// from each node's parent.
    fn record_virtual_items(&mut self, scene: &Scene) {
        self.back.virtual_items.clear();
        self.back.virtual_items.reserve(scene.len());
        for node in scene.ids().iter().copied() {
            let inherited = scene
                .parent(node)
                .and_then(|parent| scene.resolve(parent))
                .and_then(|index| self.back.virtual_items.get(index).copied())
                .unwrap_or(false);
            self.back
                .virtual_items
                .push(inherited || scene.virtual_item_index(node).is_some());
        }
    }

    /// Rebuilds `back` against the new id list, keeping every surviving node's
    /// geometry, and returns the nodes that are new and therefore need layout.
    fn remap_for_window_shift(&mut self, scene: &Scene) -> Vec<NodeId> {
        let mut previous = HashMap::with_capacity(self.front.ids.len());
        for (index, node) in self.front.ids.iter().copied().enumerate() {
            previous.insert(node, index);
        }
        self.back.ids.clear();
        self.back.ids.extend_from_slice(scene.ids());
        self.back.offsets.clear();
        self.back.sizes.clear();
        let mut added = Vec::new();
        for node in scene.ids().iter().copied() {
            match previous.get(&node) {
                Some(&index) => {
                    self.back.offsets.push(self.front.offsets[index]);
                    self.back.sizes.push(self.front.sizes[index]);
                }
                None => {
                    self.back.offsets.push(Point::ZERO);
                    self.back.sizes.push(Size::ZERO);
                    added.push(node);
                }
            }
        }
        self.record_virtual_items(scene);
        added
    }

    /// Whether a node sits inside a virtual item, computed against the Scene.
    fn within_virtual_item(&self, scene: &Scene, index: usize) -> bool {
        let mut current = scene.ids().get(index).copied();
        while let Some(node) = current {
            if scene.virtual_item_index(node).is_some() {
                return true;
            }
            current = scene.parent(node);
        }
        false
    }

    /// Whether the only structural change is virtual items appearing or
    /// disappearing, which is what moving a scroll window does.
    ///
    /// Those items take their offset from the height index rather than from
    /// their siblings, so the nodes that stayed cannot have moved.
    fn only_virtual_items_changed(&self, scene: &Scene) -> bool {
        let current: HashSet<NodeId> = scene.ids().iter().copied().collect();
        let previous: HashSet<NodeId> = self.front.ids.iter().copied().collect();
        if current == previous || self.front.ids.len() != self.front.virtual_items.len() {
            return false;
        }
        let added_are_items = scene
            .ids()
            .iter()
            .enumerate()
            .filter(|(_, node)| !previous.contains(node))
            .all(|(index, node)| {
                scene.virtual_item_index(*node).is_some() || self.within_virtual_item(scene, index)
            });
        let removed_are_items = self
            .front
            .ids
            .iter()
            .enumerate()
            .filter(|(_, node)| !current.contains(node))
            .all(|(index, _)| self.front.virtual_items[index]);
        added_are_items && removed_are_items
    }

    fn prepare_incremental(&mut self) {
        self.back.ids.clone_from(&self.front.ids);
        self.back.offsets.clone_from(&self.front.offsets);
        self.back.sizes.clone_from(&self.front.sizes);
        self.back
            .virtual_items
            .clone_from(&self.front.virtual_items);
    }

    /// Lays out one newly materialized virtual item and returns the nodes visited.
    ///
    /// The constraints must be the ones the parent hands its children -- padding
    /// removed, and unbounded for a scroll container -- so they are taken from
    /// the parent's own frame rather than from its size. `compute_subtree` only
    /// assigns an offset when a parent frame is on the stack, so the item's own
    /// offset is written here, exactly as the full pass would place it.
    fn layout_new_virtual_item(
        &mut self,
        scene: &Scene,
        node: NodeId,
        measurer: &mut impl IntrinsicMeasurer,
        virtual_layout: &impl VirtualLayoutProvider,
    ) -> Result<usize, LayoutError> {
        let parent = scene
            .parent(node)
            .ok_or(LayoutError::SceneInvariant("virtual item has no parent"))?;
        let (_, parent_size) = self
            .front
            .geometry(parent)
            .ok_or(LayoutError::SceneInvariant(
                "virtual item parent has no prior geometry",
            ))?;
        let parent_constraints = BoxConstraints::tight(parent_size)?;
        let parent_frame = make_frame(
            scene,
            parent,
            parent_constraints,
            PercentBasis::from_constraints(parent_constraints),
            virtual_layout,
        )?;
        let (child_constraints, child_basis) = constraints_for_child(scene, &parent_frame, node)?;
        compute_subtree(
            scene,
            node,
            child_constraints,
            child_basis,
            measurer,
            virtual_layout,
            &mut self.back,
            &mut self.stack,
        )?;
        let index = scene.resolve(node).ok_or(LayoutError::SceneInvariant(
            "layout encountered a stale node",
        ))?;
        let item_index = scene
            .virtual_item_index(node)
            .ok_or(LayoutError::SceneInvariant(
                "new node is not a virtual item",
            ))?;
        let offset = virtual_item_offset(scene, parent, item_index, virtual_layout)?;
        let insets = parent_frame.padding.add(parent_frame.border);
        let margin = style_margin(scene, node, percentage_basis(parent_size.width, 0.0))?;
        self.back.offsets[index] = if parent_frame.row {
            Point::new(
                insets.left + offset + margin.values.left,
                insets.top + margin.values.top,
            )
        } else {
            Point::new(
                insets.left + margin.values.left,
                insets.top + offset + margin.values.top,
            )
        };
        subtree_len(scene, node)
    }

    fn collect_boundaries(&mut self, scene: &Scene) -> Result<(), LayoutError> {
        let root = *scene
            .ids()
            .first()
            .ok_or(LayoutError::SceneInvariant("non-empty Scene has no root"))?;
        self.candidate_roots.clear();
        if self.external_roots.is_empty() {
            for index in scene.dirty(DirtyDomain::Layout).iter_ones() {
                let dirty = *scene.ids().get(index).ok_or(LayoutError::SceneInvariant(
                    "dirty layout index is out of bounds",
                ))?;
                self.candidate_roots
                    .push(relayout_boundary(scene, root, dirty, false)?);
            }
        } else {
            for dirty in self.external_roots.iter().copied() {
                self.candidate_roots
                    .push(relayout_boundary(scene, root, dirty, true)?);
            }
        }
        self.candidate_roots
            .sort_unstable_by_key(|node| scene.resolve(*node).unwrap_or(usize::MAX));
        self.candidate_roots.dedup();
        self.boundary_roots.clear();
        for candidate in self.candidate_roots.iter().copied() {
            if !self
                .boundary_roots
                .iter()
                .copied()
                .any(|ancestor| is_ancestor(scene, ancestor, candidate))
            {
                self.boundary_roots.push(candidate);
            }
        }
        Ok(())
    }
}

fn relayout_boundary(
    scene: &Scene,
    root: NodeId,
    dirty: NodeId,
    include_self: bool,
) -> Result<NodeId, LayoutError> {
    if scene.resolve(dirty).is_none() {
        return Err(LayoutError::SceneInvariant("relayout root is stale"));
    }
    if include_self && is_fixed_boundary(scene, dirty) {
        return Ok(dirty);
    }
    let mut candidate = root;
    let mut cursor = scene.parent(dirty);
    while let Some(ancestor) = cursor {
        if is_fixed_boundary(scene, ancestor) {
            candidate = ancestor;
            break;
        }
        cursor = scene.parent(ancestor);
    }
    Ok(candidate)
}

#[derive(Clone, Copy, Default)]
struct EdgeInsets {
    top: f32,
    right: f32,
    bottom: f32,
    left: f32,
}

impl EdgeInsets {
    fn horizontal(self) -> f32 {
        self.left + self.right
    }

    fn vertical(self) -> f32 {
        self.top + self.bottom
    }

    fn add(self, other: Self) -> Self {
        Self {
            top: self.top + other.top,
            right: self.right + other.right,
            bottom: self.bottom + other.bottom,
            left: self.left + other.left,
        }
    }
}

#[derive(Clone, Copy, Default)]
struct AutoEdges {
    top: bool,
    right: bool,
    bottom: bool,
    left: bool,
}

#[derive(Clone, Copy, Default)]
struct Margins {
    values: EdgeInsets,
    auto: AutoEdges,
}

/// Value of [`Prop::Direction`] that lays children out along the main axis.
///
/// The prop is an `f32` because the Mutation Stream has no integer prop value
/// type; anything other than exactly this value keeps the default column flow.
const DIRECTION_ROW: f32 = 1.0;

/// Definite content-box extents used to resolve child percentage lengths.
///
/// This is deliberately not the same quantity as `Frame::child_constraints`. A
/// scroll container measures its children against an infinite axis so content
/// can overflow, but CSS resolves percentages against the containing block's
/// content box, not against the scrollable extent. Folding the two together
/// made every percentage inside `overflow: hidden`/`auto`/`scroll` resolve to
/// zero.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PercentBasis {
    /// Definite inline content extent, or infinity when indefinite.
    pub(crate) width: f32,
    /// Definite block content extent, or infinity when indefinite.
    pub(crate) height: f32,
}

impl PercentBasis {
    /// Derives a basis from constraints for callers that have no parent frame.
    fn from_constraints(constraints: BoxConstraints) -> Self {
        Self {
            width: constraints.max_width,
            height: constraints.max_height,
        }
    }
}

struct Frame {
    node: NodeId,
    index: usize,
    constraints: BoxConstraints,
    child_constraints: BoxConstraints,
    next_child: Option<NodeId>,
    padding: EdgeInsets,
    border: EdgeInsets,
    margin: Margins,
    fixed_width: Option<f32>,
    fixed_height: Option<f32>,
    /// Outer child extent already consumed along the flow axis.
    main: f32,
    /// Largest child extent across the flow axis.
    cross: f32,
    /// Whether children flow left to right rather than top to bottom.
    row: bool,
    /// Whether the logical main-axis order starts at the physical end edge.
    reverse: bool,
    /// Main-axis distribution after fixed gaps and margins.
    justify: StyleKeyword,
    /// Cross-axis alignment for direct children.
    align: StyleKeyword,
    /// Space inserted between adjacent children.
    gap: f32,
    /// Whether a child has been placed, so `gap` applies from the second on.
    placed: bool,
    /// Percentage basis handed to children, unaffected by scroll relaxation.
    percent: PercentBasis,
}

#[allow(clippy::too_many_arguments)]
fn compute_subtree(
    scene: &Scene,
    root: NodeId,
    constraints: BoxConstraints,
    basis: PercentBasis,
    measurer: &mut impl IntrinsicMeasurer,
    virtual_layout: &impl VirtualLayoutProvider,
    output: &mut LayoutSnapshot,
    stack: &mut Vec<Frame>,
) -> Result<(), LayoutError> {
    if scene.parent(root).is_none() && scene.kind(root) != Some(NodeKind::Root) {
        return Err(LayoutError::SceneInvariant("first node is not the root"));
    }
    if scene.display_none(root) {
        zero_subtree(scene, root, output)?;
        return Ok(());
    }

    stack.clear();
    stack.push(make_frame(scene, root, constraints, basis, virtual_layout)?);
    while let Some(frame) = stack.last_mut() {
        if let Some(child) = frame.next_child {
            frame.next_child = scene.next_sibling(child);
            if scene.display_none(child) {
                zero_subtree(scene, child, output)?;
                continue;
            }
            let (child_constraints, child_basis) = constraints_for_child(scene, frame, child)?;
            let child_frame =
                make_frame(scene, child, child_constraints, child_basis, virtual_layout)?;
            stack.push(child_frame);
            continue;
        }

        let frame = stack.pop().expect("last frame exists");
        let has_children = scene.first_child(frame.node).is_some();
        let intrinsic = if has_children {
            Size::ZERO
        } else {
            let measured = measurer.measure(scene, frame.node, frame.child_constraints);
            if !measured.is_valid() {
                return Err(LayoutError::InvalidIntrinsicSize {
                    node: frame.node,
                    size: measured,
                });
            }
            frame.child_constraints.constrain(measured)
        };
        let insets = frame.padding.add(frame.border);
        let natural = if frame.row {
            Size::new(
                frame.main + intrinsic.width + insets.horizontal(),
                frame.cross.max(intrinsic.height) + insets.vertical(),
            )
        } else {
            Size::new(
                frame.cross.max(intrinsic.width) + insets.horizontal(),
                frame.main + intrinsic.height + insets.vertical(),
            )
        };
        let requested = Size::new(
            frame.fixed_width.unwrap_or(natural.width),
            frame.fixed_height.unwrap_or(natural.height),
        );
        let size = frame.constraints.constrain(requested);
        output.sizes[frame.index] = size;
        arrange_children(scene, &frame, size, output)?;

        if let Some(parent) = stack.last_mut() {
            if let Some(item_index) = scene.virtual_item_index(frame.node)
                && scene.virtual_list(parent.node).is_some()
            {
                let offset = virtual_item_offset(scene, parent.node, item_index, virtual_layout)?;
                let parent_insets = parent.padding.add(parent.border);
                output.offsets[frame.index] = if parent.row {
                    Point::new(
                        parent_insets.left + offset + frame.margin.values.left,
                        parent_insets.top + frame.margin.values.top,
                    )
                } else {
                    Point::new(
                        parent_insets.left + frame.margin.values.left,
                        parent_insets.top + offset + frame.margin.values.top,
                    )
                };
                let cross = if parent.row {
                    frame.margin.values.top + size.height + frame.margin.values.bottom
                } else {
                    frame.margin.values.left + size.width + frame.margin.values.right
                };
                parent.cross = parent.cross.max(cross);
            } else {
                if parent.placed {
                    parent.main += parent.gap;
                }
                parent.placed = true;
                let parent_insets = parent.padding.add(parent.border);
                if parent.row {
                    output.offsets[frame.index] = Point::new(
                        parent_insets.left + parent.main + frame.margin.values.left,
                        parent_insets.top + frame.margin.values.top,
                    );
                    parent.main +=
                        frame.margin.values.left + size.width + frame.margin.values.right;
                    parent.cross = parent
                        .cross
                        .max(frame.margin.values.top + size.height + frame.margin.values.bottom);
                } else {
                    output.offsets[frame.index] = Point::new(
                        parent_insets.left + frame.margin.values.left,
                        parent_insets.top + parent.main + frame.margin.values.top,
                    );
                    parent.main +=
                        frame.margin.values.top + size.height + frame.margin.values.bottom;
                    parent.cross = parent
                        .cross
                        .max(frame.margin.values.left + size.width + frame.margin.values.right);
                }
            }
        }
    }
    Ok(())
}

fn zero_subtree(
    scene: &Scene,
    root: NodeId,
    output: &mut LayoutSnapshot,
) -> Result<(), LayoutError> {
    let start = scene
        .resolve(root)
        .ok_or(LayoutError::SceneInvariant("hidden subtree root is stale"))?;
    let depth = scene.depth(root).ok_or(LayoutError::SceneInvariant(
        "hidden subtree root has no depth",
    ))?;
    let mut end = start + 1;
    while let Some(node) = scene.ids().get(end) {
        if scene.depth(*node).ok_or(LayoutError::SceneInvariant(
            "hidden subtree node has no depth",
        ))? <= depth
        {
            break;
        }
        end += 1;
    }
    for index in start..end {
        output.offsets[index] = Point::ZERO;
        output.sizes[index] = Size::ZERO;
    }
    Ok(())
}

/// Percentage-resolved inputs that would read a parent basis this pass does not have.
///
/// An incremental pass restarts at the boundary with `BoxConstraints::tight`, so
/// the boundary's own percentage basis becomes its own box instead of its
/// parent's content box. Any node whose geometry reads that basis therefore lays
/// out differently incrementally than it does in a full pass, so it cannot be a
/// containment boundary.
const PERCENTAGE_SENSITIVE_PROPERTIES: [StyleProperty; 16] = [
    StyleProperty::MinWidth,
    StyleProperty::MinHeight,
    StyleProperty::MaxWidth,
    StyleProperty::MaxHeight,
    StyleProperty::PaddingTop,
    StyleProperty::PaddingRight,
    StyleProperty::PaddingBottom,
    StyleProperty::PaddingLeft,
    StyleProperty::BorderTopWidth,
    StyleProperty::BorderRightWidth,
    StyleProperty::BorderBottomWidth,
    StyleProperty::BorderLeftWidth,
    StyleProperty::MarginTop,
    StyleProperty::MarginRight,
    StyleProperty::MarginBottom,
    StyleProperty::MarginLeft,
];

fn is_fixed_boundary(scene: &Scene, node: NodeId) -> bool {
    has_fixed_dimension(scene, node, Prop::Width, StyleProperty::Width)
        && has_fixed_dimension(scene, node, Prop::Height, StyleProperty::Height)
        && !reads_parent_percentage_basis(scene, node)
}

fn reads_parent_percentage_basis(scene: &Scene, node: NodeId) -> bool {
    PERCENTAGE_SENSITIVE_PROPERTIES.iter().any(|property| {
        scene
            .style_length(node, *property, 0)
            .is_some_and(|length| length.unit == StyleLengthUnit::Percent)
    })
}

fn has_fixed_dimension(scene: &Scene, node: NodeId, direct: Prop, property: StyleProperty) -> bool {
    scene.f32_prop(node, direct).is_some()
        || scene
            .style_length(node, property, 0)
            .is_some_and(|length| length.unit == StyleLengthUnit::Px)
}

fn is_ancestor(scene: &Scene, ancestor: NodeId, node: NodeId) -> bool {
    if ancestor == node {
        return true;
    }
    let Some(ancestor_depth) = scene.depth(ancestor) else {
        return false;
    };
    let mut cursor = scene.parent(node);
    while let Some(candidate) = cursor {
        let Some(depth) = scene.depth(candidate) else {
            return false;
        };
        if depth < ancestor_depth {
            return false;
        }
        if candidate == ancestor {
            return true;
        }
        cursor = scene.parent(candidate);
    }
    false
}

fn subtree_len(scene: &Scene, root: NodeId) -> Result<usize, LayoutError> {
    let start = scene
        .resolve(root)
        .ok_or(LayoutError::SceneInvariant("subtree root is stale"))?;
    let depth = scene
        .depth(root)
        .ok_or(LayoutError::SceneInvariant("subtree root has no depth"))?;
    let mut end = start + 1;
    while let Some(node) = scene.ids().get(end) {
        let node_depth = scene
            .depth(*node)
            .ok_or(LayoutError::SceneInvariant("subtree node has no depth"))?;
        if node_depth <= depth {
            break;
        }
        end += 1;
    }
    Ok(end - start)
}

fn make_frame(
    scene: &Scene,
    node: NodeId,
    incoming: BoxConstraints,
    basis: PercentBasis,
    virtual_layout: &impl VirtualLayoutProvider,
) -> Result<Frame, LayoutError> {
    let index = scene.resolve(node).ok_or(LayoutError::SceneInvariant(
        "layout encountered a stale node",
    ))?;
    let width_basis = percentage_basis(basis.width, incoming.min_width);
    let height_basis = percentage_basis(basis.height, incoming.min_height);
    let padding = style_padding(scene, node, width_basis)?;
    let border = style_border(scene, node, width_basis)?;
    let insets = padding.add(border);
    let border_box =
        scene.style_keyword(node, StyleProperty::BoxSizing, 0) == Some(StyleKeyword::BorderBox);
    let min_width = outer_dimension(
        scene,
        node,
        Prop::MinWidth,
        StyleProperty::MinWidth,
        width_basis,
        insets.horizontal(),
        border_box,
    )?
    .unwrap_or(0.0);
    let min_height = outer_dimension(
        scene,
        node,
        Prop::MinHeight,
        StyleProperty::MinHeight,
        height_basis,
        insets.vertical(),
        border_box,
    )?
    .unwrap_or(0.0);
    let max_width = outer_dimension(
        scene,
        node,
        Prop::MaxWidth,
        StyleProperty::MaxWidth,
        width_basis,
        insets.horizontal(),
        border_box,
    )?
    .unwrap_or(f32::INFINITY);
    let max_height = outer_dimension(
        scene,
        node,
        Prop::MaxHeight,
        StyleProperty::MaxHeight,
        height_basis,
        insets.vertical(),
        border_box,
    )?
    .unwrap_or(f32::INFINITY);
    if min_width > max_width {
        return Err(LayoutError::ContradictoryStyle {
            node,
            min_prop: Prop::MinWidth,
            min: min_width,
            max_prop: Prop::MaxWidth,
            max: max_width,
        });
    }
    if min_height > max_height {
        return Err(LayoutError::ContradictoryStyle {
            node,
            min_prop: Prop::MinHeight,
            min: min_height,
            max_prop: Prop::MaxHeight,
            max: max_height,
        });
    }
    let constraints = intersect_constraints(incoming, min_width, max_width, min_height, max_height);
    let fixed_width = outer_dimension(
        scene,
        node,
        Prop::Width,
        StyleProperty::Width,
        width_basis,
        insets.horizontal(),
        border_box,
    )?;
    let fixed_height = outer_dimension(
        scene,
        node,
        Prop::Height,
        StyleProperty::Height,
        height_basis,
        insets.vertical(),
        border_box,
    )?;
    // Virtual items use Core's axis-neutral extent index rather than sibling accumulation.
    let virtual_list = scene.virtual_list(node);
    let direction = scene
        .style_keyword(node, StyleProperty::FlexDirection, 0)
        .unwrap_or(StyleKeyword::Column);
    let row = virtual_list.map_or_else(
        || {
            scene
                .f32_prop(node, Prop::Direction)
                .is_some_and(|value| value == DIRECTION_ROW)
                || (scene.f32_prop(node, Prop::Direction).is_none()
                    && matches!(direction, StyleKeyword::Row | StyleKeyword::RowReverse))
        },
        |config| config.axis == pingo_abi::VirtualAxis::X,
    );
    let reverse = virtual_list.is_none()
        && scene.f32_prop(node, Prop::Direction).is_none()
        && matches!(
            direction,
            StyleKeyword::RowReverse | StyleKeyword::ColumnReverse
        );
    let outer_width = fixed_width.unwrap_or(constraints.max_width);
    let outer_height = fixed_height.unwrap_or(constraints.max_height);
    let mut child_constraints = BoxConstraints {
        min_width: 0.0,
        max_width: subtract_insets(outer_width, insets.horizontal()),
        min_height: 0.0,
        max_height: if row {
            subtract_insets(outer_height, insets.vertical())
        } else {
            f32::INFINITY
        },
    };
    if let Some(width) = fixed_width {
        let outer_width = constraints
            .constrain(Size::new(width, constraints.min_height))
            .width;
        child_constraints.max_width = subtract_insets(outer_width, insets.horizontal());
    }
    // The percentage basis is this container's available content box on each
    // axis. It is deliberately independent of `child_constraints`, which relaxes
    // the block axis in column flow so children can be measured naturally, and
    // relaxes a scrollable axis so content can overflow. Folding the two
    // together resolved every percentage inside those containers to zero.
    let percent = PercentBasis {
        width: child_constraints.max_width,
        height: subtract_insets(outer_height, insets.vertical()),
    };
    if scene.scrollable_axis(node, true) {
        child_constraints.max_width = f32::INFINITY;
    }
    if scene.scrollable_axis(node, false) {
        child_constraints.max_height = f32::INFINITY;
    }
    let style_gap_property = if row {
        StyleProperty::ColumnGap
    } else {
        StyleProperty::RowGap
    };
    let style_gap_basis = if row {
        fixed_width.unwrap_or(width_basis)
    } else {
        fixed_height.unwrap_or(height_basis)
    };
    let gap = match scene.f32_prop(node, Prop::Gap).or_else(|| {
        resolve_style_length(
            scene.style_length(node, style_gap_property, 0),
            style_gap_basis,
        )
    }) {
        Some(value) if value.is_finite() && value >= 0.0 => value,
        Some(value) => {
            return Err(LayoutError::InvalidStyle {
                node,
                prop: Prop::Gap,
                value,
            });
        }
        None => 0.0,
    };
    let main = match virtual_list {
        Some(_) => virtual_content_extent(scene, node, virtual_layout)?,
        None => 0.0,
    };
    Ok(Frame {
        node,
        index,
        constraints,
        child_constraints,
        next_child: scene.first_child(node),
        padding,
        border,
        margin: style_margin(scene, node, width_basis)?,
        fixed_width,
        fixed_height,
        main,
        cross: 0.0,
        row,
        reverse,
        justify: scene
            .style_keyword(node, StyleProperty::JustifyContent, 0)
            .unwrap_or(StyleKeyword::FlexStart),
        align: scene
            .style_keyword(node, StyleProperty::AlignItems, 0)
            .unwrap_or(StyleKeyword::FlexStart),
        gap,
        placed: false,
        percent,
    })
}

fn constraints_for_child(
    scene: &Scene,
    parent: &Frame,
    child: NodeId,
) -> Result<(BoxConstraints, PercentBasis), LayoutError> {
    let percentage_basis =
        percentage_basis(parent.percent.width, parent.child_constraints.min_width);
    let margin = style_margin(scene, child, percentage_basis)?.values;
    let mut constraints = parent.child_constraints;
    constraints.max_width = subtract_insets(constraints.max_width, margin.horizontal());
    constraints.max_height = subtract_insets(constraints.max_height, margin.vertical());
    let basis = PercentBasis {
        width: subtract_insets(parent.percent.width, margin.horizontal()),
        height: subtract_insets(parent.percent.height, margin.vertical()),
    };
    if parent.align == StyleKeyword::Stretch {
        if parent.row {
            if !has_requested_dimension(scene, child, Prop::Height, StyleProperty::Height)
                && constraints.max_height.is_finite()
            {
                constraints.min_height = constraints.max_height;
            }
        } else if !has_requested_dimension(scene, child, Prop::Width, StyleProperty::Width)
            && constraints.max_width.is_finite()
        {
            constraints.min_width = constraints.max_width;
        }
    }
    Ok((constraints, basis))
}

fn arrange_children(
    scene: &Scene,
    frame: &Frame,
    size: Size,
    output: &mut LayoutSnapshot,
) -> Result<(), LayoutError> {
    if scene.virtual_list(frame.node).is_some() {
        return Ok(());
    }
    let insets = frame.padding.add(frame.border);
    let content_main = if frame.row {
        (size.width - insets.horizontal()).max(0.0)
    } else {
        (size.height - insets.vertical()).max(0.0)
    };
    let content_cross = if frame.row {
        (size.height - insets.vertical()).max(0.0)
    } else {
        (size.width - insets.horizontal()).max(0.0)
    };
    let percentage_basis = (size.width - insets.horizontal()).max(0.0);
    let mut child_count = 0_usize;
    let mut auto_main_edges = 0_usize;
    let mut child = scene.first_child(frame.node);
    while let Some(node) = child {
        if !scene.display_none(node) {
            child_count += 1;
            let auto = style_margin(scene, node, percentage_basis)?.auto;
            auto_main_edges += if frame.row {
                usize::from(auto.left) + usize::from(auto.right)
            } else {
                usize::from(auto.top) + usize::from(auto.bottom)
            };
        }
        child = scene.next_sibling(node);
    }
    if child_count == 0 {
        return Ok(());
    }
    let free = (content_main - frame.main).max(0.0);
    let auto_share = if auto_main_edges == 0 {
        0.0
    } else {
        free / auto_main_edges as f32
    };
    let distributable = if auto_main_edges == 0 { free } else { 0.0 };
    let (leading, distributed_gap) = justify_spacing(frame.justify, distributable, child_count);
    let mut cursor = leading;
    let mut ordinal = 0_usize;
    child = scene.first_child(frame.node);
    while let Some(node) = child {
        child = scene.next_sibling(node);
        if scene.display_none(node) {
            continue;
        }
        let index = scene.resolve(node).ok_or(LayoutError::SceneInvariant(
            "layout child disappeared during arrangement",
        ))?;
        let child_size = *output.sizes.get(index).ok_or(LayoutError::SceneInvariant(
            "layout child has no computed size",
        ))?;
        let margin = style_margin(scene, node, percentage_basis)?;
        if ordinal > 0 {
            cursor += frame.gap + distributed_gap;
        }
        let (
            leading_margin,
            trailing_margin,
            cross_start,
            cross_end,
            cross_auto_start,
            cross_auto_end,
        ) = if frame.row {
            (
                if margin.auto.left {
                    auto_share
                } else {
                    margin.values.left
                },
                if margin.auto.right {
                    auto_share
                } else {
                    margin.values.right
                },
                margin.values.top,
                margin.values.bottom,
                margin.auto.top,
                margin.auto.bottom,
            )
        } else {
            (
                if margin.auto.top {
                    auto_share
                } else {
                    margin.values.top
                },
                if margin.auto.bottom {
                    auto_share
                } else {
                    margin.values.bottom
                },
                margin.values.left,
                margin.values.right,
                margin.auto.left,
                margin.auto.right,
            )
        };
        let child_main = if frame.row {
            child_size.width
        } else {
            child_size.height
        };
        let child_cross = if frame.row {
            child_size.height
        } else {
            child_size.width
        };
        let outer_main = leading_margin + child_main + trailing_margin;
        let normal_main = cursor + leading_margin;
        let main = if frame.reverse {
            content_main - cursor - outer_main + leading_margin
        } else {
            normal_main
        };
        let cross_free = (content_cross - child_cross - cross_start - cross_end).max(0.0);
        let cross = if cross_auto_start || cross_auto_end {
            cross_start
                + match (cross_auto_start, cross_auto_end) {
                    (true, true) => cross_free * 0.5,
                    (true, false) => cross_free,
                    (false, true) | (false, false) => 0.0,
                }
        } else {
            cross_start
                + match frame.align {
                    StyleKeyword::Center => cross_free * 0.5,
                    StyleKeyword::End | StyleKeyword::FlexEnd => cross_free,
                    StyleKeyword::Baseline
                    | StyleKeyword::FlexStart
                    | StyleKeyword::Start
                    | StyleKeyword::Stretch => 0.0,
                    _ => 0.0,
                }
        };
        output.offsets[index] = if frame.row {
            Point::new(insets.left + main, insets.top + cross)
        } else {
            Point::new(insets.left + cross, insets.top + main)
        };
        cursor += outer_main;
        ordinal += 1;
    }
    Ok(())
}

fn justify_spacing(justify: StyleKeyword, free: f32, child_count: usize) -> (f32, f32) {
    match justify {
        StyleKeyword::Center => (free * 0.5, 0.0),
        StyleKeyword::End | StyleKeyword::FlexEnd => (free, 0.0),
        StyleKeyword::SpaceBetween if child_count > 1 => (0.0, free / (child_count - 1) as f32),
        StyleKeyword::SpaceAround => {
            let step = free / child_count as f32;
            (step * 0.5, step)
        }
        StyleKeyword::SpaceEvenly => {
            let step = free / (child_count + 1) as f32;
            (step, step)
        }
        StyleKeyword::FlexStart | StyleKeyword::Start | StyleKeyword::SpaceBetween => (0.0, 0.0),
        _ => (0.0, 0.0),
    }
}

fn has_requested_dimension(
    scene: &Scene,
    node: NodeId,
    direct: Prop,
    property: StyleProperty,
) -> bool {
    scene.f32_prop(node, direct).is_some()
        || scene
            .style_length(node, property, 0)
            .is_some_and(|length| length.unit != StyleLengthUnit::Auto)
}

fn subtract_insets(value: f32, insets: f32) -> f32 {
    if value.is_infinite() {
        value
    } else {
        (value - insets).max(0.0)
    }
}

fn virtual_item_offset(
    scene: &Scene,
    list: NodeId,
    item_index: u32,
    virtual_layout: &impl VirtualLayoutProvider,
) -> Result<f32, LayoutError> {
    if let Some(offset) = virtual_layout.item_offset(list, item_index) {
        return validate_virtual_dimension(list, offset);
    }
    let config = scene.virtual_list(list).ok_or(LayoutError::SceneInvariant(
        "virtual item parent lost its configuration",
    ))?;
    validate_virtual_dimension(list, config.estimated_item_size * item_index as f32)
}

fn virtual_content_extent(
    scene: &Scene,
    list: NodeId,
    virtual_layout: &impl VirtualLayoutProvider,
) -> Result<f32, LayoutError> {
    if let Some(extent) = virtual_layout.content_extent(list) {
        return validate_virtual_dimension(list, extent);
    }
    let config = scene.virtual_list(list).ok_or(LayoutError::SceneInvariant(
        "virtual list lost its configuration",
    ))?;
    validate_virtual_dimension(list, config.estimated_item_size * config.item_count as f32)
}

fn validate_virtual_dimension(node: NodeId, value: f32) -> Result<f32, LayoutError> {
    if value.is_finite() && value >= 0.0 {
        Ok(value)
    } else {
        Err(LayoutError::InvalidVirtualGeometry { node, value })
    }
}

fn intersect_constraints(
    incoming: BoxConstraints,
    style_min_width: f32,
    style_max_width: f32,
    style_min_height: f32,
    style_max_height: f32,
) -> BoxConstraints {
    let max_width = incoming.max_width.min(style_max_width);
    let max_height = incoming.max_height.min(style_max_height);
    BoxConstraints {
        min_width: incoming.min_width.max(style_min_width).min(max_width),
        max_width,
        min_height: incoming.min_height.max(style_min_height).min(max_height),
        max_height,
    }
}

fn outer_dimension(
    scene: &Scene,
    node: NodeId,
    direct: Prop,
    property: StyleProperty,
    percentage_basis: f32,
    content_box_insets: f32,
    border_box: bool,
) -> Result<Option<f32>, LayoutError> {
    if let Some(value) = scene.f32_prop(node, direct) {
        if value.is_finite() && value >= 0.0 {
            return Ok(Some(value));
        }
        return Err(LayoutError::InvalidStyle {
            node,
            prop: direct,
            value,
        });
    }
    let Some(value) = resolve_style_length(scene.style_length(node, property, 0), percentage_basis)
    else {
        return Ok(None);
    };
    if !value.is_finite() || value < 0.0 {
        return Err(LayoutError::InvalidComputedStyle {
            node,
            property,
            value,
        });
    }
    Ok(Some(if border_box {
        value
    } else {
        value + content_box_insets
    }))
}

fn style_padding(
    scene: &Scene,
    node: NodeId,
    percentage_basis: f32,
) -> Result<EdgeInsets, LayoutError> {
    let [top, right, bottom, left] = scene.vec4_prop(node, Prop::Padding).unwrap_or_else(|| {
        [
            style_length_or_zero(scene, node, StyleProperty::PaddingTop, percentage_basis),
            style_length_or_zero(scene, node, StyleProperty::PaddingRight, percentage_basis),
            style_length_or_zero(scene, node, StyleProperty::PaddingBottom, percentage_basis),
            style_length_or_zero(scene, node, StyleProperty::PaddingLeft, percentage_basis),
        ]
    });
    for value in [top, right, bottom, left] {
        if !value.is_finite() || value < 0.0 {
            return Err(LayoutError::InvalidStyle {
                node,
                prop: Prop::Padding,
                value,
            });
        }
    }
    Ok(EdgeInsets {
        top,
        right,
        bottom,
        left,
    })
}

fn style_margin(
    scene: &Scene,
    node: NodeId,
    percentage_basis: f32,
) -> Result<Margins, LayoutError> {
    let (top, auto_top) = margin_value(scene, node, StyleProperty::MarginTop, percentage_basis)?;
    let (right, auto_right) =
        margin_value(scene, node, StyleProperty::MarginRight, percentage_basis)?;
    let (bottom, auto_bottom) =
        margin_value(scene, node, StyleProperty::MarginBottom, percentage_basis)?;
    let (left, auto_left) = margin_value(scene, node, StyleProperty::MarginLeft, percentage_basis)?;
    Ok(Margins {
        values: EdgeInsets {
            top,
            right,
            bottom,
            left,
        },
        auto: AutoEdges {
            top: auto_top,
            right: auto_right,
            bottom: auto_bottom,
            left: auto_left,
        },
    })
}

fn margin_value(
    scene: &Scene,
    node: NodeId,
    property: StyleProperty,
    percentage_basis: f32,
) -> Result<(f32, bool), LayoutError> {
    let Some(length) = scene.style_length(node, property, 0) else {
        return Ok((0.0, false));
    };
    if length.unit == StyleLengthUnit::Auto {
        return Ok((0.0, true));
    }
    let value = resolve_style_length(Some(length), percentage_basis).unwrap_or(0.0);
    if !value.is_finite() {
        return Err(LayoutError::InvalidComputedStyle {
            node,
            property,
            value,
        });
    }
    Ok((value, false))
}

fn style_border(
    scene: &Scene,
    node: NodeId,
    percentage_basis: f32,
) -> Result<EdgeInsets, LayoutError> {
    Ok(EdgeInsets {
        top: border_width(
            scene,
            node,
            StyleProperty::BorderTopWidth,
            StyleProperty::BorderTopStyle,
            percentage_basis,
        )?,
        right: border_width(
            scene,
            node,
            StyleProperty::BorderRightWidth,
            StyleProperty::BorderRightStyle,
            percentage_basis,
        )?,
        bottom: border_width(
            scene,
            node,
            StyleProperty::BorderBottomWidth,
            StyleProperty::BorderBottomStyle,
            percentage_basis,
        )?,
        left: border_width(
            scene,
            node,
            StyleProperty::BorderLeftWidth,
            StyleProperty::BorderLeftStyle,
            percentage_basis,
        )?,
    })
}

fn border_width(
    scene: &Scene,
    node: NodeId,
    width_property: StyleProperty,
    style_property: StyleProperty,
    percentage_basis: f32,
) -> Result<f32, LayoutError> {
    if scene.style_keyword(node, style_property, 0) != Some(StyleKeyword::Solid) {
        return Ok(0.0);
    }
    let value = resolve_style_length(
        scene.style_length(node, width_property, 0),
        percentage_basis,
    )
    .unwrap_or(0.0);
    if value.is_finite() && value >= 0.0 {
        Ok(value)
    } else {
        Err(LayoutError::InvalidComputedStyle {
            node,
            property: width_property,
            value,
        })
    }
}

fn percentage_basis(maximum: f32, minimum: f32) -> f32 {
    if maximum.is_finite() {
        maximum
    } else {
        minimum
    }
}

fn resolve_style_length(length: Option<StyleLength>, percentage_basis: f32) -> Option<f32> {
    match length? {
        StyleLength {
            unit: StyleLengthUnit::Px,
            value,
        } => Some(value),
        StyleLength {
            unit: StyleLengthUnit::Percent,
            value,
        } => Some(percentage_basis * value / 100.0),
        StyleLength {
            unit:
                StyleLengthUnit::Auto
                | StyleLengthUnit::None
                | StyleLengthUnit::Normal
                | StyleLengthUnit::Number,
            ..
        } => None,
    }
}

fn style_length_or_zero(
    scene: &Scene,
    node: NodeId,
    property: StyleProperty,
    percentage_basis: f32,
) -> f32 {
    resolve_style_length(scene.style_length(node, property, 0), percentage_basis).unwrap_or(0.0)
}

fn changed_geometry(previous: &LayoutSnapshot, next: &LayoutSnapshot) -> BitSet {
    let mut changed = BitSet::with_len(next.len().max(previous.len()));
    let shared = next.len().min(previous.len());
    for index in 0..shared {
        if previous.ids[index] != next.ids[index]
            || previous.offsets[index] != next.offsets[index]
            || previous.sizes[index] != next.sizes[index]
        {
            changed.insert(index);
        }
    }
    for index in shared..changed.len() {
        changed.insert(index);
    }
    changed
}

#[cfg(test)]
mod tests {
    use pingo_abi::{
        Mutation, MutationBatch, MutationInstruction, NULL_NODE_ID, ResourceKind,
        STYLE_ALL_FEATURE_BITS, STYLE_COMPUTED_ENCODING_VARIANT, STYLE_COMPUTED_ENCODING_VERSION,
        STYLE_LENGTH_AUTO, STYLE_LENGTH_PERCENT, STYLE_LENGTH_PX, STYLE_VALUE_KEYWORD,
        STYLE_VALUE_LENGTH,
    };
    use proptest::prelude::*;

    use super::*;

    fn id(index: u32) -> NodeId {
        NodeId::new(index, 1).expect("id")
    }

    fn commit(scene: &mut Scene, frame_seq: u32, mutations: Vec<Mutation>) {
        scene
            .commit(MutationBatch {
                frame_seq,
                instructions: mutations
                    .into_iter()
                    .map(|mutation| MutationInstruction { flags: 0, mutation })
                    .collect(),
            })
            .expect("valid scene mutation");
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

    fn computed_style(entries: &[(StyleProperty, u8, Vec<u8>)]) -> Vec<u8> {
        let payload_bytes = entries
            .iter()
            .map(|(_, _, payload)| 8 + payload.len().next_multiple_of(4))
            .sum::<usize>();
        let mut bytes = vec![0; 16];
        bytes[0] = STYLE_COMPUTED_ENCODING_VERSION;
        bytes[1] = STYLE_COMPUTED_ENCODING_VARIANT;
        bytes[4..8].copy_from_slice(&STYLE_ALL_FEATURE_BITS.to_le_bytes());
        bytes[8..12].copy_from_slice(&(entries.len() as u32).to_le_bytes());
        bytes[12..16].copy_from_slice(&(payload_bytes as u32).to_le_bytes());
        for (property, tag, payload) in entries {
            bytes.extend_from_slice(&(*property as u16).to_le_bytes());
            bytes.push(0);
            bytes.push(*tag);
            bytes.extend_from_slice(&(payload.len() as u16).to_le_bytes());
            bytes.extend_from_slice(&0_u16.to_le_bytes());
            bytes.extend_from_slice(payload);
            bytes.resize(bytes.len().next_multiple_of(4), 0);
        }
        bytes
    }

    fn keyword(keyword: StyleKeyword) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(4);
        bytes.extend_from_slice(&(keyword as u16).to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes
    }

    fn percent(value: f32) -> Vec<u8> {
        let mut bytes = vec![STYLE_LENGTH_PERCENT, 0, 0, 0];
        bytes.extend_from_slice(&value.to_le_bytes());
        bytes
    }

    fn px(value: f32) -> Vec<u8> {
        let mut bytes = vec![STYLE_LENGTH_PX, 0, 0, 0];
        bytes.extend_from_slice(&value.to_le_bytes());
        bytes
    }

    fn auto() -> Vec<u8> {
        let mut bytes = vec![STYLE_LENGTH_AUTO, 0, 0, 0];
        bytes.extend_from_slice(&0.0_f32.to_le_bytes());
        bytes
    }

    #[test]
    fn computed_display_and_percentage_size_drive_layout_with_direct_prop_priority() {
        let root = id(0);
        let hidden = id(1);
        let hidden_child = id(2);
        let visible = id(3);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                Mutation::DefineResource {
                    resource_id: 1,
                    kind: ResourceKind::ComputedStyle,
                    bytes: computed_style(&[(
                        StyleProperty::Display,
                        STYLE_VALUE_KEYWORD,
                        keyword(StyleKeyword::None),
                    )]),
                },
                Mutation::DefineResource {
                    resource_id: 2,
                    kind: ResourceKind::ComputedStyle,
                    bytes: computed_style(&[(
                        StyleProperty::Width,
                        STYLE_VALUE_LENGTH,
                        percent(50.0),
                    )]),
                },
                create(root, NodeKind::Root, None),
                create(hidden, NodeKind::Container, Some(root)),
                create(hidden_child, NodeKind::Container, Some(hidden)),
                create(visible, NodeKind::Container, Some(root)),
                Mutation::SetRef {
                    node_id: hidden.raw(),
                    prop: Prop::ComputedStyle,
                    resource_id: 1,
                },
                Mutation::SetRef {
                    node_id: visible.raw(),
                    prop: Prop::ComputedStyle,
                    resource_id: 2,
                },
                set_f32(hidden, Prop::Width, 200.0),
                set_f32(hidden, Prop::Height, 40.0),
                set_f32(hidden_child, Prop::Width, 40.0),
                set_f32(hidden_child, Prop::Height, 40.0),
                set_f32(visible, Prop::Width, 80.0),
                set_f32(visible, Prop::Height, 20.0),
            ],
        );
        let mut engine = LayoutEngine::new();
        engine
            .layout(
                &scene,
                BoxConstraints::tight(Size::new(200.0, 100.0)).expect("viewport"),
                &mut ZeroIntrinsicMeasurer,
            )
            .expect("style layout");

        assert_eq!(
            engine.snapshot().geometry(hidden),
            Some((Point::ZERO, Size::ZERO))
        );
        assert_eq!(
            engine.snapshot().geometry(hidden_child),
            Some((Point::ZERO, Size::ZERO))
        );
        assert_eq!(
            engine.snapshot().geometry(visible),
            Some((Point::ZERO, Size::new(80.0, 20.0)))
        );
        commit(
            &mut scene,
            2,
            vec![Mutation::ClearProp {
                node_id: visible.raw(),
                prop: Prop::Width,
            }],
        );
        engine
            .layout(
                &scene,
                BoxConstraints::tight(Size::new(200.0, 100.0)).expect("viewport"),
                &mut ZeroIntrinsicMeasurer,
            )
            .expect("percentage layout");
        assert_eq!(
            engine.snapshot().geometry(visible),
            Some((Point::ZERO, Size::new(100.0, 20.0)))
        );
    }

    #[test]
    fn css_box_model_reverse_flex_and_auto_margins_share_one_geometry_path() {
        let root = id(0);
        let view = id(1);
        let first = id(2);
        let second = id(3);
        let mut scene = Scene::new();
        let mut entries = vec![
            (StyleProperty::Width, STYLE_VALUE_LENGTH, px(100.0)),
            (StyleProperty::Height, STYLE_VALUE_LENGTH, px(80.0)),
        ];
        for property in [
            StyleProperty::PaddingTop,
            StyleProperty::PaddingRight,
            StyleProperty::PaddingBottom,
            StyleProperty::PaddingLeft,
        ] {
            entries.push((property, STYLE_VALUE_LENGTH, px(10.0)));
        }
        entries.extend([
            (
                StyleProperty::FlexDirection,
                STYLE_VALUE_KEYWORD,
                keyword(StyleKeyword::RowReverse),
            ),
            (
                StyleProperty::JustifyContent,
                STYLE_VALUE_KEYWORD,
                keyword(StyleKeyword::SpaceBetween),
            ),
            (
                StyleProperty::AlignItems,
                STYLE_VALUE_KEYWORD,
                keyword(StyleKeyword::Center),
            ),
        ]);
        for (width, style) in [
            (StyleProperty::BorderTopWidth, StyleProperty::BorderTopStyle),
            (
                StyleProperty::BorderRightWidth,
                StyleProperty::BorderRightStyle,
            ),
            (
                StyleProperty::BorderBottomWidth,
                StyleProperty::BorderBottomStyle,
            ),
            (
                StyleProperty::BorderLeftWidth,
                StyleProperty::BorderLeftStyle,
            ),
        ] {
            entries.push((width, STYLE_VALUE_LENGTH, px(2.0)));
            entries.push((style, STYLE_VALUE_KEYWORD, keyword(StyleKeyword::Solid)));
        }
        entries.sort_unstable_by_key(|(property, _, _)| *property as u16);
        commit(
            &mut scene,
            1,
            vec![
                Mutation::DefineResource {
                    resource_id: 1,
                    kind: ResourceKind::ComputedStyle,
                    bytes: computed_style(&entries),
                },
                Mutation::DefineResource {
                    resource_id: 2,
                    kind: ResourceKind::ComputedStyle,
                    bytes: computed_style(&[
                        (StyleProperty::MarginRight, STYLE_VALUE_LENGTH, auto()),
                        (StyleProperty::MarginLeft, STYLE_VALUE_LENGTH, auto()),
                    ]),
                },
                create(root, NodeKind::Root, None),
                create(view, NodeKind::Container, Some(root)),
                create(first, NodeKind::Container, Some(view)),
                create(second, NodeKind::Container, Some(view)),
                Mutation::SetRef {
                    node_id: view.raw(),
                    prop: Prop::ComputedStyle,
                    resource_id: 1,
                },
                set_f32(first, Prop::Width, 20.0),
                set_f32(first, Prop::Height, 10.0),
                set_f32(second, Prop::Width, 30.0),
                set_f32(second, Prop::Height, 10.0),
            ],
        );
        let mut engine = LayoutEngine::new();
        engine
            .layout(
                &scene,
                BoxConstraints::tight(Size::new(300.0, 200.0)).expect("viewport"),
                &mut ZeroIntrinsicMeasurer,
            )
            .expect("box model layout");
        assert_eq!(
            engine.snapshot().geometry(view),
            Some((Point::ZERO, Size::new(124.0, 104.0)))
        );
        assert_eq!(
            engine.snapshot().geometry(first),
            Some((Point::new(92.0, 47.0), Size::new(20.0, 10.0)))
        );
        assert_eq!(
            engine.snapshot().geometry(second),
            Some((Point::new(12.0, 47.0), Size::new(30.0, 10.0)))
        );

        commit(
            &mut scene,
            2,
            vec![Mutation::SetRef {
                node_id: first.raw(),
                prop: Prop::ComputedStyle,
                resource_id: 2,
            }],
        );
        engine
            .layout(
                &scene,
                BoxConstraints::tight(Size::new(300.0, 200.0)).expect("viewport"),
                &mut ZeroIntrinsicMeasurer,
            )
            .expect("auto margin layout");
        assert_eq!(
            engine.snapshot().geometry(first),
            Some((Point::new(67.0, 47.0), Size::new(20.0, 10.0)))
        );
    }

    #[test]
    fn lays_out_vertical_children_with_padding_and_fixed_dimensions() {
        let root = id(0);
        let first = id(1);
        let second = id(2);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                create(root, NodeKind::Root, None),
                create(first, NodeKind::Container, Some(root)),
                create(second, NodeKind::Container, Some(root)),
                Mutation::SetVec4 {
                    node_id: root.raw(),
                    prop: Prop::Padding,
                    value: [10.0, 5.0, 10.0, 5.0],
                },
                set_f32(first, Prop::Width, 40.0),
                set_f32(first, Prop::Height, 20.0),
                set_f32(second, Prop::Width, 60.0),
                set_f32(second, Prop::Height, 30.0),
            ],
        );
        let mut engine = LayoutEngine::new();
        engine
            .layout(
                &scene,
                BoxConstraints::tight(Size::new(100.0, 100.0)).expect("viewport"),
                &mut ZeroIntrinsicMeasurer,
            )
            .expect("layout");
        assert_eq!(
            engine.snapshot().geometry(root),
            Some((Point::ZERO, Size::new(100.0, 100.0)))
        );
        assert_eq!(
            engine.snapshot().geometry(first),
            Some((Point::new(5.0, 10.0), Size::new(40.0, 20.0)))
        );
        assert_eq!(
            engine.snapshot().geometry(second),
            Some((Point::new(5.0, 30.0), Size::new(60.0, 30.0)))
        );
    }

    fn set_vec4(node: NodeId, prop: Prop, value: [f32; 4]) -> Mutation {
        Mutation::SetVec4 {
            node_id: node.raw(),
            prop,
            value,
        }
    }

    #[test]
    fn a_row_flows_children_horizontally_with_gaps_and_sizes_to_them() {
        // A realistic list cell puts a thumbnail, a text column, a tag and a
        // button on one line. Without a flow direction each of those stacked
        // vertically, so the cell could only ever be a paragraph.
        let root = id(0);
        let row = id(1);
        let thumbnail = id(2);
        let body = id(3);
        let tag = id(4);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                create(root, NodeKind::Root, None),
                create(row, NodeKind::Container, Some(root)),
                create(thumbnail, NodeKind::Container, Some(row)),
                create(body, NodeKind::Container, Some(row)),
                create(tag, NodeKind::Container, Some(row)),
                set_f32(row, Prop::Direction, DIRECTION_ROW),
                set_f32(row, Prop::Gap, 8.0),
                set_f32(thumbnail, Prop::Width, 40.0),
                set_f32(thumbnail, Prop::Height, 40.0),
                set_f32(body, Prop::Width, 100.0),
                set_f32(body, Prop::Height, 24.0),
                set_f32(tag, Prop::Width, 30.0),
                set_f32(tag, Prop::Height, 16.0),
            ],
        );
        let mut engine = LayoutEngine::new();
        engine
            .layout(
                &scene,
                BoxConstraints::tight(Size::new(400.0, 200.0)).expect("viewport"),
                &mut ZeroIntrinsicMeasurer,
            )
            .expect("layout");
        let snapshot = engine.snapshot();
        assert_eq!(
            snapshot.geometry(thumbnail),
            Some((Point::ZERO, Size::new(40.0, 40.0)))
        );
        assert_eq!(
            snapshot.geometry(body),
            Some((Point::new(48.0, 0.0), Size::new(100.0, 24.0)))
        );
        assert_eq!(
            snapshot.geometry(tag),
            Some((Point::new(156.0, 0.0), Size::new(30.0, 16.0)))
        );
        // The row's natural size is the run along the flow axis and the tallest
        // child across it: gaps count once between each pair, never trailing.
        assert_eq!(
            snapshot.geometry(row).map(|(_, size)| size),
            Some(Size::new(186.0, 40.0))
        );
    }

    #[test]
    fn a_row_honours_padding_on_both_axes() {
        let root = id(0);
        let row = id(1);
        let child = id(2);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                create(root, NodeKind::Root, None),
                create(row, NodeKind::Container, Some(root)),
                create(child, NodeKind::Container, Some(row)),
                set_f32(row, Prop::Direction, DIRECTION_ROW),
                set_vec4(row, Prop::Padding, [6.0, 12.0, 6.0, 12.0]),
                set_f32(child, Prop::Width, 50.0),
                set_f32(child, Prop::Height, 20.0),
            ],
        );
        let mut engine = LayoutEngine::new();
        engine
            .layout(
                &scene,
                BoxConstraints::tight(Size::new(400.0, 200.0)).expect("viewport"),
                &mut ZeroIntrinsicMeasurer,
            )
            .expect("layout");
        let snapshot = engine.snapshot();
        assert_eq!(
            snapshot.geometry(child),
            Some((Point::new(12.0, 6.0), Size::new(50.0, 20.0)))
        );
        assert_eq!(
            snapshot.geometry(row).map(|(_, size)| size),
            Some(Size::new(74.0, 32.0))
        );
    }

    #[test]
    fn a_negative_gap_is_rejected_rather_than_silently_overlapping() {
        let root = id(0);
        let row = id(1);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                create(root, NodeKind::Root, None),
                create(row, NodeKind::Container, Some(root)),
                set_f32(row, Prop::Gap, -4.0),
            ],
        );
        let mut engine = LayoutEngine::new();
        assert!(
            engine
                .layout(
                    &scene,
                    BoxConstraints::tight(Size::new(400.0, 200.0)).expect("viewport"),
                    &mut ZeroIntrinsicMeasurer,
                )
                .is_err()
        );
    }

    #[test]
    fn scroll_viewport_does_not_constrain_its_content_extent() {
        let root = id(0);
        let scroll = id(1);
        let content = id(2);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                create(root, NodeKind::Root, None),
                create(scroll, NodeKind::Scroll, Some(root)),
                create(content, NodeKind::Container, Some(scroll)),
                set_f32(scroll, Prop::Width, 100.0),
                set_f32(scroll, Prop::Height, 80.0),
                set_f32(content, Prop::Width, 500.0),
                set_f32(content, Prop::Height, 1_000.0),
            ],
        );
        let mut engine = LayoutEngine::new();
        engine
            .layout(
                &scene,
                BoxConstraints::tight(Size::new(320.0, 240.0)).expect("viewport"),
                &mut ZeroIntrinsicMeasurer,
            )
            .expect("layout");
        assert_eq!(
            engine.snapshot().geometry(scroll),
            Some((Point::ZERO, Size::new(100.0, 80.0)))
        );
        assert_eq!(
            engine.snapshot().geometry(content),
            Some((Point::ZERO, Size::new(500.0, 1_000.0)))
        );
    }

    #[test]
    fn virtual_items_use_provider_offsets_instead_of_materialized_sibling_order() {
        struct VirtualGeometry;

        impl VirtualLayoutProvider for VirtualGeometry {
            fn item_offset(&self, list: NodeId, item_index: u32) -> Option<f32> {
                (list == id(1)).then_some(item_index as f32 * 30.0)
            }

            fn content_extent(&self, list: NodeId) -> Option<f32> {
                (list == id(1)).then_some(300.0)
            }
        }

        let root = id(0);
        let list = id(1);
        let seventh = id(2);
        let ninth = id(3);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                create(root, NodeKind::Root, None),
                create(list, NodeKind::Scroll, Some(root)),
                create(seventh, NodeKind::Container, Some(list)),
                create(ninth, NodeKind::Container, Some(list)),
                set_f32(list, Prop::Width, 100.0),
                set_f32(list, Prop::Height, 80.0),
                set_f32(seventh, Prop::Height, 30.0),
                set_f32(ninth, Prop::Height, 30.0),
                Mutation::ConfigureVirtualList {
                    node_id: list.raw(),
                    item_count: 10,
                    estimated_item_size: 20.0,
                    base_overscan_viewports: 1.0,
                    velocity_horizon_seconds: 0.25,
                    maximum_ahead_viewports: 4.0,
                    axis: pingo_abi::VirtualAxis::Y,
                },
                Mutation::SetVirtualItem {
                    node_id: seventh.raw(),
                    item_index: 7,
                },
                Mutation::SetVirtualItem {
                    node_id: ninth.raw(),
                    item_index: 9,
                },
            ],
        );
        let mut engine = LayoutEngine::new();
        engine
            .layout_with_virtual(
                &scene,
                BoxConstraints::tight(Size::new(100.0, 80.0)).expect("viewport"),
                &mut ZeroIntrinsicMeasurer,
                &VirtualGeometry,
            )
            .expect("layout");

        assert_eq!(
            engine.snapshot().geometry(seventh),
            Some((Point::new(0.0, 210.0), Size::new(0.0, 30.0)))
        );
        assert_eq!(
            engine.snapshot().geometry(ninth),
            Some((Point::new(0.0, 270.0), Size::new(0.0, 30.0)))
        );
    }

    #[test]
    fn horizontal_virtual_items_share_the_axis_neutral_offset_oracle() {
        struct VirtualGeometry;

        impl VirtualLayoutProvider for VirtualGeometry {
            fn item_offset(&self, list: NodeId, item_index: u32) -> Option<f32> {
                (list == id(1)).then_some(item_index as f32 * 30.0)
            }

            fn content_extent(&self, list: NodeId) -> Option<f32> {
                (list == id(1)).then_some(300.0)
            }
        }

        let root = id(0);
        let list = id(1);
        let seventh = id(2);
        let ninth = id(3);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                create(root, NodeKind::Root, None),
                create(list, NodeKind::Scroll, Some(root)),
                create(seventh, NodeKind::Container, Some(list)),
                create(ninth, NodeKind::Container, Some(list)),
                set_f32(list, Prop::Width, 80.0),
                set_f32(list, Prop::Height, 100.0),
                set_f32(seventh, Prop::Width, 30.0),
                set_f32(seventh, Prop::Height, 10.0),
                set_f32(ninth, Prop::Width, 30.0),
                set_f32(ninth, Prop::Height, 10.0),
                Mutation::ConfigureVirtualList {
                    node_id: list.raw(),
                    item_count: 10,
                    estimated_item_size: 20.0,
                    base_overscan_viewports: 1.0,
                    velocity_horizon_seconds: 0.25,
                    maximum_ahead_viewports: 4.0,
                    axis: pingo_abi::VirtualAxis::X,
                },
                Mutation::SetVirtualItem {
                    node_id: seventh.raw(),
                    item_index: 7,
                },
                Mutation::SetVirtualItem {
                    node_id: ninth.raw(),
                    item_index: 9,
                },
            ],
        );
        let mut engine = LayoutEngine::new();
        engine
            .layout_with_virtual(
                &scene,
                BoxConstraints::tight(Size::new(80.0, 100.0)).expect("viewport"),
                &mut ZeroIntrinsicMeasurer,
                &VirtualGeometry,
            )
            .expect("layout");

        assert_eq!(
            engine.snapshot().geometry(seventh),
            Some((Point::new(210.0, 0.0), Size::new(30.0, 10.0)))
        );
        assert_eq!(
            engine.snapshot().geometry(ninth),
            Some((Point::new(270.0, 0.0), Size::new(30.0, 10.0)))
        );
    }

    #[test]
    fn double_buffer_comparison_and_clean_skip_are_exact() {
        let root = id(0);
        let child = id(1);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                create(root, NodeKind::Root, None),
                create(child, NodeKind::Container, Some(root)),
                set_f32(child, Prop::Width, 10.0),
                set_f32(child, Prop::Height, 10.0),
            ],
        );
        let constraints = BoxConstraints::tight(Size::new(100.0, 100.0)).expect("viewport");
        let mut engine = LayoutEngine::new();
        let first = engine
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("first");
        assert_eq!(first.changed.iter_ones().collect::<Vec<_>>(), vec![0, 1]);
        scene.clear_dirty();
        let skipped = engine
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("skip");
        assert!(!skipped.full);
        assert_eq!(skipped.visited, 0);
        assert_eq!(skipped.changed.iter_ones().next(), None);

        commit(&mut scene, 2, vec![set_f32(child, Prop::Width, 25.0)]);
        let changed = engine
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("changed");
        assert_eq!(changed.changed.iter_ones().collect::<Vec<_>>(), vec![1]);
    }

    #[test]
    fn fixed_size_ancestor_contains_relayout_work() {
        let root = id(0);
        let boundary = id(1);
        let first = id(2);
        let second = id(3);
        let outside = id(4);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                create(root, NodeKind::Root, None),
                create(boundary, NodeKind::Container, Some(root)),
                create(first, NodeKind::Container, Some(boundary)),
                create(second, NodeKind::Container, Some(boundary)),
                create(outside, NodeKind::Container, Some(root)),
                set_f32(boundary, Prop::Width, 200.0),
                set_f32(boundary, Prop::Height, 200.0),
                set_f32(first, Prop::Width, 50.0),
                set_f32(first, Prop::Height, 20.0),
                set_f32(second, Prop::Width, 50.0),
                set_f32(second, Prop::Height, 30.0),
                set_f32(outside, Prop::Width, 100.0),
                set_f32(outside, Prop::Height, 100.0),
            ],
        );
        let constraints = BoxConstraints::tight(Size::new(500.0, 500.0)).expect("viewport");
        let mut incremental = LayoutEngine::new();
        incremental
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("initial");
        scene.clear_dirty();

        commit(&mut scene, 2, vec![set_f32(first, Prop::Height, 45.0)]);
        let outcome = incremental
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("incremental");
        assert!(!outcome.full);
        assert_eq!(outcome.visited, 3);
        assert_eq!(
            incremental.snapshot().geometry(second),
            Some((Point::new(0.0, 45.0), Size::new(50.0, 30.0)))
        );

        let mut reference = LayoutEngine::new();
        reference
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("reference");
        assert_eq!(incremental.snapshot(), reference.snapshot());
        assert_eq!(incremental.metrics().incremental_passes, 1);
        assert_eq!(incremental.metrics().boundary_subtrees, 1);
    }

    #[test]
    fn percentage_children_resolve_against_the_content_box_of_scroll_and_column_containers() {
        // Regression: a non-visible overflow makes the axis scrollable, which
        // relaxes the child measuring constraint to infinity. Deriving the
        // percentage basis from that constraint resolved every percentage
        // inside the container to zero.
        let root = id(0);
        let scroller = id(1);
        let scrolled_child = id(2);
        let column = id(3);
        let column_child = id(4);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                Mutation::DefineResource {
                    resource_id: 1,
                    kind: ResourceKind::ComputedStyle,
                    bytes: computed_style(&[
                        (StyleProperty::PaddingTop, STYLE_VALUE_LENGTH, px(10.0)),
                        (StyleProperty::PaddingRight, STYLE_VALUE_LENGTH, px(10.0)),
                        (StyleProperty::PaddingBottom, STYLE_VALUE_LENGTH, px(10.0)),
                        (StyleProperty::PaddingLeft, STYLE_VALUE_LENGTH, px(10.0)),
                        (
                            StyleProperty::OverflowY,
                            STYLE_VALUE_KEYWORD,
                            keyword(StyleKeyword::Hidden),
                        ),
                    ]),
                },
                Mutation::DefineResource {
                    resource_id: 2,
                    kind: ResourceKind::ComputedStyle,
                    bytes: computed_style(&[
                        (StyleProperty::Width, STYLE_VALUE_LENGTH, percent(50.0)),
                        (StyleProperty::Height, STYLE_VALUE_LENGTH, percent(25.0)),
                    ]),
                },
                create(root, NodeKind::Root, None),
                create(scroller, NodeKind::Container, Some(root)),
                create(scrolled_child, NodeKind::Container, Some(scroller)),
                create(column, NodeKind::Container, Some(root)),
                create(column_child, NodeKind::Container, Some(column)),
                Mutation::SetRef {
                    node_id: scroller.raw(),
                    prop: Prop::ComputedStyle,
                    resource_id: 1,
                },
                Mutation::SetRef {
                    node_id: scrolled_child.raw(),
                    prop: Prop::ComputedStyle,
                    resource_id: 2,
                },
                Mutation::SetRef {
                    node_id: column_child.raw(),
                    prop: Prop::ComputedStyle,
                    resource_id: 2,
                },
                set_f32(scroller, Prop::Width, 200.0),
                set_f32(scroller, Prop::Height, 100.0),
                set_f32(column, Prop::Width, 200.0),
                set_f32(column, Prop::Height, 100.0),
            ],
        );
        let mut engine = LayoutEngine::new();
        engine
            .layout(
                &scene,
                BoxConstraints::tight(Size::new(200.0, 400.0)).expect("viewport"),
                &mut ZeroIntrinsicMeasurer,
            )
            .expect("layout");

        // 200x100 box minus 10px padding on each edge leaves a 180x80 content box.
        assert_eq!(
            engine.snapshot().geometry(scrolled_child),
            Some((Point::new(10.0, 10.0), Size::new(90.0, 20.0)))
        );
        // Column flow relaxes the block measuring axis, but the container's own
        // height is definite, so percentages still resolve.
        assert_eq!(
            engine.snapshot().geometry(column_child),
            Some((Point::ZERO, Size::new(100.0, 25.0)))
        );
    }

    #[test]
    fn a_percentage_sized_node_is_not_treated_as_a_relayout_boundary() {
        // A boundary restarts with tight constraints, so its own percentage
        // basis would become its own box instead of its parent's content box.
        let root = id(0);
        let outer = id(1);
        let inner = id(2);
        let leaf = id(3);
        let mut scene = Scene::new();
        commit(
            &mut scene,
            1,
            vec![
                Mutation::DefineResource {
                    resource_id: 1,
                    kind: ResourceKind::ComputedStyle,
                    bytes: computed_style(&[
                        (StyleProperty::Width, STYLE_VALUE_LENGTH, px(200.0)),
                        (StyleProperty::Height, STYLE_VALUE_LENGTH, px(200.0)),
                        (
                            StyleProperty::PaddingLeft,
                            STYLE_VALUE_LENGTH,
                            percent(10.0),
                        ),
                    ]),
                },
                create(root, NodeKind::Root, None),
                create(outer, NodeKind::Container, Some(root)),
                create(inner, NodeKind::Container, Some(outer)),
                create(leaf, NodeKind::Container, Some(inner)),
                Mutation::SetRef {
                    node_id: inner.raw(),
                    prop: Prop::ComputedStyle,
                    resource_id: 1,
                },
                set_f32(outer, Prop::Width, 400.0),
                set_f32(outer, Prop::Height, 400.0),
                set_f32(leaf, Prop::Width, 10.0),
                set_f32(leaf, Prop::Height, 10.0),
            ],
        );
        let constraints = BoxConstraints::tight(Size::new(500.0, 500.0)).expect("viewport");
        let mut incremental = LayoutEngine::new();
        incremental
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("initial");
        scene.clear_dirty();

        commit(&mut scene, 2, vec![set_f32(leaf, Prop::Height, 20.0)]);
        incremental
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("incremental");
        let mut reference = LayoutEngine::new();
        reference
            .layout(&scene, constraints, &mut ZeroIntrinsicMeasurer)
            .expect("reference");
        assert_eq!(incremental.snapshot(), reference.snapshot());
        // The 10% padding is 40px, resolved from the 400px parent content box.
        assert_eq!(
            reference.snapshot().geometry(leaf),
            Some((Point::new(40.0, 0.0), Size::new(10.0, 20.0)))
        );
    }

    proptest! {
        #[test]
        fn generated_layouts_are_constrained_and_idempotent(
            viewport_width in 1.0_f32..2_000.0,
            viewport_height in 1.0_f32..2_000.0,
            dimensions in prop::collection::vec((0.0_f32..500.0, 0.0_f32..500.0), 0..64),
        ) {
            let root = id(0);
            let mut scene = Scene::new();
            let mut mutations = vec![create(root, NodeKind::Root, None)];
            for (index, (width, height)) in dimensions.iter().copied().enumerate() {
                let child = id((index + 1) as u32);
                mutations.push(create(child, NodeKind::Container, Some(root)));
                mutations.push(set_f32(child, Prop::Width, width));
                mutations.push(set_f32(child, Prop::Height, height));
            }
            commit(&mut scene, 1, mutations);
            let constraints = BoxConstraints::tight(Size::new(viewport_width, viewport_height)).expect("viewport");
            let mut first = LayoutEngine::new();
            let mut second = LayoutEngine::new();
            first.layout(&scene, constraints, &mut ZeroIntrinsicMeasurer).expect("first");
            second.layout(&scene, constraints, &mut ZeroIntrinsicMeasurer).expect("second");
            prop_assert_eq!(first.snapshot(), second.snapshot());
            for index in 0..first.snapshot().len() {
                let (_, size) = first.snapshot().geometry_at(index).expect("geometry");
                prop_assert!(size.is_valid());
                prop_assert!(size.width <= viewport_width);
            }
        }

        #[test]
        fn incremental_boundaries_match_full_layout_after_each_change(
            changes in prop::collection::vec((0_usize..4, 0.0_f32..180.0), 0..80),
        ) {
            let root = id(0);
            let left = id(1);
            let left_first = id(2);
            let left_second = id(3);
            let right = id(4);
            let right_first = id(5);
            let right_second = id(6);
            let children = [left_first, left_second, right_first, right_second];
            let mut scene = Scene::new();
            commit(&mut scene, 1, vec![
                create(root, NodeKind::Root, None),
                create(left, NodeKind::Container, Some(root)),
                create(left_first, NodeKind::Container, Some(left)),
                create(left_second, NodeKind::Container, Some(left)),
                create(right, NodeKind::Container, Some(root)),
                create(right_first, NodeKind::Container, Some(right)),
                create(right_second, NodeKind::Container, Some(right)),
                set_f32(left, Prop::Width, 200.0),
                set_f32(left, Prop::Height, 200.0),
                set_f32(right, Prop::Width, 200.0),
                set_f32(right, Prop::Height, 200.0),
                set_f32(left_first, Prop::Height, 10.0),
                set_f32(left_second, Prop::Height, 10.0),
                set_f32(right_first, Prop::Height, 10.0),
                set_f32(right_second, Prop::Height, 10.0),
            ]);
            let constraints = BoxConstraints::tight(Size::new(500.0, 500.0)).expect("viewport");
            let mut incremental = LayoutEngine::new();
            incremental.layout(&scene, constraints, &mut ZeroIntrinsicMeasurer).expect("initial");
            scene.clear_dirty();
            for (frame, (child_index, height)) in (2_u32..).zip(changes) {
                commit(&mut scene, frame, vec![set_f32(children[child_index], Prop::Height, height)]);
                incremental.layout(&scene, constraints, &mut ZeroIntrinsicMeasurer).expect("incremental");
                let mut reference = LayoutEngine::new();
                reference.layout(&scene, constraints, &mut ZeroIntrinsicMeasurer).expect("reference");
                prop_assert_eq!(incremental.snapshot(), reference.snapshot());
                scene.clear_dirty();
            }
        }
    }
}
