#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Incrementally refitted world geometry and deterministic BVH hit testing.

use std::fmt;

use pingo_abi::{
    AFFINE_A_OFFSET, AFFINE_B_OFFSET, AFFINE_C_OFFSET, AFFINE_D_OFFSET, AFFINE_E_OFFSET,
    AFFINE_F_OFFSET, AFFINE_RESOURCE_FIXED_BYTES, AFFINE_RESOURCE_VARIANT, AFFINE_VARIANT_OFFSET,
    AFFINE_VERSION_OFFSET, Prop, RESOURCE_ENCODING_VERSION, StyleKeyword, StyleLength,
    StyleLengthUnit, StyleProperty, StyleTransformOperation,
};
use pingo_layout::LayoutSnapshot;
use pingo_scene::{NodeId, Scene};

/// Finite two-dimensional point in logical pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct HitPoint {
    /// Horizontal coordinate.
    pub x: f32,
    /// Vertical coordinate.
    pub y: f32,
}

/// Axis-aligned world-space rectangle.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct WorldRect {
    /// Minimum horizontal coordinate.
    pub left: f32,
    /// Minimum vertical coordinate.
    pub top: f32,
    /// Maximum horizontal coordinate.
    pub right: f32,
    /// Maximum vertical coordinate.
    pub bottom: f32,
}

impl WorldRect {
    /// Returns whether a point is inside the half-open rectangle.
    #[must_use]
    pub fn contains(self, point: HitPoint) -> bool {
        point.x >= self.left && point.x < self.right && point.y >= self.top && point.y < self.bottom
    }

    fn union(self, other: Self) -> Self {
        Self {
            left: self.left.min(other.left),
            top: self.top.min(other.top),
            right: self.right.max(other.right),
            bottom: self.bottom.max(other.bottom),
        }
    }

    fn intersect(self, other: Self) -> Self {
        Self {
            left: self.left.max(other.left),
            top: self.top.max(other.top),
            right: self.right.min(other.right),
            bottom: self.bottom.min(other.bottom),
        }
    }
}

/// One world transform and local box retained for interaction consumers.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WorldGeometry {
    /// Canvas-compatible local-to-world affine matrix.
    pub transform: [f32; 6],
    /// World AABB enclosing the transformed local box.
    pub aabb: WorldRect,
    /// Local width.
    pub width: f32,
    /// Local height.
    pub height: f32,
    /// Resolved circular corner radius in local logical pixels.
    pub radius: f32,
}

impl WorldGeometry {
    /// Transforms a local point to world coordinates.
    #[must_use]
    pub fn transform_point(self, point: HitPoint) -> HitPoint {
        Affine(self.transform).point(point)
    }

    /// Transforms a world point into local coordinates when invertible.
    #[must_use]
    pub fn to_local(self, point: HitPoint) -> Option<HitPoint> {
        Some(Affine(self.transform).inverse()?.point(point))
    }

    fn contains_precise(self, point: HitPoint) -> bool {
        let Some(inverse) = Affine(self.transform).inverse() else {
            return false;
        };
        let local = inverse.point(point);
        rounded_box_contains(local, self.width, self.height, self.radius)
    }
}

/// Ordered target and ancestor path from root through target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HitResult {
    /// Deepest painted node containing the point.
    pub target: NodeId,
    /// Stable root-to-target propagation path.
    pub path: Vec<NodeId>,
}

/// Hit-index construction or resource error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HitError {
    /// Scene and layout topology diverged.
    TopologyMismatch,
    /// A transform resource was malformed despite reaching derived state.
    InvalidTransformResource {
        /// Interned affine resource identifier.
        resource_id: u32,
    },
}

impl fmt::Display for HitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TopologyMismatch => {
                formatter.write_str("hit-test topology does not match layout")
            }
            Self::InvalidTransformResource { resource_id } => {
                write!(
                    formatter,
                    "invalid hit-test transform resource {resource_id}"
                )
            }
        }
    }
}

impl std::error::Error for HitError {}

/// Incrementally refitted flat BVH plus topology-aligned world geometry.
#[derive(Clone, Debug, Default)]
pub struct HitIndex {
    ids: Vec<NodeId>,
    positions: std::collections::HashMap<NodeId, usize>,
    geometry: Vec<WorldGeometry>,
    hittable: Vec<bool>,
    /// Topology-aligned paint order, empty while it equals topology order.
    ///
    /// Topology order is already a depth-first walk, so without a `z-index`
    /// anywhere the rank of a node is its index and there is nothing to store
    /// or to walk. Hit testing runs every frame; this keeps the common tree
    /// paying nothing for a feature it does not use.
    paint_rank: Vec<u32>,
    leaves: Vec<usize>,
    nodes: Vec<BvhNode>,
    root: Option<usize>,
    /// Number of topology rebuilds.
    pub topology_rebuilds: u64,
    /// Number of same-topology AABB refits.
    pub refits: u64,
}

#[derive(Clone, Copy, Debug)]
struct BvhNode {
    bounds: WorldRect,
    left: Option<usize>,
    right: Option<usize>,
    geometry_index: Option<usize>,
}

impl HitIndex {
    /// Recomputes world geometry and rebuilds or refits the BVH transactionally.
    pub fn update(&mut self, scene: &Scene, layout: &LayoutSnapshot) -> Result<(), HitError> {
        if scene.ids() != layout.ids() {
            return Err(HitError::TopologyMismatch);
        }
        let geometry = build_world_geometry(scene, layout)?;
        let topology_changed = self.ids != scene.ids();
        // The Scene answers this from its resource table, so a tree that
        // declares no z-index costs nothing here at all.
        let reordered = scene.uses_z_index();
        let hittable = scene
            .ids()
            .iter()
            .copied()
            .map(|node| {
                !scene.excluded_by_display(node)
                    && scene.visible(node)
                    && scene.presented_style_keyword(node, StyleProperty::PointerEvents)
                        != Some(StyleKeyword::None)
            })
            .collect::<Vec<_>>();
        let paint_rank = if reordered {
            build_paint_rank(scene)
        } else {
            Vec::new()
        };
        let eligibility_changed = self.hittable != hittable;
        self.ids.clear();
        self.ids.extend_from_slice(scene.ids());
        if topology_changed {
            self.positions.clear();
            self.positions
                .extend(self.ids.iter().copied().enumerate().map(|(i, id)| (id, i)));
        }
        self.geometry = geometry;
        self.hittable = hittable;
        self.paint_rank = paint_rank;
        if topology_changed || eligibility_changed {
            self.rebuild();
            self.topology_rebuilds = self.topology_rebuilds.saturating_add(1);
        } else {
            self.refit();
            self.refits = self.refits.saturating_add(1);
        }
        Ok(())
    }

    /// Returns retained world geometry for one generation-bearing node.
    #[must_use]
    pub fn geometry(&self, node: NodeId) -> Option<WorldGeometry> {
        let index = *self.positions.get(&node)?;
        self.geometry.get(index).copied()
    }

    /// Iterates topology-aligned generation-bearing world geometry.
    pub fn geometries(&self) -> impl ExactSizeIterator<Item = (NodeId, WorldGeometry)> + '_ {
        self.ids.iter().copied().zip(self.geometry.iter().copied())
    }

    /// Queries the BVH and returns the deepest last-painted precise hit.
    #[must_use]
    pub fn hit(&self, scene: &Scene, point: HitPoint) -> Option<HitResult> {
        let mut candidate = None;
        let mut stack = self.root.into_iter().collect::<Vec<_>>();
        while let Some(index) = stack.pop() {
            let node = self.nodes.get(index)?;
            if !node.bounds.contains(point) {
                continue;
            }
            if let Some(geometry_index) = node.geometry_index {
                if self.geometry.get(geometry_index)?.contains_precise(point)
                    && candidate.is_none_or(|previous| self.above(geometry_index, previous))
                {
                    candidate = Some(geometry_index);
                }
                continue;
            }
            if let Some(left) = node.left {
                stack.push(left);
            }
            if let Some(right) = node.right {
                stack.push(right);
            }
        }
        self.result(scene, candidate?)
    }

    /// Linear reference query used by differential/property tests.
    #[must_use]
    pub fn hit_naive(&self, scene: &Scene, point: HitPoint) -> Option<HitResult> {
        let candidate = self
            .geometry
            .iter()
            .enumerate()
            .filter(|(index, geometry)| {
                self.hittable.get(*index).copied().unwrap_or(false)
                    && geometry.aabb.contains(point)
                    && geometry.contains_precise(point)
            })
            .map(|(index, _)| index)
            .reduce(|previous, index| {
                if self.above(index, previous) {
                    index
                } else {
                    previous
                }
            })?;
        self.result(scene, candidate)
    }

    /// Whether `index` is painted over `other`.
    ///
    /// Paint order decides, not topology: a `z-index` that lifts a sibling has
    /// to lift what it catches too, or a raised overlay would be clickable
    /// through. Equal ranks cannot happen for two different nodes, but the
    /// index tiebreak keeps the comparison total either way.
    fn above(&self, index: usize, other: usize) -> bool {
        if self.paint_rank.is_empty() {
            return index > other;
        }
        let rank = self.paint_rank.get(index).copied().unwrap_or(0);
        let previous = self.paint_rank.get(other).copied().unwrap_or(0);
        (rank, index) > (previous, other)
    }

    fn result(&self, scene: &Scene, index: usize) -> Option<HitResult> {
        let target = *self.ids.get(index)?;
        let mut path = vec![target];
        let mut parent = scene.parent(target);
        while let Some(node) = parent {
            path.push(node);
            parent = scene.parent(node);
        }
        path.reverse();
        Some(HitResult { target, path })
    }

    fn rebuild(&mut self) {
        self.leaves = self
            .geometry
            .iter()
            .enumerate()
            .filter(|(index, geometry)| {
                self.hittable.get(*index).copied().unwrap_or(false)
                    && geometry.width > 0.0
                    && geometry.height > 0.0
            })
            .map(|(index, _)| index)
            .collect();
        self.nodes.clear();
        self.root = build_bvh(&mut self.nodes, &self.geometry, &mut self.leaves);
    }

    fn refit(&mut self) {
        if let Some(root) = self.root {
            refit_node(root, &mut self.nodes, &self.geometry);
        }
    }
}

/// Assigns each node its position in a paint-order walk of the tree.
///
/// The walk is the same one the paint engine performs, and it asks the Scene the
/// same question, so a node that draws on top also ranks on top here.
fn build_paint_rank(scene: &Scene) -> Vec<u32> {
    let mut rank = vec![0_u32; scene.len()];
    let Some(root) = scene.ids().first().copied() else {
        return rank;
    };
    let mut next = 0_u32;
    let mut stack = vec![root];
    let mut children = Vec::new();
    while let Some(node) = stack.pop() {
        if let Some(index) = scene.resolve(node) {
            if let Some(slot) = rank.get_mut(index) {
                *slot = next;
            }
            next = next.saturating_add(1);
        }
        let start = children.len();
        scene.children_in_paint_order(node, &mut children);
        // The stack pops in reverse, so the last painted child is pushed first.
        while children.len() > start {
            if let Some(child) = children.pop() {
                stack.push(child);
            }
        }
    }
    rank
}

fn build_world_geometry(
    scene: &Scene,
    layout: &LayoutSnapshot,
) -> Result<Vec<WorldGeometry>, HitError> {
    let mut result = Vec::with_capacity(scene.len());
    let mut child_spaces = Vec::with_capacity(scene.len());
    let mut child_clips: Vec<Option<WorldRect>> = Vec::with_capacity(scene.len());
    for (index, node) in scene.ids().iter().copied().enumerate() {
        let (offset, size) = layout
            .geometry_at(index)
            .ok_or(HitError::TopologyMismatch)?;
        let parent_space = scene
            .parent(node)
            .and_then(|parent| scene.resolve(parent))
            .and_then(|parent| child_spaces.get(parent).copied())
            .unwrap_or(Affine::IDENTITY);
        let mut world = parent_space.multiply(Affine::translation(offset.x, offset.y));
        if let Some(transform) = scene.presentation_style_transform(node) {
            if !transform.is_empty() {
                world = world.multiply(affine_operations(transform, size.width, size.height));
            }
        } else if let Some(resource_id) = scene.ref_prop(node, Prop::Transform) {
            world = world.multiply(decode_affine(scene, resource_id)?);
        } else if let Some(transform) = style_affine(scene, node, size.width, size.height) {
            world = world.multiply(transform);
        }
        let own_aabb = world.rect_aabb(size.width, size.height);
        let inherited_clip = scene
            .parent(node)
            .and_then(|parent| scene.resolve(parent))
            .and_then(|parent| child_clips.get(parent).copied().flatten());
        let aabb = inherited_clip.map_or(own_aabb, |clip| own_aabb.intersect(clip));
        result.push(WorldGeometry {
            transform: world.0,
            aabb,
            width: size.width,
            height: size.height,
            radius: scene
                .presented_style_length(node, StyleProperty::BorderRadius)
                .map_or(0.0, |length| {
                    resolve_box_length(length, size.width.min(size.height)).max(0.0)
                }),
        });
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
        child_spaces.push(world.multiply(Affine::translation(-scroll_x, -scroll_y)));
        child_clips.push(axis_clip(
            inherited_clip,
            own_aabb,
            scene.clips_axis(node, true),
            scene.clips_axis(node, false),
        ));
    }
    Ok(result)
}

fn rounded_box_contains(point: HitPoint, width: f32, height: f32, radius: f32) -> bool {
    if point.x < 0.0 || point.x >= width || point.y < 0.0 || point.y >= height {
        return false;
    }
    let radius = radius.min(width * 0.5).min(height * 0.5);
    if radius <= f32::EPSILON {
        return true;
    }
    let center_x = if point.x < radius {
        radius
    } else if point.x >= width - radius {
        width - radius
    } else {
        return true;
    };
    let center_y = if point.y < radius {
        radius
    } else if point.y >= height - radius {
        height - radius
    } else {
        return true;
    };
    let dx = point.x - center_x;
    let dy = point.y - center_y;
    dx * dx + dy * dy <= radius * radius
}

fn axis_clip(
    inherited: Option<WorldRect>,
    own: WorldRect,
    horizontal: bool,
    vertical: bool,
) -> Option<WorldRect> {
    if !horizontal && !vertical {
        return inherited;
    }
    let own_axes = WorldRect {
        left: if horizontal {
            own.left
        } else {
            f32::NEG_INFINITY
        },
        top: if vertical { own.top } else { f32::NEG_INFINITY },
        right: if horizontal { own.right } else { f32::INFINITY },
        bottom: if vertical { own.bottom } else { f32::INFINITY },
    };
    Some(inherited.map_or(own_axes, |clip| own_axes.intersect(clip)))
}

fn style_affine(scene: &Scene, node: NodeId, width: f32, height: f32) -> Option<Affine> {
    let operations = scene
        .presented_style_transform(node)
        .filter(|value| !value.is_empty())?;
    Some(style_affine_operations(
        scene, node, operations, width, height,
    ))
}

fn style_affine_operations(
    scene: &Scene,
    node: NodeId,
    operations: &[StyleTransformOperation],
    width: f32,
    height: f32,
) -> Affine {
    let origin = scene
        .presented_style_position(node, StyleProperty::TransformOrigin)
        .map_or([width * 0.5, height * 0.5], |position| {
            [
                resolve_box_length(position[0], width),
                resolve_box_length(position[1], height),
            ]
        });
    Affine::translation(origin[0], origin[1])
        .multiply(affine_operations(operations, width, height))
        .multiply(Affine::translation(-origin[0], -origin[1]))
}

fn affine_operations(operations: &[StyleTransformOperation], width: f32, height: f32) -> Affine {
    let mut result = Affine::IDENTITY;
    for operation in operations {
        let next = match *operation {
            StyleTransformOperation::Matrix(value) => Affine(value),
            StyleTransformOperation::Translate(x, y) => {
                Affine::translation(resolve_box_length(x, width), resolve_box_length(y, height))
            }
            StyleTransformOperation::Scale([x, y]) => Affine([x, 0.0, 0.0, y, 0.0, 0.0]),
            StyleTransformOperation::Rotate(radians) => {
                let (sin, cos) = radians.sin_cos();
                Affine([cos, sin, -sin, cos, 0.0, 0.0])
            }
        };
        result = result.multiply(next);
    }
    result
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

fn decode_affine(scene: &Scene, resource_id: u32) -> Result<Affine, HitError> {
    let bytes = scene
        .resource(resource_id)
        .map(|resource| resource.bytes.as_ref())
        .ok_or(HitError::InvalidTransformResource { resource_id })?;
    if bytes.len() != AFFINE_RESOURCE_FIXED_BYTES.unwrap_or_default()
        || bytes.get(AFFINE_VERSION_OFFSET) != Some(&RESOURCE_ENCODING_VERSION)
        || bytes.get(AFFINE_VARIANT_OFFSET) != Some(&AFFINE_RESOURCE_VARIANT)
    {
        return Err(HitError::InvalidTransformResource { resource_id });
    }
    let value = |offset: usize| {
        bytes
            .get(offset..offset.saturating_add(4))
            .and_then(|value| value.try_into().ok())
            .map(f32::from_le_bytes)
            .filter(|value| value.is_finite())
            .ok_or(HitError::InvalidTransformResource { resource_id })
    };
    Ok(Affine([
        value(AFFINE_A_OFFSET)?,
        value(AFFINE_B_OFFSET)?,
        value(AFFINE_C_OFFSET)?,
        value(AFFINE_D_OFFSET)?,
        value(AFFINE_E_OFFSET)?,
        value(AFFINE_F_OFFSET)?,
    ]))
}

fn build_bvh(
    nodes: &mut Vec<BvhNode>,
    geometry: &[WorldGeometry],
    leaves: &mut [usize],
) -> Option<usize> {
    let (&first, rest) = leaves.split_first()?;
    let bounds = rest.iter().fold(geometry[first].aabb, |bounds, index| {
        bounds.union(geometry[*index].aabb)
    });
    if rest.is_empty() {
        let index = nodes.len();
        nodes.push(BvhNode {
            bounds,
            left: None,
            right: None,
            geometry_index: Some(first),
        });
        return Some(index);
    }
    let horizontal = bounds.right - bounds.left >= bounds.bottom - bounds.top;
    leaves.sort_unstable_by(|left, right| {
        let left_bounds = geometry[*left].aabb;
        let right_bounds = geometry[*right].aabb;
        let left_center = if horizontal {
            left_bounds.left + left_bounds.right
        } else {
            left_bounds.top + left_bounds.bottom
        };
        let right_center = if horizontal {
            right_bounds.left + right_bounds.right
        } else {
            right_bounds.top + right_bounds.bottom
        };
        left_center
            .total_cmp(&right_center)
            .then_with(|| left.cmp(right))
    });
    let middle = leaves.len() / 2;
    let (left_leaves, right_leaves) = leaves.split_at_mut(middle);
    let left = build_bvh(nodes, geometry, left_leaves);
    let right = build_bvh(nodes, geometry, right_leaves);
    let index = nodes.len();
    nodes.push(BvhNode {
        bounds,
        left,
        right,
        geometry_index: None,
    });
    Some(index)
}

fn refit_node(index: usize, nodes: &mut [BvhNode], geometry: &[WorldGeometry]) -> WorldRect {
    let node = nodes[index];
    let bounds = if let Some(geometry_index) = node.geometry_index {
        geometry[geometry_index].aabb
    } else {
        match (node.left, node.right) {
            (Some(left), Some(right)) => {
                let left = refit_node(left, nodes, geometry);
                let right = refit_node(right, nodes, geometry);
                left.union(right)
            }
            (Some(child), None) | (None, Some(child)) => refit_node(child, nodes, geometry),
            (None, None) => WorldRect::default(),
        }
    };
    nodes[index].bounds = bounds;
    bounds
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Affine([f32; 6]);

impl Affine {
    const IDENTITY: Self = Self([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    const fn translation(x: f32, y: f32) -> Self {
        Self([1.0, 0.0, 0.0, 1.0, x, y])
    }

    fn multiply(self, next: Self) -> Self {
        let [a, b, c, d, e, f] = self.0;
        let [na, nb, nc, nd, ne, nf] = next.0;
        Self([
            a * na + c * nb,
            b * na + d * nb,
            a * nc + c * nd,
            b * nc + d * nd,
            a * ne + c * nf + e,
            b * ne + d * nf + f,
        ])
    }

    fn point(self, point: HitPoint) -> HitPoint {
        let [a, b, c, d, e, f] = self.0;
        HitPoint {
            x: a * point.x + c * point.y + e,
            y: b * point.x + d * point.y + f,
        }
    }

    fn inverse(self) -> Option<Self> {
        let [a, b, c, d, e, f] = self.0;
        let determinant = a * d - b * c;
        if !determinant.is_finite() || determinant.abs() <= f32::EPSILON {
            return None;
        }
        let inverse = 1.0 / determinant;
        Some(Self([
            d * inverse,
            -b * inverse,
            -c * inverse,
            a * inverse,
            (c * f - d * e) * inverse,
            (b * e - a * f) * inverse,
        ]))
    }

    fn rect_aabb(self, width: f32, height: f32) -> WorldRect {
        let points = [
            self.point(HitPoint { x: 0.0, y: 0.0 }),
            self.point(HitPoint { x: width, y: 0.0 }),
            self.point(HitPoint { x: 0.0, y: height }),
            self.point(HitPoint {
                x: width,
                y: height,
            }),
        ];
        WorldRect {
            left: points
                .iter()
                .map(|point| point.x)
                .fold(f32::INFINITY, f32::min),
            top: points
                .iter()
                .map(|point| point.y)
                .fold(f32::INFINITY, f32::min),
            right: points
                .iter()
                .map(|point| point.x)
                .fold(f32::NEG_INFINITY, f32::max),
            bottom: points
                .iter()
                .map(|point| point.y)
                .fold(f32::NEG_INFINITY, f32::max),
        }
    }
}

#[cfg(test)]
mod tests {
    use pingo_abi::{Mutation, MutationBatch, MutationInstruction, NULL_NODE_ID, NodeKind};
    use pingo_layout::{BoxConstraints, LayoutEngine, Size, ZeroIntrinsicMeasurer};
    use proptest::prelude::*;

    use super::*;

    fn id(index: u32) -> NodeId {
        NodeId::new(index, 1).expect("node id")
    }

    fn computed_style(entries: &[(StyleProperty, Vec<u8>)]) -> Vec<u8> {
        let payload_bytes = entries.len() * 16;
        let mut bytes = vec![0_u8; 16];
        bytes[0] = pingo_abi::STYLE_COMPUTED_ENCODING_VERSION;
        bytes[1] = pingo_abi::STYLE_COMPUTED_ENCODING_VARIANT;
        bytes[4..8].copy_from_slice(&pingo_abi::STYLE_ALL_FEATURE_BITS.to_le_bytes());
        bytes[8..12].copy_from_slice(&u32::try_from(entries.len()).expect("count").to_le_bytes());
        bytes[12..16]
            .copy_from_slice(&u32::try_from(payload_bytes).expect("payload").to_le_bytes());
        let mut sorted = entries.to_vec();
        sorted.sort_by_key(|(property, _)| *property as u16);
        for (property, payload) in &sorted {
            bytes.extend_from_slice(&(*property as u16).to_le_bytes());
            bytes.push(0);
            bytes.push(pingo_abi::STYLE_VALUE_LENGTH);
            bytes.extend_from_slice(&8_u16.to_le_bytes());
            bytes.extend_from_slice(&0_u16.to_le_bytes());
            bytes.extend_from_slice(payload);
        }
        bytes
    }

    fn number_length(unit: u8, value: f32) -> Vec<u8> {
        let mut bytes = vec![unit, 0, 0, 0];
        bytes.extend_from_slice(&value.to_le_bytes());
        bytes
    }

    /// Two children stacked on the same spot, the first optionally raised.
    fn overlapping_scene(raise_first: Option<i32>) -> (Scene, LayoutEngine) {
        let mut instructions = vec![
            MutationInstruction {
                flags: 0,
                mutation: Mutation::CreateNode {
                    node_id: id(0).raw(),
                    kind: NodeKind::Root,
                    parent: NULL_NODE_ID,
                    before_sibling: NULL_NODE_ID,
                },
            },
            // The second child is pulled back over the first, so only order
            // decides which one a pointer in the overlap reaches.
            MutationInstruction {
                flags: 0,
                mutation: Mutation::DefineResource {
                    resource_id: 2,
                    kind: pingo_abi::ResourceKind::ComputedStyle,
                    bytes: computed_style(&[(
                        StyleProperty::MarginTop,
                        number_length(pingo_abi::STYLE_LENGTH_PX, -40.0),
                    )]),
                },
            },
        ];
        if let Some(order) = raise_first {
            #[allow(clippy::cast_precision_loss)]
            let value = order as f32;
            instructions.push(MutationInstruction {
                flags: 0,
                mutation: Mutation::DefineResource {
                    resource_id: 1,
                    kind: pingo_abi::ResourceKind::ComputedStyle,
                    bytes: computed_style(&[(
                        StyleProperty::ZIndex,
                        number_length(pingo_abi::STYLE_LENGTH_NUMBER, value),
                    )]),
                },
            });
        }
        for index in 1..=2_u32 {
            instructions.extend([
                MutationInstruction {
                    flags: 0,
                    mutation: Mutation::CreateNode {
                        node_id: id(index).raw(),
                        kind: NodeKind::Container,
                        parent: id(0).raw(),
                        before_sibling: NULL_NODE_ID,
                    },
                },
                MutationInstruction {
                    flags: 0,
                    mutation: Mutation::SetF32 {
                        node_id: id(index).raw(),
                        prop: Prop::Width,
                        value: 40.0,
                    },
                },
                MutationInstruction {
                    flags: 0,
                    mutation: Mutation::SetF32 {
                        node_id: id(index).raw(),
                        prop: Prop::Height,
                        value: 40.0,
                    },
                },
            ]);
        }
        instructions.push(MutationInstruction {
            flags: 0,
            mutation: Mutation::SetRef {
                node_id: id(2).raw(),
                prop: Prop::ComputedStyle,
                resource_id: 2,
            },
        });
        if raise_first.is_some() {
            instructions.push(MutationInstruction {
                flags: 0,
                mutation: Mutation::SetRef {
                    node_id: id(1).raw(),
                    prop: Prop::ComputedStyle,
                    resource_id: 1,
                },
            });
        }
        let mut scene = Scene::new();
        scene
            .commit(MutationBatch {
                frame_seq: 1,
                instructions,
            })
            .expect("scene commit");
        let mut layout = LayoutEngine::new();
        layout
            .layout(
                &scene,
                BoxConstraints::tight(Size::new(200.0, 200.0)).expect("viewport"),
                &mut ZeroIntrinsicMeasurer,
            )
            .expect("layout");
        (scene, layout)
    }

    #[test]
    fn a_raised_sibling_catches_the_pointer_its_z_index_put_it_over() {
        let point = HitPoint { x: 20.0, y: 20.0 };

        // Document order alone: the later sibling is on top.
        let (scene, layout) = overlapping_scene(None);
        let mut index = HitIndex::default();
        index.update(&scene, layout.snapshot()).expect("index");
        assert_eq!(index.hit(&scene, point).expect("hit").target, id(2));
        assert_eq!(index.hit_naive(&scene, point).expect("hit").target, id(2));

        // A z-index lifts the earlier sibling, and what is on top is hit.
        let (scene, layout) = overlapping_scene(Some(1));
        let mut index = HitIndex::default();
        index.update(&scene, layout.snapshot()).expect("index");
        assert_eq!(index.hit(&scene, point).expect("hit").target, id(1));
        assert_eq!(index.hit_naive(&scene, point).expect("hit").target, id(1));
    }

    fn scene_with_children(sizes: &[(f32, f32)]) -> (Scene, LayoutEngine) {
        let mut instructions = vec![MutationInstruction {
            flags: 0,
            mutation: Mutation::CreateNode {
                node_id: id(0).raw(),
                kind: NodeKind::Root,
                parent: NULL_NODE_ID,
                before_sibling: NULL_NODE_ID,
            },
        }];
        for (index, (width, height)) in sizes.iter().copied().enumerate() {
            let node = id(u32::try_from(index + 1).expect("bounded test index"));
            instructions.extend([
                MutationInstruction {
                    flags: 0,
                    mutation: Mutation::CreateNode {
                        node_id: node.raw(),
                        kind: NodeKind::Container,
                        parent: id(0).raw(),
                        before_sibling: NULL_NODE_ID,
                    },
                },
                MutationInstruction {
                    flags: 0,
                    mutation: Mutation::SetF32 {
                        node_id: node.raw(),
                        prop: Prop::Width,
                        value: width,
                    },
                },
                MutationInstruction {
                    flags: 0,
                    mutation: Mutation::SetF32 {
                        node_id: node.raw(),
                        prop: Prop::Height,
                        value: height,
                    },
                },
            ]);
        }
        let mut scene = Scene::new();
        scene
            .commit(MutationBatch {
                frame_seq: 1,
                instructions,
            })
            .expect("scene");
        let mut layout = LayoutEngine::new();
        layout
            .layout(
                &scene,
                BoxConstraints::tight(Size::new(500.0, 500.0)).expect("viewport"),
                &mut ZeroIntrinsicMeasurer,
            )
            .expect("layout");
        (scene, layout)
    }

    #[test]
    fn last_painted_overlap_wins_and_paths_are_root_ordered() {
        let (scene, layout) = scene_with_children(&[(40.0, 20.0), (40.0, 20.0)]);
        let mut index = HitIndex::default();
        index.update(&scene, layout.snapshot()).expect("hit index");
        let hit = index
            .hit(&scene, HitPoint { x: 10.0, y: 10.0 })
            .expect("hit");
        assert_eq!(hit.target, id(1));
        assert_eq!(hit.path, vec![id(0), id(1)]);
        assert_eq!(index.hit(&scene, HitPoint { x: -1.0, y: 0.0 }), None);
    }

    proptest! {
        #[test]
        fn bvh_matches_linear_oracle(
            sizes in prop::collection::vec((1.0_f32..120.0, 1.0_f32..80.0), 1..32),
            points in prop::collection::vec((-20.0_f32..520.0, -20.0_f32..520.0), 1..128),
        ) {
            let (scene, layout) = scene_with_children(&sizes);
            let mut index = HitIndex::default();
            index.update(&scene, layout.snapshot()).expect("hit index");
            for (x, y) in points {
                let point = HitPoint { x, y };
                prop_assert_eq!(index.hit(&scene, point), index.hit_naive(&scene, point));
            }
            index.update(&scene, layout.snapshot()).expect("refit");
            prop_assert_eq!(index.topology_rebuilds, 1);
            prop_assert_eq!(index.refits, 1);
        }
    }
}
