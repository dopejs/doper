#![doc = "Deterministic Core-owned animation timelines and presentation interpolation."]
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::missing_errors_doc
)]

use std::fmt;

/// Maximum finite animation duration accepted by Core (24 hours).
pub const MAX_DURATION_MICROS: u64 = 24 * 60 * 60 * 1_000_000;
/// Maximum finite iteration count accepted by Core.
pub const MAX_ITERATIONS: f64 = 1_000_000.0;
/// Maximum encoded immutable animation resource size.
pub const MAX_RESOURCE_BYTES: usize = 65_536;
const RESOURCE_HEADER_BYTES: usize = 8;
const TRANSITION_RECORD_BYTES: usize = 28;
const KEYFRAME_HEADER_BYTES: usize = 40;

/// Animation contract validation failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AnimationError {
    /// A duration, delay, or absolute timestamp exceeded its supported range.
    InvalidTime,
    /// A timing-function parameter was invalid.
    InvalidEasing,
    /// The iteration count was negative, non-finite, or unbounded.
    InvalidIterations,
    /// Keyframe offsets were empty, non-finite, unordered, duplicated, or outside `[0, 1]`.
    InvalidKeyframes,
    /// A presentation value was non-finite or outside its property domain.
    InvalidValue,
}

impl fmt::Display for AnimationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidTime => "animation time is outside the supported range",
            Self::InvalidEasing => "animation easing is invalid",
            Self::InvalidIterations => "animation iteration count is invalid",
            Self::InvalidKeyframes => "animation keyframes are invalid",
            Self::InvalidValue => "animation presentation value is invalid",
        })
    }
}

impl std::error::Error for AnimationError {}

/// CSS-compatible timing function.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Easing {
    /// Identity timing.
    Linear,
    /// CSS `ease` preset.
    Ease,
    /// CSS `ease-in` preset.
    EaseIn,
    /// CSS `ease-out` preset.
    EaseOut,
    /// CSS `ease-in-out` preset.
    EaseInOut,
    /// Cubic Bézier with CSS-constrained x control points.
    CubicBezier([f64; 4]),
    /// Quantized timing with an end or start jump.
    Steps { count: u32, position: StepPosition },
}

/// Supported CSS step positions for the initial animation subset.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StepPosition {
    /// CSS `jump-end` / `end`.
    End,
    /// CSS `jump-start` / `start`.
    Start,
}

impl Easing {
    /// Validates and evaluates the function for a normalized input.
    pub fn evaluate(self, input: f64) -> Result<f64, AnimationError> {
        if !input.is_finite() {
            return Err(AnimationError::InvalidEasing);
        }
        let x = input.clamp(0.0, 1.0);
        match self {
            Self::Linear => Ok(x),
            Self::Ease => cubic_bezier(x, [0.25, 0.1, 0.25, 1.0]),
            Self::EaseIn => cubic_bezier(x, [0.42, 0.0, 1.0, 1.0]),
            Self::EaseOut => cubic_bezier(x, [0.0, 0.0, 0.58, 1.0]),
            Self::EaseInOut => cubic_bezier(x, [0.42, 0.0, 0.58, 1.0]),
            Self::CubicBezier(points) => cubic_bezier(x, points),
            Self::Steps { count, position } => {
                if count == 0 {
                    return Err(AnimationError::InvalidEasing);
                }
                let count = f64::from(count);
                let value = match position {
                    StepPosition::End => (x * count).floor() / count,
                    StepPosition::Start => (x * count).ceil() / count,
                };
                Ok(value.clamp(0.0, 1.0))
            }
        }
    }
}

fn cubic_bezier(input: f64, points: [f64; 4]) -> Result<f64, AnimationError> {
    let [x1, y1, x2, y2] = points;
    if !points.iter().all(|value| value.is_finite())
        || !(0.0..=1.0).contains(&x1)
        || !(0.0..=1.0).contains(&x2)
    {
        return Err(AnimationError::InvalidEasing);
    }
    // Fixed-iteration bisection is deterministic across native/WASM and does
    // not inherit convergence differences from platform math libraries.
    let mut low = 0.0;
    let mut high = 1.0;
    for _ in 0..24 {
        let t = (low + high) * 0.5;
        if bezier_coordinate(t, x1, x2) < input {
            low = t;
        } else {
            high = t;
        }
    }
    Ok(bezier_coordinate((low + high) * 0.5, y1, y2))
}

fn bezier_coordinate(t: f64, first: f64, second: f64) -> f64 {
    let inverse = 1.0 - t;
    3.0 * inverse * inverse * t * first + 3.0 * inverse * t * t * second + t * t * t
}

/// Alternation rule across iterations.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Direction {
    /// Every iteration runs start to end.
    Normal,
    /// Every iteration runs end to start.
    Reverse,
    /// Odd iterations run in reverse.
    Alternate,
    /// Even iterations run in reverse.
    AlternateReverse,
}

/// Whether keyframe values apply outside the active interval.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FillMode {
    /// No value before or after the active interval.
    None,
    /// Retain the final sampled value.
    Forwards,
    /// Apply the initial sampled value during delay.
    Backwards,
    /// Apply both backwards and forwards fill.
    Both,
}

/// Declarative playback state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlayState {
    /// Timeline follows logical time.
    Running,
    /// Timeline remains at `paused_at_micros`.
    Paused,
}

/// Immutable timing resource shared by transitions and keyframes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Timing {
    /// Active duration of one iteration.
    pub duration_micros: u64,
    /// Signed delay; negative delay starts inside the active interval.
    pub delay_micros: i64,
    /// Finite iteration count; fractional final iterations are supported.
    pub iterations: f64,
    /// Per-iteration direction.
    pub direction: Direction,
    /// Value application outside the active interval.
    pub fill: FillMode,
    /// Timing function within each iteration.
    pub easing: Easing,
    /// Running or paused.
    pub play_state: PlayState,
}

impl Timing {
    /// Validates bounded timing input.
    pub fn validate(self) -> Result<Self, AnimationError> {
        if self.duration_micros > MAX_DURATION_MICROS
            || self.delay_micros.unsigned_abs() > MAX_DURATION_MICROS
        {
            return Err(AnimationError::InvalidTime);
        }
        if !self.iterations.is_finite() || self.iterations < 0.0 || self.iterations > MAX_ITERATIONS
        {
            return Err(AnimationError::InvalidIterations);
        }
        self.easing.evaluate(0.5)?;
        Ok(self)
    }
}

/// Absolute logical-time playback anchor.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Playback {
    /// Absolute logical start timestamp.
    pub started_at_micros: u64,
    /// Absolute logical timestamp captured when paused.
    pub paused_at_micros: Option<u64>,
}

/// Timeline interval for diagnostics and frame scheduling.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Phase {
    /// Before the active interval.
    Before,
    /// Inside the active interval.
    Active,
    /// After all iterations.
    After,
}

/// One deterministic timeline sample.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    /// Current interval.
    pub phase: Phase,
    /// Directed and eased progress, or `None` when fill excludes this phase.
    pub progress: Option<f64>,
    /// Zero-based iteration selected for this sample.
    pub iteration: u64,
    /// Whether another logical-time tick can change the result.
    pub active: bool,
}

/// Samples timing against an absolute, injectable logical timestamp.
pub fn sample(
    timing: Timing,
    playback: Playback,
    now_micros: u64,
    reduced_motion: bool,
) -> Result<Sample, AnimationError> {
    let timing = timing.validate()?;
    let now = match timing.play_state {
        PlayState::Running => now_micros,
        PlayState::Paused => playback.paused_at_micros.unwrap_or(now_micros),
    };
    let elapsed =
        i128::from(now) - i128::from(playback.started_at_micros) - i128::from(timing.delay_micros);
    let duration = if reduced_motion {
        0
    } else {
        timing.duration_micros
    };
    if elapsed < 0 {
        let progress = matches!(timing.fill, FillMode::Backwards | FillMode::Both)
            .then(|| directed_progress(0.0, 0, timing.direction))
            .transpose()?
            .map(|value| timing.easing.evaluate(value))
            .transpose()?;
        return Ok(Sample {
            phase: Phase::Before,
            progress,
            iteration: 0,
            active: timing.play_state == PlayState::Running,
        });
    }
    if duration == 0 || timing.iterations == 0.0 {
        return after_sample(timing, 0);
    }
    let total = (duration as f64) * timing.iterations;
    if (elapsed as f64) >= total {
        let last_iteration = timing.iterations.ceil().max(1.0) as u64 - 1;
        return after_sample(timing, last_iteration);
    }
    let elapsed = elapsed as u128;
    let iteration =
        u64::try_from(elapsed / u128::from(duration)).map_err(|_| AnimationError::InvalidTime)?;
    let local = (elapsed % u128::from(duration)) as f64 / duration as f64;
    let directed = directed_progress(local, iteration, timing.direction)?;
    Ok(Sample {
        phase: Phase::Active,
        progress: Some(timing.easing.evaluate(directed)?),
        iteration,
        active: timing.play_state == PlayState::Running,
    })
}

fn after_sample(timing: Timing, iteration: u64) -> Result<Sample, AnimationError> {
    let progress = matches!(timing.fill, FillMode::Forwards | FillMode::Both)
        .then(|| directed_progress(1.0, iteration, timing.direction))
        .transpose()?
        .map(|value| timing.easing.evaluate(value))
        .transpose()?;
    Ok(Sample {
        phase: Phase::After,
        progress,
        iteration,
        active: false,
    })
}

fn directed_progress(
    progress: f64,
    iteration: u64,
    direction: Direction,
) -> Result<f64, AnimationError> {
    if !progress.is_finite() {
        return Err(AnimationError::InvalidTime);
    }
    let reverse = match direction {
        Direction::Normal => false,
        Direction::Reverse => true,
        Direction::Alternate => iteration % 2 == 1,
        Direction::AlternateReverse => iteration.is_multiple_of(2),
    };
    Ok(if reverse { 1.0 - progress } else { progress })
}

/// Property values supported by the first compositor-friendly animation slice.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PresentationValue {
    /// Clamped opacity scalar.
    Opacity(f32),
    /// Canvas-compatible affine matrix.
    Transform([f32; 6]),
}

impl PresentationValue {
    /// Validates and linearly interpolates matching property values.
    pub fn interpolate(self, target: Self, progress: f64) -> Result<Self, AnimationError> {
        if !progress.is_finite() {
            return Err(AnimationError::InvalidValue);
        }
        let progress = progress.clamp(0.0, 1.0) as f32;
        match (self, target) {
            (Self::Opacity(from), Self::Opacity(to))
                if from.is_finite()
                    && to.is_finite()
                    && (0.0..=1.0).contains(&from)
                    && (0.0..=1.0).contains(&to) =>
            {
                Ok(Self::Opacity(from + (to - from) * progress))
            }
            (Self::Transform(from), Self::Transform(to))
                if from.iter().chain(&to).all(|value| value.is_finite()) =>
            {
                let mut output = [0.0; 6];
                for (index, value) in output.iter_mut().enumerate() {
                    *value = from[index] + (to[index] - from[index]) * progress;
                }
                Ok(Self::Transform(output))
            }
            _ => Err(AnimationError::InvalidValue),
        }
    }
}

/// One immutable property keyframe.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Keyframe {
    /// Normalized offset.
    pub offset: f64,
    /// Property value at the offset.
    pub value: PresentationValue,
}

/// Bounded immutable keyframe track.
#[derive(Clone, Debug, PartialEq)]
pub struct KeyframeTrack(Box<[Keyframe]>);

impl KeyframeTrack {
    /// Validates a non-empty, strictly ascending track with endpoints at 0 and 1.
    pub fn new(frames: impl Into<Box<[Keyframe]>>) -> Result<Self, AnimationError> {
        let frames = frames.into();
        if frames.is_empty()
            || frames.len() > 256
            || frames
                .first()
                .is_none_or(|frame| frame.offset.to_bits() != 0.0_f64.to_bits())
            || frames
                .last()
                .is_none_or(|frame| frame.offset.to_bits() != 1.0_f64.to_bits())
            || frames.windows(2).any(|pair| {
                !pair[0].offset.is_finite()
                    || !pair[1].offset.is_finite()
                    || pair[0].offset >= pair[1].offset
            })
        {
            return Err(AnimationError::InvalidKeyframes);
        }
        // Interpolating each value with itself validates domains and track type.
        for frame in &frames {
            frame.value.interpolate(frame.value, 0.0)?;
        }
        let kind = std::mem::discriminant(&frames[0].value);
        if frames
            .iter()
            .any(|frame| std::mem::discriminant(&frame.value) != kind)
        {
            return Err(AnimationError::InvalidKeyframes);
        }
        Ok(Self(frames))
    }

    /// Interpolates the enclosing keyframe segment.
    pub fn value_at(&self, progress: f64) -> Result<PresentationValue, AnimationError> {
        if !progress.is_finite() {
            return Err(AnimationError::InvalidValue);
        }
        let progress = progress.clamp(0.0, 1.0);
        let trailing = self.0.partition_point(|frame| frame.offset < progress);
        if trailing == 0 {
            return Ok(self.0[0].value);
        }
        if trailing == self.0.len() {
            return Ok(self.0[self.0.len() - 1].value);
        }
        let from = self.0[trailing - 1];
        let to = self.0[trailing];
        let local = (progress - from.offset) / (to.offset - from.offset);
        from.value.interpolate(to.value, local)
    }
}

/// Active transition that can be retargeted from its current presentation value.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transition {
    /// Current segment start.
    pub from: PresentationValue,
    /// Durable target.
    pub to: PresentationValue,
    /// Absolute segment start.
    pub started_at_micros: u64,
    /// Signed delay; a negative value starts partway through the segment.
    pub delay_micros: i64,
    /// Active interpolation duration.
    pub duration_micros: u64,
    /// Segment easing.
    pub easing: Easing,
}

/// Property selector in an immutable animation resource.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AnimatedProperty {
    /// Computed opacity.
    Opacity,
    /// Computed transform, normalized to an affine matrix by Core.
    Transform,
}

/// One transition declaration decoded from a resource.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TransitionDeclaration {
    /// Animated property.
    pub property: AnimatedProperty,
    /// Active duration.
    pub duration_micros: u64,
    /// Signed delay.
    pub delay_micros: i64,
    /// CSS timing function.
    pub easing: Easing,
}

/// One immutable keyframe animation decoded from a resource.
#[derive(Clone, Debug, PartialEq)]
pub struct KeyframeAnimation {
    /// Animated property.
    pub property: AnimatedProperty,
    /// Timeline timing.
    pub timing: Timing,
    /// Property track.
    pub track: KeyframeTrack,
}

/// Validated animation configuration attached to one Scene node.
#[derive(Clone, Debug, PartialEq)]
pub struct AnimationResource {
    /// At most one transition per supported property.
    pub transitions: Box<[TransitionDeclaration]>,
    /// Bounded immutable keyframe tracks.
    pub animations: Box<[KeyframeAnimation]>,
}

impl AnimationResource {
    /// Decodes and validates one complete little-endian resource.
    #[allow(clippy::too_many_lines)]
    pub fn decode(bytes: &[u8]) -> Result<Self, AnimationError> {
        if bytes.len() < RESOURCE_HEADER_BYTES
            || bytes.len() > MAX_RESOURCE_BYTES
            || !bytes.len().is_multiple_of(4)
            || bytes[0] != 1
            || bytes[3] != 0
            || read_u32(bytes, 4)? as usize != bytes.len()
        {
            return Err(AnimationError::InvalidValue);
        }
        let transition_count = usize::from(bytes[1]);
        let animation_count = usize::from(bytes[2]);
        if transition_count > 2 || animation_count > 2 {
            return Err(AnimationError::InvalidValue);
        }
        let mut offset = RESOURCE_HEADER_BYTES;
        let mut transitions = Vec::with_capacity(transition_count);
        for _ in 0..transition_count {
            let record = slice(bytes, offset, TRANSITION_RECORD_BYTES)?;
            let property = decode_property(record[0])?;
            if record[3] != 0 {
                return Err(AnimationError::InvalidValue);
            }
            let duration_micros = u64::from(read_u32(record, 4)?);
            let delay_micros = i64::from(read_i32(record, 8)?);
            let easing = decode_easing(record[1], record[2], record, 12)?;
            Timing {
                duration_micros,
                delay_micros,
                iterations: 1.0,
                direction: Direction::Normal,
                fill: FillMode::None,
                easing,
                play_state: PlayState::Running,
            }
            .validate()?;
            if transitions
                .iter()
                .any(|item: &TransitionDeclaration| item.property == property)
            {
                return Err(AnimationError::InvalidValue);
            }
            transitions.push(TransitionDeclaration {
                property,
                duration_micros,
                delay_micros,
                easing,
            });
            offset += TRANSITION_RECORD_BYTES;
        }
        let mut animations = Vec::with_capacity(animation_count);
        for _ in 0..animation_count {
            let header = slice(bytes, offset, KEYFRAME_HEADER_BYTES)?;
            let property = decode_property(header[0])?;
            if header[6..8].iter().any(|byte| *byte != 0) || read_u16(header, 22)? != 0 {
                return Err(AnimationError::InvalidValue);
            }
            let easing = decode_easing(header[1], header[5], header, 24)?;
            let timing = Timing {
                duration_micros: u64::from(read_u32(header, 8)?),
                delay_micros: i64::from(read_i32(header, 12)?),
                iterations: f64::from(read_f32(header, 16)?),
                direction: decode_direction(header[2])?,
                fill: decode_fill(header[3])?,
                easing,
                play_state: decode_play_state(header[4])?,
            }
            .validate()?;
            let count = usize::from(read_u16(header, 20)?);
            if !(2..=256).contains(&count) {
                return Err(AnimationError::InvalidKeyframes);
            }
            offset += KEYFRAME_HEADER_BYTES;
            let record_bytes = match property {
                AnimatedProperty::Opacity => 8,
                AnimatedProperty::Transform => 28,
            };
            let mut frames = Vec::with_capacity(count);
            for _ in 0..count {
                let record = slice(bytes, offset, record_bytes)?;
                let frame_offset = f64::from(read_f32(record, 0)?);
                let value = match property {
                    AnimatedProperty::Opacity => PresentationValue::Opacity(read_f32(record, 4)?),
                    AnimatedProperty::Transform => {
                        let mut matrix = [0.0; 6];
                        for (index, value) in matrix.iter_mut().enumerate() {
                            *value = read_f32(record, 4 + index * 4)?;
                        }
                        PresentationValue::Transform(matrix)
                    }
                };
                frames.push(Keyframe {
                    offset: frame_offset,
                    value,
                });
                offset += record_bytes;
            }
            animations.push(KeyframeAnimation {
                property,
                timing,
                track: KeyframeTrack::new(frames.into_boxed_slice())?,
            });
        }
        if offset != bytes.len() {
            return Err(AnimationError::InvalidValue);
        }
        Ok(Self {
            transitions: transitions.into_boxed_slice(),
            animations: animations.into_boxed_slice(),
        })
    }
}

fn decode_property(value: u8) -> Result<AnimatedProperty, AnimationError> {
    match value {
        1 => Ok(AnimatedProperty::Opacity),
        2 => Ok(AnimatedProperty::Transform),
        _ => Err(AnimationError::InvalidValue),
    }
}

fn decode_direction(value: u8) -> Result<Direction, AnimationError> {
    match value {
        0 => Ok(Direction::Normal),
        1 => Ok(Direction::Reverse),
        2 => Ok(Direction::Alternate),
        3 => Ok(Direction::AlternateReverse),
        _ => Err(AnimationError::InvalidValue),
    }
}

fn decode_fill(value: u8) -> Result<FillMode, AnimationError> {
    match value {
        0 => Ok(FillMode::None),
        1 => Ok(FillMode::Forwards),
        2 => Ok(FillMode::Backwards),
        3 => Ok(FillMode::Both),
        _ => Err(AnimationError::InvalidValue),
    }
}

fn decode_play_state(value: u8) -> Result<PlayState, AnimationError> {
    match value {
        0 => Ok(PlayState::Running),
        1 => Ok(PlayState::Paused),
        _ => Err(AnimationError::InvalidValue),
    }
}

fn decode_easing(
    kind: u8,
    step_position: u8,
    bytes: &[u8],
    offset: usize,
) -> Result<Easing, AnimationError> {
    let parameters = [
        read_f32(bytes, offset)?,
        read_f32(bytes, offset + 4)?,
        read_f32(bytes, offset + 8)?,
        read_f32(bytes, offset + 12)?,
    ];
    let parameters_are_zero = parameters.iter().all(|value| value.to_bits() == 0);
    let easing = match kind {
        0..=4 if step_position != 0 || !parameters_are_zero => {
            return Err(AnimationError::InvalidEasing);
        }
        0 => Easing::Linear,
        1 => Easing::Ease,
        2 => Easing::EaseIn,
        3 => Easing::EaseOut,
        4 => Easing::EaseInOut,
        5 if step_position != 0 => return Err(AnimationError::InvalidEasing),
        5 => Easing::CubicBezier(parameters.map(f64::from)),
        6 if parameters[0].fract() != 0.0
            || !(1.0..=1_000_000.0).contains(&parameters[0])
            || parameters[1..].iter().any(|value| value.to_bits() != 0) =>
        {
            return Err(AnimationError::InvalidEasing);
        }
        6 => Easing::Steps {
            count: parameters[0] as u32,
            position: match step_position {
                0 => StepPosition::End,
                1 => StepPosition::Start,
                _ => return Err(AnimationError::InvalidEasing),
            },
        },
        _ => return Err(AnimationError::InvalidEasing),
    };
    easing.evaluate(0.5)?;
    Ok(easing)
}

fn slice(bytes: &[u8], offset: usize, length: usize) -> Result<&[u8], AnimationError> {
    bytes
        .get(
            offset
                ..offset
                    .checked_add(length)
                    .ok_or(AnimationError::InvalidValue)?,
        )
        .ok_or(AnimationError::InvalidValue)
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, AnimationError> {
    Ok(u16::from_le_bytes(
        slice(bytes, offset, 2)?
            .try_into()
            .map_err(|_| AnimationError::InvalidValue)?,
    ))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, AnimationError> {
    Ok(u32::from_le_bytes(
        slice(bytes, offset, 4)?
            .try_into()
            .map_err(|_| AnimationError::InvalidValue)?,
    ))
}

fn read_i32(bytes: &[u8], offset: usize) -> Result<i32, AnimationError> {
    Ok(i32::from_le_bytes(
        slice(bytes, offset, 4)?
            .try_into()
            .map_err(|_| AnimationError::InvalidValue)?,
    ))
}

fn read_f32(bytes: &[u8], offset: usize) -> Result<f32, AnimationError> {
    let value = f32::from_le_bytes(
        slice(bytes, offset, 4)?
            .try_into()
            .map_err(|_| AnimationError::InvalidValue)?,
    );
    value
        .is_finite()
        .then_some(value)
        .ok_or(AnimationError::InvalidValue)
}

impl Transition {
    /// Samples presentation and reports whether another frame is required.
    pub fn sample(
        self,
        now_micros: u64,
        reduced_motion: bool,
    ) -> Result<(PresentationValue, bool), AnimationError> {
        if self.duration_micros > MAX_DURATION_MICROS
            || self.delay_micros.unsigned_abs() > MAX_DURATION_MICROS
        {
            return Err(AnimationError::InvalidTime);
        }
        self.easing.evaluate(0.5)?;
        if reduced_motion {
            return Ok((self.to, false));
        }
        let elapsed = i128::from(now_micros)
            - i128::from(self.started_at_micros)
            - i128::from(self.delay_micros);
        if elapsed <= 0 {
            return Ok((self.from, true));
        }
        if self.duration_micros == 0 {
            return Ok((self.to, false));
        }
        let progress = elapsed as f64 / self.duration_micros as f64;
        if progress >= 1.0 {
            return Ok((self.to, false));
        }
        Ok((
            self.from
                .interpolate(self.to, self.easing.evaluate(progress)?)?,
            true,
        ))
    }

    /// Starts a new segment from the current presentation value.
    pub fn retarget(
        self,
        target: PresentationValue,
        now_micros: u64,
        reduced_motion: bool,
    ) -> Result<Self, AnimationError> {
        let (from, _) = self.sample(now_micros, reduced_motion)?;
        // Validate matching value kinds before accepting the durable target.
        from.interpolate(target, 0.0)?;
        Ok(Self {
            from,
            to: target,
            started_at_micros: now_micros,
            ..self
        })
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn timing() -> Timing {
        Timing {
            duration_micros: 1_000,
            delay_micros: 100,
            iterations: 2.0,
            direction: Direction::Alternate,
            fill: FillMode::Both,
            easing: Easing::Linear,
            play_state: PlayState::Running,
        }
    }

    fn valid_resource_bytes() -> Vec<u8> {
        let mut bytes = vec![1, 1, 1, 0, 0, 0, 0, 0];
        // One opacity transition: 250ms, -50ms delay, linear.
        bytes.extend_from_slice(&[1, 0, 0, 0]);
        bytes.extend_from_slice(&250_000_u32.to_le_bytes());
        bytes.extend_from_slice(&(-50_000_i32).to_le_bytes());
        bytes.extend_from_slice(&[0; 16]);
        // One opacity keyframe animation: 1s, two iterations, alternate, fill both.
        bytes.extend_from_slice(&[1, 0, 2, 3, 0, 0, 0, 0]);
        bytes.extend_from_slice(&1_000_000_u32.to_le_bytes());
        bytes.extend_from_slice(&0_i32.to_le_bytes());
        bytes.extend_from_slice(&2.0_f32.to_le_bytes());
        bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&[0; 16]);
        for (offset, value) in [(0.0_f32, 0.25_f32), (1.0, 0.75)] {
            bytes.extend_from_slice(&offset.to_le_bytes());
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        let length = u32::try_from(bytes.len()).expect("small fixture");
        bytes[4..8].copy_from_slice(&length.to_le_bytes());
        bytes
    }

    #[test]
    fn absolute_timeline_covers_delay_alternation_fill_pause_and_reduced_motion() {
        let playback = Playback {
            started_at_micros: 10_000,
            paused_at_micros: None,
        };
        assert_eq!(
            sample(timing(), playback, 10_050, false)
                .expect("before")
                .progress,
            Some(0.0)
        );
        assert_eq!(
            sample(timing(), playback, 10_600, false)
                .expect("first")
                .progress,
            Some(0.5)
        );
        assert_eq!(
            sample(timing(), playback, 11_600, false)
                .expect("second")
                .progress,
            Some(0.5)
        );
        let after = sample(timing(), playback, 12_100, false).expect("after");
        assert_eq!(after.phase, Phase::After);
        assert_eq!(after.progress, Some(0.0));
        assert!(!after.active);
        assert_eq!(
            sample(timing(), playback, 10_050, true)
                .expect("reduced")
                .phase,
            Phase::Before
        );

        let paused_timing = Timing {
            play_state: PlayState::Paused,
            ..timing()
        };
        let paused = Playback {
            paused_at_micros: Some(10_600),
            ..playback
        };
        assert_eq!(
            sample(paused_timing, paused, 99_000, false)
                .expect("paused")
                .progress,
            Some(0.5)
        );
    }

    #[test]
    fn transition_retargets_from_presentation_without_mutating_the_old_target() {
        let transition = Transition {
            from: PresentationValue::Opacity(0.0),
            to: PresentationValue::Opacity(1.0),
            started_at_micros: 1_000,
            delay_micros: 0,
            duration_micros: 1_000,
            easing: Easing::Linear,
        };
        let retargeted = transition
            .retarget(PresentationValue::Opacity(0.25), 1_500, false)
            .expect("retarget");
        assert_eq!(retargeted.from, PresentationValue::Opacity(0.5));
        assert_eq!(retargeted.to, PresentationValue::Opacity(0.25));
        assert_eq!(transition.to, PresentationValue::Opacity(1.0));
    }

    #[test]
    fn keyframes_interpolate_opacity_and_transform_without_extrapolation() {
        let opacity = KeyframeTrack::new(
            vec![
                Keyframe {
                    offset: 0.0,
                    value: PresentationValue::Opacity(0.0),
                },
                Keyframe {
                    offset: 0.25,
                    value: PresentationValue::Opacity(1.0),
                },
                Keyframe {
                    offset: 1.0,
                    value: PresentationValue::Opacity(0.5),
                },
            ]
            .into_boxed_slice(),
        )
        .expect("track");
        assert_eq!(opacity.value_at(0.125), Ok(PresentationValue::Opacity(0.5)));
        assert_eq!(opacity.value_at(2.0), Ok(PresentationValue::Opacity(0.5)));

        let identity = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        let translated = [1.0, 0.0, 0.0, 1.0, 20.0, 40.0];
        let transform = KeyframeTrack::new(
            vec![
                Keyframe {
                    offset: 0.0,
                    value: PresentationValue::Transform(identity),
                },
                Keyframe {
                    offset: 1.0,
                    value: PresentationValue::Transform(translated),
                },
            ]
            .into_boxed_slice(),
        )
        .expect("track");
        assert_eq!(
            transform.value_at(0.5),
            Ok(PresentationValue::Transform([
                1.0, 0.0, 0.0, 1.0, 10.0, 20.0
            ]))
        );
    }

    #[test]
    fn hostile_animation_input_fails_closed() {
        assert_eq!(
            Easing::CubicBezier([-0.1, 0.0, 1.0, 1.0]).evaluate(0.5),
            Err(AnimationError::InvalidEasing)
        );
        assert_eq!(
            Easing::Steps {
                count: 0,
                position: StepPosition::End
            }
            .evaluate(0.5),
            Err(AnimationError::InvalidEasing)
        );
        assert_eq!(
            PresentationValue::Opacity(f32::NAN).interpolate(PresentationValue::Opacity(1.0), 0.5),
            Err(AnimationError::InvalidValue)
        );
        assert_eq!(
            KeyframeTrack::new(Vec::<Keyframe>::new().into_boxed_slice()),
            Err(AnimationError::InvalidKeyframes)
        );
    }

    #[test]
    fn immutable_resource_decodes_canonical_transition_and_keyframes() {
        let decoded = AnimationResource::decode(&valid_resource_bytes()).expect("resource");
        assert_eq!(decoded.transitions.len(), 1);
        assert_eq!(decoded.transitions[0].property, AnimatedProperty::Opacity);
        assert_eq!(decoded.transitions[0].delay_micros, -50_000);
        assert_eq!(decoded.animations.len(), 1);
        assert_eq!(
            decoded.animations[0].timing.iterations.to_bits(),
            2.0_f64.to_bits()
        );
        assert_eq!(decoded.animations[0].timing.direction, Direction::Alternate);
        assert_eq!(decoded.animations[0].timing.fill, FillMode::Both);
        assert_eq!(
            decoded.animations[0].track.value_at(0.5),
            Ok(PresentationValue::Opacity(0.5))
        );
    }

    #[test]
    fn typescript_animation_golden_decodes_with_exact_semantics() {
        let fixture = include_str!("../../../benchmarks/abi/animation-resource.v1.json");
        let marker = "\"hex\": \"";
        let start = fixture.find(marker).expect("hex field") + marker.len();
        let end = fixture[start..].find('"').expect("hex terminator") + start;
        let hex = &fixture[start..end];
        assert!(hex.len().is_multiple_of(2));
        let bytes = hex
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let text = std::str::from_utf8(pair).expect("ASCII hex");
                u8::from_str_radix(text, 16).expect("hex byte")
            })
            .collect::<Vec<_>>();
        let decoded = AnimationResource::decode(&bytes).expect("TypeScript resource");
        assert_eq!(decoded.transitions.len(), 2);
        assert_eq!(decoded.animations.len(), 1);
        assert_eq!(decoded.transitions[0].easing, Easing::EaseInOut);
        assert_eq!(decoded.transitions[1].property, AnimatedProperty::Transform);
        assert_eq!(
            decoded.animations[0].timing.easing,
            Easing::Steps {
                count: 4,
                position: StepPosition::Start,
            }
        );
        assert_eq!(
            decoded.animations[0].track.value_at(0.25),
            Ok(PresentationValue::Opacity(1.0))
        );
    }

    #[test]
    fn immutable_resource_rejects_noncanonical_and_truncated_payloads() {
        let canonical = valid_resource_bytes();
        let mut corruptions = Vec::new();
        corruptions.push(canonical[..canonical.len() - 4].to_vec());
        for (index, value) in [(0, 2), (3, 1), (8, 3), (11, 1), (36, 3), (42, 9), (58, 1)] {
            let mut bytes = canonical.clone();
            bytes[index] = value;
            corruptions.push(bytes);
        }
        let mut non_finite = canonical.clone();
        non_finite[80..84].copy_from_slice(&f32::NAN.to_le_bytes());
        corruptions.push(non_finite);
        for bytes in corruptions {
            assert!(
                AnimationResource::decode(&bytes).is_err(),
                "accepted {bytes:?}"
            );
        }
    }

    proptest! {
        #[test]
        fn easing_is_finite_and_bounded(input in -10_000.0_f64..10_000.0) {
            for easing in [Easing::Linear, Easing::Ease, Easing::EaseIn, Easing::EaseOut, Easing::EaseInOut, Easing::Steps { count: 7, position: StepPosition::End }] {
                let output = easing.evaluate(input).expect("easing");
                prop_assert!(output.is_finite());
                prop_assert!((0.0..=1.0).contains(&output));
            }
        }

        #[test]
        fn timeline_progress_never_escapes_unit_interval(now in any::<u64>()) {
            let playback = Playback { started_at_micros: u64::MAX / 2, paused_at_micros: None };
            if let Some(progress) = sample(timing(), playback, now, false).expect("sample").progress {
                prop_assert!((0.0..=1.0).contains(&progress));
            }
        }


        #[test]
        fn arbitrary_resource_bytes_never_panic(bytes in proptest::collection::vec(any::<u8>(), 0..2048)) {
            let _ = AnimationResource::decode(&bytes);
        }
    }
}
