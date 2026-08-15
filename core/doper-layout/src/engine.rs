use doper_abi::{NodeKind, Prop};
use doper_scene::{BitSet, DirtyDomain, NodeId, Scene};

use crate::{BoxConstraints, LayoutError, Point, Size};

/// Supplies deterministic intrinsic dimensions for leaf nodes.
pub trait IntrinsicMeasurer {
    /// Measures a leaf within the maximum content-box constraints.
    fn measure(&mut self, scene: &Scene, node: NodeId, constraints: BoxConstraints) -> Size;
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

    /// Computes and atomically commits geometry for the Scene.
    pub fn layout(
        &mut self,
        scene: &Scene,
        constraints: BoxConstraints,
        measurer: &mut impl IntrinsicMeasurer,
    ) -> Result<LayoutOutcome, LayoutError> {
        if scene.is_empty() {
            let changed = changed_geometry(&self.front, &LayoutSnapshot::default());
            self.front = LayoutSnapshot::default();
            self.back = LayoutSnapshot::default();
            self.last_constraints = Some(constraints);
            self.last_topology_compactions = scene.metrics().topology_compactions;
            self.metrics.geometry_changes += changed.iter_ones().count() as u64;
            return Ok(LayoutOutcome {
                changed,
                full: true,
                visited: 0,
            });
        }

        let topology_unchanged = self.front.ids == scene.ids()
            && self.last_topology_compactions == scene.metrics().topology_compactions;
        let clean = scene
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

        let can_increment = topology_unchanged && self.last_constraints == Some(constraints);
        let (full, visited, boundary_count) = if can_increment {
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
    }

    fn prepare_incremental(&mut self) {
        self.back.ids.clone_from(&self.front.ids);
        self.back.offsets.clone_from(&self.front.offsets);
        self.back.sizes.clone_from(&self.front.sizes);
    }

    fn collect_boundaries(&mut self, scene: &Scene) -> Result<(), LayoutError> {
        let root = *scene
            .ids()
            .first()
            .ok_or(LayoutError::SceneInvariant("non-empty Scene has no root"))?;
        self.candidate_roots.clear();
        for index in scene.dirty(DirtyDomain::Layout).iter_ones() {
            let dirty = *scene.ids().get(index).ok_or(LayoutError::SceneInvariant(
                "dirty layout index is out of bounds",
            ))?;
            let mut candidate = root;
            let mut cursor = scene.parent(dirty);
            while let Some(ancestor) = cursor {
                if is_fixed_boundary(scene, ancestor) {
                    candidate = ancestor;
                    break;
                }
                cursor = scene.parent(ancestor);
            }
            self.candidate_roots.push(candidate);
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
}

struct Frame {
    node: NodeId,
    index: usize,
    constraints: BoxConstraints,
    child_constraints: BoxConstraints,
    next_child: Option<NodeId>,
    padding: EdgeInsets,
    fixed_width: Option<f32>,
    fixed_height: Option<f32>,
    content_y: f32,
    content_width: f32,
}

fn compute_subtree(
    scene: &Scene,
    root: NodeId,
    constraints: BoxConstraints,
    measurer: &mut impl IntrinsicMeasurer,
    output: &mut LayoutSnapshot,
    stack: &mut Vec<Frame>,
) -> Result<(), LayoutError> {
    if scene.parent(root).is_none() && scene.kind(root) != Some(NodeKind::Root) {
        return Err(LayoutError::SceneInvariant("first node is not the root"));
    }

    stack.clear();
    stack.push(make_frame(scene, root, constraints)?);
    while let Some(frame) = stack.last_mut() {
        if let Some(child) = frame.next_child {
            frame.next_child = scene.next_sibling(child);
            let child_frame = make_frame(scene, child, frame.child_constraints)?;
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
        let natural = Size::new(
            frame.content_width.max(intrinsic.width) + frame.padding.horizontal(),
            (frame.content_y + intrinsic.height) + frame.padding.bottom,
        );
        let requested = Size::new(
            frame.fixed_width.unwrap_or(natural.width),
            frame.fixed_height.unwrap_or(natural.height),
        );
        let size = frame.constraints.constrain(requested);
        output.sizes[frame.index] = size;

        if let Some(parent) = stack.last_mut() {
            output.offsets[frame.index] = Point::new(parent.padding.left, parent.content_y);
            parent.content_y += size.height;
            parent.content_width = parent.content_width.max(size.width);
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

fn make_frame(scene: &Scene, node: NodeId, incoming: BoxConstraints) -> Result<Frame, LayoutError> {
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
    Ok(Frame {
        node,
        index,
        constraints,
        child_constraints,
        next_child: scene.first_child(node),
        padding,
        fixed_width,
        fixed_height,
        content_y: padding.top,
        content_width: 0.0,
    })
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
    use doper_abi::{Mutation, MutationBatch, MutationInstruction, NULL_NODE_ID};
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
