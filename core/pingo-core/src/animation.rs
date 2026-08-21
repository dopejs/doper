use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use pingo_abi::{ComputedStyleValue, StyleLengthUnit, StyleProperty, StyleTransformOperation};
use pingo_anim::{
    AnimatedProperty, AnimationError, Playback, PresentationValue, Transition,
    TransitionDeclaration, sample,
};
use pingo_layout::LayoutSnapshot;
use pingo_paint::AffineResource;
use pingo_scene::{NodeId, Scene};

use crate::CoreError;

// Architecture-independent logical bookkeeping sizes. Diagnostics must be
// byte-exact between wasm32 and native; allocator/node overhead is deliberately
// represented by stable logical cost coefficients instead of `size_of`. This
// is an operational trend/budget signal, not an allocator heap measurement.
const RESOURCE_BINDING_BYTES: usize = 8;
const DURABLE_ENTRY_BYTES: usize = 40;
const TRANSITION_ENTRY_BYTES: usize = 104;
const KEYFRAME_STATE_BYTES: usize = 48;

/// Cumulative bounded animation work diagnostics.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct AnimationMetrics {
    pub(crate) active: u64,
    pub(crate) phase_before: u64,
    pub(crate) phase_active: u64,
    pub(crate) phase_after: u64,
    pub(crate) started: u64,
    pub(crate) retargeted: u64,
    pub(crate) cancelled: u64,
    pub(crate) sampled_frames: u64,
    pub(crate) presentation_changes: u64,
    pub(crate) layout_nodes: u64,
    pub(crate) retained_bytes: u64,
}

#[derive(Clone, Debug)]
struct ActiveKeyframes {
    resource: Arc<pingo_anim::AnimationResource>,
    declaration_index: usize,
    playback: Playback,
    phase: pingo_anim::Phase,
    frozen: bool,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct AnimationController {
    logical_micros: u64,
    resource_ids: BTreeMap<NodeId, u32>,
    durable: BTreeMap<(NodeId, u8), PresentationValue>,
    transitions: BTreeMap<(NodeId, u8), Transition>,
    keyframes: BTreeMap<(NodeId, u8), ActiveKeyframes>,
    reduced_motion: bool,
    metrics: AnimationMetrics,
}

impl AnimationController {
    pub(crate) fn begin_frame(&mut self) {
        self.metrics.presentation_changes = 0;
        self.metrics.layout_nodes = 0;
    }

    pub(crate) fn synchronize(
        &mut self,
        scene: &mut Scene,
        layout: &LayoutSnapshot,
    ) -> Result<bool, CoreError> {
        let live = scene.ids().to_vec();
        let mut configured = BTreeMap::new();
        let mut changed = false;
        for node in live {
            if scene.excluded_by_display(node) {
                changed |= self.remove_node(scene, node);
                continue;
            }
            let Some(resource_id) = scene.ref_prop(node, pingo_abi::Prop::Animation) else {
                changed |= self.remove_node(scene, node);
                continue;
            };
            let resource = scene
                .animation_resource(node)
                .ok_or(AnimationError::InvalidValue)?;
            configured.insert(node, resource_id);
            let restarted = self.resource_ids.get(&node) != Some(&resource_id);
            if restarted {
                self.resource_ids.insert(node, resource_id);
                changed |= self.reconcile_keyframes(scene, node, &resource);
            }
            for property in [AnimatedProperty::Opacity, AnimatedProperty::Transform] {
                let key = (node, property_key(property));
                let target = durable_value(scene, layout, node, property)?;
                let previous = self.durable.insert(key, target);
                if restarted || previous.is_none() || previous == Some(target) {
                    continue;
                }
                if self.keyframes.contains_key(&key) {
                    continue;
                }
                if let Some(declaration) = transition_for(&resource.transitions, property) {
                    let next = if let Some(active) = self.transitions.get(&key).copied() {
                        self.metrics.retargeted = self.metrics.retargeted.saturating_add(1);
                        active.retarget(target, self.logical_micros, self.reduced_motion)?
                    } else {
                        Transition {
                            from: previous.unwrap_or(target),
                            to: target,
                            started_at_micros: self.logical_micros,
                            delay_micros: declaration.delay_micros,
                            duration_micros: declaration.duration_micros,
                            easing: declaration.easing,
                        }
                    };
                    self.transitions.insert(key, next);
                    self.metrics.started = self.metrics.started.saturating_add(1);
                } else if self.transitions.remove(&key).is_some() {
                    let presentation_changed = scene
                        .clear_presentation_style(node, style_property(property))
                        == Some(true);
                    changed |= presentation_changed;
                    self.record_presentation_change(presentation_changed);
                    self.metrics.cancelled = self.metrics.cancelled.saturating_add(1);
                }
            }
        }
        let stale = self
            .resource_ids
            .keys()
            .copied()
            .filter(|node| !configured.contains_key(node))
            .collect::<Vec<_>>();
        for node in stale {
            changed |= self.remove_node(scene, node);
        }
        self.update_retained_bytes(scene);
        Ok(changed)
    }

    pub(crate) fn advance(
        &mut self,
        scene: &mut Scene,
        elapsed_seconds: f64,
    ) -> Result<(bool, bool), CoreError> {
        if !elapsed_seconds.is_finite() || elapsed_seconds < 0.0 {
            return Err(CoreError::InvalidFrameDelta(elapsed_seconds));
        }
        let duration = std::time::Duration::try_from_secs_f64(elapsed_seconds)
            .map_err(|_| CoreError::InvalidFrameDelta(elapsed_seconds))?;
        let delta = u64::try_from(duration.as_micros())
            .map_err(|_| CoreError::InvalidFrameDelta(elapsed_seconds))?;
        self.logical_micros = self.logical_micros.saturating_add(delta);
        let mut changed = false;
        let mut active = false;
        let mut active_count = 0_u64;
        self.metrics.phase_before = 0;
        self.metrics.phase_active = 0;
        self.metrics.phase_after = 0;
        let transition_keys = self.transitions.keys().copied().collect::<Vec<_>>();
        for key @ (node, property) in transition_keys {
            let transition = self.transitions[&key];
            self.record_phase(transition_phase(
                transition,
                self.logical_micros,
                self.reduced_motion,
            ));
            let (value, owes_frame) =
                transition.sample(self.logical_micros, self.reduced_motion)?;
            let presentation_changed = set_presentation(scene, node, property, value)?;
            changed |= presentation_changed;
            self.record_presentation_change(presentation_changed);
            active |= owes_frame;
            active_count = active_count.saturating_add(u64::from(owes_frame));
            if !owes_frame {
                self.transitions.remove(&key);
                let presentation_changed = scene
                    .clear_presentation_style(node, style_property_from_key(property))
                    == Some(true);
                changed |= presentation_changed;
                self.record_presentation_change(presentation_changed);
            }
        }
        let keyframe_keys = self.keyframes.keys().copied().collect::<Vec<_>>();
        for key @ (node, property) in keyframe_keys {
            let frozen_phase = self.keyframes[&key]
                .frozen
                .then_some(self.keyframes[&key].phase);
            if let Some(phase) = frozen_phase {
                self.record_phase(phase);
                continue;
            }
            let (sampled, value) = {
                let state = self
                    .keyframes
                    .get_mut(&key)
                    .expect("key was collected from the animation map");
                let declaration = &state.resource.animations[state.declaration_index];
                let sampled = sample(
                    declaration.timing,
                    state.playback,
                    self.logical_micros,
                    self.reduced_motion,
                )?;
                let value = sampled
                    .progress
                    .map(|progress| declaration.track.value_at(progress))
                    .transpose()?;
                state.phase = sampled.phase;
                state.frozen = !sampled.active;
                (sampled, value)
            };
            self.record_phase(sampled.phase);
            active |= sampled.active;
            active_count = active_count.saturating_add(u64::from(sampled.active));
            if let Some(value) = value {
                let presentation_changed = set_presentation(scene, node, property, value)?;
                changed |= presentation_changed;
                self.record_presentation_change(presentation_changed);
            } else {
                let presentation_changed = scene
                    .clear_presentation_style(node, style_property_from_key(property))
                    == Some(true);
                changed |= presentation_changed;
                self.record_presentation_change(presentation_changed);
            }
        }
        if changed {
            self.metrics.sampled_frames = self.metrics.sampled_frames.saturating_add(1);
        }
        self.metrics.active = active_count;
        self.update_retained_bytes(scene);
        Ok((changed, active))
    }

    pub(crate) fn set_reduced_motion(&mut self, value: bool) {
        if self.reduced_motion == value {
            return;
        }
        self.reduced_motion = value;
        for state in self.keyframes.values_mut() {
            state.frozen = false;
        }
    }

    pub(crate) const fn metrics(&self) -> AnimationMetrics {
        self.metrics
    }

    fn remove_node(&mut self, scene: &mut Scene, node: NodeId) -> bool {
        self.resource_ids.remove(&node);
        self.durable.retain(|(candidate, _), _| *candidate != node);
        let transitions = self.transitions.len();
        let keyframes = self.keyframes.len();
        self.transitions
            .retain(|(candidate, _), _| *candidate != node);
        self.keyframes
            .retain(|(candidate, _), _| *candidate != node);
        let removed = transitions.saturating_sub(self.transitions.len())
            + keyframes.saturating_sub(self.keyframes.len());
        self.metrics.cancelled = self
            .metrics
            .cancelled
            .saturating_add(u64::try_from(removed).unwrap_or(u64::MAX));
        let presentation_changed = scene.clear_node_presentation_styles(node).unwrap_or(0) > 0;
        self.record_presentation_change(presentation_changed);
        presentation_changed
    }

    fn reconcile_keyframes(
        &mut self,
        scene: &mut Scene,
        node: NodeId,
        resource: &Arc<pingo_anim::AnimationResource>,
    ) -> bool {
        let mut expected = [false; 2];
        let mut changed = false;
        for (declaration_index, declaration) in resource.animations.iter().enumerate() {
            let key = (node, property_key(declaration.property));
            expected[usize::from(key.1 - 1)] = true;
            let preserves_timeline = self.keyframes.get(&key).is_some_and(|state| {
                same_animation_except_play_state(
                    &state.resource.animations[state.declaration_index],
                    declaration,
                )
            });
            if preserves_timeline {
                let Some(state) = self.keyframes.get_mut(&key) else {
                    continue;
                };
                let old_play_state = state.resource.animations[state.declaration_index]
                    .timing
                    .play_state;
                let new_play_state = declaration.timing.play_state;
                if old_play_state != new_play_state {
                    match new_play_state {
                        pingo_anim::PlayState::Paused => {
                            state.playback.paused_at_micros = Some(self.logical_micros);
                        }
                        pingo_anim::PlayState::Running => {
                            if let Some(paused_at) = state.playback.paused_at_micros.take() {
                                state.playback.started_at_micros = state
                                    .playback
                                    .started_at_micros
                                    .saturating_add(self.logical_micros.saturating_sub(paused_at));
                            }
                        }
                    }
                }
                state.resource = resource.clone();
                state.declaration_index = declaration_index;
                state.frozen = false;
                continue;
            }
            if self.keyframes.remove(&key).is_some() {
                self.metrics.cancelled = self.metrics.cancelled.saturating_add(1);
            }
            self.keyframes.insert(
                key,
                ActiveKeyframes {
                    resource: resource.clone(),
                    declaration_index,
                    playback: Playback {
                        started_at_micros: self.logical_micros,
                        paused_at_micros: (declaration.timing.play_state
                            == pingo_anim::PlayState::Paused)
                            .then_some(self.logical_micros),
                    },
                    phase: pingo_anim::Phase::Before,
                    frozen: false,
                },
            );
            self.metrics.started = self.metrics.started.saturating_add(1);
        }
        for property in 1..=2_u8 {
            if expected[usize::from(property - 1)] {
                continue;
            }
            let key = (node, property);
            if self.keyframes.remove(&key).is_none() {
                continue;
            }
            self.metrics.cancelled = self.metrics.cancelled.saturating_add(1);
            let presentation_changed = scene
                .clear_presentation_style(node, style_property_from_key(property))
                == Some(true);
            changed |= presentation_changed;
            self.record_presentation_change(presentation_changed);
        }
        changed
    }

    fn record_phase(&mut self, phase: pingo_anim::Phase) {
        let counter = match phase {
            pingo_anim::Phase::Before => &mut self.metrics.phase_before,
            pingo_anim::Phase::Active => &mut self.metrics.phase_active,
            pingo_anim::Phase::After => &mut self.metrics.phase_after,
        };
        *counter = counter.saturating_add(1);
    }

    fn record_presentation_change(&mut self, changed: bool) {
        if changed {
            self.metrics.presentation_changes = self.metrics.presentation_changes.saturating_add(1);
        }
    }

    fn update_retained_bytes(&mut self, scene: &Scene) {
        let resource_ids = self.resource_ids.values().copied().collect::<BTreeSet<_>>();
        let payload = resource_ids
            .iter()
            .filter_map(|resource_id| scene.resource(*resource_id))
            .map(|resource| resource.bytes.len())
            .fold(0_usize, usize::saturating_add);
        let bookkeeping = self
            .resource_ids
            .len()
            .saturating_mul(RESOURCE_BINDING_BYTES)
            .saturating_add(self.durable.len().saturating_mul(DURABLE_ENTRY_BYTES))
            .saturating_add(
                self.transitions
                    .len()
                    .saturating_mul(TRANSITION_ENTRY_BYTES),
            )
            .saturating_add(self.keyframes.len().saturating_mul(KEYFRAME_STATE_BYTES));
        self.metrics.retained_bytes = payload
            .saturating_add(bookkeeping)
            .try_into()
            .unwrap_or(u64::MAX);
    }
}

fn transition_phase(
    transition: Transition,
    now_micros: u64,
    reduced_motion: bool,
) -> pingo_anim::Phase {
    if reduced_motion {
        return pingo_anim::Phase::After;
    }
    let elapsed = i128::from(now_micros)
        - i128::from(transition.started_at_micros)
        - i128::from(transition.delay_micros);
    if elapsed <= 0 {
        pingo_anim::Phase::Before
    } else if transition.duration_micros > 0 && elapsed < i128::from(transition.duration_micros) {
        pingo_anim::Phase::Active
    } else {
        pingo_anim::Phase::After
    }
}

fn transition_for(
    declarations: &[TransitionDeclaration],
    property: AnimatedProperty,
) -> Option<TransitionDeclaration> {
    declarations
        .iter()
        .find(|item| item.property == property)
        .copied()
}

fn same_animation_except_play_state(
    left: &pingo_anim::KeyframeAnimation,
    right: &pingo_anim::KeyframeAnimation,
) -> bool {
    let mut left_timing = left.timing;
    let mut right_timing = right.timing;
    left_timing.play_state = pingo_anim::PlayState::Running;
    right_timing.play_state = pingo_anim::PlayState::Running;
    left.property == right.property && left_timing == right_timing && left.track == right.track
}

fn property_key(property: AnimatedProperty) -> u8 {
    match property {
        AnimatedProperty::Opacity => 1,
        AnimatedProperty::Transform => 2,
    }
}
fn style_property(property: AnimatedProperty) -> StyleProperty {
    style_property_from_key(property_key(property))
}
fn style_property_from_key(property: u8) -> StyleProperty {
    if property == 1 {
        StyleProperty::Opacity
    } else {
        StyleProperty::Transform
    }
}

fn durable_value(
    scene: &Scene,
    layout: &LayoutSnapshot,
    node: NodeId,
    property: AnimatedProperty,
) -> Result<PresentationValue, AnimationError> {
    match property {
        AnimatedProperty::Opacity => Ok(PresentationValue::Opacity(
            scene
                .f32_prop(node, pingo_abi::Prop::Opacity)
                .or_else(|| {
                    scene.style_f32(node, StyleProperty::Opacity, scene.interaction_state(node))
                })
                .unwrap_or(1.0),
        )),
        AnimatedProperty::Transform => {
            let size = layout
                .geometry(node)
                .map_or([0.0, 0.0], |(_, size)| [size.width, size.height]);
            if let Some(resource_id) = scene.ref_prop(node, pingo_abi::Prop::Transform) {
                let resource = scene
                    .resource(resource_id)
                    .ok_or(AnimationError::InvalidValue)?;
                let affine = AffineResource::decode(resource_id, resource)
                    .map_err(|_| AnimationError::InvalidValue)?;
                Ok(PresentationValue::Transform(affine.matrix))
            } else {
                let operations = scene
                    .style_transform(node, scene.interaction_state(node))
                    .unwrap_or_default();
                let matrix = transform_matrix(operations, size)?;
                let origin = if let Some(position) = scene.style_position(
                    node,
                    StyleProperty::TransformOrigin,
                    scene.interaction_state(node),
                ) {
                    [
                        resolve_length(position[0].unit, position[0].value, size[0])?,
                        resolve_length(position[1].unit, position[1].value, size[1])?,
                    ]
                } else {
                    [size[0] * 0.5, size[1] * 0.5]
                };
                Ok(PresentationValue::Transform(multiply(
                    multiply(translation(origin[0], origin[1]), matrix),
                    translation(-origin[0], -origin[1]),
                )))
            }
        }
    }
}

fn set_presentation(
    scene: &mut Scene,
    node: NodeId,
    property: u8,
    value: PresentationValue,
) -> Result<bool, AnimationError> {
    let (style, value) = match value {
        PresentationValue::Opacity(value) => {
            (StyleProperty::Opacity, ComputedStyleValue::F32(value))
        }
        PresentationValue::Transform(matrix) => (
            StyleProperty::Transform,
            ComputedStyleValue::TransformList(Arc::from([StyleTransformOperation::Matrix(matrix)])),
        ),
    };
    if style != style_property_from_key(property) {
        return Err(AnimationError::InvalidValue);
    }
    scene
        .set_presentation_style(node, style, value)
        .ok_or(AnimationError::InvalidValue)
}

fn transform_matrix(
    operations: &[StyleTransformOperation],
    size: [f32; 2],
) -> Result<[f32; 6], AnimationError> {
    let mut result = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    for operation in operations {
        let next = match *operation {
            StyleTransformOperation::Matrix(value) => value,
            StyleTransformOperation::Translate(x, y) => [
                1.0,
                0.0,
                0.0,
                1.0,
                resolve_length(x.unit, x.value, size[0])?,
                resolve_length(y.unit, y.value, size[1])?,
            ],
            StyleTransformOperation::Scale([x, y]) => [x, 0.0, 0.0, y, 0.0, 0.0],
            StyleTransformOperation::Rotate(radians) => {
                let (sin, cos) = radians.sin_cos();
                [cos, sin, -sin, cos, 0.0, 0.0]
            }
        };
        result = multiply(result, next);
    }
    Ok(result)
}

fn resolve_length(
    unit: StyleLengthUnit,
    value: f32,
    reference: f32,
) -> Result<f32, AnimationError> {
    match unit {
        StyleLengthUnit::Px => Ok(value),
        StyleLengthUnit::Percent => Ok(value * reference / 100.0),
        _ => Err(AnimationError::InvalidValue),
    }
}

fn multiply(left: [f32; 6], right: [f32; 6]) -> [f32; 6] {
    [
        left[0] * right[0] + left[2] * right[1],
        left[1] * right[0] + left[3] * right[1],
        left[0] * right[2] + left[2] * right[3],
        left[1] * right[2] + left[3] * right[3],
        left[0] * right[4] + left[2] * right[5] + left[4],
        left[1] * right[4] + left[3] * right[5] + left[5],
    ]
}

const fn translation(x: f32, y: f32) -> [f32; 6] {
    [1.0, 0.0, 0.0, 1.0, x, y]
}
