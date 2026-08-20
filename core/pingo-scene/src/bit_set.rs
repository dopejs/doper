/// A compact growable bit set with deterministic ascending iteration.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct BitSet {
    words: Vec<u64>,
    logical_len: usize,
}

impl BitSet {
    /// Creates an empty bit set with a logical length.
    #[must_use]
    pub fn with_len(logical_len: usize) -> Self {
        Self {
            words: vec![0; logical_len.div_ceil(64)],
            logical_len,
        }
    }

    /// Returns the number of addressable bits.
    #[must_use]
    pub const fn len(&self) -> usize {
        self.logical_len
    }

    /// Returns whether no bits are addressable.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.logical_len == 0
    }

    /// Sets one bit, growing the logical length if needed.
    pub fn insert(&mut self, index: usize) {
        if index >= self.logical_len {
            self.logical_len = index + 1;
            self.words.resize(self.logical_len.div_ceil(64), 0);
        }
        self.words[index / 64] |= 1_u64 << (index % 64);
    }

    /// Returns whether a bit is set.
    #[must_use]
    pub fn contains(&self, index: usize) -> bool {
        index < self.logical_len && self.words[index / 64] & (1_u64 << (index % 64)) != 0
    }

    /// Clears all bits without changing capacity.
    pub fn clear(&mut self) {
        self.words.fill(0);
    }

    /// Sets every logical bit.
    pub fn fill(&mut self) {
        self.words.fill(u64::MAX);
        if let Some(last) = self.words.last_mut() {
            let remainder = self.logical_len % 64;
            if remainder != 0 {
                *last &= (1_u64 << remainder) - 1;
            }
        }
    }

    /// Iterates set indices in ascending order without allocation.
    #[must_use]
    pub fn iter_ones(&self) -> SetBits<'_> {
        SetBits {
            words: &self.words,
            word_index: 0,
            current: self.words.first().copied().unwrap_or(0),
        }
    }
}

/// Allocation-free iterator over set bit indices.
pub struct SetBits<'a> {
    words: &'a [u64],
    word_index: usize,
    current: u64,
}

impl Iterator for SetBits<'_> {
    type Item = usize;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if self.current != 0 {
                let bit = self.current.trailing_zeros() as usize;
                self.current &= self.current - 1;
                return Some(self.word_index * 64 + bit);
            }
            self.word_index += 1;
            self.current = *self.words.get(self.word_index)?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iterates_sparse_bits_in_order_and_masks_tail() {
        let mut bits = BitSet::with_len(70);
        bits.insert(69);
        bits.insert(2);
        bits.insert(64);
        assert_eq!(bits.iter_ones().collect::<Vec<_>>(), vec![2, 64, 69]);
        bits.fill();
        assert_eq!(bits.iter_ones().count(), 70);
        bits.clear();
        assert_eq!(bits.iter_ones().next(), None);
    }

    #[test]
    fn default_set_grows_and_bounds_membership() {
        let mut bits = BitSet::default();
        assert!(bits.is_empty());
        assert_eq!(bits.len(), 0);
        assert!(!bits.contains(0));

        bits.insert(130);
        assert_eq!(bits.len(), 131);
        assert!(!bits.is_empty());
        assert!(bits.contains(130));
        assert!(!bits.contains(129));
        assert!(!bits.contains(131));
        assert_eq!(bits.iter_ones().collect::<Vec<_>>(), vec![130]);
    }
}
