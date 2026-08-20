use core::fmt;

use pingo_abi::{NODE_ID_GENERATION_BITS, NODE_ID_INDEX_BITS, NULL_NODE_ID};

use crate::SceneError;

const INDEX_MASK: u32 = (1_u32 << NODE_ID_INDEX_BITS) - 1;
const GENERATION_MASK: u32 = (1_u32 << NODE_ID_GENERATION_BITS) - 1;

/// Maximum number of addressable slots; the all-ones index is reserved.
pub const MAX_NODE_SLOTS: u32 = INDEX_MASK;
/// Largest generation before a removed slot is permanently retired.
pub const MAX_GENERATION: u16 = GENERATION_MASK as u16;

/// A compact node handle containing an index and non-zero generation.
#[derive(Clone, Copy, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct NodeId(u32);

impl NodeId {
    /// Constructs a valid generation-bearing identifier.
    pub fn new(index: u32, generation: u16) -> Result<Self, SceneError> {
        if index >= MAX_NODE_SLOTS {
            return Err(SceneError::NodeIndexOutOfRange { index });
        }
        if generation == 0 || generation > MAX_GENERATION {
            return Err(SceneError::InvalidGeneration { generation });
        }
        Ok(Self((u32::from(generation) << NODE_ID_INDEX_BITS) | index))
    }

    /// Validates a raw wire identifier.
    pub fn from_raw(raw: u32) -> Result<Self, SceneError> {
        if raw == NULL_NODE_ID {
            return Err(SceneError::NullNodeId);
        }
        let id = Self(raw);
        if id.index() >= MAX_NODE_SLOTS {
            return Err(SceneError::NodeIndexOutOfRange { index: id.index() });
        }
        if id.generation() == 0 {
            return Err(SceneError::InvalidGeneration { generation: 0 });
        }
        Ok(id)
    }

    /// Returns the packed wire value.
    #[must_use]
    pub const fn raw(self) -> u32 {
        self.0
    }

    /// Returns the slot index.
    #[must_use]
    pub const fn index(self) -> u32 {
        self.0 & INDEX_MASK
    }

    /// Returns the generation.
    #[must_use]
    pub const fn generation(self) -> u16 {
        ((self.0 >> NODE_ID_INDEX_BITS) & GENERATION_MASK) as u16
    }
}

impl fmt::Debug for NodeId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NodeId")
            .field("index", &self.index())
            .field("generation", &self.generation())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_and_rejects_reserved_values() {
        let id = NodeId::new(123, 7).expect("valid id");
        assert_eq!(id.index(), 123);
        assert_eq!(id.generation(), 7);
        assert_eq!(NodeId::from_raw(id.raw()), Ok(id));
        assert_eq!(NodeId::from_raw(NULL_NODE_ID), Err(SceneError::NullNodeId));
        assert!(NodeId::new(MAX_NODE_SLOTS, 1).is_err());
        assert!(NodeId::new(0, 0).is_err());
    }

    #[test]
    fn validates_generation_ceiling_and_formats_identity() {
        let maximum = NodeId::new(MAX_NODE_SLOTS - 1, MAX_GENERATION).expect("maximum valid id");
        assert_eq!(NodeId::from_raw(maximum.raw()), Ok(maximum));
        assert_eq!(
            format!("{maximum:?}"),
            format!(
                "NodeId {{ index: {}, generation: {} }}",
                MAX_NODE_SLOTS - 1,
                MAX_GENERATION
            )
        );
        assert_eq!(
            NodeId::new(0, MAX_GENERATION + 1),
            Err(SceneError::InvalidGeneration {
                generation: MAX_GENERATION + 1,
            })
        );
        assert_eq!(
            NodeId::from_raw(MAX_NODE_SLOTS),
            Err(SceneError::NodeIndexOutOfRange {
                index: MAX_NODE_SLOTS,
            })
        );
        assert_eq!(
            NodeId::from_raw(1),
            Err(SceneError::InvalidGeneration { generation: 0 })
        );
    }
}
