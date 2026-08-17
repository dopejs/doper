use core::ops::Range;

use crate::{HeightIndex, ScrollError, ScrollPhysics, ScrollPhysicsConfig, ScrollPlatform};

/// Directional preheat and prediction policy.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VirtualizerConfig {
    /// Symmetric baseline cache extent measured in viewport multiples.
    pub base_overscan_viewports: f64,
    /// Velocity projection horizon used ahead of the current direction.
    pub velocity_horizon_seconds: f64,
    /// Maximum projected leading extent measured in viewport multiples.
    pub maximum_ahead_viewports: f64,
}

impl Default for VirtualizerConfig {
    fn default() -> Self {
        Self {
            base_overscan_viewports: 1.0,
            velocity_horizon_seconds: 0.25,
            maximum_ahead_viewports: 4.0,
        }
    }
}

impl VirtualizerConfig {
    fn validate(self) -> Result<Self, ScrollError> {
        for (field, value, maximum) in [
            (
                "base overscan viewports",
                self.base_overscan_viewports,
                64.0,
            ),
            (
                "velocity horizon seconds",
                self.velocity_horizon_seconds,
                10.0,
            ),
            (
                "maximum ahead viewports",
                self.maximum_ahead_viewports,
                64.0,
            ),
        ] {
            if !value.is_finite() || value < 0.0 || value > maximum {
                return Err(ScrollError::InvalidScalar { field, value });
            }
        }
        Ok(self)
    }
}

/// Cumulative visibility, cache, and measurement-correction counters.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct VirtualizerMetrics {
    /// Planned render frames.
    pub frames: u64,
    /// Available visible items across frames.
    pub cache_hits: u64,
    /// Placeholder visible items across frames.
    pub cache_misses: u64,
    /// Coalesced refill ranges emitted for Shell work outside the render frame.
    pub refill_requests: u64,
    /// Individual items covered by refill requests.
    pub refill_items: u64,
    /// Measured-height changes applied.
    pub measurement_corrections: u64,
}

/// Borrowed result of one allocation-reusing virtual-range plan.
#[derive(Clone, Debug, PartialEq)]
pub struct VirtualFrame<'a> {
    /// Items intersecting the viewport.
    pub visible: Range<usize>,
    /// Directionally preheated item range.
    pub preheat: Range<usize>,
    /// Newly missing ranges for asynchronous Shell refill after this render frame.
    pub refill: &'a [Range<usize>],
    /// Current logical content offset.
    pub position: f64,
    /// Total logical content extent.
    pub content_extent: f64,
    /// Placeholder items in the visible range.
    pub placeholders: usize,
}

/// Core-side million-item range planner; it never calls Shell from a render frame.
#[derive(Clone, Debug, PartialEq)]
pub struct Virtualizer {
    heights: HeightIndex,
    physics: ScrollPhysics,
    config: VirtualizerConfig,
    available: Vec<bool>,
    requested: Vec<bool>,
    /// Requested-but-unanswered items, reused across frames without allocating.
    pending: Vec<usize>,
    refill: Vec<Range<usize>>,
    metrics: VirtualizerMetrics,
}

impl Virtualizer {
    /// Creates a planner whose items initially require refill.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::InvalidScalar`] for invalid viewport or preheat policy values.
    pub fn new(
        heights: HeightIndex,
        viewport_extent: f64,
        platform: ScrollPlatform,
        config: VirtualizerConfig,
    ) -> Result<Self, ScrollError> {
        let config = config.validate()?;
        let physics = ScrollPhysics::new(
            heights.total_extent(),
            viewport_extent,
            ScrollPhysicsConfig::for_platform(platform),
        )?;
        let len = heights.len();
        Ok(Self {
            heights,
            physics,
            config,
            available: vec![false; len],
            requested: vec![false; len],
            pending: Vec::new(),
            refill: Vec::new(),
            metrics: VirtualizerMetrics::default(),
        })
    }

    /// Returns the variable-height index.
    #[must_use]
    pub const fn heights(&self) -> &HeightIndex {
        &self.heights
    }

    /// Returns mutable scroll physics for input integration.
    #[must_use]
    pub const fn physics_mut(&mut self) -> &mut ScrollPhysics {
        &mut self.physics
    }

    /// Returns immutable scroll physics.
    #[must_use]
    pub const fn physics(&self) -> &ScrollPhysics {
        &self.physics
    }

    /// Returns cumulative visibility and refill counters.
    #[must_use]
    pub const fn metrics(&self) -> VirtualizerMetrics {
        self.metrics
    }

    /// Updates the viewport extent while preserving the current logical item index.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::InvalidScalar`] for a negative or non-finite extent.
    pub fn set_viewport_extent(&mut self, viewport_extent: f64) -> Result<(), ScrollError> {
        self.physics
            .set_extents(self.heights.total_extent(), viewport_extent)
    }

    /// Returns retained heap bytes for index, availability bitmaps, and refill ranges.
    #[must_use]
    pub fn estimated_heap_bytes(&self) -> usize {
        self.heights
            .estimated_heap_bytes()
            .saturating_add(self.available.capacity().div_ceil(8))
            .saturating_add(self.requested.capacity().div_ceil(8))
            .saturating_add(
                self.refill
                    .capacity()
                    .saturating_mul(core::mem::size_of::<Range<usize>>()),
            )
    }

    /// Marks a half-open item range as ready in Core cache and clears pending requests.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::IndexOutOfBounds`] when the range is invalid.
    pub fn mark_available(&mut self, range: Range<usize>) -> Result<(), ScrollError> {
        self.validate_range(&range)?;
        for index in range {
            self.available[index] = true;
            self.requested[index] = false;
        }
        Ok(())
    }

    /// Invalidates a half-open item range and makes it eligible for a new refill request.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::IndexOutOfBounds`] when the range is invalid.
    pub fn mark_unavailable(&mut self, range: Range<usize>) -> Result<(), ScrollError> {
        self.validate_range(&range)?;
        for index in range {
            self.available[index] = false;
            self.requested[index] = false;
        }
        Ok(())
    }

    /// Returns whether the Shell has materialized an item.
    #[must_use]
    pub fn is_available(&self, index: usize) -> bool {
        self.available.get(index).copied().unwrap_or(false)
    }

    /// Applies a measured height and preserves the first visible item's visual anchor.
    ///
    /// # Errors
    ///
    /// Returns an index, height, extent, or arithmetic validation error.
    pub fn update_height(&mut self, index: usize, height: f32) -> Result<f64, ScrollError> {
        let anchor = self.heights.index_at_offset(self.physics.position())?;
        let previous_position = self.physics.position();
        let delta = self.heights.update(index, height)?;
        self.physics
            .set_extents(self.heights.total_extent(), self.viewport_extent())?;
        if delta != 0.0 {
            self.metrics.measurement_corrections =
                self.metrics.measurement_corrections.saturating_add(1);
            if index < anchor {
                let desired = previous_position + delta;
                self.physics.correct_by(desired - self.physics.position())?;
            }
        }
        Ok(delta)
    }

    /// Inserts an unavailable item and rebuilds structural prefix state.
    ///
    /// # Errors
    ///
    /// Returns an index, height, extent, or arithmetic validation error.
    pub fn insert(&mut self, index: usize, height: f32) -> Result<(), ScrollError> {
        self.heights.insert(index, height)?;
        self.available.insert(index, false);
        self.requested.insert(index, false);
        self.physics
            .set_extents(self.heights.total_extent(), self.viewport_extent())
    }

    /// Removes one item and returns its last known height.
    ///
    /// # Errors
    ///
    /// Returns an index, extent, or arithmetic validation error.
    pub fn remove(&mut self, index: usize) -> Result<f32, ScrollError> {
        let height = self.heights.remove(index)?;
        self.available.remove(index);
        self.requested.remove(index);
        self.physics
            .set_extents(self.heights.total_extent(), self.viewport_extent())?;
        Ok(height)
    }

    /// Plans visible/preheat ranges and records refill demand without invoking a callback.
    ///
    /// # Errors
    ///
    /// Returns an extent or prefix-index validation error.
    pub fn plan_frame(&mut self) -> Result<VirtualFrame<'_>, ScrollError> {
        let viewport = self.viewport_extent();
        let position = self
            .physics
            .position()
            .clamp(0.0, self.physics.maximum_position());
        let visible = self.heights.visible_range(position, viewport)?;
        let base = viewport * self.config.base_overscan_viewports;
        // Preheat around where the offset is heading, not only where it is.
        // Wheel input never leaves a fling velocity behind, so projecting from
        // `velocity` alone left the window symmetric and one viewport wide: a
        // fast gesture outran it every frame and the viewport fell outside the
        // materialized range.
        let destination = self
            .physics
            .lookahead_position(self.config.velocity_horizon_seconds)
            .clamp(0.0, self.physics.maximum_position());
        let travel = (destination - position).clamp(
            -viewport * self.config.maximum_ahead_viewports,
            viewport * self.config.maximum_ahead_viewports,
        );
        let (before, after) = if travel < 0.0 {
            (base + travel.abs(), base)
        } else {
            (base, base + travel)
        };
        let preheat_start = (position - before).max(0.0);
        let preheat_extent = viewport + before + after;
        let preheat = self.heights.visible_range(preheat_start, preheat_extent)?;

        let mut placeholders = 0_usize;
        let mut hits = 0_u64;
        for index in visible.clone() {
            if self.available[index] {
                hits = hits.saturating_add(1);
            } else {
                placeholders = placeholders.saturating_add(1);
            }
        }
        // An item that was requested but never materialized -- the window moved
        // on before the Shell answered -- must become requestable again, or it
        // stays permanently blank the next time it scrolls into view.
        for index in self.pending.drain(..) {
            if !preheat.contains(&index) {
                self.requested[index] = false;
            }
        }
        self.refill.clear();
        let mut open: Option<usize> = None;
        for index in preheat.clone() {
            let missing = !self.available[index] && !self.requested[index];
            match (open, missing) {
                (None, true) => open = Some(index),
                (Some(start), false) => {
                    self.refill.push(start..index);
                    open = None;
                }
                _ => {}
            }
            if missing {
                self.requested[index] = true;
            }
            if self.requested[index] && !self.available[index] {
                self.pending.push(index);
            }
        }
        if let Some(start) = open {
            self.refill.push(start..preheat.end);
        }
        let refill_items = self
            .refill
            .iter()
            .map(|range| range.end - range.start)
            .sum::<usize>();
        self.metrics.frames = self.metrics.frames.saturating_add(1);
        self.metrics.cache_hits = self.metrics.cache_hits.saturating_add(hits);
        self.metrics.cache_misses = self
            .metrics
            .cache_misses
            .saturating_add(placeholders as u64);
        self.metrics.refill_requests = self
            .metrics
            .refill_requests
            .saturating_add(self.refill.len() as u64);
        self.metrics.refill_items = self
            .metrics
            .refill_items
            .saturating_add(refill_items as u64);
        Ok(VirtualFrame {
            visible,
            preheat,
            refill: &self.refill,
            position,
            content_extent: self.heights.total_extent(),
            placeholders,
        })
    }

    fn viewport_extent(&self) -> f64 {
        self.physics.viewport_extent()
    }

    fn validate_range(&self, range: &Range<usize>) -> Result<(), ScrollError> {
        if range.start > range.end || range.end > self.heights.len() {
            return Err(ScrollError::IndexOutOfBounds {
                index: range.end.max(range.start),
                len: self.heights.len(),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wheel_scrolling_preheats_ahead_of_the_destination() {
        // Regression: the projection used to read `physics.velocity()`, which a
        // wheel gesture never sets, so the window stayed symmetric and one
        // viewport wide and a fast gesture landed outside it every frame.
        let mut virtualizer = Virtualizer::new(
            HeightIndex::with_uniform(10_000, 32.0).expect("heights"),
            512.0,
            ScrollPlatform::Ios,
            VirtualizerConfig::default(),
        )
        .expect("virtualizer");
        virtualizer.mark_available(0..10_000).expect("available");

        let settled = virtualizer.plan_frame().expect("frame").preheat;
        virtualizer
            .physics_mut()
            .wheel_notch_by(4_000.0)
            .expect("notch");
        let heading = virtualizer.plan_frame().expect("frame");
        // The lead is capped by `maximum_ahead_viewports` so memory stays
        // bounded, but it must be a real lead rather than the symmetric window.
        let config = VirtualizerConfig::default();
        let capped_lead_items = (512.0 * config.maximum_ahead_viewports / 32.0).round();
        let lead_items = heading.preheat.end - settled.end;
        assert!(
            f64::from(u32::try_from(lead_items).expect("lead fits")) >= capped_lead_items,
            "preheat must lead the notch destination: {settled:?} -> {:?}",
            heading.preheat
        );
    }

    #[test]
    fn an_unanswered_request_is_retried_after_the_window_moves_away() {
        // Regression: `requested` was latched forever, so an item the Shell
        // never materialized could never be requested again and stayed blank.
        let mut virtualizer = Virtualizer::new(
            HeightIndex::with_uniform(4_000, 32.0).expect("heights"),
            320.0,
            ScrollPlatform::Ios,
            VirtualizerConfig::default(),
        )
        .expect("virtualizer");
        let first = virtualizer.plan_frame().expect("frame");
        assert!(
            !first.refill.is_empty(),
            "the first frame must request items"
        );

        // Move far away without ever answering, then come back.
        virtualizer.physics_mut().jump_to(60_000.0).expect("jump");
        virtualizer.plan_frame().expect("frame");
        virtualizer.physics_mut().jump_to(0.0).expect("jump");
        let returned = virtualizer.plan_frame().expect("frame");
        assert!(
            returned.refill.iter().any(|range| range.contains(&0)),
            "returning to an unanswered item must request it again"
        );
    }

    #[test]
    fn emits_coalesced_refill_once_and_uses_placeholders_until_available() {
        let heights = HeightIndex::with_uniform(1_000_000, 20.0).expect("heights");
        let mut virtualizer = Virtualizer::new(
            heights,
            100.0,
            ScrollPlatform::Android,
            VirtualizerConfig::default(),
        )
        .expect("virtualizer");
        let first = virtualizer.plan_frame().expect("frame").clone();
        assert_eq!(first.visible, 0..5);
        assert_eq!(first.placeholders, 5);
        assert_eq!(first.refill.len(), 1);
        assert_eq!(first.refill[0], 0..15);
        assert!(virtualizer.plan_frame().expect("frame").refill.is_empty());
        virtualizer.mark_available(0..15).expect("available");
        assert_eq!(virtualizer.plan_frame().expect("frame").placeholders, 0);
    }

    #[test]
    fn correction_above_the_viewport_preserves_the_visual_anchor() {
        let heights = HeightIndex::with_uniform(100, 20.0).expect("heights");
        let mut virtualizer = Virtualizer::new(
            heights,
            100.0,
            ScrollPlatform::Ios,
            VirtualizerConfig::default(),
        )
        .expect("virtualizer");
        virtualizer.physics_mut().jump_to(500.0).expect("position");
        assert_eq!(
            virtualizer
                .update_height(2, 30.0)
                .expect("height")
                .to_bits(),
            10.0_f64.to_bits(),
        );
        assert_eq!(
            virtualizer.physics().position().to_bits(),
            510.0_f64.to_bits()
        );
        assert_eq!(virtualizer.metrics().measurement_corrections, 1);
    }

    #[test]
    fn velocity_expands_preheat_in_the_fling_direction() {
        let heights = HeightIndex::with_uniform(1_000, 10.0).expect("heights");
        let mut virtualizer = Virtualizer::new(
            heights,
            100.0,
            ScrollPlatform::Android,
            VirtualizerConfig::default(),
        )
        .expect("virtualizer");
        virtualizer
            .physics_mut()
            .jump_to(1_000.0)
            .expect("position");
        virtualizer.physics_mut().end_drag(2_000.0).expect("fling");
        let frame = virtualizer.plan_frame().expect("frame");
        assert!(frame.preheat.end - frame.visible.end > frame.visible.start - frame.preheat.start);
    }

    #[test]
    fn reverse_velocity_expands_preheat_before_the_visible_range() {
        let heights = HeightIndex::with_uniform(1_000, 10.0).expect("heights");
        let mut virtualizer = Virtualizer::new(
            heights,
            100.0,
            ScrollPlatform::Ios,
            VirtualizerConfig::default(),
        )
        .expect("virtualizer");
        virtualizer
            .physics_mut()
            .jump_to(5_000.0)
            .expect("position");
        virtualizer
            .physics_mut()
            .end_drag(-2_000.0)
            .expect("reverse fling");
        let frame = virtualizer.plan_frame().expect("frame");
        assert!(frame.visible.start - frame.preheat.start > frame.preheat.end - frame.visible.end);
    }

    #[test]
    fn rejects_unbounded_preheat_configuration() {
        let heights = HeightIndex::with_uniform(1, 10.0).expect("heights");
        assert!(matches!(
            Virtualizer::new(
                heights,
                100.0,
                ScrollPlatform::Android,
                VirtualizerConfig {
                    maximum_ahead_viewports: 65.0,
                    ..VirtualizerConfig::default()
                },
            ),
            Err(ScrollError::InvalidScalar {
                field: "maximum ahead viewports",
                ..
            })
        ));
    }

    #[test]
    fn cache_invalidation_structure_edits_and_range_errors_are_explicit() {
        let heights = HeightIndex::with_uniform(10, 20.0).expect("heights");
        assert!(matches!(
            Virtualizer::new(
                heights.clone(),
                -1.0,
                ScrollPlatform::Android,
                VirtualizerConfig::default(),
            ),
            Err(ScrollError::InvalidScalar {
                field: "viewport extent",
                ..
            })
        ));
        let mut virtualizer = Virtualizer::new(
            heights,
            100.0,
            ScrollPlatform::Android,
            VirtualizerConfig::default(),
        )
        .expect("virtualizer");
        assert_eq!(virtualizer.heights().len(), 10);
        assert!(matches!(
            virtualizer.mark_available(11..12),
            Err(ScrollError::IndexOutOfBounds { .. })
        ));
        let reversed = Range { start: 4, end: 3 };
        assert!(matches!(
            virtualizer.mark_unavailable(reversed),
            Err(ScrollError::IndexOutOfBounds { .. })
        ));
        virtualizer.mark_available(0..10).expect("available");
        virtualizer.mark_unavailable(1..3).expect("first gap");
        virtualizer.mark_unavailable(5..7).expect("second gap");
        let frame = virtualizer.plan_frame().expect("frame").clone();
        assert_eq!(frame.refill, &[1..3, 5..7]);

        virtualizer.insert(2, 30.0).expect("insert");
        assert_eq!(virtualizer.heights().height(2), Some(30.0));
        assert_eq!(
            virtualizer.remove(2).expect("remove").to_bits(),
            30.0_f32.to_bits()
        );
        assert_eq!(virtualizer.heights().len(), 10);
        assert!(matches!(
            virtualizer.insert(11, 10.0),
            Err(ScrollError::IndexOutOfBounds { .. })
        ));
        assert!(matches!(
            virtualizer.remove(10),
            Err(ScrollError::IndexOutOfBounds { .. })
        ));
    }

    #[test]
    fn accelerated_thirty_minute_soak_keeps_heap_bounded() {
        const FRAMES: usize = 30 * 60 * 120;
        let heights = HeightIndex::with_uniform(1_000_000, 20.0).expect("heights");
        let mut virtualizer = Virtualizer::new(
            heights,
            800.0,
            ScrollPlatform::Android,
            VirtualizerConfig::default(),
        )
        .expect("virtualizer");
        virtualizer.mark_available(0..1_000_000).expect("available");
        virtualizer.plan_frame().expect("warmup");
        let retained_bytes = virtualizer.estimated_heap_bytes();
        for frame in 0..FRAMES {
            if frame % 2_400 == 0 {
                let direction = if (frame / 2_400) % 2 == 0 { 1.0 } else { -1.0 };
                virtualizer.physics_mut().begin_drag();
                virtualizer
                    .physics_mut()
                    .drag_by(direction * 10.0)
                    .expect("drag");
                virtualizer
                    .physics_mut()
                    .end_drag(direction * 80_000.0)
                    .expect("fling");
            }
            if frame % 3_601 == 0 {
                let item = (frame * 7_919) % 1_000_000;
                virtualizer
                    .update_height(item, if frame % 7_202 == 0 { 24.0 } else { 20.0 })
                    .expect("measurement");
            }
            virtualizer
                .physics_mut()
                .advance(1.0 / 120.0)
                .expect("physics");
            let planned = virtualizer.plan_frame().expect("plan");
            assert!(planned.refill.is_empty());
            assert!(planned.position.is_finite());
        }
        assert_eq!(virtualizer.estimated_heap_bytes(), retained_bytes);
        assert_eq!(
            virtualizer.metrics().frames,
            u64::try_from(FRAMES).expect("frame count") + 1
        );
    }
}
