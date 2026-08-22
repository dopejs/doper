use core::borrow::Borrow;
use core::fmt;

/// A key-ordered map backed by a sorted vector.
///
/// See the crate documentation for when this is the right trade against
/// [`std::collections::BTreeMap`].
#[derive(Clone, Eq, PartialEq)]
pub struct OrderedMap<K, V> {
    entries: Vec<(K, V)>,
}

// Derived `Default` would demand `K: Default, V: Default`; an empty map needs
// neither.
impl<K, V> Default for OrderedMap<K, V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<K: fmt::Debug, V: fmt::Debug> fmt::Debug for OrderedMap<K, V> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_map()
            .entries(self.entries.iter().map(|(key, value)| (key, value)))
            .finish()
    }
}

impl<K, V> OrderedMap<K, V> {
    /// Creates an empty map.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    /// Returns the number of entries.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Returns whether the map holds no entries.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Removes every entry, keeping the allocation.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Iterates entries in key order.
    #[must_use]
    pub fn iter(&self) -> impl ExactSizeIterator<Item = (&K, &V)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    /// Iterates entries in key order with mutable values.
    pub fn iter_mut(&mut self) -> impl ExactSizeIterator<Item = (&K, &mut V)> {
        self.entries.iter_mut().map(|(key, value)| (&*key, value))
    }

    /// Iterates keys in order.
    #[must_use]
    pub fn keys(&self) -> impl ExactSizeIterator<Item = &K> {
        self.entries.iter().map(|(key, _)| key)
    }

    /// Iterates values in key order.
    #[must_use]
    pub fn values(&self) -> impl ExactSizeIterator<Item = &V> {
        self.entries.iter().map(|(_, value)| value)
    }

    /// Iterates values in key order, mutably.
    pub fn values_mut(&mut self) -> impl ExactSizeIterator<Item = &mut V> {
        self.entries.iter_mut().map(|(_, value)| value)
    }

    /// Keeps only the entries the predicate accepts.
    pub fn retain(&mut self, mut keep: impl FnMut(&K, &mut V) -> bool) {
        self.entries.retain_mut(|(key, value)| keep(key, value));
    }
}

impl<K: Ord, V> OrderedMap<K, V> {
    /// Inserts a value, returning the one it replaced.
    pub fn insert(&mut self, key: K, value: V) -> Option<V> {
        match self.entries.binary_search_by(|(probe, _)| probe.cmp(&key)) {
            Ok(index) => Some(core::mem::replace(&mut self.entries[index].1, value)),
            Err(index) => {
                self.entries.insert(index, (key, value));
                None
            }
        }
    }

    /// Returns the value stored for a key.
    pub fn get<Q>(&self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
        Q: Ord + ?Sized,
    {
        self.index_of(key).map(|index| &self.entries[index].1)
    }

    /// Returns the value stored for a key, mutably.
    pub fn get_mut<Q>(&mut self, key: &Q) -> Option<&mut V>
    where
        K: Borrow<Q>,
        Q: Ord + ?Sized,
    {
        self.index_of(key).map(|index| &mut self.entries[index].1)
    }

    /// Returns whether a key is present.
    pub fn contains_key<Q>(&self, key: &Q) -> bool
    where
        K: Borrow<Q>,
        Q: Ord + ?Sized,
    {
        self.index_of(key).is_some()
    }

    /// Removes a key, returning its value.
    pub fn remove<Q>(&mut self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
        Q: Ord + ?Sized,
    {
        self.index_of(key).map(|index| self.entries.remove(index).1)
    }

    /// Returns the value for a key, inserting one from `make` first if absent.
    pub fn get_or_insert_with(&mut self, key: K, make: impl FnOnce() -> V) -> &mut V {
        let index = match self.entries.binary_search_by(|(probe, _)| probe.cmp(&key)) {
            Ok(index) => index,
            Err(index) => {
                self.entries.insert(index, (key, make()));
                index
            }
        };
        &mut self.entries[index].1
    }

    /// Returns the value for a key, inserting the default first if absent.
    pub fn get_or_insert_default(&mut self, key: K) -> &mut V
    where
        V: Default,
    {
        let index = match self.entries.binary_search_by(|(probe, _)| probe.cmp(&key)) {
            Ok(index) => index,
            Err(index) => {
                self.entries.insert(index, (key, V::default()));
                index
            }
        };
        &mut self.entries[index].1
    }

    /// Returns the value stored for a key that the caller knows is present.
    ///
    /// # Panics
    ///
    /// Panics when the key is absent, matching `BTreeMap`'s `Index`.
    #[must_use]
    pub fn at<Q>(&self, key: &Q) -> &V
    where
        K: Borrow<Q>,
        Q: Ord + ?Sized,
    {
        self.get(key).expect("key is present in the ordered map")
    }

    fn index_of<Q>(&self, key: &Q) -> Option<usize>
    where
        K: Borrow<Q>,
        Q: Ord + ?Sized,
    {
        self.entries
            .binary_search_by(|(probe, _)| probe.borrow().cmp(key))
            .ok()
    }
}

impl<K: Ord, V> FromIterator<(K, V)> for OrderedMap<K, V> {
    fn from_iter<I: IntoIterator<Item = (K, V)>>(iter: I) -> Self {
        // Sorting once beats inserting one at a time, which shifts the tail on
        // every out-of-order key and turns a bulk build into quadratic work.
        let mut entries: Vec<(K, V)> = iter.into_iter().collect();
        entries.sort_by(|(left, _), (right, _)| left.cmp(right));
        // A later duplicate wins, matching repeated `insert`.
        entries.reverse();
        entries.dedup_by(|(left, _), (right, _)| left == right);
        entries.reverse();
        Self { entries }
    }
}

impl<'a, K, V> IntoIterator for &'a mut OrderedMap<K, V> {
    type Item = (&'a K, &'a mut V);
    type IntoIter =
        std::iter::Map<std::slice::IterMut<'a, (K, V)>, fn(&'a mut (K, V)) -> (&'a K, &'a mut V)>;

    fn into_iter(self) -> Self::IntoIter {
        self.entries.iter_mut().map(|(key, value)| (&*key, value))
    }
}

impl<K, V> IntoIterator for OrderedMap<K, V> {
    type Item = (K, V);
    type IntoIter = std::vec::IntoIter<(K, V)>;

    fn into_iter(self) -> Self::IntoIter {
        self.entries.into_iter()
    }
}

impl<'a, K, V> IntoIterator for &'a OrderedMap<K, V> {
    type Item = (&'a K, &'a V);
    type IntoIter = std::iter::Map<std::slice::Iter<'a, (K, V)>, fn(&'a (K, V)) -> (&'a K, &'a V)>;

    fn into_iter(self) -> Self::IntoIter {
        self.entries.iter().map(|(key, value)| (key, value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_entries_in_key_order_whatever_the_insertion_order() {
        let mut map = OrderedMap::new();
        for key in [5, 1, 4, 2, 3] {
            assert_eq!(map.insert(key, key * 10), None);
        }
        assert_eq!(map.keys().copied().collect::<Vec<_>>(), vec![1, 2, 3, 4, 5]);
        assert_eq!(map.insert(3, 99), Some(30));
        assert_eq!(map.get(&3), Some(&99));
        assert_eq!(map.len(), 5);
    }

    #[test]
    fn removal_keeps_the_remaining_order() {
        let mut map: OrderedMap<u32, u32> = (0..6).map(|key| (key, key)).collect();
        assert_eq!(map.remove(&0), Some(0));
        assert_eq!(map.remove(&5), Some(5));
        assert_eq!(map.remove(&2), Some(2));
        assert_eq!(map.remove(&2), None);
        assert_eq!(map.keys().copied().collect::<Vec<_>>(), vec![1, 3, 4]);
    }

    #[test]
    fn default_insertion_and_retain_behave_like_a_btree() {
        let mut map: OrderedMap<u32, u32> = OrderedMap::new();
        *map.get_or_insert_default(7) += 1;
        *map.get_or_insert_default(7) += 1;
        *map.get_or_insert_default(3) += 5;
        assert_eq!(map.get(&7), Some(&2));
        map.retain(|_, value| *value > 2);
        assert_eq!(map.keys().copied().collect::<Vec<_>>(), vec![3]);
        assert!(!map.contains_key(&7));
        map.clear();
        assert!(map.is_empty());
    }

    #[test]
    fn matches_a_btree_across_a_seeded_operation_stream() {
        use std::collections::BTreeMap;

        let mut ordered = OrderedMap::new();
        let mut reference = BTreeMap::new();
        let mut state = 0x1234_5678_u32;
        for step in 0..4_000_u32 {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let key = state % 64;
            if step % 3 == 2 {
                assert_eq!(ordered.remove(&key), reference.remove(&key));
            } else {
                assert_eq!(ordered.insert(key, step), reference.insert(key, step));
            }
            assert_eq!(ordered.get(&key), reference.get(&key));
        }
        assert_eq!(
            ordered.iter().map(|(k, v)| (*k, *v)).collect::<Vec<_>>(),
            reference.iter().map(|(k, v)| (*k, *v)).collect::<Vec<_>>()
        );
    }
}
