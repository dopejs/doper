use doper_abi::{DisplayCommand, DisplayList, DisplayOpcode, ResourceKind};
use doper_paint::SolidPaint;
use doper_scene::Scene;

use crate::HeadlessError;

const MAX_DIMENSION: u32 = 8192;
const MAX_PIXELS: usize = 64 * 1024 * 1024;

/// Exact RGBA8 result owned by the deterministic headless oracle.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HeadlessImage {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    hash: u64,
}

impl HeadlessImage {
    /// Returns the image width in pixels.
    #[must_use]
    pub const fn width(&self) -> u32 {
        self.width
    }

    /// Returns the image height in pixels.
    #[must_use]
    pub const fn height(&self) -> u32 {
        self.height
    }

    /// Returns tightly packed, row-major, straight-alpha RGBA8 pixels.
    #[must_use]
    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    /// Returns the deterministic FNV-1a hash of dimensions and pixel bytes.
    #[must_use]
    pub const fn hash(&self) -> u64 {
        self.hash
    }
}

/// Work counters for one software-oracle replay.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct HeadlessMetrics {
    /// Validated `DisplayList` commands.
    pub commands: usize,
    /// Pixel centers evaluated inside command bounds.
    pub candidate_pixels: u64,
    /// Pixels that passed geometry and clip tests and were blended.
    pub blended_pixels: u64,
}

/// Allocation-reusing deterministic renderer for the M1 command intersection.
#[derive(Default)]
pub struct HeadlessRenderer {
    pixels: Vec<u8>,
    states: Vec<State>,
    metrics: HeadlessMetrics,
}

impl HeadlessRenderer {
    /// Creates an empty renderer.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Validates and renders one `DisplayList` against portable Scene resources.
    ///
    /// # Errors
    ///
    /// Rejects malformed lists, oversized surfaces, missing/wrong resources,
    /// and commands outside the M1 oracle subset.
    pub fn render(
        &mut self,
        bytes: &[u8],
        scene: &Scene,
        width: u32,
        height: u32,
    ) -> Result<HeadlessImage, HeadlessError> {
        let pixel_count = surface_pixels(width, height)?;
        let byte_count = pixel_count
            .checked_mul(4)
            .ok_or(HeadlessError::SurfaceSizeOverflow)?;
        self.metrics = HeadlessMetrics::default();
        let display_list = DisplayList::decode(bytes)?;
        self.metrics.commands = display_list.instructions.len();
        validate_supported(&display_list)?;
        self.pixels.clear();
        self.pixels.resize(byte_count, 0);
        self.states.clear();
        self.states.push(State::default());

        for instruction in display_list.instructions {
            self.execute(instruction.command, scene, width, height)?;
        }
        let hash = hash_image(width, height, &self.pixels);
        Ok(HeadlessImage {
            width,
            height,
            pixels: self.pixels.clone(),
            hash,
        })
    }

    /// Returns counters from the most recent successful or failed replay attempt.
    #[must_use]
    pub const fn metrics(&self) -> HeadlessMetrics {
        self.metrics
    }

    fn execute(
        &mut self,
        command: DisplayCommand,
        scene: &Scene,
        width: u32,
        height: u32,
    ) -> Result<(), HeadlessError> {
        match command {
            DisplayCommand::Save => {
                let current = self.current().clone();
                self.states.push(current);
            }
            DisplayCommand::Restore => {
                self.states.pop();
            }
            DisplayCommand::Transform(matrix) => {
                self.current_mut().transform = self.current().transform.multiply(Affine(matrix));
            }
            DisplayCommand::ClipRect(rect) => {
                let polygon = self.current().transform.rect(rect);
                self.current_mut().clips.push(polygon);
            }
            DisplayCommand::Alpha(alpha) => self.current_mut().alpha *= alpha,
            DisplayCommand::FillRect { rect, paint_id } => {
                let resource = scene
                    .resource(paint_id)
                    .ok_or(HeadlessError::MissingResource {
                        resource_id: paint_id,
                    })?;
                if resource.kind != ResourceKind::Paint {
                    return Err(HeadlessError::WrongResourceKind {
                        resource_id: paint_id,
                        actual: resource.kind,
                    });
                }
                let paint = SolidPaint::decode(paint_id, resource)?;
                let state = self.current().clone();
                let polygon = state.transform.rect(rect);
                self.fill_polygon(polygon, &state.clips, paint, state.alpha, width, height);
            }
            DisplayCommand::DrawEditorDecoration { rect, rgba, .. } => {
                let [red, green, blue, alpha] = rgba.to_be_bytes();
                let state = self.current().clone();
                let polygon = state.transform.rect(rect);
                self.fill_polygon(
                    polygon,
                    &state.clips,
                    SolidPaint {
                        red,
                        green,
                        blue,
                        alpha,
                    },
                    state.alpha,
                    width,
                    height,
                );
            }
            unsupported => {
                return Err(HeadlessError::UnsupportedCommand(command_opcode(
                    &unsupported,
                )));
            }
        }
        Ok(())
    }

    fn fill_polygon(
        &mut self,
        polygon: Polygon,
        clips: &[Polygon],
        paint: SolidPaint,
        alpha: f32,
        width: u32,
        height: u32,
    ) {
        let Some(bounds) = polygon.bounds(width, height) else {
            return;
        };
        let source_alpha = scale_alpha(paint.alpha, alpha);
        if source_alpha == 0 {
            return;
        }
        for y in bounds.top..bounds.bottom {
            for x in bounds.left..bounds.right {
                self.metrics.candidate_pixels += 1;
                let sample = Point {
                    x: f64::from(x) + 0.5,
                    y: f64::from(y) + 0.5,
                };
                if !polygon.contains(sample) || clips.iter().any(|clip| !clip.contains(sample)) {
                    continue;
                }
                let pixel = (usize::try_from(y).expect("bounded y")
                    * usize::try_from(width).expect("bounded width")
                    + usize::try_from(x).expect("bounded x"))
                    * 4;
                blend(
                    &mut self.pixels[pixel..pixel + 4],
                    [paint.red, paint.green, paint.blue, source_alpha],
                );
                self.metrics.blended_pixels += 1;
            }
        }
    }

    fn current(&self) -> &State {
        self.states.last().expect("DisplayList state is validated")
    }

    fn current_mut(&mut self) -> &mut State {
        self.states
            .last_mut()
            .expect("DisplayList state is validated")
    }
}

#[derive(Clone, Debug)]
struct State {
    transform: Affine,
    clips: Vec<Polygon>,
    alpha: f32,
}

impl Default for State {
    fn default() -> Self {
        Self {
            transform: Affine::IDENTITY,
            clips: Vec::new(),
            alpha: 1.0,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Affine([f32; 6]);

impl Affine {
    const IDENTITY: Self = Self([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    #[allow(clippy::similar_names)]
    fn multiply(self, next: Self) -> Self {
        let [m00, m10, m01, m11, tx, ty] = self.0;
        let [next_m00, next_m10, next_m01, next_m11, next_tx, next_ty] = next.0;
        Self([
            m00 * next_m00 + m01 * next_m10,
            m10 * next_m00 + m11 * next_m10,
            m00 * next_m01 + m01 * next_m11,
            m10 * next_m01 + m11 * next_m11,
            m00 * next_tx + m01 * next_ty + tx,
            m10 * next_tx + m11 * next_ty + ty,
        ])
    }

    fn point(self, horizontal: f32, vertical: f32) -> Point {
        let [m00, m10, m01, m11, tx, ty] = self.0;
        Point {
            x: f64::from(m00 * horizontal + m01 * vertical + tx),
            y: f64::from(m10 * horizontal + m11 * vertical + ty),
        }
    }

    fn rect(self, [x, y, width, height]: [f32; 4]) -> Polygon {
        Polygon([
            self.point(x, y),
            self.point(x + width, y),
            self.point(x + width, y + height),
            self.point(x, y + height),
        ])
    }
}

#[derive(Clone, Copy, Debug)]
struct Point {
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Debug)]
struct Polygon([Point; 4]);

impl Polygon {
    fn contains(&self, point: Point) -> bool {
        let mut sign = 0_i8;
        for index in 0..4 {
            let first = self.0[index];
            let second = self.0[(index + 1) % 4];
            let cross = (second.x - first.x) * (point.y - first.y)
                - (second.y - first.y) * (point.x - first.x);
            if cross == 0.0 {
                continue;
            }
            let next_sign = if cross > 0.0 { 1 } else { -1 };
            if sign != 0 && sign != next_sign {
                return false;
            }
            sign = next_sign;
        }
        sign != 0
    }

    fn bounds(&self, width: u32, height: u32) -> Option<Bounds> {
        let min_x = self
            .0
            .iter()
            .map(|point| point.x)
            .fold(f64::INFINITY, f64::min);
        let max_x = self
            .0
            .iter()
            .map(|point| point.x)
            .fold(f64::NEG_INFINITY, f64::max);
        let min_y = self
            .0
            .iter()
            .map(|point| point.y)
            .fold(f64::INFINITY, f64::min);
        let max_y = self
            .0
            .iter()
            .map(|point| point.y)
            .fold(f64::NEG_INFINITY, f64::max);
        let left = clamp_floor(min_x, width);
        let right = clamp_ceil(max_x, width);
        let top = clamp_floor(min_y, height);
        let bottom = clamp_ceil(max_y, height);
        (left < right && top < bottom).then_some(Bounds {
            left,
            right,
            top,
            bottom,
        })
    }
}

struct Bounds {
    left: u32,
    right: u32,
    top: u32,
    bottom: u32,
}

fn surface_pixels(width: u32, height: u32) -> Result<usize, HeadlessError> {
    if width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(HeadlessError::InvalidSurface { width, height });
    }
    let pixels = usize::try_from(width)
        .ok()
        .and_then(|width| {
            usize::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .ok_or(HeadlessError::SurfaceSizeOverflow)?;
    if pixels > MAX_PIXELS {
        return Err(HeadlessError::InvalidSurface { width, height });
    }
    Ok(pixels)
}

fn validate_supported(display_list: &DisplayList) -> Result<(), HeadlessError> {
    for instruction in &display_list.instructions {
        match instruction.command {
            DisplayCommand::Save
            | DisplayCommand::Restore
            | DisplayCommand::Transform(_)
            | DisplayCommand::ClipRect(_)
            | DisplayCommand::Alpha(_)
            | DisplayCommand::FillRect { .. }
            | DisplayCommand::DrawEditorDecoration { .. } => {}
            ref command => return Err(HeadlessError::UnsupportedCommand(command_opcode(command))),
        }
    }
    Ok(())
}

fn command_opcode(command: &DisplayCommand) -> DisplayOpcode {
    match command {
        DisplayCommand::Save => DisplayOpcode::Save,
        DisplayCommand::Restore => DisplayOpcode::Restore,
        DisplayCommand::Transform(_) => DisplayOpcode::Transform,
        DisplayCommand::ClipRect(_) => DisplayOpcode::ClipRect,
        DisplayCommand::Alpha(_) => DisplayOpcode::Alpha,
        DisplayCommand::FillRect { .. } => DisplayOpcode::FillRect,
        DisplayCommand::FillRRect { .. } => DisplayOpcode::FillRRect,
        DisplayCommand::FillPath { .. } => DisplayOpcode::FillPath,
        DisplayCommand::DrawGlyphRun { .. } => DisplayOpcode::DrawGlyphRun,
        DisplayCommand::DrawTextFallback { .. } => DisplayOpcode::DrawTextFallback,
        DisplayCommand::DrawTextInlineFallback { .. } => DisplayOpcode::DrawTextInlineFallback,
        DisplayCommand::DrawEditorDecoration { .. } => DisplayOpcode::DrawEditorDecoration,
        DisplayCommand::DrawImage { .. } => DisplayOpcode::DrawImage,
        DisplayCommand::DrawPicture { .. } => DisplayOpcode::DrawPicture,
    }
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn clamp_floor(value: f64, maximum: u32) -> u32 {
    if !value.is_finite() || value <= 0.0 {
        0
    } else if value >= f64::from(maximum) {
        maximum
    } else {
        value.floor() as u32
    }
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn clamp_ceil(value: f64, maximum: u32) -> u32 {
    if !value.is_finite() || value <= 0.0 {
        0
    } else if value >= f64::from(maximum) {
        maximum
    } else {
        value.ceil() as u32
    }
}

fn blend(destination: &mut [u8], source: [u8; 4]) {
    let source_alpha = u32::from(source[3]);
    let destination_alpha = u32::from(destination[3]);
    let inverse = 255 - source_alpha;
    let output_alpha_numerator = source_alpha * 255 + destination_alpha * inverse;
    if output_alpha_numerator == 0 {
        destination.fill(0);
        return;
    }
    for channel in 0..3 {
        let numerator = u32::from(source[channel]) * source_alpha * 255
            + u32::from(destination[channel]) * destination_alpha * inverse;
        destination[channel] = u8::try_from(rounded_divide(numerator, output_alpha_numerator))
            .expect("blended color is bounded to u8");
    }
    destination[3] = u8::try_from(rounded_divide(output_alpha_numerator, 255))
        .expect("blended alpha is bounded to u8");
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn scale_alpha(alpha: u8, multiplier: f32) -> u8 {
    // The explicit clamp proves the rounded value is finite and in 0..=255.
    (f32::from(alpha) * multiplier.clamp(0.0, 1.0)).round() as u8
}

fn rounded_divide(numerator: u32, denominator: u32) -> u32 {
    (numerator + denominator / 2) / denominator
}

fn hash_image(width: u32, height: u32, pixels: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in width
        .to_le_bytes()
        .into_iter()
        .chain(height.to_le_bytes())
        .chain(pixels.iter().copied())
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use doper_abi::{
        DisplayCommand, DisplayInstruction, DisplayList, Mutation, MutationBatch,
        MutationInstruction, NULL_NODE_ID, NodeKind, ResourceKind,
    };
    use doper_paint::SolidPaint;
    use doper_scene::{NodeId, Scene};
    use proptest::prelude::*;

    use super::HeadlessRenderer;
    use crate::HeadlessError;

    fn scene_with_paint(color: SolidPaint) -> Scene {
        let root = NodeId::new(0, 1).expect("root").raw();
        let mut scene = Scene::new();
        scene
            .commit(MutationBatch {
                frame_seq: 1,
                instructions: vec![
                    MutationInstruction {
                        flags: 0,
                        mutation: Mutation::CreateNode {
                            node_id: root,
                            kind: NodeKind::Root,
                            parent: NULL_NODE_ID,
                            before_sibling: NULL_NODE_ID,
                        },
                    },
                    MutationInstruction {
                        flags: 0,
                        mutation: Mutation::DefineResource {
                            resource_id: 1,
                            kind: ResourceKind::Paint,
                            bytes: color.encode().to_vec(),
                        },
                    },
                ],
            })
            .expect("Scene");
        scene
    }

    fn display(commands: Vec<DisplayCommand>) -> Vec<u8> {
        DisplayList {
            instructions: commands
                .into_iter()
                .map(|command| DisplayInstruction { flags: 0, command })
                .collect(),
        }
        .encode()
        .expect("DisplayList")
    }

    fn pixel(image: &super::HeadlessImage, x: u32, y: u32) -> [u8; 4] {
        let offset = (usize::try_from(y).expect("y")
            * usize::try_from(image.width()).expect("width")
            + usize::try_from(x).expect("x"))
            * 4;
        image.pixels()[offset..offset + 4]
            .try_into()
            .expect("pixel")
    }

    #[test]
    fn fills_exact_pixel_centers_and_reports_work() {
        let scene = scene_with_paint(SolidPaint {
            red: 255,
            green: 0,
            blue: 0,
            alpha: 255,
        });
        let bytes = display(vec![DisplayCommand::FillRect {
            rect: [1.0, 1.0, 2.0, 2.0],
            paint_id: 1,
        }]);
        let mut renderer = HeadlessRenderer::new();
        let image = renderer.render(&bytes, &scene, 4, 4).expect("render");

        assert_eq!(pixel(&image, 0, 0), [0, 0, 0, 0]);
        assert_eq!(pixel(&image, 1, 1), [255, 0, 0, 255]);
        assert_eq!(pixel(&image, 2, 2), [255, 0, 0, 255]);
        assert_eq!(pixel(&image, 3, 3), [0, 0, 0, 0]);
        assert_eq!(renderer.metrics().candidate_pixels, 4);
        assert_eq!(renderer.metrics().blended_pixels, 4);
    }

    #[test]
    fn composes_transform_clip_and_alpha_without_platform_pixels() {
        let scene = scene_with_paint(SolidPaint {
            red: 20,
            green: 40,
            blue: 60,
            alpha: 255,
        });
        let bytes = display(vec![
            DisplayCommand::Save,
            DisplayCommand::Transform([1.0, 0.0, 0.0, 1.0, 1.0, 0.0]),
            DisplayCommand::ClipRect([0.0, 0.0, 2.0, 2.0]),
            DisplayCommand::Alpha(0.5),
            DisplayCommand::FillRect {
                rect: [0.0, 0.0, 3.0, 3.0],
                paint_id: 1,
            },
            DisplayCommand::Restore,
        ]);
        let image = HeadlessRenderer::new()
            .render(&bytes, &scene, 4, 3)
            .expect("render");

        assert_eq!(pixel(&image, 1, 0), [20, 40, 60, 128]);
        assert_eq!(pixel(&image, 2, 1), [20, 40, 60, 128]);
        assert_eq!(pixel(&image, 3, 1), [0, 0, 0, 0]);
        assert_ne!(image.hash(), 0);
    }

    #[test]
    fn rejects_unsupported_commands_before_mutating_the_reusable_surface() {
        let scene = scene_with_paint(SolidPaint {
            red: 0,
            green: 0,
            blue: 0,
            alpha: 255,
        });
        let bytes = display(vec![DisplayCommand::DrawTextFallback {
            string_id: 2,
            font_description_id: 3,
            origin: [0.0, 10.0],
        }]);
        assert!(matches!(
            HeadlessRenderer::new().render(&bytes, &scene, 10, 10),
            Err(HeadlessError::UnsupportedCommand(_))
        ));
    }

    proptest! {
        #[test]
        fn axis_aligned_rectangles_match_a_naive_pixel_oracle(
            x in 0_u16..8,
            y in 0_u16..8,
            width in 0_u16..8,
            height in 0_u16..8,
            red in any::<u8>(),
            green in any::<u8>(),
            blue in any::<u8>(),
        ) {
            let scene = scene_with_paint(SolidPaint { red, green, blue, alpha: 255 });
            let bytes = display(vec![DisplayCommand::FillRect {
                rect: [f32::from(x), f32::from(y), f32::from(width), f32::from(height)],
                paint_id: 1,
            }]);
            let image = HeadlessRenderer::new().render(&bytes, &scene, 16, 16).expect("render");
            for sample_y in 0..16 {
                for sample_x in 0..16 {
                    let inside = sample_x >= u32::from(x)
                        && sample_x < u32::from(x.saturating_add(width))
                        && sample_y >= u32::from(y)
                        && sample_y < u32::from(y.saturating_add(height));
                    let expected = if inside { [red, green, blue, 255] } else { [0, 0, 0, 0] };
                    prop_assert_eq!(pixel(&image, sample_x, sample_y), expected);
                }
            }
        }
    }
}
