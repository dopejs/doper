use core::borrow::Borrow;
use core::fmt;

/// An ordered set backed by a sorted vector.
///
/// See the crate documentation for when this is the right trade against
/// [`std::collections::BTreeSet`].
#[derive(Clone, Eq, PartialEq)]
pub struct OrderedSet<T> {
    values: Vec<T>,
}

// Derived `Default` would demand `T: Default`; an empty set needs none.
impl<T> Default for OrderedSet<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: fmt::Debug> fmt::Debug for OrderedSet<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_set().entries(self.values.iter()).finish()
    }
}

impl<T> OrderedSet<T> {
    /// Creates an empty set.
    #[must_use]
    pub const fn new() -> Self {
        Self { values: Vec::new() }
    }

    /// Returns the number of values.
    #[must_use]
    pub fn len(&self) -> usize {
        self.values.len()
    }

    /// Returns whether the set holds no values.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// Removes every value, keeping the allocation.
    pub fn clear(&mut self) {
        self.values.clear();
    }

    /// Iterates values in order.
    #[must_use]
    pub fn iter(&self) -> impl ExactSizeIterator<Item = &T> {
        self.values.iter()
    }
}

impl<T: Ord> OrderedSet<T> {
    /// Inserts a value, returning whether it was newly added.
    pub fn insert(&mut self, value: T) -> bool {
        match self.values.binary_search(&value) {
            Ok(_) => false,
            Err(index) => {
                self.values.insert(index, value);
                true
            }
        }
    }

    /// Returns whether a value is present.
    pub fn contains<Q>(&self, value: &Q) -> bool
    where
        T: Borrow<Q>,
        Q: Ord + ?Sized,
    {
        self.values
            .binary_search_by(|probe| probe.borrow().cmp(value))
            .is_ok()
    }

    /// Removes a value, returning whether it was present.
    pub fn remove<Q>(&mut self, value: &Q) -> bool
    where
        T: Borrow<Q>,
        Q: Ord + ?Sized,
    {
        match self
            .values
            .binary_search_by(|probe| probe.borrow().cmp(value))
        {
            Ok(index) => {
                self.values.remove(index);
                true
            }
            Err(_) => false,
        }
    }
}

impl<T: Ord> OrderedSet<T> {
    /// Returns the smallest value.
    #[must_use]
    pub fn first(&self) -> Option<&T> {
        self.values.first()
    }

    /// Returns the largest value.
    #[must_use]
    pub fn last(&self) -> Option<&T> {
        self.values.last()
    }

    /// Iterates the values this set holds and `other` does not, in order.
    pub fn difference<'a>(&'a self, other: &'a Self) -> impl Iterator<Item = &'a T> {
        self.values
            .iter()
            .filter(move |value| !other.contains(*value))
    }
}

impl<T: Ord> FromIterator<T> for OrderedSet<T> {
    fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Self {
        let mut values: Vec<T> = iter.into_iter().collect();
        values.sort_unstable();
        values.dedup();
        Self { values }
    }
}

impl<T> IntoIterator for OrderedSet<T> {
    type Item = T;
    type IntoIter = std::vec::IntoIter<T>;

    fn into_iter(self) -> Self::IntoIter {
        self.values.into_iter()
    }
}

impl<'a, T> IntoIterator for &'a OrderedSet<T> {
    type Item = &'a T;
    type IntoIter = std::slice::Iter<'a, T>;

    fn into_iter(self) -> Self::IntoIter {
        self.values.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deduplicates_and_orders_whatever_the_insertion_order() {
        let mut set = OrderedSet::new();
        assert!(set.insert(3));
        assert!(set.insert(1));
        assert!(!set.insert(3));
        assert_eq!(set.iter().copied().collect::<Vec<_>>(), vec![1, 3]);
        assert!(set.contains(&1));
        assert!(set.remove(&1));
        assert!(!set.remove(&1));
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn collecting_sorts_and_dedups() {
        let set: OrderedSet<u32> = [5, 1, 5, 3, 1].into_iter().collect();
        assert_eq!(set.iter().copied().collect::<Vec<_>>(), vec![1, 3, 5]);
    }

    #[test]
    fn matches_a_btree_across_a_seeded_operation_stream() {
        use std::collections::BTreeSet;

        let mut ordered = OrderedSet::new();
        let mut reference = BTreeSet::new();
        let mut state = 0x9e37_79b9_u32;
        for step in 0..4_000_u32 {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let value = state % 48;
            if step % 3 == 2 {
                assert_eq!(ordered.remove(&value), reference.remove(&value));
            } else {
                assert_eq!(ordered.insert(value), reference.insert(value));
            }
            assert_eq!(ordered.contains(&value), reference.contains(&value));
        }
        assert_eq!(
            ordered.iter().copied().collect::<Vec<_>>(),
            reference.iter().copied().collect::<Vec<_>>()
        );
    }
}
