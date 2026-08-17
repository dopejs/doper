use crate::ScrollError;

/// Tunable platform family. Defaults are deterministic starting points, not qualification claims.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScrollPlatform {
    /// iOS-style longer coast and elastic edge response.
    Ios,
    /// Android-style faster coast and tighter edge response.
    Android,
}

/// Validated coefficients for deterministic one-dimensional scrolling.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollPhysicsConfig {
    /// Per-second velocity decay coefficient.
    pub deceleration: f64,
    /// Spring acceleration applied per logical pixel beyond a bound.
    pub spring_stiffness: f64,
    /// Velocity damping while outside a bound.
    pub spring_damping: f64,
    /// Maximum overscroll as a fraction of the viewport extent.
    pub overscroll_viewport_fraction: f64,
    /// Velocity below which an in-bounds animation settles.
    pub stop_velocity: f64,
    /// Distance to a bound below which rebound snaps exactly to it.
    pub stop_distance: f64,
    /// Maximum accepted integration step; larger elapsed time is split by the caller.
    pub maximum_step_seconds: f64,
}

impl ScrollPhysicsConfig {
    /// Returns the default coefficient set for a platform family.
    #[must_use]
    pub const fn for_platform(platform: ScrollPlatform) -> Self {
        match platform {
            ScrollPlatform::Ios => Self {
                deceleration: 7.5,
                spring_stiffness: 260.0,
                spring_damping: 28.0,
                overscroll_viewport_fraction: 0.5,
                stop_velocity: 2.0,
                stop_distance: 0.25,
                maximum_step_seconds: 1.0 / 30.0,
            },
            ScrollPlatform::Android => Self {
                deceleration: 11.5,
                spring_stiffness: 340.0,
                spring_damping: 38.0,
                overscroll_viewport_fraction: 0.3,
                stop_velocity: 2.0,
                stop_distance: 0.25,
                maximum_step_seconds: 1.0 / 30.0,
            },
        }
    }

    fn validate(self) -> Result<Self, ScrollError> {
        for (field, value, minimum, maximum) in [
            ("deceleration", self.deceleration, f64::EPSILON, 1_000.0),
            (
                "spring stiffness",
                self.spring_stiffness,
                f64::EPSILON,
                100_000.0,
            ),
            (
                "spring damping",
                self.spring_damping,
                f64::EPSILON,
                10_000.0,
            ),
            (
                "overscroll viewport fraction",
                self.overscroll_viewport_fraction,
                0.0,
                2.0,
            ),
            ("stop velocity", self.stop_velocity, 0.0, 1_000_000.0),
            ("stop distance", self.stop_distance, 0.0, 1_000_000.0),
            (
                "maximum step",
                self.maximum_step_seconds,
                f64::EPSILON,
                0.25,
            ),
        ] {
            if !value.is_finite() || value < minimum || value > maximum {
                return Err(ScrollError::InvalidScalar { field, value });
            }
        }
        Ok(self)
    }
}

/// Cumulative physics work and boundary events.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ScrollPhysicsMetrics {
    /// Successful integration steps.
    pub frames: u64,
    /// Pointer/wheel deltas accepted.
    pub input_deltas: u64,
    /// Non-zero fling velocities accepted.
    pub flings: u64,
    /// Frames integrating an out-of-bounds spring.
    pub rebound_frames: u64,
    /// Programmatic or extent-change positions clamped to bounds.
    pub clamps: u64,
}

/// Immutable result of one physics step.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollFrame {
    /// Current logical content offset.
    pub position: f64,
    /// Current logical pixels per second.
    pub velocity: f64,
    /// Whether another frame is required without new input.
    pub active: bool,
    /// Whether position changed during this step.
    pub changed: bool,
    /// Whether the position is currently outside its hard content bounds.
    pub overscrolled: bool,
}

/// Exponential time constant for the discrete wheel-notch animation.
///
/// Browsers animate a wheel notch instead of jumping to it; this constant
/// settles roughly 95% of the remaining distance in 135ms, which matches the
/// desktop smooth-scroll feel without adding perceptible latency.
const WHEEL_ANIMATION_TAU_SECONDS: f64 = 0.045;

/// Core-owned deterministic scroll state with drag, fling, and rebound phases.
#[derive(Clone, Debug, PartialEq)]
pub struct ScrollPhysics {
    config: ScrollPhysicsConfig,
    content_extent: f64,
    viewport_extent: f64,
    position: f64,
    velocity: f64,
    dragging: bool,
    /// Pending animated destination for discrete wheel notches.
    wheel_target: Option<f64>,
    metrics: ScrollPhysicsMetrics,
}

impl ScrollPhysics {
    /// Creates a bounded scroll state at offset zero.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::InvalidScalar`] for invalid extents or coefficients.
    pub fn new(
        content_extent: f64,
        viewport_extent: f64,
        config: ScrollPhysicsConfig,
    ) -> Result<Self, ScrollError> {
        validate_extent(content_extent, "content extent")?;
        validate_extent(viewport_extent, "viewport extent")?;
        Ok(Self {
            config: config.validate()?,
            content_extent,
            viewport_extent,
            position: 0.0,
            velocity: 0.0,
            dragging: false,
            wheel_target: None,
            metrics: ScrollPhysicsMetrics::default(),
        })
    }

    /// Returns the current logical content offset.
    #[must_use]
    pub const fn position(&self) -> f64 {
        self.position
    }

    /// Returns the current viewport extent.
    #[must_use]
    pub const fn viewport_extent(&self) -> f64 {
        self.viewport_extent
    }

    /// Returns the current logical pixels per second.
    #[must_use]
    pub const fn velocity(&self) -> f64 {
        self.velocity
    }

    /// Returns the maximum in-bounds content offset.
    #[must_use]
    pub fn maximum_position(&self) -> f64 {
        (self.content_extent - self.viewport_extent).max(0.0)
    }

    /// Returns whether a pointer drag currently owns position updates.
    #[must_use]
    pub const fn is_dragging(&self) -> bool {
        self.dragging
    }

    /// Returns cumulative work counters.
    #[must_use]
    pub const fn metrics(&self) -> ScrollPhysicsMetrics {
        self.metrics
    }

    /// Updates content and viewport extents, preserving a valid position.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::InvalidScalar`] for a negative or non-finite extent.
    pub fn set_extents(
        &mut self,
        content_extent: f64,
        viewport_extent: f64,
    ) -> Result<(), ScrollError> {
        validate_extent(content_extent, "content extent")?;
        validate_extent(viewport_extent, "viewport extent")?;
        self.content_extent = content_extent;
        self.viewport_extent = viewport_extent;
        if let Some(target) = self.wheel_target {
            self.wheel_target = Some(target.clamp(0.0, self.maximum_position()));
        }
        if !self.dragging {
            let clamped = self.position.clamp(0.0, self.maximum_position());
            if changed(clamped, self.position) {
                self.position = clamped;
                self.velocity = 0.0;
                self.metrics.clamps = self.metrics.clamps.saturating_add(1);
            }
        }
        Ok(())
    }

    /// Starts direct manipulation and cancels prior fling velocity.
    pub fn begin_drag(&mut self) {
        self.dragging = true;
        self.velocity = 0.0;
        // Direct manipulation and high-precision deltas take over immediately;
        // a pending notch animation must not keep pulling the position.
        self.wheel_target = None;
    }

    /// Applies a logical content-offset delta with bounded edge resistance.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::InvalidScalar`] when `delta` is non-finite.
    pub fn drag_by(&mut self, delta: f64) -> Result<ScrollFrame, ScrollError> {
        validate_finite(delta, "scroll delta")?;
        if !self.dragging {
            self.begin_drag();
        }
        self.wheel_target = None;
        let previous = self.position;
        let maximum = self.maximum_position();
        let proposed = self.position + delta;
        let resisted = if proposed < 0.0 {
            -resisted_distance(-proposed, self.overscroll_limit())
        } else if proposed > maximum {
            maximum + resisted_distance(proposed - maximum, self.overscroll_limit())
        } else {
            proposed
        };
        self.position = resisted.clamp(-self.overscroll_limit(), maximum + self.overscroll_limit());
        if self.position == 0.0 {
            self.position = 0.0;
        }
        self.metrics.input_deltas = self.metrics.input_deltas.saturating_add(1);
        Ok(self.frame(changed(self.position, previous)))
    }

    /// Ends direct manipulation and starts a fling/rebound with logical pixels per second.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::InvalidScalar`] when `velocity` is non-finite.
    pub fn end_drag(&mut self, velocity: f64) -> Result<(), ScrollError> {
        validate_finite(velocity, "fling velocity")?;
        self.dragging = false;
        self.velocity = velocity;
        if velocity.abs() > f64::EPSILON {
            self.metrics.flings = self.metrics.flings.saturating_add(1);
        }
        Ok(())
    }

    /// Jumps programmatically to a hard-clamped offset and cancels animation.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::InvalidScalar`] when `position` is non-finite.
    pub fn jump_to(&mut self, position: f64) -> Result<ScrollFrame, ScrollError> {
        validate_finite(position, "scroll position")?;
        let previous = self.position;
        let clamped = position.clamp(0.0, self.maximum_position());
        if changed(clamped, position) {
            self.metrics.clamps = self.metrics.clamps.saturating_add(1);
        }
        self.position = clamped;
        self.velocity = 0.0;
        self.dragging = false;
        self.wheel_target = None;
        Ok(self.frame(changed(previous, clamped)))
    }

    /// Applies a measurement anchor correction without introducing velocity.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::InvalidScalar`] when `delta` is non-finite.
    pub fn correct_by(&mut self, delta: f64) -> Result<ScrollFrame, ScrollError> {
        validate_finite(delta, "anchor correction")?;
        let previous = self.position;
        self.position = (self.position + delta).clamp(0.0, self.maximum_position());
        Ok(self.frame(changed(previous, self.position)))
    }

    /// Advances one bounded deterministic integration step.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::InvalidScalar`] for a negative, non-finite, or oversized step.
    pub fn advance(&mut self, elapsed_seconds: f64) -> Result<ScrollFrame, ScrollError> {
        if !elapsed_seconds.is_finite()
            || elapsed_seconds < 0.0
            || elapsed_seconds > self.config.maximum_step_seconds
        {
            return Err(ScrollError::InvalidScalar {
                field: "elapsed seconds",
                value: elapsed_seconds,
            });
        }
        if elapsed_seconds == 0.0 || self.dragging {
            return Ok(self.frame(false));
        }
        if let Some(target) = self.wheel_target {
            return Ok(self.advance_wheel_animation(target, elapsed_seconds));
        }
        let previous = self.position;
        let maximum = self.maximum_position();
        let displacement = if self.position < 0.0 {
            self.position
        } else if self.position > maximum {
            self.position - maximum
        } else {
            0.0
        };
        if displacement.abs() <= f64::EPSILON {
            self.velocity /= 1.0 + self.config.deceleration * elapsed_seconds;
        } else {
            let acceleration = -self.config.spring_stiffness * displacement
                - self.config.spring_damping * self.velocity;
            self.velocity += acceleration * elapsed_seconds;
            self.metrics.rebound_frames = self.metrics.rebound_frames.saturating_add(1);
        }
        self.position += self.velocity * elapsed_seconds;
        let limit = self.overscroll_limit();
        self.position = self.position.clamp(-limit, maximum + limit);

        let target = self.position.clamp(0.0, maximum);
        if self.velocity.abs() <= self.config.stop_velocity
            && (self.position - target).abs() <= self.config.stop_distance
        {
            self.position = target;
            self.velocity = 0.0;
        }
        self.metrics.frames = self.metrics.frames.saturating_add(1);
        Ok(self.frame(changed(self.position, previous)))
    }

    /// Adds one discrete wheel notch to the animated destination.
    ///
    /// Discrete notches are clamped to the content bounds and never overscroll,
    /// matching browsers; consecutive notches accumulate into one animation.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::InvalidScalar`] when `delta` is non-finite.
    pub fn wheel_notch_by(&mut self, delta: f64) -> Result<ScrollFrame, ScrollError> {
        validate_finite(delta, "scroll delta")?;
        let maximum = self.maximum_position();
        let base = self.wheel_target.unwrap_or(self.position);
        let target = (base + delta).clamp(0.0, maximum);
        self.dragging = false;
        self.velocity = 0.0;
        self.metrics.input_deltas = self.metrics.input_deltas.saturating_add(1);
        if (target - self.position).abs() <= self.config.stop_distance {
            let previous = self.position;
            self.position = target;
            self.wheel_target = None;
            return Ok(self.frame(changed(self.position, previous)));
        }
        self.wheel_target = Some(target);
        Ok(self.frame(false))
    }

    /// Returns whether a discrete wheel animation is still running.
    #[must_use]
    pub const fn is_animating(&self) -> bool {
        self.wheel_target.is_some()
    }

    fn advance_wheel_animation(&mut self, target: f64, elapsed_seconds: f64) -> ScrollFrame {
        let previous = self.position;
        let factor = 1.0 - (-elapsed_seconds / WHEEL_ANIMATION_TAU_SECONDS).exp();
        self.position += (target - self.position) * factor;
        if (target - self.position).abs() <= self.config.stop_distance {
            self.position = target;
            self.wheel_target = None;
        }
        self.metrics.frames = self.metrics.frames.saturating_add(1);
        self.frame(changed(self.position, previous))
    }

    fn overscroll_limit(&self) -> f64 {
        self.viewport_extent * self.config.overscroll_viewport_fraction
    }

    fn frame(&self, changed: bool) -> ScrollFrame {
        let maximum = self.maximum_position();
        let overscrolled = self.position < 0.0 || self.position > maximum;
        ScrollFrame {
            position: self.position,
            velocity: self.velocity,
            active: !self.dragging
                && (self.velocity.abs() > f64::EPSILON
                    || overscrolled
                    || self.wheel_target.is_some()),
            changed,
            overscrolled,
        }
    }
}

fn resisted_distance(distance: f64, limit: f64) -> f64 {
    if limit == 0.0 {
        return 0.0;
    }
    distance / (1.0 + 3.0 * distance / limit)
}

fn changed(first: f64, second: f64) -> bool {
    first.to_bits() != second.to_bits()
}

fn validate_extent(value: f64, field: &'static str) -> Result<(), ScrollError> {
    if value.is_finite() && (0.0..=f64::from(f32::MAX)).contains(&value) {
        Ok(())
    } else {
        Err(ScrollError::InvalidScalar { field, value })
    }
}

fn validate_finite(value: f64, field: &'static str) -> Result<(), ScrollError> {
    if value.is_finite() {
        Ok(())
    } else {
        Err(ScrollError::InvalidScalar { field, value })
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn wheel_physics() -> ScrollPhysics {
        ScrollPhysics::new(
            2_000.0,
            500.0,
            ScrollPhysicsConfig::for_platform(ScrollPlatform::Ios),
        )
        .expect("physics")
    }

    /// Settles a pending notch animation and returns the frames it required.
    fn settle(physics: &mut ScrollPhysics) -> usize {
        for frame in 1..=1_000 {
            if !physics.advance(1.0 / 120.0).expect("frame").active {
                return frame;
            }
        }
        panic!("wheel animation never settled");
    }

    #[test]
    fn discrete_wheel_notches_accumulate_into_one_animation() {
        let mut physics = wheel_physics();
        physics.wheel_notch_by(100.0).expect("notch");
        assert!(physics.is_animating());
        // A notch must not jump: the offset is still behind its destination.
        assert!(physics.position() < 100.0);
        physics.advance(1.0 / 120.0).expect("frame");
        let partial = physics.position();
        assert!(partial > 0.0 && partial < 100.0);

        // A second notch mid-animation retargets rather than restarting.
        physics.wheel_notch_by(100.0).expect("notch");
        assert!(physics.position() >= partial);
        let frames = settle(&mut physics);
        assert!((physics.position() - 200.0).abs() <= f64::EPSILON);
        assert!(!physics.is_animating());
        // 120Hz frames: the animation is perceptibly smooth but still brief.
        assert!((5..=40).contains(&frames), "settled in {frames} frames");
    }

    #[test]
    fn discrete_wheel_notches_clamp_to_content_bounds_without_overscroll() {
        let mut physics = wheel_physics();
        physics.wheel_notch_by(10_000.0).expect("notch");
        settle(&mut physics);
        assert!((physics.position() - physics.maximum_position()).abs() <= f64::EPSILON);
        physics.wheel_notch_by(-10_000.0).expect("notch");
        settle(&mut physics);
        assert!(physics.position().abs() <= f64::EPSILON);
        assert!(!physics.frame(false).overscrolled);
    }

    #[test]
    fn direct_manipulation_cancels_a_pending_wheel_animation() {
        for cancel in [
            (|physics: &mut ScrollPhysics| physics.begin_drag()) as fn(&mut ScrollPhysics),
            |physics| {
                physics.drag_by(5.0).expect("drag");
            },
            |physics| {
                physics.jump_to(0.0).expect("jump");
            },
        ] {
            let mut physics = wheel_physics();
            physics.wheel_notch_by(400.0).expect("notch");
            assert!(physics.is_animating());
            cancel(&mut physics);
            assert!(
                !physics.is_animating(),
                "a high-precision or programmatic update must own the offset"
            );
        }
    }

    #[test]
    fn a_notch_smaller_than_the_stop_distance_applies_immediately() {
        let mut physics = wheel_physics();
        let frame = physics.wheel_notch_by(0.1).expect("notch");
        assert!(frame.changed);
        assert!(!physics.is_animating());
    }

    #[test]
    fn fling_coasts_then_settles_inside_bounds() {
        let mut physics = ScrollPhysics::new(
            2_000.0,
            500.0,
            ScrollPhysicsConfig::for_platform(ScrollPlatform::Ios),
        )
        .expect("physics");
        physics.jump_to(500.0).expect("position");
        physics.end_drag(2_000.0).expect("fling");
        for _ in 0..2_000 {
            let frame = physics.advance(1.0 / 120.0).expect("frame");
            if !frame.active {
                break;
            }
        }
        assert!((0.0..=physics.maximum_position()).contains(&physics.position()));
        assert!(physics.velocity().abs() <= f64::EPSILON);
    }

    #[test]
    fn drag_is_resisted_and_rebounds_from_both_edges() {
        let mut physics = ScrollPhysics::new(
            1_000.0,
            200.0,
            ScrollPhysicsConfig::for_platform(ScrollPlatform::Android),
        )
        .expect("physics");
        physics.begin_drag();
        assert!(physics.drag_by(-500.0).expect("drag").position < 0.0);
        assert!(physics.position() >= -60.0);
        physics.end_drag(0.0).expect("release");
        for _ in 0..1_000 {
            if !physics.advance(1.0 / 120.0).expect("frame").active {
                break;
            }
        }
        assert!(physics.position().abs() <= f64::EPSILON);
    }

    #[test]
    fn rejects_unbounded_coefficients_and_extents() {
        let mut config = ScrollPhysicsConfig::for_platform(ScrollPlatform::Android);
        config.maximum_step_seconds = 1.0;
        assert!(matches!(
            ScrollPhysics::new(1_000.0, 100.0, config),
            Err(ScrollError::InvalidScalar {
                field: "maximum step",
                ..
            })
        ));
        assert!(matches!(
            ScrollPhysics::new(
                f64::from(f32::MAX) * 2.0,
                100.0,
                ScrollPhysicsConfig::for_platform(ScrollPlatform::Android),
            ),
            Err(ScrollError::InvalidScalar {
                field: "content extent",
                ..
            })
        ));
    }

    #[test]
    fn public_state_transitions_validate_inputs_and_report_clamps() {
        let mut physics = ScrollPhysics::new(
            1_000.0,
            100.0,
            ScrollPhysicsConfig::for_platform(ScrollPlatform::Android),
        )
        .expect("physics");
        assert!(!physics.is_dragging());
        physics.jump_to(900.0).expect("end");
        physics.set_extents(200.0, 100.0).expect("smaller extent");
        assert_eq!(physics.position().to_bits(), 100.0_f64.to_bits());
        assert_eq!(physics.metrics().clamps, 1);
        assert!(physics.drag_by(5.0).expect("implicit drag").changed);
        assert!(physics.is_dragging());
        assert!(!physics.advance(0.0).expect("drag frame").changed);
        physics.end_drag(0.0).expect("end drag");
        assert!(physics.jump_to(-10.0).expect("clamp start").changed);
        assert_eq!(physics.metrics().clamps, 2);
        assert!(physics.correct_by(25.0).expect("correction").changed);

        for error in [
            physics.drag_by(f64::NAN).expect_err("delta"),
            physics.end_drag(f64::INFINITY).expect_err("velocity"),
            physics.jump_to(f64::NEG_INFINITY).expect_err("position"),
            physics.correct_by(f64::NAN).expect_err("correction"),
            physics.advance(-1.0).expect_err("elapsed"),
        ] {
            assert!(matches!(error, ScrollError::InvalidScalar { .. }));
        }
        assert!(matches!(
            physics.set_extents(-1.0, 100.0),
            Err(ScrollError::InvalidScalar {
                field: "content extent",
                ..
            })
        ));
    }

    #[test]
    fn zero_overscroll_policy_hard_clamps_direct_manipulation() {
        let mut config = ScrollPhysicsConfig::for_platform(ScrollPlatform::Android);
        config.overscroll_viewport_fraction = 0.0;
        let mut physics = ScrollPhysics::new(100.0, 100.0, config).expect("physics");
        assert_eq!(
            physics.drag_by(-100.0).expect("drag").position.to_bits(),
            0.0_f64.to_bits()
        );
    }

    proptest! {
        #[test]
        fn arbitrary_input_never_escapes_the_bounded_overscroll_envelope(
            deltas in prop::collection::vec(-1_000.0_f64..1_000.0, 0..256),
        ) {
            let config = ScrollPhysicsConfig::for_platform(ScrollPlatform::Ios);
            let mut physics = ScrollPhysics::new(10_000.0, 400.0, config).expect("physics");
            physics.begin_drag();
            for delta in deltas {
                let frame = physics.drag_by(delta).expect("drag");
                let limit = 400.0 * config.overscroll_viewport_fraction;
                prop_assert!(frame.position >= -limit);
                prop_assert!(frame.position <= physics.maximum_position() + limit);
                prop_assert!(frame.position.is_finite());
            }
        }
    }
}
