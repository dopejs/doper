#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Ordered containers sized for a WASM code budget.
//!
//! Core output must not depend on iteration order, so its maps are ordered
//! rather than hashed. `BTreeMap` gives that ordering, but every key/value pair
//! it is instantiated with generates the whole node balancing, splitting,
//! merging and navigation machinery. Across the Core's roughly twenty distinct
//! pairs that came to 22% of the compiled code section, which is budget spent on
//! generic tree maintenance rather than on rendering.
//!
//! These containers keep a sorted vector instead. Ordering and `O(log n)`
//! lookup are the same; insertion and removal move elements instead of
//! rebalancing nodes. That trade is right for a map that stays small or is
//! rebuilt in bulk, and wrong for one that takes thousands of scattered
//! inserts — those should stay a `BTreeMap`.

mod map;
mod set;

pub use map::OrderedMap;
pub use set::OrderedSet;
