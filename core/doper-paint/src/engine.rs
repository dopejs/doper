use std::sync::Arc;

use doper_abi::{DisplayCommand, DisplayInstruction, DisplayList, NodeKind, Prop, ResourceKind};
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
}

/// Result of one paint decision.
#[derive(Clone, Debug)]
pub struct PaintOutcome {
    /// Active immutable Picture.
    pub picture: Picture,
    /// Whether the DisplayList was rebuilt.
    pub rebuilt: bool,
}

/// Deterministic Scene/Layout-to-DisplayList builder.
#[derive(Default)]
pub struct PaintEngine {
    current: Option<Picture>,
    topology: Vec<NodeId>,
    metrics: PaintMetrics,
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
        if scene.ids() != layout.ids() {
            return Err(PaintError::LayoutTopologyMismatch);
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

        let display_list = build_display_list(scene, layout)?;
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
        self.topology.clear();
        self.topology.extend_from_slice(scene.ids());
        self.metrics.builds += 1;
        self.metrics.last_command_count = command_count;
        Ok(PaintOutcome {
            picture,
            rebuilt: true,
        })
    }
}

fn build_display_list(scene: &Scene, layout: &LayoutSnapshot) -> Result<DisplayList, PaintError> {
    let mut instructions = Vec::with_capacity(scene.len().saturating_mul(5));
    let mut open_nodes = 0_usize;
    for (index, node) in scene.ids().iter().copied().enumerate() {
        let depth = usize::from(
            scene
                .depth(node)
                .ok_or(PaintError::MissingGeometry { node })?,
        );
        while open_nodes > depth {
            push(&mut instructions, DisplayCommand::Restore);
            open_nodes -= 1;
        }
        let (offset, size) = layout
            .geometry_at(index)
            .ok_or(PaintError::MissingGeometry { node })?;
        push(&mut instructions, DisplayCommand::Save);
        open_nodes += 1;
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
        if scene.kind(node) == Some(NodeKind::Scroll) {
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
        if let Some(text_run) = scene.text_run(node) {
            typed_resource(scene, text_run.string_id, ResourceKind::Utf8String)?;
            let style_resource = typed_resource(scene, text_run.style_id, ResourceKind::TextStyle)?;
            let style = TextStyleResource::decode(text_run.style_id, style_resource)?;
            let paint_resource = typed_resource(scene, style.paint_id, ResourceKind::Paint)?;
            SolidPaint::decode(style.paint_id, paint_resource)?;
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
    while open_nodes != 0 {
        push(&mut instructions, DisplayCommand::Restore);
        open_nodes -= 1;
    }
    Ok(DisplayList { instructions })
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
