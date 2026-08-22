use pingo_abi::{
    DisplayCommand, DisplayList, DisplayOpcode, FillRule, PathResource, PathVerb, ResourceKind,
};
use pingo_paint::SolidPaint;
use pingo_scene::Scene;

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
                let paint = solid_paint(scene, paint_id)?;
                let state = self.current().clone();
                let polygon = state.transform.rect(rect);
                self.fill_polygon(polygon, &state.clips, paint, state.alpha, width, height);
            }
            DisplayCommand::FillColorRect { rect, rgba }
            | DisplayCommand::FillPlaceholder { rect, rgba }
            | DisplayCommand::DrawEditorDecoration { rect, rgba, .. } => {
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
            DisplayCommand::FillColorShadow {
                rect,
                radii,
                offset,
                blur,
                rgba,
            } => {
                let state = self.current().clone();
                self.fill_shadow(rect, radii, offset, blur, rgba, &state, width, height);
            }
            DisplayCommand::FillColorPath { path_id, rgba } => {
                self.execute_fill_color_path(path_id, rgba, scene, width, height)?;
            }
            DisplayCommand::FillColorRRect { rect, radii, rgba } => {
                let [red, green, blue, alpha] = rgba.to_be_bytes();
                let state = self.current().clone();
                self.fill_rrect(
                    rect,
                    radii,
                    &state,
                    SolidPaint {
                        red,
                        green,
                        blue,
                        alpha,
                    },
                    width,
                    height,
                );
            }
            DisplayCommand::FillRRect {
                rect,
                radii,
                paint_id,
            } => {
                let paint = solid_paint(scene, paint_id)?;
                let state = self.current().clone();
                self.fill_rrect(rect, radii, &state, paint, width, height);
            }
            DisplayCommand::FillColorBorder {
                rect,
                radii,
                widths,
                colors,
            } => {
                let state = self.current().clone();
                self.fill_border(rect, radii, widths, colors, &state, width, height);
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

    /// Unpacks the inline colour before handing off, so `execute` stays a
    /// dispatch table rather than growing a body per command.
    fn execute_fill_color_path(
        &mut self,
        path_id: u32,
        rgba: u32,
        scene: &Scene,
        width: u32,
        height: u32,
    ) -> Result<(), HeadlessError> {
        let [red, green, blue, alpha] = rgba.to_be_bytes();
        let state = self.current().clone();
        self.fill_path(
            path_id,
            scene,
            &state,
            SolidPaint {
                red,
                green,
                blue,
                alpha,
            },
            width,
            height,
        )
    }

    /// Fills a flattened outline by sampling, the same way `fill_rrect` does.
    ///
    /// Sampling rather than scanline conversion because the renderer already
    /// inverse-transforms each pixel to test containment; a second rasterisation
    /// strategy would be a second set of edge cases to keep in agreement.
    fn fill_path(
        &mut self,
        path_id: u32,
        scene: &Scene,
        state: &State,
        paint: SolidPaint,
        width: u32,
        height: u32,
    ) -> Result<(), HeadlessError> {
        let resource = scene
            .resource(path_id)
            .ok_or(HeadlessError::MissingResource {
                resource_id: path_id,
            })?;
        if resource.kind != ResourceKind::Path {
            return Err(HeadlessError::WrongResourceKind {
                resource_id: path_id,
                actual: resource.kind,
            });
        }
        // Scene validated this at commit; decoding again keeps the oracle from
        // trusting a caller that assembled a Scene by hand.
        let path = PathResource::decode(&resource.bytes).map_err(|_| {
            HeadlessError::WrongResourceKind {
                resource_id: path_id,
                actual: resource.kind,
            }
        })?;
        let contours = flatten_path(&path);
        let Some(local_bounds) = contour_bounds(&contours) else {
            return Ok(());
        };
        let polygon = state.transform.rect(local_bounds);
        let Some(bounds) = polygon.bounds(width, height) else {
            return Ok(());
        };
        let Some(inverse) = state.transform.inverse() else {
            return Ok(());
        };
        let source_alpha = scale_alpha(paint.alpha, state.alpha);
        if source_alpha == 0 {
            return Ok(());
        }
        for y in bounds.top..bounds.bottom {
            for x in bounds.left..bounds.right {
                self.metrics.candidate_pixels += 1;
                let sample = Point {
                    x: f64::from(x) + 0.5,
                    y: f64::from(y) + 0.5,
                };
                let local = inverse.point_f64(sample);
                if !contours_contain(&contours, local, path.fill_rule)
                    || state.clips.iter().any(|clip| !clip.contains(sample))
                {
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
        Ok(())
    }

    fn fill_rrect(
        &mut self,
        rect: [f32; 4],
        radii: [f32; 4],
        state: &State,
        paint: SolidPaint,
        width: u32,
        height: u32,
    ) {
        let polygon = state.transform.rect(rect);
        let Some(bounds) = polygon.bounds(width, height) else {
            return;
        };
        let Some(inverse) = state.transform.inverse() else {
            return;
        };
        let source_alpha = scale_alpha(paint.alpha, state.alpha);
        if source_alpha == 0 {
            return;
        }
        let radii = normalize_radii(rect[2], rect[3], radii);
        for y in bounds.top..bounds.bottom {
            for x in bounds.left..bounds.right {
                self.metrics.candidate_pixels += 1;
                let sample = Point {
                    x: f64::from(x) + 0.5,
                    y: f64::from(y) + 0.5,
                };
                let local = inverse.point_f64(sample);
                if !rounded_rect_contains(rect, radii, local)
                    || state.clips.iter().any(|clip| !clip.contains(sample))
                {
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

    /// Rasterizes one outer drop shadow.
    ///
    /// `Canvas2D` specifies `shadowBlur` as a Gaussian whose sigma is half the
    /// blur, and implementations approximate it with three box passes. This
    /// oracle does the same rather than an exact Gaussian, so it lands where a
    /// real backend lands instead of somewhere provably different.
    #[allow(clippy::too_many_arguments)]
    fn fill_shadow(
        &mut self,
        rect: [f32; 4],
        corners: [f32; 4],
        shift: [f32; 2],
        blur_radius: f32,
        rgba: u32,
        state: &State,
        width: u32,
        height: u32,
    ) {
        let [red, green, blue, declared] = rgba.to_be_bytes();
        let source_alpha = scale_alpha(declared, state.alpha);
        if source_alpha == 0 {
            return;
        }
        let shifted = [rect[0] + shift[0], rect[1] + shift[1], rect[2], rect[3]];
        let polygon = state.transform.rect(shifted);
        let Some(tight) = polygon.bounds(width, height) else {
            return;
        };
        let Some(inverse) = state.transform.inverse() else {
            return;
        };
        // Three box passes reach about three sigma, which is where a Gaussian
        // has nothing left worth blending.
        let margin = clamp_ceil(f64::from(blur_radius) * 1.5, MAX_DIMENSION);
        let bounds = Bounds {
            left: tight.left.saturating_sub(margin),
            right: (tight.right + margin).min(width),
            top: tight.top.saturating_sub(margin),
            bottom: (tight.bottom + margin).min(height),
        };
        let span = usize::try_from(bounds.right.saturating_sub(bounds.left)).unwrap_or(0);
        let rows = usize::try_from(bounds.bottom.saturating_sub(bounds.top)).unwrap_or(0);
        if span == 0 || rows == 0 {
            return;
        }
        let radii = normalize_radii(rect[2], rect[3], corners);
        let mut coverage = vec![0.0_f32; span * rows];
        for row in 0..rows {
            for column in 0..span {
                let sample = Point {
                    x: f64::from(bounds.left + offset_of(column)) + 0.5,
                    y: f64::from(bounds.top + offset_of(row)) + 0.5,
                };
                let local = inverse.point_f64(sample);
                let unshifted = Point {
                    x: local.x - f64::from(shift[0]),
                    y: local.y - f64::from(shift[1]),
                };
                if rounded_rect_contains(rect, radii, unshifted) {
                    coverage[row * span + column] = 1.0;
                }
            }
        }
        if blur_radius > 0.0 {
            box_blur(&mut coverage, span, rows, box_size(blur_radius * 0.5));
        }
        for row in 0..rows {
            for column in 0..span {
                self.metrics.candidate_pixels += 1;
                let value = coverage[row * span + column];
                if value <= 0.0 {
                    continue;
                }
                let x = bounds.left + offset_of(column);
                let y = bounds.top + offset_of(row);
                let sample = Point {
                    x: f64::from(x) + 0.5,
                    y: f64::from(y) + 0.5,
                };
                if state.clips.iter().any(|clip| !clip.contains(sample)) {
                    continue;
                }
                let blended_alpha = scale_alpha(source_alpha, value.clamp(0.0, 1.0));
                if blended_alpha == 0 {
                    continue;
                }
                let pixel = (usize::try_from(y).expect("bounded y")
                    * usize::try_from(width).expect("bounded width")
                    + usize::try_from(x).expect("bounded x"))
                    * 4;
                blend(
                    &mut self.pixels[pixel..pixel + 4],
                    [red, green, blue, blended_alpha],
                );
                self.metrics.blended_pixels += 1;
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn fill_border(
        &mut self,
        rect: [f32; 4],
        radii: [f32; 4],
        widths: [f32; 4],
        colors: [u32; 4],
        state: &State,
        surface_width: u32,
        surface_height: u32,
    ) {
        let polygon = state.transform.rect(rect);
        let Some(bounds) = polygon.bounds(surface_width, surface_height) else {
            return;
        };
        let Some(inverse) = state.transform.inverse() else {
            return;
        };
        let [x, y, width, height] = rect;
        let [top, right, bottom, left] = widths;
        let radii = normalize_radii(width, height, radii);
        let inner = [
            x + left,
            y + top,
            (width - left - right).max(0.0),
            (height - top - bottom).max(0.0),
        ];
        let inner_radii = [
            [(radii[0] - left).max(0.0), (radii[0] - top).max(0.0)],
            [(radii[1] - right).max(0.0), (radii[1] - top).max(0.0)],
            [(radii[2] - right).max(0.0), (radii[2] - bottom).max(0.0)],
            [(radii[3] - left).max(0.0), (radii[3] - bottom).max(0.0)],
        ];
        for pixel_y in bounds.top..bounds.bottom {
            for pixel_x in bounds.left..bounds.right {
                self.metrics.candidate_pixels += 1;
                let sample = Point {
                    x: f64::from(pixel_x) + 0.5,
                    y: f64::from(pixel_y) + 0.5,
                };
                let local = inverse.point_f64(sample);
                if !rounded_rect_contains(rect, radii, local)
                    || (inner[2] > 0.0
                        && inner[3] > 0.0
                        && elliptical_rrect_contains(inner, inner_radii, local))
                    || state.clips.iter().any(|clip| !clip.contains(sample))
                {
                    continue;
                }
                let distances = [
                    side_distance(local.y - f64::from(y), top),
                    side_distance(f64::from(x + width) - local.x, right),
                    side_distance(f64::from(y + height) - local.y, bottom),
                    side_distance(local.x - f64::from(x), left),
                ];
                let Some(side) = distances
                    .iter()
                    .enumerate()
                    .filter(|(side, _)| widths[*side] > 0.0)
                    .min_by(|left, right| left.1.total_cmp(right.1))
                    .map(|(side, _)| side)
                else {
                    continue;
                };
                let [red, green, blue, alpha] = colors[side].to_be_bytes();
                let source_alpha = scale_alpha(alpha, state.alpha);
                if source_alpha == 0 {
                    continue;
                }
                let pixel = (usize::try_from(pixel_y).expect("bounded y")
                    * usize::try_from(surface_width).expect("bounded width")
                    + usize::try_from(pixel_x).expect("bounded x"))
                    * 4;
                blend(
                    &mut self.pixels[pixel..pixel + 4],
                    [red, green, blue, source_alpha],
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

fn solid_paint(scene: &Scene, paint_id: u32) -> Result<SolidPaint, HeadlessError> {
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
    Ok(SolidPaint::decode(paint_id, resource)?)
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

    fn point_f64(self, point: Point) -> Point {
        let [m00, m10, m01, m11, tx, ty] = self.0;
        Point {
            x: f64::from(m00) * point.x + f64::from(m01) * point.y + f64::from(tx),
            y: f64::from(m10) * point.x + f64::from(m11) * point.y + f64::from(ty),
        }
    }

    fn inverse(self) -> Option<Self> {
        let [m00, m10, m01, m11, tx, ty] = self.0;
        let determinant = m00 * m11 - m10 * m01;
        if !determinant.is_finite() || determinant.abs() <= f32::EPSILON {
            return None;
        }
        let inverse = determinant.recip();
        Some(Self([
            m11 * inverse,
            -m10 * inverse,
            -m01 * inverse,
            m00 * inverse,
            (m01 * ty - m11 * tx) * inverse,
            (m10 * tx - m00 * ty) * inverse,
        ]))
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
            | DisplayCommand::FillColorRect { .. }
            | DisplayCommand::FillRRect { .. }
            | DisplayCommand::FillColorRRect { .. }
            | DisplayCommand::FillColorPath { .. }
            | DisplayCommand::FillColorBorder { .. }
            | DisplayCommand::FillColorShadow { .. }
            | DisplayCommand::FillPlaceholder { .. }
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
        DisplayCommand::FillColorRect { .. } => DisplayOpcode::FillColorRect,
        DisplayCommand::FillColorRRect { .. } => DisplayOpcode::FillColorRRect,
        DisplayCommand::FillColorBorder { .. } => DisplayOpcode::FillColorBorder,
        DisplayCommand::FillColorShadow { .. } => DisplayOpcode::FillColorShadow,
        DisplayCommand::FillRRect { .. } => DisplayOpcode::FillRRect,
        DisplayCommand::FillPath { .. } => DisplayOpcode::FillPath,
        DisplayCommand::StrokePath { .. } => DisplayOpcode::StrokePath,
        DisplayCommand::FillColorPath { .. } => DisplayOpcode::FillColorPath,
        DisplayCommand::StrokeColorPath { .. } => DisplayOpcode::StrokeColorPath,
        DisplayCommand::DrawGlyphRun { .. } => DisplayOpcode::DrawGlyphRun,
        DisplayCommand::DrawTextFallback { .. } => DisplayOpcode::DrawTextFallback,
        DisplayCommand::DrawTextInlineFallback { .. } => DisplayOpcode::DrawTextInlineFallback,
        DisplayCommand::FillPlaceholder { .. } => DisplayOpcode::FillPlaceholder,
        DisplayCommand::DrawEditorDecoration { .. } => DisplayOpcode::DrawEditorDecoration,
        DisplayCommand::DrawImage { .. } => DisplayOpcode::DrawImage,
        DisplayCommand::DrawPicture { .. } => DisplayOpcode::DrawPicture,
    }
}

/// Converts a mask index back into a pixel offset.
fn offset_of(index: usize) -> u32 {
    u32::try_from(index).unwrap_or(u32::MAX)
}

/// Box width whose three passes approximate a Gaussian of this sigma.
///
/// This is the same rule Skia uses for `shadowBlur`, so the oracle and a real
/// `Canvas2D` reach the same shape.
fn box_size(sigma: f32) -> usize {
    if sigma <= 0.0 {
        return 0;
    }
    let size = usize::try_from(clamp_floor(
        f64::from(sigma) * 3.0 * (2.0 * core::f64::consts::PI).sqrt() / 4.0 + 0.5,
        MAX_DIMENSION,
    ))
    .unwrap_or(1)
    .max(1);
    // An odd width keeps the box centred, so the blur does not drift.
    if size % 2 == 0 { size + 1 } else { size }
}

/// Three separable box passes over a coverage mask.
fn box_blur(coverage: &mut [f32], span: usize, rows: usize, size: usize) {
    if size <= 1 {
        return;
    }
    let radius = size / 2;
    let mut scratch = vec![0.0_f32; coverage.len()];
    for _ in 0..3 {
        blur_axis(coverage, &mut scratch, span, rows, radius, true);
        blur_axis(&scratch, coverage, span, rows, radius, false);
        // `blur_axis` wrote rows into `scratch` then columns back into
        // `coverage`, so the pass ends with the result where it started.
    }
}

fn blur_axis(
    source: &[f32],
    destination: &mut [f32],
    span: usize,
    rows: usize,
    radius: usize,
    horizontal: bool,
) {
    let (outer, inner) = if horizontal {
        (rows, span)
    } else {
        (span, rows)
    };
    let divisor = coverage_divisor(radius);
    for line in 0..outer {
        for index in 0..inner {
            let mut total = 0.0_f32;
            for step in 0..=radius * 2 {
                // Saturating arithmetic clamps at the edges, which is the
                // border behaviour a box blur wants anyway.
                let clamped = (index + step)
                    .saturating_sub(radius)
                    .min(inner.saturating_sub(1));
                let (row, column) = if horizontal {
                    (line, clamped)
                } else {
                    (clamped, line)
                };
                total += source[row * span + column];
            }
            let (row, column) = if horizontal {
                (line, index)
            } else {
                (index, line)
            };
            destination[row * span + column] = total / divisor;
        }
    }
}

#[allow(clippy::cast_precision_loss)]
fn coverage_divisor(radius: usize) -> f32 {
    (radius * 2 + 1) as f32
}

fn normalize_radii(width: f32, height: f32, radii: [f32; 4]) -> [f32; 4] {
    let [top_left, top_right, bottom_right, bottom_left] = radii;
    let scale = [
        ratio(width, top_left + top_right),
        ratio(height, top_right + bottom_right),
        ratio(width, bottom_left + bottom_right),
        ratio(height, top_left + bottom_left),
    ]
    .into_iter()
    .fold(1.0_f32, f32::min);
    radii.map(|radius| radius * scale)
}

fn ratio(available: f32, requested: f32) -> f32 {
    if requested <= f32::EPSILON {
        1.0
    } else {
        (available / requested).min(1.0)
    }
}

fn rounded_rect_contains(rect: [f32; 4], radii: [f32; 4], point: Point) -> bool {
    let [x, y, width, height] = rect.map(f64::from);
    if point.x < x || point.x >= x + width || point.y < y || point.y >= y + height {
        return false;
    }
    let radii = radii.map(f64::from);
    let corners = [
        (
            x + radii[0],
            y + radii[0],
            radii[0],
            point.x < x + radii[0],
            point.y < y + radii[0],
        ),
        (
            x + width - radii[1],
            y + radii[1],
            radii[1],
            point.x >= x + width - radii[1],
            point.y < y + radii[1],
        ),
        (
            x + width - radii[2],
            y + height - radii[2],
            radii[2],
            point.x >= x + width - radii[2],
            point.y >= y + height - radii[2],
        ),
        (
            x + radii[3],
            y + height - radii[3],
            radii[3],
            point.x < x + radii[3],
            point.y >= y + height - radii[3],
        ),
    ];
    for (center_x, center_y, radius, in_x, in_y) in corners {
        if radius > 0.0 && in_x && in_y {
            let dx = point.x - center_x;
            let dy = point.y - center_y;
            return dx * dx + dy * dy <= radius * radius;
        }
    }
    true
}

fn elliptical_rrect_contains(rect: [f32; 4], radii: [[f32; 2]; 4], point: Point) -> bool {
    let [x, y, width, height] = rect.map(f64::from);
    if point.x < x || point.x >= x + width || point.y < y || point.y >= y + height {
        return false;
    }
    let radii = radii.map(|radius| radius.map(f64::from));
    let corners = [
        (
            x + radii[0][0],
            y + radii[0][1],
            radii[0],
            point.x < x + radii[0][0],
            point.y < y + radii[0][1],
        ),
        (
            x + width - radii[1][0],
            y + radii[1][1],
            radii[1],
            point.x >= x + width - radii[1][0],
            point.y < y + radii[1][1],
        ),
        (
            x + width - radii[2][0],
            y + height - radii[2][1],
            radii[2],
            point.x >= x + width - radii[2][0],
            point.y >= y + height - radii[2][1],
        ),
        (
            x + radii[3][0],
            y + height - radii[3][1],
            radii[3],
            point.x < x + radii[3][0],
            point.y >= y + height - radii[3][1],
        ),
    ];
    for (center_x, center_y, [radius_x, radius_y], in_x, in_y) in corners {
        if radius_x > 0.0 && radius_y > 0.0 && in_x && in_y {
            let dx = (point.x - center_x) / radius_x;
            let dy = (point.y - center_y) / radius_y;
            return dx * dx + dy * dy <= 1.0;
        }
    }
    true
}

fn side_distance(distance: f64, width: f32) -> f64 {
    if width <= f32::EPSILON {
        f64::INFINITY
    } else {
        distance / f64::from(width)
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

const ORIGIN: Point = Point { x: 0.0, y: 0.0 };

/// Flattens every subpath into a closed polyline in path-local coordinates.
///
/// Curves are subdivided a fixed number of times rather than adaptively: the
/// oracle has to be deterministic across machines, and error-driven
/// subdivision turns on floating-point comparisons that need not agree.
fn flatten_path(path: &PathResource) -> Vec<Vec<Point>> {
    /// Fixed subdivision count. The table is built once so the cast from a
    /// loop counter never appears in the hot path.
    const SEGMENTS: usize = 24;
    let steps: [f64; SEGMENTS] =
        std::array::from_fn(|index| f64::from(u32::try_from(index + 1).unwrap_or(u32::MAX)) / 24.0);
    let mut contours: Vec<Vec<Point>> = Vec::new();
    let mut current: Vec<Point> = Vec::new();
    let mut cursor = 0_usize;
    let mut next = || {
        let point = Point {
            x: f64::from(path.points[cursor]),
            y: f64::from(path.points[cursor + 1]),
        };
        cursor += 2;
        point
    };
    for verb in &path.verbs {
        match verb {
            PathVerb::Move => {
                if current.len() > 1 {
                    contours.push(std::mem::take(&mut current));
                } else {
                    current.clear();
                }
                current.push(next());
            }
            PathVerb::Line => current.push(next()),
            PathVerb::Quad => {
                let start = *current.last().unwrap_or(&ORIGIN);
                let control = next();
                let end = next();
                for t in steps {
                    let inverse = 1.0 - t;
                    current.push(Point {
                        x: inverse * inverse * start.x
                            + 2.0 * inverse * t * control.x
                            + t * t * end.x,
                        y: inverse * inverse * start.y
                            + 2.0 * inverse * t * control.y
                            + t * t * end.y,
                    });
                }
            }
            PathVerb::Cubic => {
                let start = *current.last().unwrap_or(&ORIGIN);
                let first = next();
                let second = next();
                let end = next();
                for t in steps {
                    let inverse = 1.0 - t;
                    let start_weight = inverse * inverse * inverse;
                    let first_weight = 3.0 * inverse * inverse * t;
                    let second_weight = 3.0 * inverse * t * t;
                    let end_weight = t * t * t;
                    current.push(Point {
                        x: start_weight * start.x
                            + first_weight * first.x
                            + second_weight * second.x
                            + end_weight * end.x,
                        y: start_weight * start.y
                            + first_weight * first.y
                            + second_weight * second.y
                            + end_weight * end.y,
                    });
                }
            }
            PathVerb::Close => {
                if current.len() > 1 {
                    contours.push(std::mem::take(&mut current));
                } else {
                    current.clear();
                }
            }
        }
    }
    if current.len() > 1 {
        contours.push(current);
    }
    contours
}

/// Local bounding rectangle as `x, y, width, height`.
fn contour_bounds(contours: &[Vec<Point>]) -> Option<[f32; 4]> {
    let mut left = f64::INFINITY;
    let mut top = f64::INFINITY;
    let mut right = f64::NEG_INFINITY;
    let mut bottom = f64::NEG_INFINITY;
    for point in contours.iter().flatten() {
        left = left.min(point.x);
        top = top.min(point.y);
        right = right.max(point.x);
        bottom = bottom.max(point.y);
    }
    if !left.is_finite() || right <= left || bottom <= top {
        return None;
    }
    Some([
        clamp_f32(left),
        clamp_f32(top),
        clamp_f32(right - left),
        clamp_f32(bottom - top),
    ])
}

#[expect(
    clippy::cast_possible_truncation,
    reason = "path bounds only feed a device-space rectangle, which is f32"
)]
fn clamp_f32(value: f64) -> f32 {
    value as f32
}

/// Point-in-path under the resource's fill rule.
///
/// Every contour is treated as closed, which is what filling means: an open
/// subpath is filled as if a segment joined its ends.
fn contours_contain(contours: &[Vec<Point>], sample: Point, rule: FillRule) -> bool {
    let mut winding = 0_i32;
    let mut crossings = 0_u32;
    for contour in contours {
        for index in 0..contour.len() {
            let start = contour[index];
            let end = contour[(index + 1) % contour.len()];
            if (start.y <= sample.y) != (end.y <= sample.y) {
                let span = end.y - start.y;
                if span == 0.0 {
                    continue;
                }
                let t = (sample.y - start.y) / span;
                let x = start.x + t * (end.x - start.x);
                if x > sample.x {
                    crossings += 1;
                    winding += if end.y > start.y { 1 } else { -1 };
                }
            }
        }
    }
    match rule {
        FillRule::NonZero => winding != 0,
        FillRule::EvenOdd => crossings % 2 == 1,
    }
}

#[cfg(test)]
mod tests {
    use pingo_abi::{
        DisplayCommand, DisplayInstruction, DisplayList, Mutation, MutationBatch,
        MutationInstruction, NULL_NODE_ID, NodeKind, ResourceKind,
    };
    use pingo_paint::SolidPaint;
    use pingo_scene::{NodeId, Scene};
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
    fn inline_rounded_rect_excludes_corner_pixels() {
        let scene = scene_with_paint(SolidPaint {
            red: 0,
            green: 0,
            blue: 0,
            alpha: 255,
        });
        let bytes = display(vec![DisplayCommand::FillColorRRect {
            rect: [0.0, 0.0, 8.0, 8.0],
            radii: [4.0; 4],
            rgba: 0x1234_56ff,
        }]);
        let image = HeadlessRenderer::new()
            .render(&bytes, &scene, 8, 8)
            .expect("rounded render");

        assert_eq!(pixel(&image, 0, 0), [0, 0, 0, 0]);
        assert_eq!(pixel(&image, 3, 0), [0x12, 0x34, 0x56, 0xff]);
        assert_eq!(pixel(&image, 4, 4), [0x12, 0x34, 0x56, 0xff]);
        assert_eq!(pixel(&image, 7, 7), [0, 0, 0, 0]);
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
