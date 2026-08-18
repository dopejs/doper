use crate::ScrollError;

/// Tunable platform family. Defaults are deterministic starting points, not qualification claims.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScrollPlatform {
    /// iOS-style longer coast and elastic edge response.
    Ios,
    /// Android-style faster coast and tighter edge response.
    Android,
}

/// How a released flick coasts to a stop.
///
/// The two platform families do not merely differ by a constant. iOS decays
/// velocity exponentially, so distance is proportional to the release speed.
/// Android follows a spline whose distance grows as roughly `v^1.74`, so a
/// single decay coefficient can only agree with it at one speed: calibrated at
/// a firm flick it overshoots a gentle one by nearly three times and falls the
/// same factor short of a hard one, which reads as the list not responding in
/// proportion to the gesture.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FlingModel {
    /// `v(t) = v0 * e^(-deceleration * t)`, which is what `UIScrollView` does.
    ExponentialDecay,
    /// AOSP's spline fling, reproduced from its distance and duration.
    ///
    /// `coefficient` is `ViewConfiguration.getScrollFriction()` times
    /// `SensorManager.GRAVITY_EARTH * 39.37 * ppi * 0.84`, evaluated in logical
    /// pixels, which AOSP calls `mFlingFriction * mPhysicalCoeff`.
    AndroidSpline { coefficient: f64 },
}

/// AOSP's `INFLEXION`: the ratio of a fling's mean speed to its release speed.
const ANDROID_INFLEXION: f64 = 0.35;

/// Validated coefficients for deterministic one-dimensional scrolling.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollPhysicsConfig {
    /// Per-second velocity decay coefficient, used by the exponential model.
    pub deceleration: f64,
    /// How a released flick coasts.
    pub fling: FlingModel,
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
    /// Ceiling on the release speed a flick may hand to the fling.
    ///
    /// A velocity estimate is a measurement, and a single fast sample can imply
    /// a speed no finger produced. Unclamped, AOSP's spline turns 24000 px/s
    /// into a five-second, thirty-thousand-pixel coast. Real toolkits clamp for
    /// the same reason: AOSP publishes 8000 as
    /// `ViewConfiguration.getScaledMaximumFlingVelocity`.
    pub maximum_fling_velocity: f64,
}

impl ScrollPhysicsConfig {
    /// Returns the default coefficient set for a platform family.
    #[must_use]
    pub const fn for_platform(platform: ScrollPlatform) -> Self {
        match platform {
            // UIScrollView's normal `decelerationRate` is 0.998 per millisecond,
            // so velocity follows `v0 * 0.998^(1000t)`, which is `v0 * e^(-2.002t)`.
            // This integrator's `v /= 1 + d*dt` approaches `v0 * e^(-d*t)`, so `d`
            // is that exponent. The previous 7.5 coasted to a stop in roughly a
            // quarter of the distance, which reads as having almost no inertia
            // next to a native list. (0.99 -- the "fast" rate -- would be 10.05.)
            ScrollPlatform::Ios => Self {
                deceleration: 2.0,
                fling: FlingModel::ExponentialDecay,
                spring_stiffness: 260.0,
                spring_damping: 28.0,
                overscroll_viewport_fraction: 0.5,
                stop_velocity: 2.0,
                stop_distance: 0.25,
                maximum_step_seconds: 1.0 / 30.0,
                // iOS publishes no equivalent constant, so this is a guard
                // against a noisy estimate rather than a platform value.
                maximum_fling_velocity: 8_000.0,
            },
            ScrollPlatform::Android => Self {
                // 0.015 friction times 9.80665 * 39.37 * 160 * 0.84, the
                // physical coefficient at one logical pixel per density unit.
                fling: FlingModel::AndroidSpline {
                    coefficient: 0.015 * 9.806_65 * 39.37 * 160.0 * 0.84,
                },
                // Unused by the spline model; retained for the preheat decay.
                deceleration: 11.5,
                spring_stiffness: 340.0,
                spring_damping: 38.0,
                overscroll_viewport_fraction: 0.3,
                stop_velocity: 2.0,
                stop_distance: 0.25,
                maximum_step_seconds: 1.0 / 30.0,
                maximum_fling_velocity: 8_000.0,
            },
        }
    }

    fn validate(self) -> Result<Self, ScrollError> {
        for (field, value, minimum, maximum) in [
            ("deceleration", self.deceleration, f64::EPSILON, 1_000.0),
            (
                "maximum fling velocity",
                self.maximum_fling_velocity,
                f64::EPSILON,
                1_000_000.0,
            ),
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

/// Duration of the discrete wheel-notch animation.
///
/// Browsers animate a wheel notch over a bounded, short interval rather than
/// easing toward it asymptotically. The duration is what the gesture actually
/// costs, so it has to stay close to the desktop smooth-scroll feel: an
/// exponential approach with a stop threshold spends its final third covering
/// a couple of pixels, which reads as sluggish scrolling even though the total
/// distance is right.
const WHEEL_ANIMATION_SECONDS: f64 = 0.12;

/// Plans a fling from AOSP's closed forms for distance and duration.
fn plan_spline_fling(start: f64, velocity: f64, coefficient: f64) -> SplineFling {
    // AOSP: l = ln(INFLEXION * |v| / (friction * physicalCoeff)),
    // distance = friction * physicalCoeff * exp(rate / (rate - 1) * l),
    // duration = 1000ms * exp(l / (rate - 1)), with rate = ln(0.78) / ln(0.9).
    let rate = 0.78_f64.ln() / 0.9_f64.ln();
    let decel_minus_one = rate - 1.0;
    let l = (ANDROID_INFLEXION * velocity.abs() / coefficient).ln();
    let distance = coefficient * (rate / decel_minus_one * l).exp();
    let duration_seconds = (l / decel_minus_one).exp();
    SplineFling {
        start,
        distance: distance.copysign(velocity),
        duration_seconds: duration_seconds.max(f64::EPSILON),
        elapsed_seconds: 0.0,
    }
}

/// One in-flight AOSP-style spline fling.
///
/// Distance and duration come straight from AOSP's closed forms. Its velocity
/// then follows `v0 * (1 - t/T)^k`, whose mean is `v0 / (k + 1)`; AOSP defines
/// that mean to be `INFLEXION * v0`, which fixes `k` and makes this reproduce
/// both the distance and the duration exactly at every release speed.
#[derive(Clone, Copy, Debug, PartialEq)]
struct SplineFling {
    start: f64,
    /// Signed distance the flick will travel.
    distance: f64,
    duration_seconds: f64,
    elapsed_seconds: f64,
}

impl SplineFling {
    /// Velocity decay exponent implied by AOSP's mean-to-release speed ratio.
    const DECAY: f64 = 1.0 / ANDROID_INFLEXION - 1.0;

    /// Fraction of the total distance covered after `elapsed / duration`.
    fn travelled_fraction(self) -> f64 {
        let progress = (self.elapsed_seconds / self.duration_seconds).clamp(0.0, 1.0);
        1.0 - (1.0 - progress).powf(Self::DECAY + 1.0)
    }

    /// Current speed, so cache planning can still look ahead of the motion.
    fn velocity(self) -> f64 {
        let progress = (self.elapsed_seconds / self.duration_seconds).clamp(0.0, 1.0);
        let peak = self.distance / (ANDROID_INFLEXION * self.duration_seconds);
        peak * (1.0 - progress).powf(Self::DECAY)
    }
}

/// One in-flight discrete wheel animation.
#[derive(Clone, Copy, Debug, PartialEq)]
struct WheelAnimation {
    /// Offset the animation started from.
    start: f64,
    /// Offset the animation lands on.
    target: f64,
    /// Time already spent animating.
    elapsed_seconds: f64,
}

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
    wheel_animation: Option<WheelAnimation>,
    /// In-flight spline fling, on platforms that coast that way.
    spline_fling: Option<SplineFling>,
    /// Recent input speed used only to look ahead when planning caches.
    ///
    /// This is deliberately separate from `velocity`: a trackpad gesture must
    /// not coast after the fingers lift, because the platform already sends its
    /// own momentum samples, but the virtualizer still has to know which way
    /// the content is moving so it can preheat ahead of it.
    preheat_velocity: f64,
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
            wheel_animation: None,
            spline_fling: None,
            preheat_velocity: 0.0,
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
    pub fn velocity(&self) -> f64 {
        // A spline fling carries the motion instead of `velocity`, so report its
        // current speed or the virtualizer stops preheating mid-flick.
        self.spline_fling.map_or(self.velocity, |fling| {
            fling.velocity().copysign(fling.distance)
        })
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
        let maximum = self.maximum_position();
        if let Some(animation) = self.wheel_animation.as_mut() {
            animation.start = animation.start.clamp(0.0, maximum);
            animation.target = animation.target.clamp(0.0, maximum);
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
        self.wheel_animation = None;
        self.spline_fling = None;
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
        self.wheel_animation = None;
        self.spline_fling = None;
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
        let velocity = velocity.clamp(
            -self.config.maximum_fling_velocity,
            self.config.maximum_fling_velocity,
        );
        self.dragging = false;
        self.velocity = velocity;
        self.spline_fling = None;
        if velocity.abs() > f64::EPSILON {
            self.metrics.flings = self.metrics.flings.saturating_add(1);
            if let FlingModel::AndroidSpline { coefficient } = self.config.fling {
                self.spline_fling = Some(plan_spline_fling(self.position, velocity, coefficient));
                // The spline owns the motion from here; leaving a velocity
                // behind would let the exponential path move it as well.
                self.velocity = 0.0;
            }
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
        self.wheel_animation = None;
        self.spline_fling = None;
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
        // The lookahead speed reflects recent input, so it has to fade once the
        // input stops; otherwise a finished gesture keeps preheating forward.
        self.preheat_velocity /= 1.0 + self.config.deceleration * elapsed_seconds;
        if self.preheat_velocity.abs() <= self.config.stop_velocity {
            self.preheat_velocity = 0.0;
        }
        if elapsed_seconds == 0.0 || self.dragging {
            return Ok(self.frame(false));
        }
        if self.wheel_animation.is_some() {
            return Ok(self.advance_wheel_animation(elapsed_seconds));
        }
        if self.spline_fling.is_some() {
            return Ok(self.advance_spline_fling(elapsed_seconds));
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
        let base = self
            .wheel_animation
            .as_ref()
            .map_or(self.position, |animation| animation.target);
        let target = (base + delta).clamp(0.0, maximum);
        self.dragging = false;
        self.velocity = 0.0;
        self.metrics.input_deltas = self.metrics.input_deltas.saturating_add(1);
        if (target - self.position).abs() <= self.config.stop_distance {
            let previous = self.position;
            self.position = target;
            self.wheel_animation = None;
            self.spline_fling = None;
            return Ok(self.frame(changed(self.position, previous)));
        }
        // A notch arriving mid-animation retargets from where the offset is
        // now, so a fast wheel spin never falls further and further behind.
        self.wheel_animation = Some(WheelAnimation {
            start: self.position,
            target,
            elapsed_seconds: 0.0,
        });
        // The animation covers this distance in a fixed time, so it is also the
        // speed the viewport is about to travel at. Recording it lets preheat
        // lead the gesture; without it, the only prediction available is the
        // animation target, which never reaches beyond the notch in flight.
        self.note_input_speed((target - self.position) / WHEEL_ANIMATION_SECONDS);
        Ok(self.frame(false))
    }

    /// Records the observed input speed in logical pixels per second.
    ///
    /// Callers pass the speed of the gesture itself, not a fling velocity: this
    /// never makes the offset move on its own.
    pub fn note_input_speed(&mut self, pixels_per_second: f64) {
        if pixels_per_second.is_finite() {
            self.preheat_velocity = pixels_per_second;
        }
    }

    /// Returns the offset caches should be planned around.
    ///
    /// A pending notch animation has an exact destination, so it is used
    /// directly. Otherwise the offset is projected from whichever speed is
    /// larger: a fling that is still coasting, or the gesture currently
    /// driving the offset.
    #[must_use]
    pub fn lookahead_position(&self, horizon_seconds: f64) -> f64 {
        // The accessor, not the field: a spline fling carries the motion
        // outside `velocity`, and reading the field leaves preheat blind for
        // the whole coast.
        let moving = self.velocity();
        let speed = if moving.abs() >= self.preheat_velocity.abs() {
            moving
        } else {
            self.preheat_velocity
        };
        let horizon = if horizon_seconds.is_finite() {
            horizon_seconds.max(0.0)
        } else {
            0.0
        };
        let projected = self.position + speed * horizon;
        // A notch animation only ever aims one notch ahead, so on a sustained
        // gesture it under-predicts badly: the offset outruns the preheat
        // window every frame and the viewport lands on rows nobody asked for.
        // Take whichever prediction reaches further along the travel, and never
        // predict against it.
        match self.wheel_animation {
            Some(animation) if animation.target >= self.position => projected.max(animation.target),
            Some(animation) => projected.min(animation.target),
            None => projected,
        }
    }

    /// Advances an AOSP-style fling and hands over to the spring at a bound.
    fn advance_spline_fling(&mut self, elapsed_seconds: f64) -> ScrollFrame {
        let Some(mut fling) = self.spline_fling else {
            return self.frame(false);
        };
        let previous = self.position;
        fling.elapsed_seconds += elapsed_seconds;
        let target = fling.start + fling.distance * fling.travelled_fraction();
        let maximum = self.maximum_position();
        if target < 0.0 || target > maximum {
            // Past the edge the spring owns the motion, so the fling stops and
            // hands it the speed it had when it arrived.
            self.spline_fling = None;
            self.velocity = fling.velocity().copysign(fling.distance);
            self.position =
                target.clamp(-self.overscroll_limit(), maximum + self.overscroll_limit());
            return self.frame(changed(self.position, previous));
        }
        self.position = target;
        if fling.elapsed_seconds >= fling.duration_seconds {
            self.spline_fling = None;
            self.velocity = 0.0;
        } else {
            self.spline_fling = Some(fling);
        }
        self.metrics.frames = self.metrics.frames.saturating_add(1);
        self.frame(changed(self.position, previous))
    }

    /// Returns whether a discrete wheel animation is still running.
    #[must_use]
    pub const fn is_animating(&self) -> bool {
        self.wheel_animation.is_some() || self.spline_fling.is_some()
    }

    fn advance_wheel_animation(&mut self, elapsed_seconds: f64) -> ScrollFrame {
        let previous = self.position;
        let Some(mut animation) = self.wheel_animation else {
            return self.frame(false);
        };
        animation.elapsed_seconds += elapsed_seconds;
        let progress = (animation.elapsed_seconds / WHEEL_ANIMATION_SECONDS).clamp(0.0, 1.0);
        // Cubic ease-out: fast at the start, and finished exactly on time.
        let eased = 1.0 - (1.0 - progress).powi(3);
        self.position = animation.start + (animation.target - animation.start) * eased;
        if progress >= 1.0 {
            self.position = animation.target;
            self.wheel_animation = None;
            self.spline_fling = None;
        } else {
            self.wheel_animation = Some(animation);
        }
        self.metrics.frames = self.metrics.frames.saturating_add(1);
        self.frame(changed(self.position, previous))
    }

    fn overscroll_limit(&self) -> f64 {
        // An axis with nothing to scroll does not rubber-band. A trackpad emits
        // a small cross-axis delta throughout an ordinary vertical gesture, so
        // without this a list whose content is exactly as wide as its viewport
        // wobbles sideways the whole way down.
        if self.maximum_position() <= 0.0 {
            return 0.0;
        }
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
                    || self.wheel_animation.is_some()),
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

    /// Frames a duration covers when integrating at the 120Hz physics step.
    fn frames_at_120hz(seconds: f64) -> usize {
        let mut frames = 0;
        let mut elapsed = 0.0;
        while elapsed < seconds - f64::EPSILON {
            elapsed += 1.0 / 120.0;
            frames += 1;
        }
        frames
    }

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
        // The animation has a bounded duration rather than an asymptotic tail:
        // at 120Hz it must finish within a frame of WHEEL_ANIMATION_SECONDS.
        let expected = frames_at_120hz(WHEEL_ANIMATION_SECONDS);
        assert!(
            (expected..=expected + 1).contains(&frames),
            "settled in {frames} frames, expected about {expected}"
        );
    }

    #[test]
    fn a_wheel_notch_always_finishes_within_its_bounded_duration() {
        // A long asymptotic tail is what makes wheel scrolling feel sluggish,
        // so the contract is the completion time, not just the destination.
        let mut physics = wheel_physics();
        physics.wheel_notch_by(400.0).expect("notch");
        let mut elapsed = 0.0;
        let step = 1.0 / 120.0;
        while physics.is_animating() {
            physics.advance(step).expect("frame");
            elapsed += step;
            assert!(
                elapsed <= WHEEL_ANIMATION_SECONDS + step * 2.0,
                "tail at {elapsed}s"
            );
        }
        assert!(elapsed >= WHEEL_ANIMATION_SECONDS - step * 2.0);
        // Ease-out: most of the distance is covered in the first half.
        let mut halfway = wheel_physics();
        halfway.wheel_notch_by(400.0).expect("notch");
        for _ in 0..frames_at_120hz(WHEEL_ANIMATION_SECONDS) / 2 {
            halfway.advance(step).expect("frame");
        }
        assert!(halfway.position() > 200.0, "at {}", halfway.position());
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

    #[test]
    fn an_axis_with_nothing_to_scroll_does_not_rubber_band() {
        // Reported from the playground: a list whose content is exactly as wide
        // as its viewport wobbled sideways for the whole of a vertical gesture.
        // A trackpad carries a small cross-axis delta throughout, and the
        // horizontal axis rubber-banded it even though there was nowhere to go.
        let mut physics = ScrollPhysics::new(
            640.0,
            640.0,
            ScrollPhysicsConfig::for_platform(ScrollPlatform::Ios),
        )
        .expect("physics");
        assert!(physics.maximum_position() <= 0.0);

        for _ in 0..30 {
            let frame = physics.drag_by(6.0).expect("cross-axis delta");
            assert!(
                frame.position.abs() < f64::EPSILON,
                "a non-scrollable axis must not move"
            );
            assert!(!frame.overscrolled, "a non-scrollable axis must not bounce");
        }
        physics.end_drag(0.0).expect("release");
        physics.advance(1.0 / 60.0).expect("settle");
        assert!(physics.position().abs() < f64::EPSILON);

        // A scrollable axis still bounces at its edge.
        let mut scrollable = ScrollPhysics::new(
            2_000.0,
            640.0,
            ScrollPhysicsConfig::for_platform(ScrollPlatform::Ios),
        )
        .expect("physics");
        let frame = scrollable.drag_by(-40.0).expect("overscroll");
        assert!(frame.position < 0.0, "a scrollable axis still rubber-bands");
    }
    #[test]
    fn an_ios_flick_coasts_about_as_far_as_uiscrollview_does() {
        // Reported from a phone: the list had almost no inertia next to a native
        // one. The integrator approaches `v0 * e^(-d*t)`, so a flick travels
        // `v0 / d`. UIScrollView's normal rate is 0.998 per millisecond, which
        // is an exponent of 2.002, so a 2000 px/s release should coast about a
        // thousand pixels. At the previous 7.5 it managed under three hundred.
        let coast = |platform| {
            let mut physics = ScrollPhysics::new(
                1_000_000.0,
                800.0,
                ScrollPhysicsConfig::for_platform(platform),
            )
            .expect("physics");
            physics.begin_drag();
            physics.end_drag(2_000.0).expect("release");
            for _ in 0..600 {
                physics.advance(1.0 / 60.0).expect("frame");
            }
            physics.position()
        };

        let ios = coast(ScrollPlatform::Ios);
        assert!(
            (900.0..1_100.0).contains(&ios),
            "an iOS flick should coast about v0/2.002 pixels, travelled {ios}"
        );
        // Android is not a scaled iOS: AOSP's spline puts a 2000 px/s release at
        // 647 pixels over 925ms, and that exact number is what this reproduces.
        let android = coast(ScrollPlatform::Android);
        assert!(
            (640.0..655.0).contains(&android),
            "an Android flick should coast AOSP's 647 pixels, travelled {android}"
        );
    }
    #[test]
    fn an_android_flick_scales_with_the_gesture_the_way_aosp_does() {
        // The reason a single decay coefficient feels wrong on Android is not
        // that it is the wrong size: AOSP's spline puts distance at roughly
        // `v^1.74`, while exponential decay is linear in `v`. Calibrating one
        // coefficient at a firm flick therefore overshoots a gentle one by
        // nearly three times and falls the same factor short of a hard one, so
        // the list stops responding in proportion to the gesture.
        let coast = |velocity: f64| {
            let mut physics = ScrollPhysics::new(
                10_000_000.0,
                800.0,
                ScrollPhysicsConfig::for_platform(ScrollPlatform::Android),
            )
            .expect("physics");
            physics.begin_drag();
            physics.end_drag(velocity).expect("release");
            for _ in 0..1_200 {
                physics.advance(1.0 / 120.0).expect("frame");
            }
            physics.position()
        };

        // AOSP's closed form at 160dpi-equivalent logical pixels.
        for (velocity, expected) in [(500.0, 58.3), (2_000.0, 647.4), (8_000.0, 7_186.4)] {
            let travelled = coast(velocity);
            let error = (travelled - expected).abs() / expected;
            assert!(
                error < 0.02,
                "{velocity} px/s should coast {expected}, travelled {travelled}"
            );
        }

        // The point of the spline, stated as the property it gives: four times
        // the release speed travels far more than four times the distance.
        assert!(coast(8_000.0) / coast(2_000.0) > 8.0);
    }

    #[test]
    fn a_flick_that_reaches_the_edge_hands_over_to_the_spring() {
        // The spline owns the motion until a bound, where the existing rebound
        // has to take it; otherwise a fling would run straight through the edge.
        let mut physics = ScrollPhysics::new(
            2_000.0,
            800.0,
            ScrollPhysicsConfig::for_platform(ScrollPlatform::Android),
        )
        .expect("physics");
        physics.begin_drag();
        physics.end_drag(20_000.0).expect("release");
        for _ in 0..600 {
            physics.advance(1.0 / 120.0).expect("frame");
        }
        assert!(
            !physics.is_animating(),
            "the fling must not outlive the edge"
        );
        assert!(
            (physics.position() - physics.maximum_position()).abs() < 0.5,
            "it should settle exactly on the bound, at {}",
            physics.position()
        );
    }
    #[test]
    fn a_release_speed_no_finger_produced_is_clamped() {
        // A velocity estimate is a measurement: one fast sample can imply a
        // speed no gesture produced. AOSP's spline turns 24000 px/s into a
        // five-second, thirty-thousand-pixel coast, so the release is clamped
        // the way real toolkits clamp it.
        let coast = |velocity: f64| {
            let mut physics = ScrollPhysics::new(
                10_000_000.0,
                800.0,
                ScrollPhysicsConfig::for_platform(ScrollPlatform::Android),
            )
            .expect("physics");
            physics.begin_drag();
            physics.end_drag(velocity).expect("release");
            let mut frames = 0;
            while physics.is_animating() && frames < 2_000 {
                physics.advance(1.0 / 120.0).expect("frame");
                frames += 1;
            }
            (physics.position(), frames)
        };

        let (clamped, frames) = coast(24_000.0);
        let (ceiling, _) = coast(8_000.0);
        assert!(
            (clamped - ceiling).abs() < 1.0,
            "beyond the ceiling every release should coast the same: {clamped} against {ceiling}"
        );
        assert!(
            frames < 2_000,
            "a clamped fling must still finish, took {frames} frames"
        );
    }
}
