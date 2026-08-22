//! Immutable vector outline resource shared by every node that draws it.
//!
//! Lives here rather than in `pingo-paint` because the Scene validates the
//! payload at its commit boundary and `pingo-paint` sits above the Scene, so
//! putting the decoder there would make the dependency a cycle. This mirrors
//! `ComputedStyleResource`, which is here for the same reason.

use crate::{
    AbiError, PATH_FILL_RULE_OFFSET, PATH_POINT_COUNT_OFFSET, PATH_RESERVED_OFFSET,
    PATH_RESOURCE_MINIMUM_BYTES, PATH_RESOURCE_VARIANT, PATH_VARIANT_OFFSET,
    PATH_VERB_COUNT_OFFSET, PATH_VERSION_OFFSET, PATH_VIEW_BOX_HEIGHT_OFFSET,
    PATH_VIEW_BOX_WIDTH_OFFSET, PATH_VIEW_BOX_X_OFFSET, PATH_VIEW_BOX_Y_OFFSET,
    RESOURCE_ENCODING_VERSION,
};

/// How a filled path decides what is inside it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FillRule {
    /// Winding-number rule; the SVG and Canvas2D default.
    NonZero,
    /// Parity rule.
    EvenOdd,
}

/// One step of a path outline.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PathVerb {
    /// Starts a new subpath at the next point.
    Move,
    /// Straight segment to the next point.
    Line,
    /// Quadratic segment through the next two points.
    Quad,
    /// Cubic segment through the next three points.
    Cubic,
    /// Closes the current subpath; consumes no points.
    Close,
}

impl PathVerb {
    const fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Move),
            1 => Some(Self::Line),
            2 => Some(Self::Quad),
            3 => Some(Self::Cubic),
            4 => Some(Self::Close),
            _ => None,
        }
    }

    /// Points this verb consumes.
    #[must_use]
    pub const fn point_count(self) -> usize {
        match self {
            Self::Move | Self::Line => 1,
            Self::Quad => 2,
            Self::Cubic => 3,
            Self::Close => 0,
        }
    }
}

/// Immutable vector outline shared by every node that draws it.
///
/// Verbs and points are separate arrays rather than interleaved records: the
/// shapes differ per verb, and a flat point array is what both `Path2D` and a
/// scanline rasteriser want to walk.
#[derive(Clone, Debug, PartialEq)]
pub struct PathResource {
    /// Outline steps in order.
    pub verbs: Vec<PathVerb>,
    /// Flat `x, y` pairs consumed by the verbs in order.
    pub points: Vec<f32>,
    /// Inside-ness rule for filling.
    pub fill_rule: FillRule,
    /// Author coordinate space as `x, y, width, height`.
    pub view_box: [f32; 4],
}

impl PathResource {
    /// Encodes the aligned v1 resource payload.
    ///
    /// # Errors
    /// Returns [`AbiError::InvalidValue`] when a coordinate is not finite
    /// or the counts overflow.
    pub fn encode(&self) -> Result<Vec<u8>, AbiError> {
        if self.verbs.len() > u32::MAX as usize || self.points.len() > u32::MAX as usize {
            return Err(AbiError::InvalidValue("path is too large to encode"));
        }
        let expected: usize = self.verbs.iter().map(|verb| verb.point_count()).sum();
        if expected * 2 != self.points.len() {
            return Err(AbiError::InvalidValue("path verbs and points disagree"));
        }
        // The decoder refuses an outline that does not start with a move, and
        // so must this: an encoder that emits what its own decoder rejects
        // turns a caller's mistake into a resource nobody can read back.
        if self
            .verbs
            .first()
            .is_some_and(|verb| *verb != PathVerb::Move)
        {
            return Err(AbiError::InvalidValue("path must begin with a move"));
        }
        let mut bytes = vec![0_u8; PATH_RESOURCE_MINIMUM_BYTES];
        bytes[PATH_VERSION_OFFSET] = RESOURCE_ENCODING_VERSION;
        bytes[PATH_VARIANT_OFFSET] = PATH_RESOURCE_VARIANT;
        bytes[PATH_FILL_RULE_OFFSET] = match self.fill_rule {
            FillRule::NonZero => 0,
            FillRule::EvenOdd => 1,
        };
        let verb_count = u32::try_from(self.verbs.len()).unwrap_or(0);
        let point_count = u32::try_from(self.points.len()).unwrap_or(0);
        bytes[PATH_VERB_COUNT_OFFSET..PATH_VERB_COUNT_OFFSET + 4]
            .copy_from_slice(&verb_count.to_le_bytes());
        bytes[PATH_POINT_COUNT_OFFSET..PATH_POINT_COUNT_OFFSET + 4]
            .copy_from_slice(&point_count.to_le_bytes());
        for (index, offset) in [
            PATH_VIEW_BOX_X_OFFSET,
            PATH_VIEW_BOX_Y_OFFSET,
            PATH_VIEW_BOX_WIDTH_OFFSET,
            PATH_VIEW_BOX_HEIGHT_OFFSET,
        ]
        .into_iter()
        .enumerate()
        {
            let value = self.view_box[index];
            if !value.is_finite() {
                return Err(AbiError::InvalidValue("path view box is not finite"));
            }
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        for verb in &self.verbs {
            bytes.push(*verb as u8);
        }
        // Points start four-byte aligned so a decoder can read them without a
        // copy; the verb array is bytes and rarely lands on a boundary.
        while !bytes.len().is_multiple_of(4) {
            bytes.push(0);
        }
        for value in &self.points {
            if !value.is_finite() {
                return Err(AbiError::InvalidValue("path coordinate is not finite"));
            }
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        Ok(bytes)
    }

    /// Decodes a validated outline.
    ///
    /// # Errors
    /// Returns [`AbiError::InvalidValue`] for a truncated, misaligned or
    /// self-inconsistent path.
    pub fn decode(bytes: &[u8]) -> Result<Self, AbiError> {
        if bytes.len() < PATH_RESOURCE_MINIMUM_BYTES {
            return Err(AbiError::InvalidValue("path resource is truncated"));
        }
        if bytes[PATH_VERSION_OFFSET] != RESOURCE_ENCODING_VERSION
            || bytes[PATH_VARIANT_OFFSET] != PATH_RESOURCE_VARIANT
        {
            return Err(AbiError::InvalidValue("path resource version"));
        }
        if bytes[PATH_RESERVED_OFFSET] != 0 {
            return Err(AbiError::InvalidValue("path reserved byte is not zero"));
        }
        let fill_rule = match bytes[PATH_FILL_RULE_OFFSET] {
            0 => FillRule::NonZero,
            1 => FillRule::EvenOdd,
            _ => return Err(AbiError::InvalidValue("path fill rule is unknown")),
        };
        let read_u32 = |offset: usize| -> u32 {
            u32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ])
        };
        let verb_count = read_u32(PATH_VERB_COUNT_OFFSET) as usize;
        let point_count = read_u32(PATH_POINT_COUNT_OFFSET) as usize;
        let verbs_end = PATH_RESOURCE_MINIMUM_BYTES
            .checked_add(verb_count)
            .ok_or(AbiError::InvalidValue("path verb count overflows"))?;
        let points_start = verbs_end
            .checked_add((4 - verbs_end % 4) % 4)
            .ok_or(AbiError::InvalidValue("path padding overflows"))?;
        let points_end = point_count
            .checked_mul(4)
            .and_then(|size| points_start.checked_add(size))
            .ok_or(AbiError::InvalidValue("path point count overflows"))?;
        if bytes.len() != points_end {
            return Err(AbiError::InvalidValue(
                "path length does not match its counts",
            ));
        }
        if bytes[verbs_end..points_start].iter().any(|byte| *byte != 0) {
            return Err(AbiError::InvalidValue("path padding is not zero"));
        }
        let mut verbs = Vec::with_capacity(verb_count);
        let mut expected = 0_usize;
        for raw in &bytes[PATH_RESOURCE_MINIMUM_BYTES..verbs_end] {
            let verb =
                PathVerb::from_u8(*raw).ok_or(AbiError::InvalidValue("path verb is unknown"))?;
            // A path that does not open with a move has no current point, and
            // every consumer would have to invent one.
            if verbs.is_empty() && verb != PathVerb::Move {
                return Err(AbiError::InvalidValue("path must begin with a move"));
            }
            expected += verb.point_count();
            verbs.push(verb);
        }
        if expected * 2 != point_count {
            return Err(AbiError::InvalidValue("path verbs and points disagree"));
        }
        let mut points = Vec::with_capacity(point_count);
        for offset in (points_start..points_end).step_by(4) {
            let value = f32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ]);
            if !value.is_finite() {
                return Err(AbiError::InvalidValue("path coordinate is not finite"));
            }
            points.push(value);
        }
        let mut view_box = [0.0_f32; 4];
        for (index, offset) in [
            PATH_VIEW_BOX_X_OFFSET,
            PATH_VIEW_BOX_Y_OFFSET,
            PATH_VIEW_BOX_WIDTH_OFFSET,
            PATH_VIEW_BOX_HEIGHT_OFFSET,
        ]
        .into_iter()
        .enumerate()
        {
            let value = f32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ]);
            if !value.is_finite() {
                return Err(AbiError::InvalidValue("path view box is not finite"));
            }
            view_box[index] = value;
        }
        if view_box[2] <= 0.0 || view_box[3] <= 0.0 {
            return Err(AbiError::InvalidValue("path view box must be positive"));
        }
        Ok(Self {
            verbs,
            points,
            fill_rule,
            view_box,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn circle_ish() -> PathResource {
        PathResource {
            verbs: vec![
                PathVerb::Move,
                PathVerb::Cubic,
                PathVerb::Quad,
                PathVerb::Line,
                PathVerb::Close,
            ],
            points: vec![
                0.0, 0.0, // move
                1.0, 0.0, 2.0, 1.0, 2.0, 2.0, // cubic
                1.0, 3.0, 0.0, 3.0, // quad
                0.0, 1.0, // line
            ],
            fill_rule: FillRule::EvenOdd,
            view_box: [0.0, 0.0, 24.0, 24.0],
        }
    }

    #[test]
    fn round_trips_every_verb_and_both_fill_rules() {
        for rule in [FillRule::NonZero, FillRule::EvenOdd] {
            let path = PathResource {
                fill_rule: rule,
                ..circle_ish()
            };
            let bytes = path.encode().expect("encode");
            // Points start four-byte aligned so a decoder never reads across a
            // boundary; five verbs means three bytes of padding here.
            assert_eq!(bytes.len() % 4, 0);
            assert_eq!(PathResource::decode(&bytes), Ok(path));
        }
    }

    #[test]
    fn rejects_a_path_that_does_not_begin_with_a_move() {
        // Without an opening move there is no current point, and every consumer
        // would have to invent one.
        let mut bytes = circle_ish().encode().expect("encode");
        bytes[PATH_RESOURCE_MINIMUM_BYTES] = PathVerb::Line as u8;
        assert!(PathResource::decode(&bytes).is_err());
    }

    #[test]
    fn rejects_verbs_and_points_that_disagree() {
        let mut path = circle_ish();
        path.points.pop();
        assert!(path.encode().is_err());

        let mut bytes = circle_ish().encode().expect("encode");
        bytes[PATH_POINT_COUNT_OFFSET] = 2;
        assert!(PathResource::decode(&bytes).is_err());
    }

    #[test]
    fn rejects_malformed_headers_and_payloads() {
        let valid = circle_ish().encode().expect("encode");
        for mutate in [
            |bytes: &mut Vec<u8>| bytes[PATH_VERSION_OFFSET] = 99,
            |bytes: &mut Vec<u8>| bytes[PATH_VARIANT_OFFSET] = 99,
            |bytes: &mut Vec<u8>| bytes[PATH_FILL_RULE_OFFSET] = 9,
            |bytes: &mut Vec<u8>| bytes[PATH_RESERVED_OFFSET] = 1,
            // A zero-extent view box would divide by zero when scaling.
            |bytes: &mut Vec<u8>| {
                bytes[PATH_VIEW_BOX_WIDTH_OFFSET..PATH_VIEW_BOX_WIDTH_OFFSET + 4]
                    .copy_from_slice(&0.0_f32.to_le_bytes());
            },
            |bytes: &mut Vec<u8>| {
                bytes[PATH_VIEW_BOX_X_OFFSET..PATH_VIEW_BOX_X_OFFSET + 4]
                    .copy_from_slice(&f32::NAN.to_le_bytes());
            },
            |bytes: &mut Vec<u8>| {
                let start = bytes.len() - 4;
                bytes[start..].copy_from_slice(&f32::INFINITY.to_le_bytes());
            },
            |bytes: &mut Vec<u8>| {
                bytes[PATH_RESOURCE_MINIMUM_BYTES] = 9;
            },
            |bytes: &mut Vec<u8>| {
                bytes.push(0);
            },
            |bytes: &mut Vec<u8>| {
                bytes.truncate(bytes.len() - 1);
            },
        ] {
            let mut bytes = valid.clone();
            mutate(&mut bytes);
            assert!(
                PathResource::decode(&bytes).is_err(),
                "a mutated path decoded cleanly"
            );
        }
        assert!(PathResource::decode(&valid).is_ok());
    }

    #[test]
    fn rejects_padding_that_is_not_zero() {
        // The padding is where a producer could smuggle bytes past a decoder
        // that trusted the counts.
        let mut bytes = circle_ish().encode().expect("encode");
        bytes[PATH_RESOURCE_MINIMUM_BYTES + 5] = 1;
        assert!(PathResource::decode(&bytes).is_err());
    }

    #[test]
    fn arbitrary_bytes_never_panic() {
        for length in 0..256 {
            let bytes = (0..length)
                .map(|index| (index as u8).wrapping_mul(31))
                .collect::<Vec<_>>();
            let _ = PathResource::decode(&bytes);
        }
    }
    #[test]
    fn rejects_every_malformed_outline() {
        let valid = PathResource {
            verbs: vec![PathVerb::Move, PathVerb::Line, PathVerb::Close],
            points: vec![0.0, 0.0, 1.0, 1.0],
            view_box: [0.0, 0.0, 24.0, 24.0],
            fill_rule: FillRule::NonZero,
        };
        let bytes = valid.encode().expect("valid outline encodes");
        assert_eq!(PathResource::decode(&bytes), Ok(valid));

        // Truncated below the header, so no field can be read at all.
        assert!(PathResource::decode(&bytes[..8]).is_err());

        let mut wrong_version = bytes.clone();
        wrong_version[PATH_VERSION_OFFSET] = RESOURCE_ENCODING_VERSION + 1;
        assert!(PathResource::decode(&wrong_version).is_err());

        let mut wrong_variant = bytes.clone();
        wrong_variant[PATH_VARIANT_OFFSET] = PATH_RESOURCE_VARIANT + 1;
        assert!(PathResource::decode(&wrong_variant).is_err());

        // Reserved byte: a future field must not be read as padding.
        let mut reserved = bytes.clone();
        reserved[PATH_RESERVED_OFFSET] = 1;
        assert!(PathResource::decode(&reserved).is_err());

        let mut unknown_rule = bytes.clone();
        unknown_rule[PATH_FILL_RULE_OFFSET] = 2;
        assert!(PathResource::decode(&unknown_rule).is_err());

        // Counts that do not describe the bytes that follow.
        let mut wrong_counts = bytes.clone();
        wrong_counts[PATH_VERB_COUNT_OFFSET] = 9;
        assert!(PathResource::decode(&wrong_counts).is_err());

        // Padding between the verbs and the points must be zero, for the same
        // reason as the reserved byte.
        let mut dirty_padding = bytes.clone();
        let verbs_end = PATH_RESOURCE_MINIMUM_BYTES + 3;
        dirty_padding[verbs_end] = 1;
        assert!(PathResource::decode(&dirty_padding).is_err());

        // A view box with no extent would divide by zero when scaled.
        let mut empty_view_box = bytes.clone();
        empty_view_box[PATH_VIEW_BOX_WIDTH_OFFSET..PATH_VIEW_BOX_WIDTH_OFFSET + 4]
            .copy_from_slice(&0.0_f32.to_le_bytes());
        assert!(PathResource::decode(&empty_view_box).is_err());

        // A non-finite coordinate would poison every bound derived from it.
        let mut wild_point = bytes.clone();
        let points_start = wild_point.len() - 16;
        wild_point[points_start..points_start + 4].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(PathResource::decode(&wild_point).is_err());
    }

    #[test]
    fn refuses_to_encode_an_outline_that_could_not_be_drawn() {
        // A path that does not begin with a move has no start point, and every
        // consumer would have to invent one — differently.
        assert!(
            PathResource {
                verbs: vec![PathVerb::Line],
                points: vec![1.0, 1.0],
                view_box: [0.0, 0.0, 1.0, 1.0],
                fill_rule: FillRule::NonZero,
            }
            .encode()
            .is_err()
        );

        // Verb and point counts that disagree.
        assert!(
            PathResource {
                verbs: vec![PathVerb::Move, PathVerb::Cubic],
                points: vec![0.0, 0.0],
                view_box: [0.0, 0.0, 1.0, 1.0],
                fill_rule: FillRule::NonZero,
            }
            .encode()
            .is_err()
        );
    }
}
