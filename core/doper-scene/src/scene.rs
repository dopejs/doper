use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use doper_abi::{
    AFFINE_A_OFFSET, AFFINE_RESOURCE_FIXED_BYTES, AFFINE_RESOURCE_VARIANT, AFFINE_VARIANT_OFFSET,
    AFFINE_VERSION_OFFSET, Invalidation, MAX_RESOURCE_BYTES, MAX_VIRTUAL_ITEMS, Mutation,
    MutationBatch, NULL_NODE_ID, NodeKind, Prop, PropValueType, RESOURCE_ENCODING_VERSION,
    ResourceKind, SOLID_PAINT_RED_OFFSET, SOLID_PAINT_RESOURCE_FIXED_BYTES,
    SOLID_PAINT_RESOURCE_VARIANT, SOLID_PAINT_VARIANT_OFFSET, SOLID_PAINT_VERSION_OFFSET,
    TEXT_STYLE_FAMILY_BYTES_OFFSET, TEXT_STYLE_FAMILY_OFFSET, TEXT_STYLE_FONT_SIZE_OFFSET,
    TEXT_STYLE_LINE_HEIGHT_OFFSET, TEXT_STYLE_PAINT_ID_OFFSET, TEXT_STYLE_RESOURCE_MINIMUM_BYTES,
    TEXT_STYLE_RESOURCE_VARIANT, TEXT_STYLE_VARIANT_OFFSET, TEXT_STYLE_VERSION_OFFSET,
    TEXT_STYLE_WEIGHT_OFFSET,
};

use crate::{BitSet, MAX_GENERATION, NodeId, SceneError};

/// A Scene dirty domain backed by a topology-ordered bitmap.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DirtyDomain {
    /// Constraint or geometry inputs changed.
    Layout,
    /// Subtree paint output changed.
    Paint,
    /// Only node-local compositing state changed.
    PaintSelf,
    /// Hit-test geometry or behavior changed.
    Hit,
    /// Accessibility semantics changed.
    Semantics,
}

/// Immutable resource interned by identifier.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Resource {
    /// Generated resource kind.
    pub kind: ResourceKind,
    /// Canonical resource bytes shared by snapshots and pictures.
    pub bytes: Arc<[u8]>,
}

/// Text and style resources attached atomically to a text node.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TextRun {
    /// UTF-8 string resource identifier.
    pub string_id: u32,
    /// Text style resource identifier.
    pub style_id: u32,
}

/// Validated Core-owned virtual-list policy attached to a Scroll node.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VirtualListConfig {
    /// Total logical item count without materializing Scene nodes.
    pub item_count: u32,
    /// Initial logical height estimate for every item.
    pub estimated_item_height: f32,
    /// Symmetric preheat extent in viewport multiples.
    pub base_overscan_viewports: f32,
    /// Velocity projection horizon in seconds.
    pub velocity_horizon_seconds: f32,
    /// Maximum directional preheat extent in viewport multiples.
    pub maximum_ahead_viewports: f32,
}

/// Counters exposing structural work and accepted commits.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SceneMetrics {
    /// Number of accepted commits.
    pub commits: u64,
    /// Number of O(n) topology compactions.
    pub topology_compactions: u64,
    /// Number of rejected transactions.
    pub rejected_transactions: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Slot {
    generation: u16,
    active_index: Option<usize>,
    retired: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct PropertyLanes {
    f32: BTreeMap<Prop, Vec<Option<f32>>>,
    vec4: BTreeMap<Prop, Vec<Option<[f32; 4]>>>,
    refs: BTreeMap<Prop, Vec<Option<u32>>>,
}

/// Core-owned, topology-ordered Scene using structure-of-arrays storage.
#[derive(Clone, Debug, PartialEq)]
pub struct Scene {
    ids: Vec<NodeId>,
    parents: Vec<Option<NodeId>>,
    first_children: Vec<Option<NodeId>>,
    next_siblings: Vec<Option<NodeId>>,
    depths: Vec<u16>,
    kinds: Vec<NodeKind>,
    flags: Vec<u32>,
    text_runs: Vec<Option<TextRun>>,
    scroll_positions: Vec<Option<[f32; 2]>>,
    virtual_lists: Vec<Option<VirtualListConfig>>,
    virtual_item_indices: Vec<Option<u32>>,
    props: PropertyLanes,
    slots: Vec<Slot>,
    resources: BTreeMap<u32, Resource>,
    dirty_layout: BitSet,
    dirty_paint: BitSet,
    dirty_paint_self: BitSet,
    dirty_hit: BitSet,
    dirty_semantics: BitSet,
    last_frame_seq: Option<u32>,
    metrics: SceneMetrics,
}

impl Default for Scene {
    fn default() -> Self {
        Self::new()
    }
}

impl Scene {
    /// Creates an empty Scene.
    #[must_use]
    pub fn new() -> Self {
        Self {
            ids: Vec::new(),
            parents: Vec::new(),
            first_children: Vec::new(),
            next_siblings: Vec::new(),
            depths: Vec::new(),
            kinds: Vec::new(),
            flags: Vec::new(),
            text_runs: Vec::new(),
            scroll_positions: Vec::new(),
            virtual_lists: Vec::new(),
            virtual_item_indices: Vec::new(),
            props: PropertyLanes::default(),
            slots: Vec::new(),
            resources: BTreeMap::new(),
            dirty_layout: BitSet::default(),
            dirty_paint: BitSet::default(),
            dirty_paint_self: BitSet::default(),
            dirty_hit: BitSet::default(),
            dirty_semantics: BitSet::default(),
            last_frame_seq: None,
            metrics: SceneMetrics::default(),
        }
    }

    /// Atomically applies a fully decoded mutation batch.
    pub fn commit(&mut self, batch: MutationBatch) -> Result<(), SceneError> {
        if let Err(error) = self.validate_frame_seq(batch.frame_seq) {
            self.metrics.rejected_transactions += 1;
            return Err(error);
        }
        let structural = batch.instructions.iter().any(|instruction| {
            matches!(
                instruction.mutation,
                Mutation::CreateNode { .. }
                    | Mutation::RemoveNode { .. }
                    | Mutation::Reparent { .. }
                    | Mutation::ConfigureVirtualList { .. }
                    | Mutation::SetVirtualItem { .. }
            )
        });
        let releases_resource = batch
            .instructions
            .iter()
            .any(|instruction| matches!(instruction.mutation, Mutation::ReleaseResource { .. }));
        let result = if releases_resource {
            self.commit_with_resource_releases(batch)
        } else if structural {
            self.commit_structural(batch)
        } else {
            self.commit_non_structural(batch)
        };
        if result.is_err() {
            self.metrics.rejected_transactions += 1;
        }
        result
    }

    /// Returns the number of active nodes.
    #[must_use]
    pub fn len(&self) -> usize {
        self.ids.len()
    }

    /// Returns whether the Scene has no active nodes.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    /// Returns node IDs in topology order.
    #[must_use]
    pub fn ids(&self) -> &[NodeId] {
        &self.ids
    }

    /// Resolves a generation-bearing ID to its current topology index.
    #[must_use]
    pub fn resolve(&self, node: NodeId) -> Option<usize> {
        let slot = self.slots.get(node.index() as usize)?;
        if slot.generation != node.generation() {
            return None;
        }
        let index = slot.active_index?;
        (self.ids.get(index) == Some(&node)).then_some(index)
    }

    /// Returns a node's parent.
    #[must_use]
    pub fn parent(&self, node: NodeId) -> Option<NodeId> {
        self.resolve(node).and_then(|index| self.parents[index])
    }

    /// Returns the node kind for an active identifier.
    #[must_use]
    pub fn kind(&self, node: NodeId) -> Option<NodeKind> {
        self.resolve(node).map(|index| self.kinds[index])
    }

    /// Returns the first direct child, if any.
    #[must_use]
    pub fn first_child(&self, node: NodeId) -> Option<NodeId> {
        self.resolve(node)
            .and_then(|index| self.first_children[index])
    }

    /// Returns the next sibling, if any.
    #[must_use]
    pub fn next_sibling(&self, node: NodeId) -> Option<NodeId> {
        self.resolve(node)
            .and_then(|index| self.next_siblings[index])
    }

    /// Returns node flags.
    #[must_use]
    pub fn flags(&self, node: NodeId) -> Option<u32> {
        self.resolve(node).map(|index| self.flags[index])
    }

    /// Returns the current scroll position.
    #[must_use]
    pub fn scroll_position(&self, node: NodeId) -> Option<[f32; 2]> {
        self.resolve(node)
            .and_then(|index| self.scroll_positions[index])
    }

    /// Returns the virtual-list policy for a configured Scroll node.
    #[must_use]
    pub fn virtual_list(&self, node: NodeId) -> Option<VirtualListConfig> {
        self.resolve(node)
            .and_then(|index| self.virtual_lists[index])
    }

    /// Returns the logical item index associated with a materialized wrapper.
    #[must_use]
    pub fn virtual_item_index(&self, node: NodeId) -> Option<u32> {
        self.resolve(node)
            .and_then(|index| self.virtual_item_indices[index])
    }

    /// Applies a Core-owned physics position outside the Shell Mutation Stream.
    ///
    /// This is restricted to an existing Scroll node and invalidates only paint
    /// and hit-test state. Shell transactions remain the sole owner of topology
    /// and durable properties.
    ///
    /// # Errors
    ///
    /// Returns a stale-node, wrong-kind, or non-finite-value error without
    /// changing the Scene.
    pub fn apply_scroll_position(
        &mut self,
        node: NodeId,
        position: [f32; 2],
    ) -> Result<bool, SceneError> {
        Ok(self.apply_scroll_positions(&[(node, position)])? != 0)
    }

    /// Atomically applies a batch of Core-owned scroll positions.
    ///
    /// Every target and value is validated before the first Scene write. This
    /// lets the input hot path stage only the touched physics states instead of
    /// cloning the entire Scene to preserve transaction semantics.
    ///
    /// # Errors
    ///
    /// Returns a stale-node, wrong-kind, or non-finite-value error without
    /// changing the Scene.
    pub fn apply_scroll_positions(
        &mut self,
        positions: &[(NodeId, [f32; 2])],
    ) -> Result<usize, SceneError> {
        for &(node, position) in positions {
            if !position[0].is_finite() || !position[1].is_finite() {
                return Err(SceneError::NonFiniteValue {
                    node,
                    field: "Core scroll position",
                });
            }
            let index = self.resolve(node).ok_or(SceneError::StaleNode { node })?;
            let kind = self.kinds[index];
            if kind != NodeKind::Scroll {
                return Err(SceneError::UnsupportedNodeOperation {
                    node,
                    kind,
                    operation: "apply Core scroll position",
                });
            }
        }

        let mut changed = 0_usize;
        for &(node, position) in positions {
            // The validation pass above proved this generation-bearing ID is
            // live for the duration of this exclusive Scene borrow.
            let index = self.resolve(node).expect("validated scroll node");
            let next = Some(position);
            if self.scroll_positions[index] == next {
                continue;
            }
            self.scroll_positions[index] = next;
            self.mark(
                index,
                Invalidation::from_bits(Invalidation::PAINT.bits() | Invalidation::HIT.bits()),
            );
            changed += 1;
        }
        Ok(changed)
    }

    /// Returns a node's depth.
    #[must_use]
    pub fn depth(&self, node: NodeId) -> Option<u16> {
        self.resolve(node).map(|index| self.depths[index])
    }

    /// Returns one scalar property value.
    #[must_use]
    pub fn f32_prop(&self, node: NodeId, prop: Prop) -> Option<f32> {
        let index = self.resolve(node)?;
        self.props.f32.get(&prop)?.get(index).copied().flatten()
    }

    /// Returns one four-component property value.
    #[must_use]
    pub fn vec4_prop(&self, node: NodeId, prop: Prop) -> Option<[f32; 4]> {
        let index = self.resolve(node)?;
        self.props.vec4.get(&prop)?.get(index).copied().flatten()
    }

    /// Returns one reference property value.
    #[must_use]
    pub fn ref_prop(&self, node: NodeId, prop: Prop) -> Option<u32> {
        let index = self.resolve(node)?;
        self.props.refs.get(&prop)?.get(index).copied().flatten()
    }

    /// Returns a node's text run.
    #[must_use]
    pub fn text_run(&self, node: NodeId) -> Option<TextRun> {
        self.resolve(node).and_then(|index| self.text_runs[index])
    }

    /// Returns an immutable resource.
    #[must_use]
    pub fn resource(&self, resource_id: u32) -> Option<&Resource> {
        self.resources.get(&resource_id)
    }

    /// Returns the dirty bitmap for one domain.
    #[must_use]
    pub const fn dirty(&self, domain: DirtyDomain) -> &BitSet {
        match domain {
            DirtyDomain::Layout => &self.dirty_layout,
            DirtyDomain::Paint => &self.dirty_paint,
            DirtyDomain::PaintSelf => &self.dirty_paint_self,
            DirtyDomain::Hit => &self.dirty_hit,
            DirtyDomain::Semantics => &self.dirty_semantics,
        }
    }

    /// Clears all dirty domains after derived systems consume them.
    pub fn clear_dirty(&mut self) {
        self.dirty_layout.clear();
        self.dirty_paint.clear();
        self.dirty_paint_self.clear();
        self.dirty_hit.clear();
        self.dirty_semantics.clear();
    }

    /// Returns observability counters.
    #[must_use]
    pub const fn metrics(&self) -> SceneMetrics {
        self.metrics
    }

    /// Verifies topology, slot and SoA lane invariants for diagnostics and tests.
    pub fn validate_invariants(&self) -> Result<(), SceneError> {
        let length = self.ids.len();
        if self.parents.len() != length
            || self.first_children.len() != length
            || self.next_siblings.len() != length
            || self.depths.len() != length
            || self.kinds.len() != length
            || self.flags.len() != length
            || self.text_runs.len() != length
            || self.scroll_positions.len() != length
            || self.virtual_lists.len() != length
            || self.virtual_item_indices.len() != length
        {
            return Err(SceneError::InternalInvariant("SoA lane length mismatch"));
        }
        if self.dirty_layout.len() != length
            || self.dirty_paint.len() != length
            || self.dirty_paint_self.len() != length
            || self.dirty_hit.len() != length
            || self.dirty_semantics.len() != length
        {
            return Err(SceneError::InternalInvariant(
                "dirty bitmap length mismatch",
            ));
        }
        for lane in self
            .props
            .f32
            .values()
            .map(Vec::len)
            .chain(self.props.vec4.values().map(Vec::len))
            .chain(self.props.refs.values().map(Vec::len))
        {
            if lane != length {
                return Err(SceneError::InternalInvariant(
                    "property lane length mismatch",
                ));
            }
        }
        let mut root_count = 0;
        let mut previous_child = BTreeMap::new();
        for (index, node) in self.ids.iter().copied().enumerate() {
            if self.resolve(node) != Some(index) {
                return Err(SceneError::InternalInvariant(
                    "slot does not resolve topology index",
                ));
            }
            if let Some(parent) = self.parents[index] {
                let parent_index = self
                    .resolve(parent)
                    .ok_or(SceneError::InternalInvariant("parent is stale"))?;
                if !matches!(
                    self.kinds[parent_index],
                    NodeKind::Root | NodeKind::Container | NodeKind::Scroll
                ) {
                    return Err(SceneError::InternalInvariant(
                        "leaf node cannot own children",
                    ));
                }
                if parent_index >= index
                    || self.depths[parent_index].checked_add(1) != Some(self.depths[index])
                {
                    return Err(SceneError::InternalInvariant(
                        "topology order or depth is invalid",
                    ));
                }
                if let Some(previous) = previous_child.insert(parent, node) {
                    let previous_index = self
                        .resolve(previous)
                        .ok_or(SceneError::InternalInvariant("previous sibling is stale"))?;
                    if self.next_siblings[previous_index] != Some(node) {
                        return Err(SceneError::InternalInvariant(
                            "next sibling lane is invalid",
                        ));
                    }
                } else if self.first_children[parent_index] != Some(node) {
                    return Err(SceneError::InternalInvariant("first child lane is invalid"));
                }
            } else if self.depths[index] != 0 || self.kinds[index] != NodeKind::Root {
                return Err(SceneError::InternalInvariant("invalid root lane"));
            } else {
                root_count += 1;
            }
        }
        if (length == 0 && root_count != 0) || (length != 0 && root_count != 1) {
            return Err(SceneError::InternalInvariant(
                "Scene must have exactly one root",
            ));
        }
        for last_child in previous_child.values() {
            let index = self
                .resolve(*last_child)
                .ok_or(SceneError::InternalInvariant("last sibling is stale"))?;
            if self.next_siblings[index].is_some() {
                return Err(SceneError::InternalInvariant(
                    "last sibling must terminate the chain",
                ));
            }
        }
        for (index, node) in self.ids.iter().copied().enumerate() {
            match self.first_children[index] {
                Some(child) if self.parent(child) != Some(node) => {
                    return Err(SceneError::InternalInvariant(
                        "first child does not reference its parent",
                    ));
                }
                None if previous_child.contains_key(&node) => {
                    return Err(SceneError::InternalInvariant(
                        "parent with children has no first child",
                    ));
                }
                _ => {}
            }
            if let Some(sibling) = self.next_siblings[index] {
                let sibling_index = self
                    .resolve(sibling)
                    .ok_or(SceneError::InternalInvariant("next sibling is stale"))?;
                if sibling_index <= index || self.parents[sibling_index] != self.parents[index] {
                    return Err(SceneError::InternalInvariant(
                        "next sibling has a different parent or order",
                    ));
                }
            }
        }
        let active_slots = self
            .slots
            .iter()
            .filter(|slot| slot.active_index.is_some())
            .count();
        if active_slots != length {
            return Err(SceneError::InternalInvariant("active slot count mismatch"));
        }
        for (slot_index, slot) in self.slots.iter().enumerate() {
            if slot.generation == 0
                || (slot.retired
                    && (slot.active_index.is_some() || slot.generation != MAX_GENERATION))
            {
                return Err(SceneError::InternalInvariant(
                    "slot generation state is invalid",
                ));
            }
            if let Some(index) = slot.active_index {
                let id = self
                    .ids
                    .get(index)
                    .ok_or(SceneError::InternalInvariant("slot index is out of bounds"))?;
                if id.index() as usize != slot_index || id.generation() != slot.generation {
                    return Err(SceneError::InternalInvariant(
                        "slot identity does not match active node",
                    ));
                }
            }
        }
        validate_virtual_plan(&self.plan_nodes())?;
        Ok(())
    }

    fn validate_frame_seq(&self, incoming: u32) -> Result<(), SceneError> {
        if let Some(previous) = self.last_frame_seq {
            let distance = incoming.wrapping_sub(previous);
            if distance == 0 || distance >= (1_u32 << 31) {
                return Err(SceneError::FrameSequenceNotNewer { previous, incoming });
            }
        }
        Ok(())
    }

    fn commit_non_structural(&mut self, batch: MutationBatch) -> Result<(), SceneError> {
        let mut staged_resources = BTreeMap::new();
        let mut actions = Vec::with_capacity(batch.instructions.len());
        for instruction in batch.instructions {
            match instruction.mutation {
                Mutation::DefineResource {
                    resource_id,
                    kind,
                    bytes,
                } => {
                    validate_resource(resource_id, kind, &bytes)?;
                    if self.resources.contains_key(&resource_id)
                        || staged_resources
                            .insert(resource_id, Resource::new(kind, bytes))
                            .is_some()
                    {
                        return Err(SceneError::DuplicateResource { resource_id });
                    }
                }
                mutation => {
                    validate_non_structural_mutation(self, &staged_resources, &mutation)?;
                    actions.push(mutation);
                }
            }
        }

        validate_resource_graph(&self.resources, &staged_resources)?;

        for mutation in actions {
            self.apply_non_structural_mutation(mutation)?;
        }
        self.resources.extend(staged_resources);
        self.last_frame_seq = Some(batch.frame_seq);
        self.metrics.commits += 1;
        Ok(())
    }

    fn apply_non_structural_mutation(&mut self, mutation: Mutation) -> Result<(), SceneError> {
        let raw_node = mutation_node(&mutation).ok_or(SceneError::InternalInvariant(
            "unexpected structural mutation",
        ))?;
        let node = NodeId::from_raw(raw_node)?;
        let index = self.resolve(node).ok_or(SceneError::StaleNode { node })?;
        let scene_len = self.len();
        match mutation {
            Mutation::SetF32 { prop, value, .. } => {
                if set_lane(&mut self.props.f32, prop, index, scene_len, value) {
                    self.mark(index, prop.invalidation());
                }
            }
            Mutation::SetVec4 { prop, value, .. } => {
                if set_lane(&mut self.props.vec4, prop, index, scene_len, value) {
                    self.mark(index, prop.invalidation());
                }
            }
            Mutation::SetRef {
                prop, resource_id, ..
            } => {
                if set_lane(&mut self.props.refs, prop, index, scene_len, resource_id) {
                    self.mark(index, prop.invalidation());
                }
            }
            Mutation::SetFlags { set, clear, .. } => {
                let next = (self.flags[index] | set) & !clear;
                if next != self.flags[index] {
                    self.flags[index] = next;
                    self.mark(
                        index,
                        Invalidation::from_bits(
                            Invalidation::LAYOUT.bits()
                                | Invalidation::PAINT.bits()
                                | Invalidation::HIT.bits()
                                | Invalidation::SEMANTICS.bits(),
                        ),
                    );
                }
            }
            Mutation::ClearProp { prop, .. } => {
                let changed = match prop.value_type() {
                    PropValueType::F32 => clear_lane(&mut self.props.f32, prop, index),
                    PropValueType::Vec4 => clear_lane(&mut self.props.vec4, prop, index),
                    PropValueType::Ref => clear_lane(&mut self.props.refs, prop, index),
                };
                if changed {
                    self.mark(index, prop.invalidation());
                }
            }
            Mutation::SetTextRun {
                string_id,
                style_id,
                ..
            } => {
                let next = Some(TextRun {
                    string_id,
                    style_id,
                });
                if self.text_runs[index] != next {
                    self.text_runs[index] = next;
                    self.mark(
                        index,
                        Invalidation::from_bits(
                            Invalidation::LAYOUT.bits()
                                | Invalidation::PAINT.bits()
                                | Invalidation::SEMANTICS.bits(),
                        ),
                    );
                }
            }
            Mutation::ScrollTo { x, y, .. } => {
                let next = Some([x, y]);
                if self.scroll_positions[index] != next {
                    self.scroll_positions[index] = next;
                    self.mark(
                        index,
                        Invalidation::from_bits(
                            Invalidation::PAINT.bits() | Invalidation::HIT.bits(),
                        ),
                    );
                }
            }
            Mutation::CreateNode { .. }
            | Mutation::RemoveNode { .. }
            | Mutation::Reparent { .. }
            | Mutation::ConfigureVirtualList { .. }
            | Mutation::SetVirtualItem { .. }
            | Mutation::DefineResource { .. }
            | Mutation::ReleaseResource { .. } => {
                return Err(SceneError::InternalInvariant(
                    "unexpected mutation in non-structural apply",
                ));
            }
        }
        Ok(())
    }

    fn mark(&mut self, index: usize, invalidation: Invalidation) {
        if invalidation.contains(Invalidation::LAYOUT) {
            self.dirty_layout.insert(index);
        }
        if invalidation.contains(Invalidation::PAINT) {
            self.dirty_paint.insert(index);
        }
        if invalidation.contains(Invalidation::PAINT_SELF) {
            self.dirty_paint_self.insert(index);
        }
        if invalidation.contains(Invalidation::HIT) {
            self.dirty_hit.insert(index);
        }
        if invalidation.contains(Invalidation::SEMANTICS) {
            self.dirty_semantics.insert(index);
        }
    }

    fn commit_with_resource_releases(
        &mut self,
        mut batch: MutationBatch,
    ) -> Result<(), SceneError> {
        let mut releases = BTreeSet::new();
        let mut duplicate_release = None;
        batch.instructions.retain(|instruction| {
            if let Mutation::ReleaseResource { resource_id } = &instruction.mutation {
                if !releases.insert(*resource_id) {
                    duplicate_release = Some(*resource_id);
                }
                false
            } else {
                true
            }
        });
        if let Some(resource_id) = duplicate_release {
            return Err(SceneError::DuplicateResourceRelease { resource_id });
        }

        let mut candidate = self.clone();
        let structural = batch.instructions.iter().any(|instruction| {
            matches!(
                instruction.mutation,
                Mutation::CreateNode { .. }
                    | Mutation::RemoveNode { .. }
                    | Mutation::Reparent { .. }
                    | Mutation::ConfigureVirtualList { .. }
                    | Mutation::SetVirtualItem { .. }
            )
        });
        if structural {
            candidate.commit_structural(batch)?;
        } else {
            candidate.commit_non_structural(batch)?;
        }
        for resource_id in releases {
            if resource_directly_referenced(&candidate, resource_id) {
                return Err(SceneError::ResourceInUse { resource_id });
            }
            if candidate.resources.remove(&resource_id).is_none() {
                return Err(SceneError::MissingResource { resource_id });
            }
        }
        validate_resource_graph(&candidate.resources, &BTreeMap::new())?;
        *self = candidate;
        Ok(())
    }
}

impl Resource {
    fn new(kind: ResourceKind, bytes: Vec<u8>) -> Self {
        Self {
            kind,
            bytes: Arc::from(bytes),
        }
    }
}

fn validate_non_structural_mutation(
    scene: &Scene,
    staged_resources: &BTreeMap<u32, Resource>,
    mutation: &Mutation,
) -> Result<(), SceneError> {
    validate_numeric_mutation(mutation)?;
    if matches!(
        mutation,
        Mutation::CreateNode { .. } | Mutation::RemoveNode { .. } | Mutation::Reparent { .. }
    ) {
        return Err(SceneError::InternalInvariant(
            "structural mutation routed to non-structural commit",
        ));
    }
    if let Some(raw_node) = mutation_node(mutation) {
        let node = NodeId::from_raw(raw_node)?;
        if scene.resolve(node).is_none() {
            return Err(SceneError::StaleNode { node });
        }
        validate_node_operation(scene, node, mutation)?;
    }
    match mutation {
        Mutation::SetF32 { prop, .. } => validate_prop_value_type(*prop, PropValueType::F32),
        Mutation::SetVec4 { prop, .. } => validate_prop_value_type(*prop, PropValueType::Vec4),
        Mutation::SetRef {
            prop, resource_id, ..
        } => {
            validate_prop_value_type(*prop, PropValueType::Ref)?;
            validate_prop_resource(scene, staged_resources, *prop, *resource_id)
        }
        Mutation::SetTextRun {
            string_id,
            style_id,
            ..
        } => {
            validate_resource_kind(
                scene,
                staged_resources,
                *string_id,
                ResourceKind::Utf8String,
            )?;
            validate_resource_kind(scene, staged_resources, *style_id, ResourceKind::TextStyle)
        }
        _ => Ok(()),
    }
}

fn validate_numeric_mutation(mutation: &Mutation) -> Result<(), SceneError> {
    match mutation {
        Mutation::SetF32 { node_id, value, .. } if !value.is_finite() => {
            Err(SceneError::NonFiniteValue {
                node: NodeId::from_raw(*node_id)?,
                field: "SetF32.value",
            })
        }
        Mutation::SetVec4 { node_id, value, .. }
            if value.iter().any(|component| !component.is_finite()) =>
        {
            Err(SceneError::NonFiniteValue {
                node: NodeId::from_raw(*node_id)?,
                field: "SetVec4.value",
            })
        }
        Mutation::ScrollTo { node_id, x, y, .. } if !x.is_finite() || !y.is_finite() => {
            Err(SceneError::NonFiniteValue {
                node: NodeId::from_raw(*node_id)?,
                field: "ScrollTo.position",
            })
        }
        Mutation::ConfigureVirtualList {
            node_id,
            estimated_item_height,
            base_overscan_viewports,
            velocity_horizon_seconds,
            maximum_ahead_viewports,
            ..
        } if !estimated_item_height.is_finite()
            || !base_overscan_viewports.is_finite()
            || !velocity_horizon_seconds.is_finite()
            || !maximum_ahead_viewports.is_finite() =>
        {
            Err(SceneError::NonFiniteValue {
                node: NodeId::from_raw(*node_id)?,
                field: "ConfigureVirtualList.policy",
            })
        }
        _ => Ok(()),
    }
}

fn validate_node_operation(
    scene: &Scene,
    node: NodeId,
    mutation: &Mutation,
) -> Result<(), SceneError> {
    let kind = scene.kind(node).ok_or(SceneError::StaleNode { node })?;
    let supported = match mutation {
        Mutation::SetTextRun { .. } => matches!(kind, NodeKind::Text | NodeKind::EditableText),
        Mutation::ScrollTo { .. } => kind == NodeKind::Scroll,
        Mutation::ConfigureVirtualList { .. } => kind == NodeKind::Scroll,
        Mutation::SetVirtualItem { .. } => kind == NodeKind::Container,
        _ => true,
    };
    if supported {
        Ok(())
    } else {
        Err(SceneError::UnsupportedNodeOperation {
            node,
            kind,
            operation: match mutation {
                Mutation::SetTextRun { .. } => "SetTextRun",
                Mutation::ScrollTo { .. } => "ScrollTo",
                Mutation::ConfigureVirtualList { .. } => "ConfigureVirtualList",
                Mutation::SetVirtualItem { .. } => "SetVirtualItem",
                _ => "unknown",
            },
        })
    }
}

fn validate_prop_value_type(prop: Prop, actual: PropValueType) -> Result<(), SceneError> {
    let expected = prop.value_type();
    if expected == actual {
        Ok(())
    } else {
        Err(SceneError::WrongPropValueType {
            prop,
            expected,
            actual,
        })
    }
}

fn mutation_node(mutation: &Mutation) -> Option<u32> {
    match mutation {
        Mutation::RemoveNode { node_id }
        | Mutation::SetF32 { node_id, .. }
        | Mutation::SetVec4 { node_id, .. }
        | Mutation::SetRef { node_id, .. }
        | Mutation::SetFlags { node_id, .. }
        | Mutation::ClearProp { node_id, .. }
        | Mutation::SetTextRun { node_id, .. }
        | Mutation::ScrollTo { node_id, .. }
        | Mutation::ConfigureVirtualList { node_id, .. }
        | Mutation::SetVirtualItem { node_id, .. } => Some(*node_id),
        Mutation::CreateNode { .. }
        | Mutation::Reparent { .. }
        | Mutation::DefineResource { .. }
        | Mutation::ReleaseResource { .. } => None,
    }
}

fn validate_resource(resource_id: u32, kind: ResourceKind, bytes: &[u8]) -> Result<(), SceneError> {
    if bytes.len() > MAX_RESOURCE_BYTES {
        return Err(SceneError::ResourceTooLarge {
            resource_id,
            actual: bytes.len(),
            maximum: MAX_RESOURCE_BYTES,
        });
    }
    match kind {
        ResourceKind::Utf8String => {
            if std::str::from_utf8(bytes).is_err() {
                return Err(SceneError::InvalidUtf8Resource { resource_id });
            }
        }
        ResourceKind::Paint => validate_portable_header(
            resource_id,
            bytes,
            SOLID_PAINT_RESOURCE_FIXED_BYTES,
            SOLID_PAINT_RESOURCE_VARIANT,
            SOLID_PAINT_VERSION_OFFSET,
            SOLID_PAINT_VARIANT_OFFSET,
            SOLID_PAINT_RED_OFFSET,
        )?,
        ResourceKind::Affine => {
            validate_portable_header(
                resource_id,
                bytes,
                AFFINE_RESOURCE_FIXED_BYTES,
                AFFINE_RESOURCE_VARIANT,
                AFFINE_VERSION_OFFSET,
                AFFINE_VARIANT_OFFSET,
                AFFINE_A_OFFSET,
            )?;
            for chunk in bytes[AFFINE_A_OFFSET..].chunks_exact(4) {
                let value = f32::from_le_bytes(chunk.try_into().expect("four-byte affine field"));
                if !value.is_finite() {
                    return Err(SceneError::InvalidResourceEncoding { resource_id });
                }
            }
        }
        ResourceKind::TextStyle => validate_text_style_resource(resource_id, bytes)?,
        ResourceKind::Image | ResourceKind::Path | ResourceKind::Font | ResourceKind::GlyphSpan => {
        }
    }
    Ok(())
}

fn validate_portable_header(
    resource_id: u32,
    bytes: &[u8],
    fixed_bytes: Option<usize>,
    variant: u8,
    version_offset: usize,
    variant_offset: usize,
    payload_offset: usize,
) -> Result<(), SceneError> {
    if bytes.len() < payload_offset
        || fixed_bytes.is_some_and(|length| bytes.len() != length)
        || bytes[version_offset] != RESOURCE_ENCODING_VERSION
        || bytes[variant_offset] != variant
        || bytes[variant_offset + 1..payload_offset]
            .iter()
            .any(|reserved| *reserved != 0)
    {
        return Err(SceneError::InvalidResourceEncoding { resource_id });
    }
    Ok(())
}

fn validate_text_style_resource(resource_id: u32, bytes: &[u8]) -> Result<(), SceneError> {
    validate_portable_header(
        resource_id,
        bytes,
        None,
        TEXT_STYLE_RESOURCE_VARIANT,
        TEXT_STYLE_VERSION_OFFSET,
        TEXT_STYLE_VARIANT_OFFSET,
        TEXT_STYLE_PAINT_ID_OFFSET,
    )?;
    if bytes.len() < TEXT_STYLE_RESOURCE_MINIMUM_BYTES
        || !bytes.len().is_multiple_of(4)
        || bytes[TEXT_STYLE_WEIGHT_OFFSET + 2..TEXT_STYLE_FAMILY_BYTES_OFFSET]
            .iter()
            .any(|reserved| *reserved != 0)
    {
        return Err(SceneError::InvalidResourceEncoding { resource_id });
    }
    let font_size = read_resource_f32(bytes, TEXT_STYLE_FONT_SIZE_OFFSET);
    let line_height = read_resource_f32(bytes, TEXT_STYLE_LINE_HEIGHT_OFFSET);
    let weight = u16::from_le_bytes([
        bytes[TEXT_STYLE_WEIGHT_OFFSET],
        bytes[TEXT_STYLE_WEIGHT_OFFSET + 1],
    ]);
    let family_len = usize::try_from(read_resource_u32(bytes, TEXT_STYLE_FAMILY_BYTES_OFFSET))
        .map_err(|_| SceneError::InvalidResourceEncoding { resource_id })?;
    let family_end = TEXT_STYLE_FAMILY_OFFSET
        .checked_add(family_len)
        .ok_or(SceneError::InvalidResourceEncoding { resource_id })?;
    if !font_size.is_finite()
        || font_size <= 0.0
        || !line_height.is_finite()
        || line_height <= 0.0
        || !(1..=1000).contains(&weight)
        || family_end > bytes.len()
        || bytes[family_end..].iter().any(|padding| *padding != 0)
        || std::str::from_utf8(&bytes[TEXT_STYLE_FAMILY_OFFSET..family_end])
            .map_or(true, str::is_empty)
    {
        return Err(SceneError::InvalidResourceEncoding { resource_id });
    }
    Ok(())
}

fn read_resource_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("validated resource field"),
    )
}

fn read_resource_f32(bytes: &[u8], offset: usize) -> f32 {
    f32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("validated resource field"),
    )
}

fn validate_prop_resource(
    scene: &Scene,
    staged: &BTreeMap<u32, Resource>,
    prop: Prop,
    resource_id: u32,
) -> Result<(), SceneError> {
    if let Some(expected) = prop.resource_kind() {
        validate_resource_kind(scene, staged, resource_id, expected)?;
    }
    Ok(())
}

fn validate_resource_kind(
    scene: &Scene,
    staged: &BTreeMap<u32, Resource>,
    resource_id: u32,
    expected: ResourceKind,
) -> Result<(), SceneError> {
    let resource = staged
        .get(&resource_id)
        .or_else(|| scene.resources.get(&resource_id))
        .ok_or(SceneError::MissingResource { resource_id })?;
    if resource.kind != expected {
        return Err(SceneError::WrongResourceKind {
            resource_id,
            expected,
            actual: resource.kind,
        });
    }
    Ok(())
}

fn validate_resource_graph(
    existing: &BTreeMap<u32, Resource>,
    staged: &BTreeMap<u32, Resource>,
) -> Result<(), SceneError> {
    for (resource_id, resource) in existing.iter().chain(staged) {
        if resource.kind != ResourceKind::TextStyle {
            continue;
        }
        let paint_id = read_resource_u32(&resource.bytes, TEXT_STYLE_PAINT_ID_OFFSET);
        let paint = staged
            .get(&paint_id)
            .or_else(|| existing.get(&paint_id))
            .ok_or(SceneError::MissingResource {
                resource_id: paint_id,
            })?;
        if paint.kind != ResourceKind::Paint {
            return Err(SceneError::WrongResourceKind {
                resource_id: paint_id,
                expected: ResourceKind::Paint,
                actual: paint.kind,
            });
        }
        if *resource_id == paint_id {
            return Err(SceneError::InvalidResourceEncoding {
                resource_id: *resource_id,
            });
        }
    }
    Ok(())
}

fn resource_directly_referenced(scene: &Scene, resource_id: u32) -> bool {
    if scene
        .text_runs
        .iter()
        .flatten()
        .any(|run| run.string_id == resource_id || run.style_id == resource_id)
    {
        return true;
    }
    scene.props.refs.iter().any(|(prop, lane)| {
        prop.resource_kind().is_some() && lane.iter().flatten().any(|value| *value == resource_id)
    })
}

fn set_lane<T: PartialEq + Copy>(
    lanes: &mut BTreeMap<Prop, Vec<Option<T>>>,
    prop: Prop,
    index: usize,
    scene_len: usize,
    value: T,
) -> bool {
    let lane = lanes.entry(prop).or_insert_with(|| vec![None; scene_len]);
    let changed = lane[index] != Some(value);
    lane[index] = Some(value);
    changed
}

fn clear_lane<T>(lanes: &mut BTreeMap<Prop, Vec<Option<T>>>, prop: Prop, index: usize) -> bool {
    lanes
        .get_mut(&prop)
        .and_then(|lane| lane[index].take())
        .is_some()
}

#[derive(Clone, Debug, PartialEq)]
struct PlanNode {
    id: NodeId,
    kind: NodeKind,
    parent: Option<NodeId>,
    children: Vec<NodeId>,
    flags: u32,
    text_run: Option<TextRun>,
    scroll_position: Option<[f32; 2]>,
    virtual_list: Option<VirtualListConfig>,
    virtual_item_index: Option<u32>,
    f32_props: BTreeMap<Prop, f32>,
    vec4_props: BTreeMap<Prop, [f32; 4]>,
    ref_props: BTreeMap<Prop, u32>,
}

#[derive(Clone, Debug)]
struct PlanSlot {
    generation: u16,
    active: bool,
    retired: bool,
}

impl Scene {
    fn commit_structural(&mut self, batch: MutationBatch) -> Result<(), SceneError> {
        let mut nodes = self.plan_nodes();
        let mut slots: Vec<_> = self
            .slots
            .iter()
            .map(|slot| PlanSlot {
                generation: slot.generation,
                active: slot.active_index.is_some(),
                retired: slot.retired,
            })
            .collect();
        let mut staged_resources = BTreeMap::new();

        for instruction in batch.instructions {
            match instruction.mutation {
                Mutation::CreateNode {
                    node_id,
                    kind,
                    parent,
                    before_sibling,
                } => plan_create(
                    &mut nodes,
                    &mut slots,
                    node_id,
                    kind,
                    parent,
                    before_sibling,
                )?,
                Mutation::RemoveNode { node_id } => {
                    plan_remove(&mut nodes, &mut slots, NodeId::from_raw(node_id)?)?;
                }
                Mutation::Reparent {
                    node_id,
                    new_parent,
                    before_sibling,
                } => plan_reparent(
                    &mut nodes,
                    NodeId::from_raw(node_id)?,
                    NodeId::from_raw(new_parent)?,
                    optional_node(before_sibling)?,
                )?,
                Mutation::DefineResource {
                    resource_id,
                    kind,
                    bytes,
                } => {
                    validate_resource(resource_id, kind, &bytes)?;
                    if self.resources.contains_key(&resource_id)
                        || staged_resources
                            .insert(resource_id, Resource::new(kind, bytes))
                            .is_some()
                    {
                        return Err(SceneError::DuplicateResource { resource_id });
                    }
                }
                Mutation::ReleaseResource { .. } => {
                    return Err(SceneError::InternalInvariant(
                        "resource release reached structural planner",
                    ));
                }
                mutation => plan_apply_property(&mut nodes, self, &staged_resources, mutation)?,
            }
        }

        validate_virtual_plan(&nodes)?;
        let order = topology_order(&nodes)?;
        let mut next = Self::build_from_plan(nodes, slots, order)?;
        next.resources = self.resources.clone();
        next.resources.extend(staged_resources);
        validate_resource_graph(&next.resources, &BTreeMap::new())?;
        next.last_frame_seq = Some(batch.frame_seq);
        next.metrics = self.metrics;
        next.metrics.commits += 1;
        next.metrics.topology_compactions += 1;
        *self = next;
        Ok(())
    }

    fn plan_nodes(&self) -> BTreeMap<NodeId, PlanNode> {
        let mut result = BTreeMap::new();
        for (index, id) in self.ids.iter().copied().enumerate() {
            result.insert(
                id,
                PlanNode {
                    id,
                    kind: self.kinds[index],
                    parent: self.parents[index],
                    children: Vec::new(),
                    flags: self.flags[index],
                    text_run: self.text_runs[index],
                    scroll_position: self.scroll_positions[index],
                    virtual_list: self.virtual_lists[index],
                    virtual_item_index: self.virtual_item_indices[index],
                    f32_props: collect_props(&self.props.f32, index),
                    vec4_props: collect_props(&self.props.vec4, index),
                    ref_props: collect_props(&self.props.refs, index),
                },
            );
        }
        for (index, id) in self.ids.iter().copied().enumerate() {
            if let Some(parent) = self.parents[index]
                && let Some(parent_node) = result.get_mut(&parent)
            {
                parent_node.children.push(id);
            }
        }
        result
    }

    fn build_from_plan(
        mut nodes: BTreeMap<NodeId, PlanNode>,
        mut slots: Vec<PlanSlot>,
        order: Vec<(NodeId, u16)>,
    ) -> Result<Self, SceneError> {
        let length = order.len();
        let mut next = Self::new();

        for (id, depth) in &order {
            let node = nodes.remove(id).ok_or(SceneError::InternalInvariant(
                "planned node missing during rebuild",
            ))?;
            next.ids.push(node.id);
            next.parents.push(node.parent);
            next.first_children.push(node.children.first().copied());
            next.next_siblings.push(None);
            next.depths.push(*depth);
            next.kinds.push(node.kind);
            next.flags.push(node.flags);
            next.text_runs.push(node.text_run);
            next.scroll_positions.push(node.scroll_position);
            next.virtual_lists.push(node.virtual_list);
            next.virtual_item_indices.push(node.virtual_item_index);
            push_props(&mut next.props.f32, node.f32_props, next.ids.len() - 1);
            push_props(&mut next.props.vec4, node.vec4_props, next.ids.len() - 1);
            push_props(&mut next.props.refs, node.ref_props, next.ids.len() - 1);
            extend_all_lanes(&mut next.props, next.ids.len());
        }
        if !nodes.is_empty() {
            return Err(SceneError::InternalInvariant("unreachable planned nodes"));
        }

        for index in 0..length {
            if let Some(parent) = next.parents[index]
                && let Some(previous_index) = (0..index)
                    .rev()
                    .find(|candidate| next.parents[*candidate] == Some(parent))
            {
                next.next_siblings[previous_index] = Some(next.ids[index]);
            }
        }
        for slot in &mut slots {
            slot.active = false;
        }
        next.slots = slots
            .into_iter()
            .map(|slot| Slot {
                generation: slot.generation,
                active_index: None,
                retired: slot.retired,
            })
            .collect();
        for (index, id) in next.ids.iter().copied().enumerate() {
            let slot = next
                .slots
                .get_mut(id.index() as usize)
                .ok_or(SceneError::InternalInvariant("rebuilt slot missing"))?;
            slot.active_index = Some(index);
        }

        next.dirty_layout = BitSet::with_len(length);
        next.dirty_paint = BitSet::with_len(length);
        next.dirty_paint_self = BitSet::with_len(length);
        next.dirty_hit = BitSet::with_len(length);
        next.dirty_semantics = BitSet::with_len(length);
        next.dirty_layout.fill();
        next.dirty_paint.fill();
        next.dirty_hit.fill();
        next.dirty_semantics.fill();
        next.validate_invariants()?;
        Ok(next)
    }
}

fn plan_create(
    nodes: &mut BTreeMap<NodeId, PlanNode>,
    slots: &mut Vec<PlanSlot>,
    raw_node: u32,
    kind: NodeKind,
    raw_parent: u32,
    raw_before: u32,
) -> Result<(), SceneError> {
    let node = NodeId::from_raw(raw_node)?;
    if nodes.contains_key(&node) {
        return Err(SceneError::DuplicateNode { node });
    }
    let slot_index = node.index() as usize;
    match slot_index.cmp(&slots.len()) {
        std::cmp::Ordering::Greater => {
            return Err(SceneError::SlotGap {
                index: node.index(),
                next_index: slots.len() as u32,
            });
        }
        std::cmp::Ordering::Equal => {
            if node.generation() != 1 {
                return Err(SceneError::UnexpectedGeneration {
                    index: node.index(),
                    expected: 1,
                    actual: node.generation(),
                });
            }
            slots.push(PlanSlot {
                generation: 1,
                active: true,
                retired: false,
            });
        }
        std::cmp::Ordering::Less => {
            let slot = &mut slots[slot_index];
            if slot.active {
                return Err(SceneError::DuplicateNode { node });
            }
            if slot.retired || slot.generation == MAX_GENERATION {
                return Err(SceneError::RetiredSlot {
                    index: node.index(),
                });
            }
            let expected = slot.generation + 1;
            if node.generation() != expected {
                return Err(SceneError::UnexpectedGeneration {
                    index: node.index(),
                    expected,
                    actual: node.generation(),
                });
            }
            slot.generation = expected;
            slot.active = true;
        }
    }

    let parent = optional_node(raw_parent)?;
    let before = optional_node(raw_before)?;
    if kind == NodeKind::Root {
        if parent.is_some() || before.is_some() {
            return Err(SceneError::InvalidRoot { node });
        }
        if nodes.values().any(|candidate| candidate.parent.is_none()) {
            return Err(SceneError::MultipleRoots);
        }
    } else {
        let parent_id = parent.ok_or(SceneError::InvalidRoot { node })?;
        insert_child(nodes, parent_id, node, before)?;
    }
    nodes.insert(
        node,
        PlanNode {
            id: node,
            kind,
            parent,
            children: Vec::new(),
            flags: 0,
            text_run: None,
            scroll_position: None,
            virtual_list: None,
            virtual_item_index: None,
            f32_props: BTreeMap::new(),
            vec4_props: BTreeMap::new(),
            ref_props: BTreeMap::new(),
        },
    );
    Ok(())
}

fn plan_remove(
    nodes: &mut BTreeMap<NodeId, PlanNode>,
    slots: &mut [PlanSlot],
    node: NodeId,
) -> Result<(), SceneError> {
    let parent = nodes
        .get(&node)
        .ok_or(SceneError::StaleNode { node })?
        .parent;
    if let Some(parent) = parent {
        let parent_node = nodes
            .get_mut(&parent)
            .ok_or(SceneError::MissingParent { node, parent })?;
        parent_node.children.retain(|child| *child != node);
    }
    let mut stack = vec![node];
    while let Some(current) = stack.pop() {
        let removed = nodes
            .remove(&current)
            .ok_or(SceneError::StaleNode { node: current })?;
        stack.extend(removed.children);
        let slot = slots
            .get_mut(current.index() as usize)
            .ok_or(SceneError::StaleNode { node: current })?;
        slot.active = false;
        if slot.generation == MAX_GENERATION {
            slot.retired = true;
        }
    }
    Ok(())
}

fn plan_reparent(
    nodes: &mut BTreeMap<NodeId, PlanNode>,
    node: NodeId,
    new_parent: NodeId,
    before: Option<NodeId>,
) -> Result<(), SceneError> {
    let old_parent = nodes
        .get(&node)
        .ok_or(SceneError::StaleNode { node })?
        .parent
        .ok_or(SceneError::ReparentRoot { node })?;
    if !nodes.contains_key(&new_parent) {
        return Err(SceneError::MissingParent {
            node,
            parent: new_parent,
        });
    }
    let mut cursor = Some(new_parent);
    while let Some(candidate) = cursor {
        if candidate == node {
            return Err(SceneError::Cycle {
                node,
                parent: new_parent,
            });
        }
        cursor = nodes.get(&candidate).and_then(|entry| entry.parent);
    }
    nodes
        .get_mut(&old_parent)
        .ok_or(SceneError::MissingParent {
            node,
            parent: old_parent,
        })?
        .children
        .retain(|child| *child != node);
    insert_child(nodes, new_parent, node, before)?;
    nodes
        .get_mut(&node)
        .ok_or(SceneError::StaleNode { node })?
        .parent = Some(new_parent);
    Ok(())
}

fn insert_child(
    nodes: &mut BTreeMap<NodeId, PlanNode>,
    parent: NodeId,
    node: NodeId,
    before: Option<NodeId>,
) -> Result<(), SceneError> {
    let parent_node = nodes
        .get_mut(&parent)
        .ok_or(SceneError::MissingParent { node, parent })?;
    if !matches!(
        parent_node.kind,
        NodeKind::Root | NodeKind::Container | NodeKind::Scroll
    ) {
        return Err(SceneError::InvalidParentKind {
            node,
            parent,
            actual: parent_node.kind,
        });
    }
    let position = if let Some(sibling) = before {
        parent_node
            .children
            .iter()
            .position(|child| *child == sibling)
            .ok_or(SceneError::InvalidBeforeSibling { sibling })?
    } else {
        parent_node.children.len()
    };
    parent_node.children.insert(position, node);
    Ok(())
}

fn plan_apply_property(
    nodes: &mut BTreeMap<NodeId, PlanNode>,
    scene: &Scene,
    staged_resources: &BTreeMap<u32, Resource>,
    mutation: Mutation,
) -> Result<(), SceneError> {
    validate_numeric_mutation(&mutation)?;
    let raw_node =
        mutation_node(&mutation).ok_or(SceneError::InternalInvariant("missing property target"))?;
    let node = NodeId::from_raw(raw_node)?;
    let entry = nodes.get(&node).ok_or(SceneError::StaleNode { node })?;
    let kind = entry.kind;
    match &mutation {
        Mutation::SetTextRun { .. } if !matches!(kind, NodeKind::Text | NodeKind::EditableText) => {
            return Err(SceneError::UnsupportedNodeOperation {
                node,
                kind,
                operation: "SetTextRun",
            });
        }
        Mutation::ScrollTo { .. } if kind != NodeKind::Scroll => {
            return Err(SceneError::UnsupportedNodeOperation {
                node,
                kind,
                operation: "ScrollTo",
            });
        }
        Mutation::ConfigureVirtualList { .. } if kind != NodeKind::Scroll => {
            return Err(SceneError::UnsupportedNodeOperation {
                node,
                kind,
                operation: "ConfigureVirtualList",
            });
        }
        Mutation::SetVirtualItem { .. } if kind != NodeKind::Container => {
            return Err(SceneError::UnsupportedNodeOperation {
                node,
                kind,
                operation: "SetVirtualItem",
            });
        }
        _ => {}
    }
    match mutation {
        Mutation::SetF32 { prop, value, .. } => {
            validate_prop_value_type(prop, PropValueType::F32)?;
            nodes
                .get_mut(&node)
                .ok_or(SceneError::StaleNode { node })?
                .f32_props
                .insert(prop, value);
        }
        Mutation::SetVec4 { prop, value, .. } => {
            validate_prop_value_type(prop, PropValueType::Vec4)?;
            nodes
                .get_mut(&node)
                .ok_or(SceneError::StaleNode { node })?
                .vec4_props
                .insert(prop, value);
        }
        Mutation::SetRef {
            prop, resource_id, ..
        } => {
            validate_prop_value_type(prop, PropValueType::Ref)?;
            validate_prop_resource(scene, staged_resources, prop, resource_id)?;
            nodes
                .get_mut(&node)
                .ok_or(SceneError::StaleNode { node })?
                .ref_props
                .insert(prop, resource_id);
        }
        Mutation::SetFlags { set, clear, .. } => {
            let entry = nodes.get_mut(&node).ok_or(SceneError::StaleNode { node })?;
            entry.flags = (entry.flags | set) & !clear;
        }
        Mutation::ClearProp { prop, .. } => {
            let entry = nodes.get_mut(&node).ok_or(SceneError::StaleNode { node })?;
            match prop.value_type() {
                PropValueType::F32 => {
                    entry.f32_props.remove(&prop);
                }
                PropValueType::Vec4 => {
                    entry.vec4_props.remove(&prop);
                }
                PropValueType::Ref => {
                    entry.ref_props.remove(&prop);
                }
            }
        }
        Mutation::SetTextRun {
            string_id,
            style_id,
            ..
        } => {
            validate_resource_kind(scene, staged_resources, string_id, ResourceKind::Utf8String)?;
            validate_resource_kind(scene, staged_resources, style_id, ResourceKind::TextStyle)?;
            nodes
                .get_mut(&node)
                .ok_or(SceneError::StaleNode { node })?
                .text_run = Some(TextRun {
                string_id,
                style_id,
            });
        }
        Mutation::ScrollTo { x, y, .. } => {
            nodes
                .get_mut(&node)
                .ok_or(SceneError::StaleNode { node })?
                .scroll_position = Some([x, y]);
        }
        Mutation::ConfigureVirtualList {
            item_count,
            estimated_item_height,
            base_overscan_viewports,
            velocity_horizon_seconds,
            maximum_ahead_viewports,
            ..
        } => {
            let config = VirtualListConfig {
                item_count,
                estimated_item_height,
                base_overscan_viewports,
                velocity_horizon_seconds,
                maximum_ahead_viewports,
            };
            validate_virtual_list_config(node, config)?;
            nodes
                .get_mut(&node)
                .ok_or(SceneError::StaleNode { node })?
                .virtual_list = Some(config);
        }
        Mutation::SetVirtualItem { item_index, .. } => {
            nodes
                .get_mut(&node)
                .ok_or(SceneError::StaleNode { node })?
                .virtual_item_index = Some(item_index);
        }
        Mutation::CreateNode { .. }
        | Mutation::RemoveNode { .. }
        | Mutation::Reparent { .. }
        | Mutation::DefineResource { .. }
        | Mutation::ReleaseResource { .. } => {
            return Err(SceneError::InternalInvariant(
                "unexpected structural/resource mutation in property planner",
            ));
        }
    }
    Ok(())
}

fn validate_virtual_list_config(node: NodeId, config: VirtualListConfig) -> Result<(), SceneError> {
    if config.item_count > MAX_VIRTUAL_ITEMS {
        return Err(SceneError::InvalidVirtualListConfig {
            node,
            field: "itemCount",
        });
    }
    for (field, value, minimum, maximum) in [
        (
            "estimatedItemHeight",
            config.estimated_item_height,
            f32::EPSILON,
            1_000_000_000.0,
        ),
        (
            "baseOverscanViewports",
            config.base_overscan_viewports,
            0.0,
            64.0,
        ),
        (
            "velocityHorizonSeconds",
            config.velocity_horizon_seconds,
            0.0,
            10.0,
        ),
        (
            "maximumAheadViewports",
            config.maximum_ahead_viewports,
            0.0,
            64.0,
        ),
    ] {
        if !value.is_finite() || value < minimum || value > maximum {
            return Err(SceneError::InvalidVirtualListConfig { node, field });
        }
    }
    Ok(())
}

fn validate_virtual_plan(nodes: &BTreeMap<NodeId, PlanNode>) -> Result<(), SceneError> {
    let mut materialized = BTreeSet::new();
    for (&node, entry) in nodes {
        if let Some(config) = entry.virtual_list {
            if entry.kind != NodeKind::Scroll {
                return Err(SceneError::UnsupportedNodeOperation {
                    node,
                    kind: entry.kind,
                    operation: "ConfigureVirtualList",
                });
            }
            validate_virtual_list_config(node, config)?;
        }
        let Some(item_index) = entry.virtual_item_index else {
            continue;
        };
        if entry.kind != NodeKind::Container {
            return Err(SceneError::UnsupportedNodeOperation {
                node,
                kind: entry.kind,
                operation: "SetVirtualItem",
            });
        }
        let parent = entry
            .parent
            .and_then(|parent| nodes.get(&parent).map(|entry| (parent, entry)))
            .ok_or(SceneError::MissingVirtualListParent { node })?;
        let config = parent
            .1
            .virtual_list
            .ok_or(SceneError::MissingVirtualListParent { node })?;
        if item_index >= config.item_count {
            return Err(SceneError::InvalidVirtualItemIndex {
                node,
                index: item_index,
                item_count: config.item_count,
            });
        }
        if !materialized.insert((parent.0, item_index)) {
            return Err(SceneError::DuplicateVirtualItemIndex {
                list: parent.0,
                index: item_index,
            });
        }
    }
    Ok(())
}

fn topology_order(nodes: &BTreeMap<NodeId, PlanNode>) -> Result<Vec<(NodeId, u16)>, SceneError> {
    if nodes.is_empty() {
        return Ok(Vec::new());
    }
    let roots: Vec<_> = nodes
        .values()
        .filter(|node| node.parent.is_none())
        .map(|node| node.id)
        .collect();
    let [root] = roots.as_slice() else {
        return Err(if roots.is_empty() {
            SceneError::MissingRoot
        } else {
            SceneError::MultipleRoots
        });
    };
    let mut order = Vec::with_capacity(nodes.len());
    let mut visited = BTreeSet::new();
    let mut stack = vec![(*root, 0_u32)];
    while let Some((node, depth)) = stack.pop() {
        if !visited.insert(node) {
            return Err(SceneError::Cycle { node, parent: node });
        }
        let depth = u16::try_from(depth).map_err(|_| SceneError::DepthOverflow { node })?;
        order.push((node, depth));
        let entry = nodes.get(&node).ok_or(SceneError::StaleNode { node })?;
        for child in entry.children.iter().rev() {
            let child_entry = nodes
                .get(child)
                .ok_or(SceneError::StaleNode { node: *child })?;
            if child_entry.parent != Some(node) {
                return Err(SceneError::MissingParent {
                    node: *child,
                    parent: node,
                });
            }
            stack.push((*child, u32::from(depth) + 1));
        }
    }
    if order.len() != nodes.len() {
        return Err(SceneError::InternalInvariant(
            "planned topology is disconnected",
        ));
    }
    Ok(order)
}

fn optional_node(raw: u32) -> Result<Option<NodeId>, SceneError> {
    if raw == NULL_NODE_ID {
        Ok(None)
    } else {
        NodeId::from_raw(raw).map(Some)
    }
}

fn collect_props<T: Copy>(
    lanes: &BTreeMap<Prop, Vec<Option<T>>>,
    index: usize,
) -> BTreeMap<Prop, T> {
    lanes
        .iter()
        .filter_map(|(prop, lane)| lane[index].map(|value| (*prop, value)))
        .collect()
}

fn push_props<T: Copy>(
    lanes: &mut BTreeMap<Prop, Vec<Option<T>>>,
    values: BTreeMap<Prop, T>,
    index: usize,
) {
    for (prop, value) in values {
        let lane = lanes.entry(prop).or_insert_with(|| vec![None; index]);
        lane.push(Some(value));
    }
}

fn extend_all_lanes(props: &mut PropertyLanes, length: usize) {
    for lane in props
        .f32
        .values_mut()
        .map(|lane| lane as &mut dyn ResizeLane)
        .chain(
            props
                .vec4
                .values_mut()
                .map(|lane| lane as &mut dyn ResizeLane),
        )
        .chain(
            props
                .refs
                .values_mut()
                .map(|lane| lane as &mut dyn ResizeLane),
        )
    {
        lane.resize_none(length);
    }
}

trait ResizeLane {
    fn resize_none(&mut self, length: usize);
}

impl<T> ResizeLane for Vec<Option<T>> {
    fn resize_none(&mut self, length: usize) {
        self.resize_with(length, || None);
    }
}

#[cfg(test)]
mod tests {
    use doper_abi::{MutationInstruction, Prop};
    use proptest::prelude::*;

    use super::*;

    fn id(index: u32, generation: u16) -> NodeId {
        NodeId::new(index, generation).expect("test id")
    }

    fn batch(frame_seq: u32, mutations: Vec<Mutation>) -> MutationBatch {
        MutationBatch {
            frame_seq,
            instructions: mutations
                .into_iter()
                .map(|mutation| MutationInstruction { flags: 0, mutation })
                .collect(),
        }
    }

    fn create(node: NodeId, kind: NodeKind, parent: Option<NodeId>) -> Mutation {
        Mutation::CreateNode {
            node_id: node.raw(),
            kind,
            parent: parent.map_or(NULL_NODE_ID, NodeId::raw),
            before_sibling: NULL_NODE_ID,
        }
    }

    fn create_before(
        node: NodeId,
        kind: NodeKind,
        parent: NodeId,
        before_sibling: NodeId,
    ) -> Mutation {
        Mutation::CreateNode {
            node_id: node.raw(),
            kind,
            parent: parent.raw(),
            before_sibling: before_sibling.raw(),
        }
    }

    fn define(resource_id: u32, kind: ResourceKind, bytes: Vec<u8>) -> Mutation {
        Mutation::DefineResource {
            resource_id,
            kind,
            bytes,
        }
    }

    fn paint(red: u8, green: u8, blue: u8, alpha: u8) -> Vec<u8> {
        vec![
            RESOURCE_ENCODING_VERSION,
            SOLID_PAINT_RESOURCE_VARIANT,
            0,
            0,
            red,
            green,
            blue,
            alpha,
        ]
    }

    fn affine(values: [f32; 6]) -> Vec<u8> {
        let mut bytes = vec![RESOURCE_ENCODING_VERSION, AFFINE_RESOURCE_VARIANT, 0, 0];
        for value in values {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    fn text_style(paint_id: u32, family: &[u8]) -> Vec<u8> {
        let padded_len = TEXT_STYLE_FAMILY_OFFSET + family.len().next_multiple_of(4);
        let mut bytes = vec![0; padded_len];
        bytes[TEXT_STYLE_VERSION_OFFSET] = RESOURCE_ENCODING_VERSION;
        bytes[TEXT_STYLE_VARIANT_OFFSET] = TEXT_STYLE_RESOURCE_VARIANT;
        bytes[TEXT_STYLE_PAINT_ID_OFFSET..TEXT_STYLE_PAINT_ID_OFFSET + 4]
            .copy_from_slice(&paint_id.to_le_bytes());
        bytes[TEXT_STYLE_FONT_SIZE_OFFSET..TEXT_STYLE_FONT_SIZE_OFFSET + 4]
            .copy_from_slice(&16.0_f32.to_le_bytes());
        bytes[TEXT_STYLE_LINE_HEIGHT_OFFSET..TEXT_STYLE_LINE_HEIGHT_OFFSET + 4]
            .copy_from_slice(&20.0_f32.to_le_bytes());
        bytes[TEXT_STYLE_WEIGHT_OFFSET..TEXT_STYLE_WEIGHT_OFFSET + 2]
            .copy_from_slice(&400_u16.to_le_bytes());
        bytes[TEXT_STYLE_FAMILY_BYTES_OFFSET..TEXT_STYLE_FAMILY_BYTES_OFFSET + 4]
            .copy_from_slice(&(family.len() as u32).to_le_bytes());
        bytes[TEXT_STYLE_FAMILY_OFFSET..TEXT_STYLE_FAMILY_OFFSET + family.len()]
            .copy_from_slice(family);
        bytes
    }

    fn basic_scene() -> (Scene, NodeId, NodeId, NodeId) {
        let root = id(0, 1);
        let left = id(1, 1);
        let right = id(2, 1);
        let mut scene = Scene::default();
        scene
            .commit(batch(
                1,
                vec![
                    create(root, NodeKind::Root, None),
                    create(left, NodeKind::Container, Some(root)),
                    create(right, NodeKind::Container, Some(root)),
                ],
            ))
            .expect("basic scene");
        (scene, root, left, right)
    }

    fn assert_invariant(scene: &Scene, message: &'static str) {
        assert_eq!(
            scene.validate_invariants(),
            Err(SceneError::InternalInvariant(message))
        );
    }

    #[test]
    fn public_queries_and_every_non_structural_lane_are_observable() {
        let root = id(0, 1);
        let scroll = id(1, 1);
        let text = id(2, 1);
        let editable = id(3, 1);
        let mut scene = Scene::default();
        assert!(scene.is_empty());
        assert_eq!(scene.len(), 0);

        scene
            .commit(batch(
                1,
                vec![
                    define(10, ResourceKind::Paint, paint(1, 2, 3, 255)),
                    define(
                        11,
                        ResourceKind::Affine,
                        affine([1.0, 0.0, 0.0, 1.0, 4.0, 5.0]),
                    ),
                    define(12, ResourceKind::Utf8String, b"hello".to_vec()),
                    define(13, ResourceKind::TextStyle, text_style(10, b"sans")),
                    create(root, NodeKind::Root, None),
                    create(scroll, NodeKind::Scroll, Some(root)),
                    create(text, NodeKind::Text, Some(scroll)),
                    create(editable, NodeKind::EditableText, Some(scroll)),
                    Mutation::SetF32 {
                        node_id: root.raw(),
                        prop: Prop::Opacity,
                        value: 0.5,
                    },
                    Mutation::SetVec4 {
                        node_id: root.raw(),
                        prop: Prop::Padding,
                        value: [1.0, 2.0, 3.0, 4.0],
                    },
                    Mutation::SetRef {
                        node_id: root.raw(),
                        prop: Prop::BackgroundColor,
                        resource_id: 10,
                    },
                    Mutation::SetRef {
                        node_id: root.raw(),
                        prop: Prop::Transform,
                        resource_id: 11,
                    },
                    Mutation::SetRef {
                        node_id: root.raw(),
                        prop: Prop::SemanticLabel,
                        resource_id: 12,
                    },
                    Mutation::SetFlags {
                        node_id: root.raw(),
                        set: 0b1111,
                        clear: 0b0010,
                    },
                    Mutation::SetTextRun {
                        node_id: text.raw(),
                        string_id: 12,
                        style_id: 13,
                    },
                    Mutation::SetTextRun {
                        node_id: editable.raw(),
                        string_id: 12,
                        style_id: 13,
                    },
                    Mutation::ScrollTo {
                        node_id: scroll.raw(),
                        x: 7.0,
                        y: 9.0,
                        behavior: 0,
                    },
                ],
            ))
            .expect("all supported lanes");

        assert!(!scene.is_empty());
        assert_eq!(scene.len(), 4);
        assert_eq!(scene.parent(root), None);
        assert_eq!(scene.parent(text), Some(scroll));
        assert_eq!(scene.kind(editable), Some(NodeKind::EditableText));
        assert_eq!(scene.first_child(root), Some(scroll));
        assert_eq!(scene.first_child(scroll), Some(text));
        assert_eq!(scene.next_sibling(text), Some(editable));
        assert_eq!(scene.next_sibling(editable), None);
        assert_eq!(scene.depth(text), Some(2));
        assert_eq!(scene.flags(root), Some(0b1101));
        assert_eq!(scene.scroll_position(scroll), Some([7.0, 9.0]));
        assert_eq!(scene.f32_prop(root, Prop::Opacity), Some(0.5));
        assert_eq!(
            scene.vec4_prop(root, Prop::Padding),
            Some([1.0, 2.0, 3.0, 4.0])
        );
        assert_eq!(scene.ref_prop(root, Prop::Transform), Some(11));
        assert_eq!(
            scene.text_run(text),
            Some(TextRun {
                string_id: 12,
                style_id: 13,
            })
        );
        assert_eq!(
            scene.resource(10).map(|resource| resource.kind),
            Some(ResourceKind::Paint)
        );
        assert!(scene.dirty(DirtyDomain::Layout).contains(0));
        assert!(scene.dirty(DirtyDomain::Paint).contains(0));
        assert!(!scene.dirty(DirtyDomain::PaintSelf).contains(0));
        assert!(scene.dirty(DirtyDomain::Hit).contains(0));
        assert!(scene.dirty(DirtyDomain::Semantics).contains(0));
        assert_eq!(scene.parent(id(9, 1)), None);
        assert_eq!(scene.kind(id(9, 1)), None);

        scene.clear_dirty();
        scene
            .commit(batch(
                2,
                vec![Mutation::SetF32 {
                    node_id: root.raw(),
                    prop: Prop::Opacity,
                    value: 0.75,
                }],
            ))
            .expect("self-paint invalidation");
        assert!(scene.dirty(DirtyDomain::PaintSelf).contains(0));
        scene.clear_dirty();
        scene
            .commit(batch(
                3,
                vec![
                    Mutation::SetF32 {
                        node_id: root.raw(),
                        prop: Prop::Opacity,
                        value: 0.75,
                    },
                    Mutation::SetVec4 {
                        node_id: root.raw(),
                        prop: Prop::Padding,
                        value: [1.0, 2.0, 3.0, 4.0],
                    },
                    Mutation::SetRef {
                        node_id: root.raw(),
                        prop: Prop::Transform,
                        resource_id: 11,
                    },
                    Mutation::SetFlags {
                        node_id: root.raw(),
                        set: 0b1101,
                        clear: 0,
                    },
                    Mutation::SetTextRun {
                        node_id: text.raw(),
                        string_id: 12,
                        style_id: 13,
                    },
                    Mutation::ScrollTo {
                        node_id: scroll.raw(),
                        x: 7.0,
                        y: 9.0,
                        behavior: 0,
                    },
                    Mutation::ClearProp {
                        node_id: root.raw(),
                        prop: Prop::Width,
                    },
                ],
            ))
            .expect("idempotent mutations");
        for domain in [
            DirtyDomain::Layout,
            DirtyDomain::Paint,
            DirtyDomain::PaintSelf,
            DirtyDomain::Hit,
            DirtyDomain::Semantics,
        ] {
            assert_eq!(scene.dirty(domain).iter_ones().next(), None);
        }

        scene
            .commit(batch(
                4,
                vec![
                    Mutation::ClearProp {
                        node_id: root.raw(),
                        prop: Prop::Opacity,
                    },
                    Mutation::ClearProp {
                        node_id: root.raw(),
                        prop: Prop::Padding,
                    },
                    Mutation::ClearProp {
                        node_id: root.raw(),
                        prop: Prop::Transform,
                    },
                ],
            ))
            .expect("clear all lane kinds");
        assert_eq!(scene.f32_prop(root, Prop::Opacity), None);
        assert_eq!(scene.vec4_prop(root, Prop::Padding), None);
        assert_eq!(scene.ref_prop(root, Prop::Transform), None);
        scene.validate_invariants().expect("valid all-lane scene");
    }

    #[test]
    fn core_scroll_position_is_generation_safe_and_marks_only_dynamic_domains() {
        let root = id(0, 1);
        let scroll = id(1, 1);
        let child = id(2, 1);
        let mut scene = Scene::new();
        scene
            .commit(batch(
                1,
                vec![
                    create(root, NodeKind::Root, None),
                    create(scroll, NodeKind::Scroll, Some(root)),
                    create(child, NodeKind::Container, Some(scroll)),
                ],
            ))
            .expect("scene");
        scene.clear_dirty();

        assert_eq!(scene.apply_scroll_position(scroll, [3.0, 25.0]), Ok(true));
        assert_eq!(scene.scroll_position(scroll), Some([3.0, 25.0]));
        assert!(scene.dirty(DirtyDomain::Paint).contains(1));
        assert!(scene.dirty(DirtyDomain::Hit).contains(1));
        assert_eq!(scene.dirty(DirtyDomain::Layout).iter_ones().next(), None);
        assert_eq!(scene.dirty(DirtyDomain::Semantics).iter_ones().next(), None);
        scene.clear_dirty();
        assert_eq!(scene.apply_scroll_position(scroll, [3.0, 25.0]), Ok(false));
        assert_eq!(scene.dirty(DirtyDomain::Paint).iter_ones().next(), None);

        assert!(matches!(
            scene.apply_scroll_position(child, [0.0, 1.0]),
            Err(SceneError::UnsupportedNodeOperation { .. })
        ));
        assert_eq!(
            scene.apply_scroll_position(id(1, 2), [0.0, 1.0]),
            Err(SceneError::StaleNode { node: id(1, 2) })
        );
        assert!(matches!(
            scene.apply_scroll_position(scroll, [f32::NAN, 0.0]),
            Err(SceneError::NonFiniteValue { .. })
        ));
        assert_eq!(scene.scroll_position(scroll), Some([3.0, 25.0]));

        assert!(matches!(
            scene.apply_scroll_positions(&[(scroll, [8.0, 40.0]), (child, [0.0, 2.0])]),
            Err(SceneError::UnsupportedNodeOperation { .. })
        ));
        assert_eq!(
            scene.scroll_position(scroll),
            Some([3.0, 25.0]),
            "a late invalid target must roll back the whole Core position batch"
        );
    }

    #[test]
    fn virtual_list_metadata_is_bounded_generation_safe_and_transactional() {
        let root = id(0, 1);
        let list = id(1, 1);
        let first = id(2, 1);
        let second = id(3, 1);
        let mut scene = Scene::new();
        scene
            .commit(batch(
                1,
                vec![
                    create(root, NodeKind::Root, None),
                    create(list, NodeKind::Scroll, Some(root)),
                    create(first, NodeKind::Container, Some(list)),
                    create(second, NodeKind::Container, Some(list)),
                    Mutation::ConfigureVirtualList {
                        node_id: list.raw(),
                        item_count: 1_000_000,
                        estimated_item_height: 24.0,
                        base_overscan_viewports: 1.0,
                        velocity_horizon_seconds: 0.25,
                        maximum_ahead_viewports: 4.0,
                    },
                    Mutation::SetVirtualItem {
                        node_id: first.raw(),
                        item_index: 10,
                    },
                    Mutation::SetVirtualItem {
                        node_id: second.raw(),
                        item_index: 11,
                    },
                ],
            ))
            .expect("virtual scene");
        assert_eq!(
            scene.virtual_list(list).expect("config").item_count,
            1_000_000
        );
        assert_eq!(scene.virtual_item_index(first), Some(10));
        assert_eq!(scene.virtual_item_index(second), Some(11));

        let before = scene.clone();
        assert!(matches!(
            scene.commit(batch(
                2,
                vec![Mutation::ConfigureVirtualList {
                    node_id: list.raw(),
                    item_count: 1,
                    estimated_item_height: 24.0,
                    base_overscan_viewports: 1.0,
                    velocity_horizon_seconds: 0.25,
                    maximum_ahead_viewports: 4.0,
                }]
            )),
            Err(SceneError::InvalidVirtualItemIndex { .. })
        ));
        assert_eq!(scene.ids(), before.ids());
        assert_eq!(scene.virtual_list(list), before.virtual_list(list));

        assert!(matches!(
            scene.commit(batch(
                2,
                vec![Mutation::ConfigureVirtualList {
                    node_id: list.raw(),
                    item_count: MAX_VIRTUAL_ITEMS + 1,
                    estimated_item_height: 24.0,
                    base_overscan_viewports: 1.0,
                    velocity_horizon_seconds: 0.25,
                    maximum_ahead_viewports: 4.0,
                }]
            )),
            Err(SceneError::InvalidVirtualListConfig {
                field: "itemCount",
                ..
            })
        ));
        assert_eq!(scene.virtual_list(list), before.virtual_list(list));
    }

    #[test]
    fn structural_ordering_subtree_removal_and_frame_wrap_are_deterministic() {
        let root = id(0, 1);
        let first = id(1, 1);
        let second = id(2, 1);
        let nested = id(3, 1);
        let mut scene = Scene::new();
        scene
            .commit(batch(
                u32::MAX,
                vec![
                    create(root, NodeKind::Root, None),
                    create(first, NodeKind::Container, Some(root)),
                    create_before(second, NodeKind::Container, root, first),
                    create(nested, NodeKind::Text, Some(first)),
                ],
            ))
            .expect("ordered tree");
        assert_eq!(scene.ids(), &[root, second, first, nested]);
        assert_eq!(scene.first_child(root), Some(second));
        assert_eq!(scene.next_sibling(second), Some(first));

        scene
            .commit(batch(
                0,
                vec![Mutation::Reparent {
                    node_id: nested.raw(),
                    new_parent: root.raw(),
                    before_sibling: second.raw(),
                }],
            ))
            .expect("wrapping sequence and ordered reparent");
        assert_eq!(scene.ids(), &[root, nested, second, first]);
        assert_eq!(scene.depth(nested), Some(1));

        scene
            .commit(batch(
                1,
                vec![Mutation::RemoveNode {
                    node_id: second.raw(),
                }],
            ))
            .expect("subtree removal");
        assert_eq!(scene.ids(), &[root, nested, first]);
        assert_eq!(scene.resolve(second), None);
        scene.validate_invariants().expect("valid ordered tree");
    }

    #[test]
    fn structural_validation_rejects_each_invalid_identity_and_relation() {
        let root = id(0, 1);
        let child = id(1, 1);
        let other = id(2, 1);

        let mut scene = Scene::new();
        assert_eq!(
            scene.commit(batch(1, vec![create(id(1, 1), NodeKind::Root, None)])),
            Err(SceneError::SlotGap {
                index: 1,
                next_index: 0,
            })
        );

        let mut scene = Scene::new();
        assert_eq!(
            scene.commit(batch(1, vec![create(id(0, 2), NodeKind::Root, None)])),
            Err(SceneError::UnexpectedGeneration {
                index: 0,
                expected: 1,
                actual: 2,
            })
        );

        let mut scene = Scene::new();
        assert_eq!(
            scene.commit(batch(
                1,
                vec![
                    create(root, NodeKind::Root, None),
                    create(root, NodeKind::Root, None),
                ],
            )),
            Err(SceneError::DuplicateNode { node: root })
        );

        let mut scene = Scene::new();
        assert_eq!(
            scene.commit(batch(
                1,
                vec![Mutation::CreateNode {
                    node_id: root.raw(),
                    kind: NodeKind::Root,
                    parent: NULL_NODE_ID,
                    before_sibling: child.raw(),
                }],
            )),
            Err(SceneError::InvalidRoot { node: root })
        );

        let mut scene = Scene::new();
        assert_eq!(
            scene.commit(batch(
                1,
                vec![
                    create(root, NodeKind::Root, None),
                    create(child, NodeKind::Root, None),
                ],
            )),
            Err(SceneError::MultipleRoots)
        );

        let mut scene = Scene::new();
        assert_eq!(
            scene.commit(batch(1, vec![create(child, NodeKind::Container, None)],)),
            Err(SceneError::SlotGap {
                index: 1,
                next_index: 0,
            })
        );

        let mut scene = Scene::new();
        assert_eq!(
            scene.commit(batch(
                1,
                vec![
                    create(root, NodeKind::Root, None),
                    create(child, NodeKind::Container, Some(other)),
                ],
            )),
            Err(SceneError::MissingParent {
                node: child,
                parent: other,
            })
        );

        let (mut scene, root, child, other) = basic_scene();
        assert_eq!(
            scene.commit(batch(
                2,
                vec![create_before(id(3, 1), NodeKind::Container, root, id(9, 1),)],
            )),
            Err(SceneError::InvalidBeforeSibling { sibling: id(9, 1) })
        );
        assert_eq!(
            scene.commit(batch(
                3,
                vec![Mutation::Reparent {
                    node_id: root.raw(),
                    new_parent: child.raw(),
                    before_sibling: NULL_NODE_ID,
                }],
            )),
            Err(SceneError::ReparentRoot { node: root })
        );
        assert_eq!(
            scene.commit(batch(
                4,
                vec![Mutation::Reparent {
                    node_id: child.raw(),
                    new_parent: id(9, 1).raw(),
                    before_sibling: NULL_NODE_ID,
                }],
            )),
            Err(SceneError::MissingParent {
                node: child,
                parent: id(9, 1),
            })
        );
        assert_eq!(scene.parent(other), Some(root));

        scene
            .commit(batch(
                5,
                vec![Mutation::RemoveNode {
                    node_id: child.raw(),
                }],
            ))
            .expect("free child slot");
        assert_eq!(
            scene.commit(batch(
                6,
                vec![create(id(1, 3), NodeKind::Container, Some(root))],
            )),
            Err(SceneError::UnexpectedGeneration {
                index: 1,
                expected: 2,
                actual: 3,
            })
        );
    }

    #[test]
    fn non_structural_validation_covers_numeric_kinds_operations_and_sequence() {
        let root = id(0, 1);
        let scroll = id(1, 1);
        let text = id(2, 1);
        let mut scene = Scene::new();
        scene
            .commit(batch(
                10,
                vec![
                    define(10, ResourceKind::Utf8String, b"text".to_vec()),
                    define(11, ResourceKind::Paint, paint(0, 0, 0, 255)),
                    create(root, NodeKind::Root, None),
                    create(scroll, NodeKind::Scroll, Some(root)),
                    create(text, NodeKind::Text, Some(root)),
                ],
            ))
            .expect("fixture");

        assert_eq!(
            scene.commit(batch(10, vec![])),
            Err(SceneError::FrameSequenceNotNewer {
                previous: 10,
                incoming: 10,
            })
        );
        assert_eq!(
            scene.commit(batch(9, vec![])),
            Err(SceneError::FrameSequenceNotNewer {
                previous: 10,
                incoming: 9,
            })
        );
        assert_eq!(
            scene.commit(batch(
                11,
                vec![Mutation::SetVec4 {
                    node_id: root.raw(),
                    prop: Prop::Padding,
                    value: [0.0, f32::INFINITY, 0.0, 0.0],
                }],
            )),
            Err(SceneError::NonFiniteValue {
                node: root,
                field: "SetVec4.value",
            })
        );
        assert_eq!(
            scene.commit(batch(
                12,
                vec![Mutation::ScrollTo {
                    node_id: scroll.raw(),
                    x: 0.0,
                    y: f32::NEG_INFINITY,
                    behavior: 0,
                }],
            )),
            Err(SceneError::NonFiniteValue {
                node: scroll,
                field: "ScrollTo.position",
            })
        );
        assert_eq!(
            scene.commit(batch(
                13,
                vec![Mutation::SetTextRun {
                    node_id: root.raw(),
                    string_id: 10,
                    style_id: 11,
                }],
            )),
            Err(SceneError::UnsupportedNodeOperation {
                node: root,
                kind: NodeKind::Root,
                operation: "SetTextRun",
            })
        );
        assert_eq!(
            scene.commit(batch(
                14,
                vec![Mutation::ScrollTo {
                    node_id: text.raw(),
                    x: 0.0,
                    y: 0.0,
                    behavior: 0,
                }],
            )),
            Err(SceneError::UnsupportedNodeOperation {
                node: text,
                kind: NodeKind::Text,
                operation: "ScrollTo",
            })
        );
        assert_eq!(
            scene.commit(batch(
                15,
                vec![Mutation::SetRef {
                    node_id: root.raw(),
                    prop: Prop::Color,
                    resource_id: 10,
                }],
            )),
            Err(SceneError::WrongResourceKind {
                resource_id: 10,
                expected: ResourceKind::Paint,
                actual: ResourceKind::Utf8String,
            })
        );
    }

    #[test]
    fn resource_validation_rejects_malformed_and_inconsistent_graphs() {
        let reject = |kind, bytes, expected| {
            let mut scene = Scene::new();
            assert_eq!(
                scene.commit(batch(1, vec![define(10, kind, bytes)])),
                Err(expected)
            );
            assert!(scene.resources.is_empty());
        };

        reject(
            ResourceKind::Utf8String,
            vec![0xff],
            SceneError::InvalidUtf8Resource { resource_id: 10 },
        );
        reject(
            ResourceKind::Paint,
            vec![0; 7],
            SceneError::InvalidResourceEncoding { resource_id: 10 },
        );
        let mut invalid_paint = paint(1, 2, 3, 4);
        invalid_paint[0] = RESOURCE_ENCODING_VERSION + 1;
        reject(
            ResourceKind::Paint,
            invalid_paint,
            SceneError::InvalidResourceEncoding { resource_id: 10 },
        );
        let mut invalid_paint = paint(1, 2, 3, 4);
        invalid_paint[1] = SOLID_PAINT_RESOURCE_VARIANT + 1;
        reject(
            ResourceKind::Paint,
            invalid_paint,
            SceneError::InvalidResourceEncoding { resource_id: 10 },
        );
        let mut invalid_paint = paint(1, 2, 3, 4);
        invalid_paint[2] = 1;
        reject(
            ResourceKind::Paint,
            invalid_paint,
            SceneError::InvalidResourceEncoding { resource_id: 10 },
        );
        let mut invalid_affine = affine([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        invalid_affine[AFFINE_A_OFFSET..AFFINE_A_OFFSET + 4]
            .copy_from_slice(&f32::NAN.to_le_bytes());
        reject(
            ResourceKind::Affine,
            invalid_affine,
            SceneError::InvalidResourceEncoding { resource_id: 10 },
        );

        let style_cases = [
            vec![0; TEXT_STYLE_RESOURCE_MINIMUM_BYTES - 1],
            vec![0; TEXT_STYLE_RESOURCE_MINIMUM_BYTES + 1],
            {
                let mut bytes = text_style(1, b"sans");
                bytes[TEXT_STYLE_WEIGHT_OFFSET + 2] = 1;
                bytes
            },
            {
                let mut bytes = text_style(1, b"sans");
                bytes[TEXT_STYLE_FONT_SIZE_OFFSET..TEXT_STYLE_FONT_SIZE_OFFSET + 4]
                    .copy_from_slice(&0.0_f32.to_le_bytes());
                bytes
            },
            {
                let mut bytes = text_style(1, b"sans");
                bytes[TEXT_STYLE_LINE_HEIGHT_OFFSET..TEXT_STYLE_LINE_HEIGHT_OFFSET + 4]
                    .copy_from_slice(&f32::NAN.to_le_bytes());
                bytes
            },
            {
                let mut bytes = text_style(1, b"sans");
                bytes[TEXT_STYLE_WEIGHT_OFFSET..TEXT_STYLE_WEIGHT_OFFSET + 2]
                    .copy_from_slice(&0_u16.to_le_bytes());
                bytes
            },
            {
                let mut bytes = text_style(1, b"sans");
                bytes[TEXT_STYLE_FAMILY_BYTES_OFFSET..TEXT_STYLE_FAMILY_BYTES_OFFSET + 4]
                    .copy_from_slice(&u32::MAX.to_le_bytes());
                bytes
            },
            {
                let mut bytes = text_style(1, b"a");
                *bytes.last_mut().expect("padding") = 1;
                bytes
            },
            text_style(1, b""),
            text_style(1, &[0xff]),
        ];
        for bytes in style_cases {
            reject(
                ResourceKind::TextStyle,
                bytes,
                SceneError::InvalidResourceEncoding { resource_id: 10 },
            );
        }

        let mut scene = Scene::new();
        assert_eq!(
            scene.commit(batch(
                1,
                vec![
                    define(10, ResourceKind::Paint, paint(1, 2, 3, 4)),
                    define(10, ResourceKind::Paint, paint(5, 6, 7, 8)),
                ],
            )),
            Err(SceneError::DuplicateResource { resource_id: 10 })
        );
        scene
            .commit(batch(
                2,
                vec![define(10, ResourceKind::Paint, paint(1, 2, 3, 4))],
            ))
            .expect("paint");
        assert_eq!(
            scene.commit(batch(
                3,
                vec![define(10, ResourceKind::Paint, paint(5, 6, 7, 8))],
            )),
            Err(SceneError::DuplicateResource { resource_id: 10 })
        );

        let mut scene = Scene::new();
        assert_eq!(
            scene.commit(batch(
                1,
                vec![define(11, ResourceKind::TextStyle, text_style(99, b"sans"),)],
            )),
            Err(SceneError::MissingResource { resource_id: 99 })
        );
        assert_eq!(
            scene.commit(batch(
                2,
                vec![
                    define(10, ResourceKind::Utf8String, b"not paint".to_vec()),
                    define(11, ResourceKind::TextStyle, text_style(10, b"sans")),
                ],
            )),
            Err(SceneError::WrongResourceKind {
                resource_id: 10,
                expected: ResourceKind::Paint,
                actual: ResourceKind::Utf8String,
            })
        );
        assert_eq!(
            scene.commit(batch(
                3,
                vec![define(10, ResourceKind::TextStyle, text_style(10, b"sans"))],
            )),
            Err(SceneError::WrongResourceKind {
                resource_id: 10,
                expected: ResourceKind::Paint,
                actual: ResourceKind::TextStyle,
            })
        );
    }

    #[test]
    fn resource_release_checks_duplicates_missing_direct_and_transitive_use() {
        let root = id(0, 1);
        let text = id(1, 1);
        let mut scene = Scene::new();
        scene
            .commit(batch(
                1,
                vec![
                    define(10, ResourceKind::Paint, paint(1, 2, 3, 255)),
                    define(11, ResourceKind::Utf8String, b"hello".to_vec()),
                    define(12, ResourceKind::TextStyle, text_style(10, b"sans")),
                    create(root, NodeKind::Root, None),
                    create(text, NodeKind::Text, Some(root)),
                    Mutation::SetTextRun {
                        node_id: text.raw(),
                        string_id: 11,
                        style_id: 12,
                    },
                ],
            ))
            .expect("resource graph");

        assert_eq!(
            scene.commit(batch(
                2,
                vec![
                    Mutation::ReleaseResource { resource_id: 10 },
                    Mutation::ReleaseResource { resource_id: 10 },
                ],
            )),
            Err(SceneError::DuplicateResourceRelease { resource_id: 10 })
        );
        assert_eq!(
            scene.commit(batch(
                3,
                vec![Mutation::ReleaseResource { resource_id: 99 }],
            )),
            Err(SceneError::MissingResource { resource_id: 99 })
        );
        assert_eq!(
            scene.commit(batch(
                4,
                vec![Mutation::ReleaseResource { resource_id: 11 }],
            )),
            Err(SceneError::ResourceInUse { resource_id: 11 })
        );
        assert_eq!(
            scene.commit(batch(
                5,
                vec![Mutation::ReleaseResource { resource_id: 12 }],
            )),
            Err(SceneError::ResourceInUse { resource_id: 12 })
        );
        assert_eq!(
            scene.commit(batch(
                6,
                vec![Mutation::ReleaseResource { resource_id: 10 }],
            )),
            Err(SceneError::MissingResource { resource_id: 10 })
        );

        scene
            .commit(batch(
                7,
                vec![
                    Mutation::RemoveNode {
                        node_id: text.raw(),
                    },
                    Mutation::ReleaseResource { resource_id: 11 },
                    Mutation::ReleaseResource { resource_id: 12 },
                    Mutation::ReleaseResource { resource_id: 10 },
                ],
            ))
            .expect("structural release path");
        assert_eq!(scene.resource(10), None);
        assert_eq!(scene.resource(11), None);
        assert_eq!(scene.resource(12), None);
    }

    #[test]
    fn invariant_diagnostics_detect_corruption_in_every_storage_family() {
        let (scene, root, left, right) = basic_scene();

        let mut broken = scene.clone();
        broken.parents.pop();
        assert_invariant(&broken, "SoA lane length mismatch");

        let mut broken = scene.clone();
        broken.dirty_layout.insert(scene.len());
        assert_invariant(&broken, "dirty bitmap length mismatch");

        let mut broken = scene.clone();
        broken.props.f32.insert(Prop::Width, vec![None]);
        assert_invariant(&broken, "property lane length mismatch");

        let mut broken = scene.clone();
        broken.slots[1].generation += 1;
        assert_invariant(&broken, "slot does not resolve topology index");

        let mut broken = scene.clone();
        broken.parents[1] = Some(id(9, 1));
        assert_invariant(&broken, "parent is stale");

        let mut broken = scene.clone();
        broken.next_siblings[1] = None;
        broken.parents[2] = Some(left);
        broken.depths[2] = 2;
        broken.first_children[1] = Some(right);
        broken.kinds[1] = NodeKind::Text;
        assert_invariant(&broken, "leaf node cannot own children");

        let mut broken = scene.clone();
        broken.depths[1] = 3;
        assert_invariant(&broken, "topology order or depth is invalid");

        let mut broken = scene.clone();
        broken.next_siblings[1] = None;
        assert_invariant(&broken, "next sibling lane is invalid");

        let mut broken = scene.clone();
        broken.first_children[0] = Some(right);
        assert_invariant(&broken, "first child lane is invalid");

        let mut broken = scene.clone();
        broken.parents[0] = Some(left);
        assert_invariant(&broken, "topology order or depth is invalid");

        let mut broken = scene.clone();
        broken.kinds[0] = NodeKind::Container;
        assert_invariant(&broken, "invalid root lane");

        let mut broken = scene.clone();
        broken.parents[2] = None;
        broken.depths[2] = 0;
        broken.kinds[2] = NodeKind::Root;
        broken.next_siblings[1] = None;
        assert_invariant(&broken, "Scene must have exactly one root");

        let mut broken = scene.clone();
        broken.next_siblings[2] = Some(left);
        assert_invariant(&broken, "last sibling must terminate the chain");

        let mut broken = scene.clone();
        broken.first_children[1] = Some(right);
        assert_invariant(&broken, "first child does not reference its parent");

        let mut broken = scene.clone();
        broken.first_children[0] = None;
        assert_invariant(&broken, "first child lane is invalid");

        let mut broken = scene.clone();
        broken.next_siblings[1] = Some(id(9, 1));
        assert_invariant(&broken, "next sibling lane is invalid");

        let mut broken = scene.clone();
        broken.next_siblings[1] = Some(left);
        assert_invariant(&broken, "next sibling lane is invalid");

        let mut broken = scene.clone();
        broken.slots.push(Slot {
            generation: 1,
            active_index: Some(0),
            retired: false,
        });
        assert_invariant(&broken, "active slot count mismatch");

        let mut broken = scene.clone();
        broken.slots[2].generation = 0;
        assert_invariant(&broken, "slot does not resolve topology index");

        let mut broken = scene.clone();
        broken.slots.push(Slot {
            generation: 1,
            active_index: None,
            retired: true,
        });
        assert_invariant(&broken, "slot generation state is invalid");

        let mut broken = scene.clone();
        broken.slots[2].active_index = Some(99);
        assert_invariant(&broken, "slot does not resolve topology index");

        let mut broken = scene.clone();
        broken.ids[2] = id(3, 1);
        assert_invariant(&broken, "slot does not resolve topology index");

        assert_eq!(scene.resolve(root), Some(0));
    }

    #[test]
    fn resource_size_is_bounded_before_interning() {
        let mut scene = Scene::new();
        let oversized = vec![0; MAX_RESOURCE_BYTES + 1];
        assert_eq!(
            scene.commit(batch(1, vec![define(10, ResourceKind::Image, oversized)],)),
            Err(SceneError::ResourceTooLarge {
                resource_id: 10,
                actual: MAX_RESOURCE_BYTES + 1,
                maximum: MAX_RESOURCE_BYTES,
            })
        );
    }

    #[test]
    fn compacts_once_and_keeps_parent_before_children() {
        let root = id(0, 1);
        let left = id(1, 1);
        let right = id(2, 1);
        let leaf = id(3, 1);
        let mut scene = Scene::new();
        scene
            .commit(batch(
                1,
                vec![
                    create(root, NodeKind::Root, None),
                    create(left, NodeKind::Container, Some(root)),
                    create(right, NodeKind::Container, Some(root)),
                    create(leaf, NodeKind::Text, Some(left)),
                    Mutation::Reparent {
                        node_id: leaf.raw(),
                        new_parent: right.raw(),
                        before_sibling: NULL_NODE_ID,
                    },
                ],
            ))
            .expect("valid structural commit");
        assert_eq!(scene.ids(), &[root, left, right, leaf]);
        assert_eq!(scene.parent(leaf), Some(right));
        assert_eq!(scene.metrics().topology_compactions, 1);
        scene.validate_invariants().expect("valid scene");
    }

    #[test]
    fn rejects_stale_generation_transactionally() {
        let root = id(0, 1);
        let child = id(1, 1);
        let replacement = id(1, 2);
        let mut scene = Scene::new();
        scene
            .commit(batch(
                1,
                vec![
                    create(root, NodeKind::Root, None),
                    create(child, NodeKind::Text, Some(root)),
                ],
            ))
            .expect("initial scene");
        scene
            .commit(batch(
                2,
                vec![
                    Mutation::RemoveNode {
                        node_id: child.raw(),
                    },
                    create(replacement, NodeKind::Text, Some(root)),
                ],
            ))
            .expect("valid reuse");
        let before = scene.clone();
        assert_eq!(
            scene.commit(batch(
                3,
                vec![Mutation::SetF32 {
                    node_id: child.raw(),
                    prop: Prop::Width,
                    value: 10.0,
                }],
            )),
            Err(SceneError::StaleNode { node: child })
        );
        let mut expected = before;
        expected.metrics.rejected_transactions += 1;
        assert_eq!(scene, expected);
    }

    #[test]
    fn prop_only_commit_does_not_compact_and_marks_generated_domains() {
        let root = id(0, 1);
        let mut scene = Scene::new();
        scene
            .commit(batch(1, vec![create(root, NodeKind::Root, None)]))
            .expect("root");
        scene.clear_dirty();
        scene
            .commit(batch(
                2,
                vec![
                    Mutation::SetF32 {
                        node_id: root.raw(),
                        prop: Prop::Width,
                        value: 100.0,
                    },
                    Mutation::SetRef {
                        node_id: root.raw(),
                        prop: Prop::OnTap,
                        resource_id: 55,
                    },
                ],
            ))
            .expect("props");
        assert_eq!(scene.metrics().topology_compactions, 1);
        assert!(scene.dirty(DirtyDomain::Layout).contains(0));
        assert!(scene.dirty(DirtyDomain::Paint).contains(0));
        assert!(!scene.dirty(DirtyDomain::Hit).contains(0));
        assert_eq!(scene.f32_prop(root, Prop::Width), Some(100.0));
    }

    #[test]
    fn rejects_missing_typed_resource_without_partial_prop_change() {
        let root = id(0, 1);
        let mut scene = Scene::new();
        scene
            .commit(batch(1, vec![create(root, NodeKind::Root, None)]))
            .expect("root");
        assert_eq!(
            scene.commit(batch(
                2,
                vec![Mutation::SetRef {
                    node_id: root.raw(),
                    prop: Prop::Color,
                    resource_id: 99,
                }],
            )),
            Err(SceneError::MissingResource { resource_id: 99 })
        );
        assert_eq!(scene.ref_prop(root, Prop::Color), None);
    }

    #[test]
    fn rejects_wrong_prop_lane_even_when_called_without_the_wire_decoder() {
        let root = id(0, 1);
        let mut scene = Scene::new();
        scene
            .commit(batch(1, vec![create(root, NodeKind::Root, None)]))
            .expect("root");
        let before = scene.clone();
        assert_eq!(
            scene.commit(batch(
                2,
                vec![Mutation::SetF32 {
                    node_id: root.raw(),
                    prop: Prop::Color,
                    value: 1.0,
                }],
            )),
            Err(SceneError::WrongPropValueType {
                prop: Prop::Color,
                expected: PropValueType::Ref,
                actual: PropValueType::F32,
            })
        );
        let mut expected = before;
        expected.metrics.rejected_transactions += 1;
        assert_eq!(scene, expected);
    }

    #[test]
    fn rejects_non_finite_direct_mutations_transactionally() {
        let root = id(0, 1);
        let mut scene = Scene::new();
        scene
            .commit(batch(1, vec![create(root, NodeKind::Root, None)]))
            .expect("root");
        let before = scene.clone();
        assert_eq!(
            scene.commit(batch(
                2,
                vec![Mutation::SetF32 {
                    node_id: root.raw(),
                    prop: Prop::Width,
                    value: f32::NAN,
                }],
            )),
            Err(SceneError::NonFiniteValue {
                node: root,
                field: "SetF32.value",
            })
        );
        let mut expected = before;
        expected.metrics.rejected_transactions += 1;
        assert_eq!(scene, expected);
    }

    #[test]
    fn leaf_nodes_cannot_become_structural_parents() {
        let root = id(0, 1);
        let text = id(1, 1);
        let illegal_child = id(2, 1);
        let mut scene = Scene::new();
        scene
            .commit(batch(
                1,
                vec![
                    create(root, NodeKind::Root, None),
                    create(text, NodeKind::Text, Some(root)),
                ],
            ))
            .expect("initial scene");
        let before = scene.clone();
        assert_eq!(
            scene.commit(batch(
                2,
                vec![create(illegal_child, NodeKind::Container, Some(text),)],
            )),
            Err(SceneError::InvalidParentKind {
                node: illegal_child,
                parent: text,
                actual: NodeKind::Text,
            })
        );
        let mut expected = before;
        expected.metrics.rejected_transactions += 1;
        assert_eq!(scene, expected);
    }

    #[test]
    fn clear_prop_and_release_resource_commit_atomically() {
        let root = id(0, 1);
        let mut scene = Scene::new();
        scene
            .commit(batch(
                1,
                vec![
                    Mutation::DefineResource {
                        resource_id: 10,
                        kind: ResourceKind::Paint,
                        bytes: vec![1, 1, 0, 0, 1, 2, 3, 255],
                    },
                    create(root, NodeKind::Root, None),
                    Mutation::SetRef {
                        node_id: root.raw(),
                        prop: Prop::BackgroundColor,
                        resource_id: 10,
                    },
                ],
            ))
            .expect("initial scene");
        scene.clear_dirty();
        let compactions = scene.metrics().topology_compactions;
        scene
            .commit(batch(
                2,
                vec![
                    Mutation::ClearProp {
                        node_id: root.raw(),
                        prop: Prop::BackgroundColor,
                    },
                    Mutation::ReleaseResource { resource_id: 10 },
                ],
            ))
            .expect("clear and release");
        assert_eq!(scene.ref_prop(root, Prop::BackgroundColor), None);
        assert_eq!(scene.resource(10), None);
        assert!(scene.dirty(DirtyDomain::Paint).contains(0));
        assert_eq!(scene.metrics().topology_compactions, compactions);
    }

    #[test]
    fn referenced_resource_release_is_rejected_without_partial_changes() {
        let root = id(0, 1);
        let mut scene = Scene::new();
        scene
            .commit(batch(
                1,
                vec![
                    Mutation::DefineResource {
                        resource_id: 10,
                        kind: ResourceKind::Paint,
                        bytes: vec![1, 1, 0, 0, 1, 2, 3, 255],
                    },
                    create(root, NodeKind::Root, None),
                    Mutation::SetRef {
                        node_id: root.raw(),
                        prop: Prop::BackgroundColor,
                        resource_id: 10,
                    },
                ],
            ))
            .expect("initial scene");
        let before = scene.clone();
        assert_eq!(
            scene.commit(batch(
                2,
                vec![Mutation::ReleaseResource { resource_id: 10 }],
            )),
            Err(SceneError::ResourceInUse { resource_id: 10 })
        );
        let mut expected = before;
        expected.metrics.rejected_transactions += 1;
        assert_eq!(scene, expected);
    }

    #[test]
    fn portable_resource_payloads_are_validated_at_scene_boundary() {
        let mut scene = Scene::new();
        assert_eq!(
            scene.commit(batch(
                1,
                vec![Mutation::DefineResource {
                    resource_id: 10,
                    kind: ResourceKind::Paint,
                    bytes: vec![1, 1, 1, 0, 1, 2, 3, 255],
                }],
            )),
            Err(SceneError::InvalidResourceEncoding { resource_id: 10 })
        );
        assert_eq!(scene.resource(10), None);
    }

    #[test]
    fn late_structural_failure_does_not_apply_earlier_mutations() {
        let root = id(0, 1);
        let parent = id(1, 1);
        let child = id(2, 1);
        let mut scene = Scene::new();
        scene
            .commit(batch(
                1,
                vec![
                    create(root, NodeKind::Root, None),
                    create(parent, NodeKind::Container, Some(root)),
                    create(child, NodeKind::Container, Some(parent)),
                ],
            ))
            .expect("initial scene");
        scene.clear_dirty();
        let before = scene.clone();
        assert_eq!(
            scene.commit(batch(
                2,
                vec![
                    Mutation::SetF32 {
                        node_id: parent.raw(),
                        prop: Prop::Width,
                        value: 200.0,
                    },
                    Mutation::Reparent {
                        node_id: parent.raw(),
                        new_parent: child.raw(),
                        before_sibling: NULL_NODE_ID,
                    },
                ],
            )),
            Err(SceneError::Cycle {
                node: parent,
                parent: child,
            })
        );
        let mut expected = before;
        expected.metrics.rejected_transactions += 1;
        assert_eq!(scene, expected);
    }

    #[test]
    fn a_max_generation_slot_retires_instead_of_wrapping() {
        let root = id(0, 1);
        let child = id(1, 1);
        let max_child = id(1, MAX_GENERATION);
        let mut scene = Scene::new();
        scene
            .commit(batch(
                1,
                vec![
                    create(root, NodeKind::Root, None),
                    create(child, NodeKind::Text, Some(root)),
                ],
            ))
            .expect("initial scene");

        // Put the otherwise-valid Scene at the generation boundary without
        // spending thousands of structural commits in this focused test.
        scene.ids[1] = max_child;
        scene.first_children[0] = Some(max_child);
        scene.slots[1].generation = MAX_GENERATION;
        scene.validate_invariants().expect("boundary scene");

        scene
            .commit(batch(
                2,
                vec![Mutation::RemoveNode {
                    node_id: max_child.raw(),
                }],
            ))
            .expect("remove last generation");
        assert!(scene.slots[1].retired);
        assert_eq!(
            scene.commit(batch(
                3,
                vec![create(max_child, NodeKind::Text, Some(root))],
            )),
            Err(SceneError::RetiredSlot { index: 1 })
        );
    }

    proptest! {
        #[test]
        fn arbitrary_transactions_preserve_invariants(
            operations in prop::collection::vec((any::<u8>(), any::<u32>(), any::<u32>()), 0..100),
        ) {
            let root = id(0, 1);
            let mut scene = Scene::new();
            scene.commit(batch(1, vec![create(root, NodeKind::Root, None)])).expect("root");
            let mut frame = 2_u32;
            for (tag, first, second) in operations {
                let mutation = match tag % 4 {
                    0 => Mutation::SetF32 {
                        node_id: first,
                        prop: Prop::Width,
                        value: (second % 10_000) as f32,
                    },
                    1 => Mutation::RemoveNode { node_id: first },
                    2 => Mutation::Reparent {
                        node_id: first,
                        new_parent: second,
                        before_sibling: NULL_NODE_ID,
                    },
                    _ => Mutation::SetFlags {
                        node_id: first,
                        set: second & 0x55aa_55aa,
                        clear: second & 0xaa55_aa55,
                    },
                };
                let before = scene.clone();
                let result = scene.commit(batch(frame, vec![mutation]));
                if result.is_err() {
                    let mut expected = before;
                    expected.metrics.rejected_transactions += 1;
                    prop_assert_eq!(&scene, &expected);
                }
                prop_assert!(scene.validate_invariants().is_ok());
                frame = frame.wrapping_add(1);
            }
        }

        #[test]
        fn valid_create_remove_sequences_keep_slot_generations_consistent(
            operations in prop::collection::vec((any::<bool>(), any::<u8>(), any::<u16>()), 0..100),
        ) {
            let root = id(0, 1);
            let mut scene = Scene::new();
            scene.commit(batch(1, vec![create(root, NodeKind::Root, None)])).expect("root");
            let mut generations: Vec<Option<u16>> = Vec::new();
            let mut frame = 2_u32;

            for (wants_create, selector, width) in operations {
                let active: Vec<_> = generations
                    .iter()
                    .enumerate()
                    .filter_map(|(index, generation)| generation.map(|value| (index, value)))
                    .collect();
                let inactive: Vec<_> = generations
                    .iter()
                    .enumerate()
                    .filter_map(|(index, generation)| generation.is_none().then_some(index))
                    .collect();

                let mutation = if wants_create && (!inactive.is_empty() || generations.len() < 8) {
                    let slot = if inactive.is_empty() || usize::from(selector) % (inactive.len() + 1) == inactive.len() {
                        let slot = generations.len();
                        generations.push(Some(1));
                        slot
                    } else {
                        let slot = inactive[usize::from(selector) % inactive.len()];
                        let previous = scene.slots[slot + 1].generation;
                        generations[slot] = Some(previous + 1);
                        slot
                    };
                    let node = id((slot + 1) as u32, generations[slot].expect("active generation"));
                    create(node, NodeKind::Container, Some(root))
                } else if !active.is_empty() {
                    let (slot, generation) = active[usize::from(selector) % active.len()];
                    generations[slot] = None;
                    Mutation::RemoveNode {
                        node_id: id((slot + 1) as u32, generation).raw(),
                    }
                } else {
                    Mutation::SetF32 {
                        node_id: root.raw(),
                        prop: Prop::Width,
                        value: f32::from(width),
                    }
                };

                scene.commit(batch(frame, vec![mutation])).expect("model-generated valid commit");
                prop_assert!(scene.validate_invariants().is_ok());
                for (slot, generation) in generations.iter().enumerate() {
                    if let Some(generation) = generation {
                        prop_assert!(scene.resolve(id((slot + 1) as u32, *generation)).is_some());
                    }
                }
                prop_assert_eq!(scene.len(), 1 + generations.iter().filter(|entry| entry.is_some()).count());
                frame = frame.wrapping_add(1);
            }
        }
    }
}
