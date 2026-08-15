use unicode_segmentation::UnicodeSegmentation;

use crate::{Affinity, EditError, Selection, Utf16Position, Utf16Range};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Boundary {
    utf8: usize,
    utf16: u32,
}

/// Direction used when an external offset lands inside a grapheme.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OffsetBias {
    /// Snap to the preceding boundary.
    Backward,
    /// Snap to the following boundary.
    Forward,
}

/// Revision-local conversion table between UTF-8 bytes and grapheme-safe UTF-16 offsets.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextIndex {
    boundaries: Vec<Boundary>,
    utf8_len: usize,
    utf16_len: u32,
}

impl TextIndex {
    /// Builds an index for one immutable text revision.
    pub fn new(text: &str) -> Result<Self, EditError> {
        let mut boundaries = Vec::with_capacity(text.graphemes(true).count() + 1);
        boundaries.push(Boundary { utf8: 0, utf16: 0 });
        let mut utf16 = 0_u32;
        for (utf8, grapheme) in text.grapheme_indices(true) {
            let end_utf8 = utf8 + grapheme.len();
            let units = u32::try_from(grapheme.encode_utf16().count())
                .map_err(|_| EditError::OffsetOverflow)?;
            utf16 = utf16.checked_add(units).ok_or(EditError::OffsetOverflow)?;
            boundaries.push(Boundary {
                utf8: end_utf8,
                utf16,
            });
        }
        Ok(Self {
            boundaries,
            utf8_len: text.len(),
            utf16_len: utf16,
        })
    }

    /// Returns the number of grapheme clusters.
    #[must_use]
    pub fn grapheme_count(&self) -> usize {
        self.boundaries.len().saturating_sub(1)
    }

    /// Returns the UTF-8 byte length.
    #[must_use]
    pub const fn utf8_len(&self) -> usize {
        self.utf8_len
    }

    /// Returns the UTF-16 code-unit length.
    #[must_use]
    pub const fn utf16_len(&self) -> u32 {
        self.utf16_len
    }

    /// Converts and snaps a UTF-16 offset to a UTF-8 grapheme boundary.
    pub fn utf16_to_utf8(&self, offset: u32, bias: OffsetBias) -> Result<usize, EditError> {
        if offset > self.utf16_len {
            return Err(EditError::InvalidRange {
                start: offset,
                end: offset,
                text_len: self.utf16_len,
            });
        }
        match self
            .boundaries
            .binary_search_by_key(&offset, |boundary| boundary.utf16)
        {
            Ok(index) => Ok(self.boundaries[index].utf8),
            Err(index) => Ok(match bias {
                OffsetBias::Backward => self.boundaries[index - 1].utf8,
                OffsetBias::Forward => self.boundaries[index].utf8,
            }),
        }
    }

    /// Converts an exact UTF-8 grapheme boundary to UTF-16.
    pub fn utf8_to_utf16(&self, offset: usize) -> Result<u32, EditError> {
        if offset > self.utf8_len {
            return Err(EditError::InvalidUtf8Boundary { offset });
        }
        self.boundaries
            .binary_search_by_key(&offset, |boundary| boundary.utf8)
            .map(|index| self.boundaries[index].utf16)
            .map_err(|_| EditError::InvalidUtf8Boundary { offset })
    }

    /// Normalizes a position according to its affinity.
    pub fn normalize_position(&self, position: Utf16Position) -> Result<Utf16Position, EditError> {
        let bias = match position.affinity {
            Affinity::Upstream => OffsetBias::Backward,
            Affinity::Downstream => OffsetBias::Forward,
        };
        let utf8 = self.utf16_to_utf8(position.offset, bias)?;
        Ok(Utf16Position {
            offset: self.utf8_to_utf16(utf8)?,
            affinity: position.affinity,
        })
    }

    /// Normalizes both directed selection edges without splitting graphemes.
    pub fn normalize_selection(&self, selection: Selection) -> Result<Selection, EditError> {
        Ok(Selection {
            anchor: self.normalize_position(selection.anchor)?,
            focus: self.normalize_position(selection.focus)?,
        })
    }

    /// Expands a replacement range to complete grapheme boundaries.
    pub fn normalize_range(&self, range: Utf16Range) -> Result<Utf16Range, EditError> {
        if range.start > range.end || range.end > self.utf16_len {
            return Err(EditError::InvalidRange {
                start: range.start,
                end: range.end,
                text_len: self.utf16_len,
            });
        }
        let start = self.utf16_to_utf8(range.start, OffsetBias::Backward)?;
        let end = self.utf16_to_utf8(range.end, OffsetBias::Forward)?;
        Ok(Utf16Range {
            start: self.utf8_to_utf16(start)?,
            end: self.utf8_to_utf16(end)?,
        })
    }

    /// Returns the preceding grapheme boundary.
    pub fn previous(&self, offset: u32) -> Result<u32, EditError> {
        let byte = self.utf16_to_utf8(offset, OffsetBias::Backward)?;
        let index = self
            .boundaries
            .binary_search_by_key(&byte, |boundary| boundary.utf8)
            .map_err(|_| EditError::InvalidUtf8Boundary { offset: byte })?;
        Ok(self.boundaries[index.saturating_sub(1)].utf16)
    }

    /// Returns the following grapheme boundary.
    pub fn next(&self, offset: u32) -> Result<u32, EditError> {
        let byte = self.utf16_to_utf8(offset, OffsetBias::Forward)?;
        let index = self
            .boundaries
            .binary_search_by_key(&byte, |boundary| boundary.utf8)
            .map_err(|_| EditError::InvalidUtf8Boundary { offset: byte })?;
        Ok(self.boundaries[(index + 1).min(self.boundaries.len() - 1)].utf16)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_combining_and_emoji_sequences_without_exposing_internal_edges() {
        let text = "a\u{301}👨‍👩‍👧‍👦z";
        let index = TextIndex::new(text).expect("index");
        assert_eq!(index.grapheme_count(), 3);
        let first_end = "a\u{301}".encode_utf16().count() as u32;
        assert_eq!(index.utf16_to_utf8(1, OffsetBias::Backward), Ok(0));
        assert_eq!(
            index.utf16_to_utf8(1, OffsetBias::Forward),
            Ok("a\u{301}".len())
        );
        assert_eq!(index.previous(first_end), Ok(0));
        assert_eq!(index.next(0), Ok(first_end));
        assert_eq!(
            index.utf8_to_utf16(1),
            Err(EditError::InvalidUtf8Boundary { offset: 1 })
        );
    }
}
