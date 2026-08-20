use core::ops::Range;

use crate::ScrollError;

const MAXIMUM_ITEM_EXTENT: f32 = 1_000_000_000.0;

/// Work counters for the variable-extent prefix-sum index.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ExtentIndexMetrics {
    /// Point updates completed through the Fenwick tree.
    pub updates: u64,
    /// Structural inserts and removals that rebuilt the contiguous index.
    pub structural_rebuilds: u64,
    /// Offset-to-index searches.
    pub searches: u64,
}

/// Contiguous variable-extent sequence with O(log n) offset queries and point updates.
///
/// Item insertion/removal is intentionally O(n): list structure changes occur on UI commits,
/// while scrolling, measurement correction, and visible-range queries stay on the O(log n)
/// render hot path.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExtentIndex {
    extents: Vec<f32>,
    tree: Vec<f64>,
    metrics: ExtentIndexMetrics,
}

impl ExtentIndex {
    /// Builds an index from validated logical-pixel extents.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::InvalidExtent`] or [`ScrollError::ArithmeticOverflow`].
    pub fn from_extents(extents: impl IntoIterator<Item = f32>) -> Result<Self, ScrollError> {
        let extents: Vec<f32> = extents.into_iter().collect();
        validate_extents(&extents)?;
        let tree = build_tree(&extents)?;
        Ok(Self {
            extents,
            tree,
            metrics: ExtentIndexMetrics::default(),
        })
    }

    /// Builds `len` equal-extent items without allocating an intermediate input vector.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::InvalidExtent`] or [`ScrollError::ArithmeticOverflow`].
    pub fn with_uniform(len: usize, extent: f32) -> Result<Self, ScrollError> {
        validate_extent(extent, None)?;
        let extents = vec![extent; len];
        let tree = build_tree(&extents)?;
        Ok(Self {
            extents,
            tree,
            metrics: ExtentIndexMetrics::default(),
        })
    }

    /// Returns the number of indexed items.
    #[must_use]
    pub fn len(&self) -> usize {
        self.extents.len()
    }

    /// Returns whether the index contains no items.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.extents.is_empty()
    }

    /// Returns one item extent.
    #[must_use]
    pub fn extent(&self, index: usize) -> Option<f32> {
        self.extents.get(index).copied()
    }

    /// Returns current indexing work counters.
    #[must_use]
    pub const fn metrics(&self) -> ExtentIndexMetrics {
        self.metrics
    }

    /// Returns the retained heap footprint of extent and Fenwick buffers.
    #[must_use]
    pub fn estimated_heap_bytes(&self) -> usize {
        self.extents
            .capacity()
            .saturating_mul(core::mem::size_of::<f32>())
            .saturating_add(
                self.tree
                    .capacity()
                    .saturating_mul(core::mem::size_of::<f64>()),
            )
    }

    /// Returns total content extent in logical pixels.
    #[must_use]
    pub fn total_extent(&self) -> f64 {
        prefix_sum(&self.tree, self.len())
    }

    /// Returns the leading offset of `index`; `len` returns the trailing content edge.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::IndexOutOfBounds`] when `index` exceeds `len`.
    pub fn offset_of(&self, index: usize) -> Result<f64, ScrollError> {
        if index > self.len() {
            return Err(ScrollError::IndexOutOfBounds {
                index,
                len: self.len(),
            });
        }
        Ok(prefix_sum(&self.tree, index))
    }

    /// Finds the item covering `offset`; returns `len` at or beyond the trailing edge.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::InvalidScalar`] when `offset` is non-finite.
    pub fn index_at_offset(&mut self, offset: f64) -> Result<usize, ScrollError> {
        validate_finite(offset, "offset")?;
        self.metrics.searches = self.metrics.searches.saturating_add(1);
        if self.is_empty() {
            return Ok(0);
        }
        let target = offset.max(0.0);
        if target >= self.total_extent() {
            return Ok(self.len());
        }
        Ok(self.largest_prefix_matching(target, |sum, target| sum <= target))
    }

    /// Returns items intersecting the half-open viewport `[offset, offset + extent)`.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::InvalidScalar`] for invalid viewport coordinates.
    pub fn visible_range(&mut self, offset: f64, extent: f64) -> Result<Range<usize>, ScrollError> {
        validate_finite(offset, "offset")?;
        if !extent.is_finite() || extent < 0.0 {
            return Err(ScrollError::InvalidScalar {
                field: "viewport extent",
                value: extent,
            });
        }
        let total = self.total_extent();
        let start_offset = offset.max(0.0);
        if self.is_empty() || extent == 0.0 || start_offset >= total {
            return Ok(self.len()..self.len());
        }
        let proposed_end = start_offset + extent;
        let end_offset = if proposed_end.is_finite() {
            proposed_end.min(total)
        } else {
            total
        };
        let start = self.index_at_offset(start_offset)?;
        self.metrics.searches = self.metrics.searches.saturating_add(1);
        let end = if end_offset >= total {
            self.len()
        } else {
            self.largest_prefix_matching(end_offset, |sum, target| sum < target)
                .saturating_add(1)
                .min(self.len())
        };
        Ok(start.min(end)..end)
    }

    /// Changes one measured item extent in O(log n), returning the signed extent delta.
    ///
    /// # Errors
    ///
    /// Returns an index, extent, or arithmetic validation error.
    pub fn update(&mut self, index: usize, extent: f32) -> Result<f64, ScrollError> {
        validate_extent(extent, Some(index))?;
        let len = self.len();
        let previous = self
            .extents
            .get_mut(index)
            .ok_or(ScrollError::IndexOutOfBounds { index, len })?;
        let delta = f64::from(extent) - f64::from(*previous);
        if delta == 0.0 {
            return Ok(0.0);
        }
        *previous = extent;
        add(&mut self.tree, index, delta)?;
        self.metrics.updates = self.metrics.updates.saturating_add(1);
        Ok(delta)
    }

    /// Inserts one item, rebuilding contiguous structural state.
    ///
    /// # Errors
    ///
    /// Returns an index, extent, or arithmetic validation error.
    pub fn insert(&mut self, index: usize, extent: f32) -> Result<(), ScrollError> {
        validate_extent(extent, Some(index))?;
        if index > self.len() {
            return Err(ScrollError::IndexOutOfBounds {
                index,
                len: self.len(),
            });
        }
        self.extents.insert(index, extent);
        self.rebuild()?;
        Ok(())
    }

    /// Removes and returns one item extent, rebuilding contiguous structural state.
    ///
    /// # Errors
    ///
    /// Returns [`ScrollError::IndexOutOfBounds`] or [`ScrollError::ArithmeticOverflow`].
    pub fn remove(&mut self, index: usize) -> Result<f32, ScrollError> {
        if index >= self.len() {
            return Err(ScrollError::IndexOutOfBounds {
                index,
                len: self.len(),
            });
        }
        let removed = self.extents.remove(index);
        self.rebuild()?;
        Ok(removed)
    }

    fn rebuild(&mut self) -> Result<(), ScrollError> {
        let next = build_tree(&self.extents)?;
        self.tree = next;
        self.metrics.structural_rebuilds = self.metrics.structural_rebuilds.saturating_add(1);
        Ok(())
    }

    fn largest_prefix_matching(&self, target: f64, predicate: impl Fn(f64, f64) -> bool) -> usize {
        let mut index = 0_usize;
        let mut sum = 0.0_f64;
        let mut step = highest_power_of_two_at_most(self.len());
        while step != 0 {
            let next = index + step;
            if next <= self.len() {
                let candidate = sum + self.tree[next];
                if predicate(candidate, target) {
                    index = next;
                    sum = candidate;
                }
            }
            step >>= 1;
        }
        index.min(self.len())
    }
}

fn build_tree(extents: &[f32]) -> Result<Vec<f64>, ScrollError> {
    let capacity = extents
        .len()
        .checked_add(1)
        .ok_or(ScrollError::ArithmeticOverflow)?;
    let mut tree = Vec::with_capacity(capacity);
    tree.push(0.0);
    tree.extend(extents.iter().copied().map(f64::from));
    for index in 1..tree.len() {
        let parent = index
            .checked_add(index & index.wrapping_neg())
            .ok_or(ScrollError::ArithmeticOverflow)?;
        if parent < tree.len() {
            let next = tree[parent] + tree[index];
            if !next.is_finite() {
                return Err(ScrollError::ArithmeticOverflow);
            }
            tree[parent] = next;
        }
    }
    Ok(tree)
}

fn add(tree: &mut [f64], zero_based_index: usize, delta: f64) -> Result<(), ScrollError> {
    let mut index = zero_based_index
        .checked_add(1)
        .ok_or(ScrollError::ArithmeticOverflow)?;
    while index < tree.len() {
        let next = tree[index] + delta;
        if !next.is_finite() {
            return Err(ScrollError::ArithmeticOverflow);
        }
        tree[index] = next;
        let increment = index & index.wrapping_neg();
        index = index
            .checked_add(increment)
            .ok_or(ScrollError::ArithmeticOverflow)?;
    }
    Ok(())
}

fn prefix_sum(tree: &[f64], count: usize) -> f64 {
    let mut index = count;
    let mut sum = 0.0_f64;
    while index != 0 {
        sum += tree[index];
        index &= index - 1;
    }
    sum
}

fn validate_extents(extents: &[f32]) -> Result<(), ScrollError> {
    for (index, extent) in extents.iter().copied().enumerate() {
        validate_extent(extent, Some(index))?;
    }
    Ok(())
}

fn validate_extent(value: f32, index: Option<usize>) -> Result<(), ScrollError> {
    if value.is_finite() && (0.0..=MAXIMUM_ITEM_EXTENT).contains(&value) {
        Ok(())
    } else {
        Err(ScrollError::InvalidExtent { index, value })
    }
}

fn validate_finite(value: f64, field: &'static str) -> Result<(), ScrollError> {
    if value.is_finite() {
        Ok(())
    } else {
        Err(ScrollError::InvalidScalar { field, value })
    }
}

fn highest_power_of_two_at_most(value: usize) -> usize {
    if value == 0 {
        return 0;
    }
    1_usize << (usize::BITS - 1 - value.leading_zeros())
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    #[test]
    fn maps_boundaries_and_partially_visible_items_exactly() {
        let mut index = ExtentIndex::from_extents([10.0, 20.0, 30.0]).expect("index");
        assert_eq!(index.total_extent().to_bits(), 60.0_f64.to_bits());
        assert_eq!(index.index_at_offset(-1.0).expect("lookup"), 0);
        assert_eq!(index.index_at_offset(0.0).expect("lookup"), 0);
        assert_eq!(index.index_at_offset(9.999).expect("lookup"), 0);
        assert_eq!(index.index_at_offset(10.0).expect("lookup"), 1);
        assert_eq!(index.index_at_offset(60.0).expect("lookup"), 3);
        assert_eq!(index.visible_range(10.0, 20.0).expect("range"), 1..2);
        assert_eq!(index.visible_range(9.0, 2.0).expect("range"), 0..2);
        assert_eq!(index.visible_range(59.0, 20.0).expect("range"), 2..3);
        assert_eq!(index.visible_range(60.0, 20.0).expect("range"), 3..3);
    }

    #[test]
    fn point_updates_and_structural_edits_report_work() {
        let mut index = ExtentIndex::with_uniform(3, 10.0).expect("index");
        assert_eq!(
            index.update(1, 15.0).expect("update").to_bits(),
            5.0_f64.to_bits()
        );
        index.insert(1, 5.0).expect("insert");
        assert_eq!(
            index.remove(0).expect("remove").to_bits(),
            10.0_f32.to_bits()
        );
        assert_eq!(index.total_extent().to_bits(), 30.0_f64.to_bits());
        assert_eq!(index.metrics().updates, 1);
        assert_eq!(index.metrics().structural_rebuilds, 2);
    }

    #[test]
    fn zero_extent_runs_are_skipped_and_extreme_extents_are_rejected() {
        let mut index = ExtentIndex::from_extents([0.0, 0.0, 10.0, 0.0, 20.0]).expect("index");
        assert_eq!(index.index_at_offset(0.0).expect("start"), 2);
        assert_eq!(index.index_at_offset(10.0).expect("boundary"), 4);
        assert_eq!(index.visible_range(0.0, 10.0).expect("visible"), 2..3);
        assert!(matches!(
            ExtentIndex::with_uniform(1, MAXIMUM_ITEM_EXTENT * 2.0),
            Err(ScrollError::InvalidExtent { .. })
        ));
    }

    #[test]
    fn empty_and_invalid_queries_fail_without_changing_the_index() {
        let mut empty = ExtentIndex::default();
        assert_eq!(empty.index_at_offset(0.0), Ok(0));
        assert_eq!(empty.visible_range(0.0, 10.0), Ok(0..0));
        assert_eq!(empty.extent(0), None);
        assert!(matches!(
            empty.index_at_offset(f64::NAN),
            Err(ScrollError::InvalidScalar {
                field: "offset",
                ..
            })
        ));

        let mut index = ExtentIndex::from_extents([10.0, 20.0]).expect("index");
        assert_eq!(index.extent(1), Some(20.0));
        assert!(matches!(
            index.offset_of(3),
            Err(ScrollError::IndexOutOfBounds { index: 3, len: 2 })
        ));
        assert!(matches!(
            index.visible_range(0.0, -1.0),
            Err(ScrollError::InvalidScalar {
                field: "viewport extent",
                ..
            })
        ));
        assert_eq!(index.visible_range(1.0, f64::MAX), Ok(0..2));
        assert!(matches!(
            index.update(3, 1.0),
            Err(ScrollError::IndexOutOfBounds { index: 3, len: 2 })
        ));
        assert!(matches!(
            index.insert(3, 1.0),
            Err(ScrollError::IndexOutOfBounds { index: 3, len: 2 })
        ));
        assert!(matches!(
            index.remove(2),
            Err(ScrollError::IndexOutOfBounds { index: 2, len: 2 })
        ));
        assert_eq!(index.total_extent().to_bits(), 30.0_f64.to_bits());
    }

    proptest! {
        #[test]
        fn arbitrary_edits_match_a_naive_prefix_oracle(
            initial in prop::collection::vec(1_u16..500, 0..128),
            operations in prop::collection::vec((0_u8..3, any::<u16>(), 1_u16..500), 0..256),
        ) {
            let mut naive: Vec<f32> = initial.into_iter().map(f32::from).collect();
            let mut index = ExtentIndex::from_extents(naive.iter().copied()).expect("index");
            for (kind, raw_index, raw_extent) in operations {
                let extent = f32::from(raw_extent);
                match kind {
                    0 if !naive.is_empty() => {
                        let item = usize::from(raw_index) % naive.len();
                        naive[item] = extent;
                        index.update(item, extent).expect("update");
                    }
                    1 => {
                        let item = usize::from(raw_index) % (naive.len() + 1);
                        naive.insert(item, extent);
                        index.insert(item, extent).expect("insert");
                    }
                    2 if !naive.is_empty() => {
                        let item = usize::from(raw_index) % naive.len();
                        prop_assert_eq!(
                            index.remove(item).expect("remove").to_bits(),
                            naive.remove(item).to_bits(),
                        );
                    }
                    _ => {}
                }
                let mut expected = 0.0_f64;
                for item in 0..=naive.len() {
                    prop_assert_eq!(
                        index.offset_of(item).expect("offset").to_bits(),
                        expected.to_bits(),
                    );
                    if let Some(extent) = naive.get(item) {
                        expected += f64::from(*extent);
                    }
                }
                prop_assert_eq!(index.total_extent().to_bits(), expected.to_bits());
                if expected > 0.0 {
                    let probe = f64::from(raw_index) % expected;
                    let found = index.index_at_offset(probe).expect("lookup");
                    prop_assert!(found < naive.len());
                    let start: f64 = naive[..found].iter().map(|value| f64::from(*value)).sum();
                    prop_assert!(start <= probe);
                    prop_assert!(probe < start + f64::from(naive[found]));
                }
            }
        }
    }
}
