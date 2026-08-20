use std::collections::{HashMap, HashSet};

use pingo_abi::{NodeKind, Prop};
use pingo_scene::{BitSet, DirtyDomain, NodeId, Scene};

use crate::{BoxConstraints, LayoutError, Point, Size};

/// Supplies deterministic intrinsic dimensions for leaf nodes.
pub trait IntrinsicMeasurer {
    /// Measures a leaf within the maximum content-box constraints.
    fn measure(&mut self, scene: &Scene, node: NodeId, constraints: BoxConstraints) -> Size;
}

/// Supplies variable-height virtual-list geometry owned by the scrolling subsystem.
///
/// Returning `None` uses the Scene's validated uniform-height estimate. This keeps
/// the reference layout path deterministic before a Core scroll state is created.
pub trait VirtualLayoutProvider {
    /// Returns the leading logical offset for one item in its virtual list.
    fn item_offset(&self, list: NodeId, item_index: u32) -> Option<f32>;

    /// Returns the current total logical content height for one virtual list.
    fn content_height(&self, list: NodeId) -> Option<f32>;
}

/// Uniform-estimate virtual geometry used by standalone layout callers.
#[derive(Default)]
pub struct EstimatedVirtualLayout;

impl VirtualLayoutProvider for EstimatedVirtualLayout {
    fn item_offset(&self, _list: NodeId, _item_index: u32) -> Option<f32> {
        None
    }

    fn content_height(&self, _list: NodeId) -> Option<f32> {
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
        let parent_frame = make_frame(
            scene,
            parent,
            BoxConstraints::tight(parent_size)?,
            virtual_layout,
        )?;
        compute_subtree(
            scene,
            node,
            parent_frame.child_constraints,
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
        self.back.offsets[index] =
            Point::new(parent_frame.padding.left, parent_frame.padding.top + offset);
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

#[derive(Clone, Copy)]
struct EdgeInsets {
    top: f32,
    right: f32,
    bottom: f32,
    left: f32,
}

impl EdgeInsets {
    const ZERO: Self = Self {
        top: 0.0,
        right: 0.0,
        bottom: 0.0,
        left: 0.0,
    };

    fn horizontal(self) -> f32 {
        self.left + self.right
    }

    fn vertical(self) -> f32 {
        self.top + self.bottom
    }
}

/// Value of [`Prop::Direction`] that lays children out along the main axis.
///
/// The prop is an `f32` because the Mutation Stream has no integer prop value
/// type; anything other than exactly this value keeps the default column flow.
const DIRECTION_ROW: f32 = 1.0;

struct Frame {
    node: NodeId,
    index: usize,
    constraints: BoxConstraints,
    child_constraints: BoxConstraints,
    next_child: Option<NodeId>,
    padding: EdgeInsets,
    fixed_width: Option<f32>,
    fixed_height: Option<f32>,
    /// Offset already consumed along the flow axis, including leading padding.
    main: f32,
    /// Largest child extent across the flow axis.
    cross: f32,
    /// Whether children flow left to right rather than top to bottom.
    row: bool,
    /// Space inserted between adjacent children.
    gap: f32,
    /// Whether a child has been placed, so `gap` applies from the second on.
    placed: bool,
}

fn compute_subtree(
    scene: &Scene,
    root: NodeId,
    constraints: BoxConstraints,
    measurer: &mut impl IntrinsicMeasurer,
    virtual_layout: &impl VirtualLayoutProvider,
    output: &mut LayoutSnapshot,
    stack: &mut Vec<Frame>,
) -> Result<(), LayoutError> {
    if scene.parent(root).is_none() && scene.kind(root) != Some(NodeKind::Root) {
        return Err(LayoutError::SceneInvariant("first node is not the root"));
    }

    stack.clear();
    stack.push(make_frame(scene, root, constraints, virtual_layout)?);
    while let Some(frame) = stack.last_mut() {
        if let Some(child) = frame.next_child {
            frame.next_child = scene.next_sibling(child);
            let child_frame = make_frame(scene, child, frame.child_constraints, virtual_layout)?;
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
        let natural = if frame.row {
            Size::new(
                frame.main + intrinsic.width + frame.padding.right,
                frame.cross.max(intrinsic.height) + frame.padding.vertical(),
            )
        } else {
            Size::new(
                frame.cross.max(intrinsic.width) + frame.padding.horizontal(),
                frame.main + intrinsic.height + frame.padding.bottom,
            )
        };
        let requested = Size::new(
            frame.fixed_width.unwrap_or(natural.width),
            frame.fixed_height.unwrap_or(natural.height),
        );
        let size = frame.constraints.constrain(requested);
        output.sizes[frame.index] = size;

        if let Some(parent) = stack.last_mut() {
            if let Some(item_index) = scene.virtual_item_index(frame.node)
                && scene.virtual_list(parent.node).is_some()
            {
                let offset = virtual_item_offset(scene, parent.node, item_index, virtual_layout)?;
                output.offsets[frame.index] =
                    Point::new(parent.padding.left, parent.padding.top + offset);
                // A virtual list is always a column, so its cross axis is width.
                parent.cross = parent.cross.max(size.width);
            } else {
                if parent.placed {
                    parent.main += parent.gap;
                }
                parent.placed = true;
                if parent.row {
                    output.offsets[frame.index] = Point::new(parent.main, parent.padding.top);
                    parent.main += size.width;
                    parent.cross = parent.cross.max(size.height);
                } else {
                    output.offsets[frame.index] = Point::new(parent.padding.left, parent.main);
                    parent.main += size.height;
                    parent.cross = parent.cross.max(size.width);
                }
            }
        }
    }
    Ok(())
}

fn is_fixed_boundary(scene: &Scene, node: NodeId) -> bool {
    scene.f32_prop(node, Prop::Width).is_some() && scene.f32_prop(node, Prop::Height).is_some()
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
    virtual_layout: &impl VirtualLayoutProvider,
) -> Result<Frame, LayoutError> {
    let index = scene.resolve(node).ok_or(LayoutError::SceneInvariant(
        "layout encountered a stale node",
    ))?;
    let min_width = style_dimension(scene, node, Prop::MinWidth)?.unwrap_or(0.0);
    let min_height = style_dimension(scene, node, Prop::MinHeight)?.unwrap_or(0.0);
    let max_width = style_dimension(scene, node, Prop::MaxWidth)?.unwrap_or(f32::INFINITY);
    let max_height = style_dimension(scene, node, Prop::MaxHeight)?.unwrap_or(f32::INFINITY);
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
    let padding = style_padding(scene, node)?;
    let fixed_width = style_dimension(scene, node, Prop::Width)?;
    let fixed_height = style_dimension(scene, node, Prop::Height)?;
    let mut child_constraints = constraints.child_constraints(padding.horizontal());
    if let Some(width) = fixed_width {
        let outer_width = constraints
            .constrain(Size::new(width, constraints.min_height))
            .width;
        child_constraints.max_width = (outer_width - padding.horizontal()).max(0.0);
    }
    if scene.kind(node) == Some(NodeKind::Scroll) {
        child_constraints.max_width = f32::INFINITY;
        child_constraints.max_height = f32::INFINITY;
    }
    // A virtual list always flows vertically: its item offsets come from Core's
    // height index, not from sibling accumulation.
    let virtual_list = scene.virtual_list(node);
    let row = virtual_list.is_none()
        && scene
            .f32_prop(node, Prop::Direction)
            .is_some_and(|value| value == DIRECTION_ROW);
    let gap = match scene.f32_prop(node, Prop::Gap) {
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
        Some(_) => padding.top + virtual_content_height(scene, node, virtual_layout)?,
        None if row => padding.left,
        None => padding.top,
    };
    Ok(Frame {
        node,
        index,
        constraints,
        child_constraints,
        next_child: scene.first_child(node),
        padding,
        fixed_width,
        fixed_height,
        main,
        cross: 0.0,
        row,
        gap,
        placed: false,
    })
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
    validate_virtual_dimension(list, config.estimated_item_height * item_index as f32)
}

fn virtual_content_height(
    scene: &Scene,
    list: NodeId,
    virtual_layout: &impl VirtualLayoutProvider,
) -> Result<f32, LayoutError> {
    if let Some(height) = virtual_layout.content_height(list) {
        return validate_virtual_dimension(list, height);
    }
    let config = scene.virtual_list(list).ok_or(LayoutError::SceneInvariant(
        "virtual list lost its configuration",
    ))?;
    validate_virtual_dimension(
        list,
        config.estimated_item_height * config.item_count as f32,
    )
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

fn style_dimension(scene: &Scene, node: NodeId, prop: Prop) -> Result<Option<f32>, LayoutError> {
    let Some(value) = scene.f32_prop(node, prop) else {
        return Ok(None);
    };
    if value.is_finite() && value >= 0.0 {
        Ok(Some(value))
    } else {
        Err(LayoutError::InvalidStyle { node, prop, value })
    }
}

fn style_padding(scene: &Scene, node: NodeId) -> Result<EdgeInsets, LayoutError> {
    let Some([top, right, bottom, left]) = scene.vec4_prop(node, Prop::Padding) else {
        return Ok(EdgeInsets::ZERO);
    };
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
    use pingo_abi::{Mutation, MutationBatch, MutationInstruction, NULL_NODE_ID};
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

            fn content_height(&self, list: NodeId) -> Option<f32> {
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
                    estimated_item_height: 20.0,
                    base_overscan_viewports: 1.0,
                    velocity_horizon_seconds: 0.25,
                    maximum_ahead_viewports: 4.0,
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
