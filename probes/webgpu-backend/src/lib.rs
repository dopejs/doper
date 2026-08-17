#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Isolated `wgpu` prototype consuming the exact `DisplayList` the `Canvas2D` and
//! headless backends replay. Scope: the M1 oracle subset (save/restore,
//! axis-aligned affine transforms, axis-aligned clips, alpha, solid fills).
//! Rotational transforms are out of scope for this probe and rejected.

use doper_abi::{DisplayCommand, DisplayList, ResourceKind};
use doper_paint::SolidPaint;
use doper_scene::Scene;
use wgpu::util::DeviceExt;

/// Probe failure; the caller reports and never falls back silently.
#[derive(Debug)]
pub enum ProbeError {
    /// No GPU adapter is available in this environment.
    NoAdapter,
    /// The `DisplayList` used a command outside the probe subset.
    Unsupported(&'static str),
    /// The `DisplayList` or its resources were malformed.
    InvalidInput(String),
    /// A GPU operation failed.
    Gpu(String),
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoAdapter => write!(formatter, "no GPU adapter available"),
            Self::Unsupported(detail) => write!(formatter, "unsupported for probe: {detail}"),
            Self::InvalidInput(detail) => write!(formatter, "invalid input: {detail}"),
            Self::Gpu(detail) => write!(formatter, "GPU failure: {detail}"),
        }
    }
}

impl std::error::Error for ProbeError {}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Vertex {
    position: [f32; 2],
    color: [f32; 4],
}

const SHADER: &str = r"
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(@location(0) position: vec2<f32>, @location(1) color: vec4<f32>) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4<f32>(position, 0.0, 1.0);
    output.color = color;
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    return input.color;
}
";

/// Offscreen `wgpu` renderer replaying the shared `DisplayList` rect subset.
pub struct GpuProbeRenderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
}

impl GpuProbeRenderer {
    /// Acquires a headless device; `Err(NoAdapter)` when the host has no GPU.
    ///
    /// # Errors
    ///
    /// Returns [`ProbeError::NoAdapter`] or a device-acquisition failure.
    ///
    /// # Panics
    ///
    /// Panics only if the vertex layout size stops fitting in `u64`.
    pub fn new() -> Result<Self, ProbeError> {
        let instance = wgpu::Instance::default();
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::LowPower,
            ..Default::default()
        }))
        .map_err(|_| ProbeError::NoAdapter)?;
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
                .map_err(|error| ProbeError::Gpu(error.to_string()))?;
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("doper-gpu-probe"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[],
            ..Default::default()
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("doper-gpu-probe"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: u64::try_from(std::mem::size_of::<Vertex>())
                        .expect("vertex stride"),
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4],
                })],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            cache: None,
            multiview_mask: None,
        });
        Ok(Self {
            device,
            queue,
            pipeline,
        })
    }

    /// Replays one `DisplayList` into RGBA8 pixels (straight alpha, row-major).
    ///
    /// # Errors
    ///
    /// Rejects malformed lists, commands outside the probe subset, and GPU
    /// readback failures.
    pub fn render(
        &self,
        bytes: &[u8],
        scene: &Scene,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, ProbeError> {
        let vertices = build_vertices(bytes, scene, width, height)?;
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("probe-target"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let vertex_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("probe-vertices"),
                contents: bytemuck::cast_slice(&vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });
        let bytes_per_row = (width * 4).next_multiple_of(256);
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("probe-readback"),
            size: u64::from(bytes_per_row) * u64::from(height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                ..Default::default()
            });
            if !vertices.is_empty() {
                pass.set_pipeline(&self.pipeline);
                pass.set_vertex_buffer(0, vertex_buffer.slice(..));
                let count = u32::try_from(vertices.len())
                    .map_err(|_| ProbeError::InvalidInput("vertex overflow".to_owned()))?;
                pass.draw(0..count, 0..1);
            }
        }
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: None,
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([encoder.finish()]);
        self.read_back(&readback, bytes_per_row, width, height)
    }

    fn read_back(
        &self,
        readback: &wgpu::Buffer,
        bytes_per_row: u32,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, ProbeError> {
        let slice = readback.slice(..);
        let (sender, receiver) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        let _ = self.device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: None,
        });
        receiver
            .recv()
            .map_err(|_| ProbeError::Gpu("readback channel closed".to_owned()))?
            .map_err(|error| ProbeError::Gpu(format!("{error:?}")))?;
        let mapped = slice
            .get_mapped_range()
            .map_err(|error| ProbeError::Gpu(format!("{error:?}")))?;
        let mut pixels = vec![0_u8; (width as usize) * (height as usize) * 4];
        for row in 0..height as usize {
            let source = row * bytes_per_row as usize;
            let target = row * width as usize * 4;
            pixels[target..target + width as usize * 4]
                .copy_from_slice(&mapped[source..source + width as usize * 4]);
        }
        drop(mapped);
        readback.unmap();
        Ok(pixels)
    }
}

#[derive(Clone)]
struct ProbeState {
    // Row-major affine [a, b, c, d, e, f]; b and c must stay zero.
    transform: [f32; 6],
    clip: Option<[f32; 4]>,
    alpha: f32,
}

impl Default for ProbeState {
    fn default() -> Self {
        Self {
            transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            clip: None,
            alpha: 1.0,
        }
    }
}

fn build_vertices(
    bytes: &[u8],
    scene: &Scene,
    width: u32,
    height: u32,
) -> Result<Vec<Vertex>, ProbeError> {
    let list =
        DisplayList::decode(bytes).map_err(|error| ProbeError::InvalidInput(error.to_string()))?;
    let mut states = vec![ProbeState::default()];
    let mut vertices = Vec::new();
    for instruction in list.instructions {
        let state = states.last().cloned().unwrap_or_default();
        match instruction.command {
            DisplayCommand::Save => states.push(state),
            DisplayCommand::Restore => {
                if states.len() > 1 {
                    states.pop();
                }
            }
            DisplayCommand::Transform(matrix) => {
                let top = states.last_mut().expect("state stack");
                top.transform = concat_affine(top.transform, matrix)?;
            }
            DisplayCommand::ClipRect(rect) => {
                let top = states.last_mut().expect("state stack");
                let world = transform_rect(top.transform, rect)?;
                top.clip = Some(match top.clip {
                    None => world,
                    Some(existing) => intersect(existing, world),
                });
            }
            DisplayCommand::Alpha(alpha) => {
                states.last_mut().expect("state stack").alpha *= alpha;
            }
            DisplayCommand::FillRect { rect, paint_id } => {
                let paint = resolve_paint(scene, paint_id)?;
                push_rect(&mut vertices, &state, rect, paint, width, height)?;
            }
            DisplayCommand::DrawEditorDecoration { rect, rgba, .. } => {
                let [red, green, blue, alpha] = rgba.to_be_bytes();
                push_rect(
                    &mut vertices,
                    &state,
                    rect,
                    SolidPaint {
                        red,
                        green,
                        blue,
                        alpha,
                    },
                    width,
                    height,
                )?;
            }
            _ => return Err(ProbeError::Unsupported("command outside the probe subset")),
        }
    }
    Ok(vertices)
}

fn resolve_paint(scene: &Scene, paint_id: u32) -> Result<SolidPaint, ProbeError> {
    let resource = scene
        .resource(paint_id)
        .ok_or_else(|| ProbeError::InvalidInput(format!("missing paint {paint_id}")))?;
    if resource.kind != ResourceKind::Paint {
        return Err(ProbeError::InvalidInput(format!(
            "resource {paint_id} is not a paint"
        )));
    }
    SolidPaint::decode(paint_id, resource)
        .map_err(|error| ProbeError::InvalidInput(error.to_string()))
}

fn push_rect(
    vertices: &mut Vec<Vertex>,
    state: &ProbeState,
    rect: [f32; 4],
    paint: SolidPaint,
    width: u32,
    height: u32,
) -> Result<(), ProbeError> {
    let mut world = transform_rect(state.transform, rect)?;
    if let Some(clip) = state.clip {
        world = intersect(world, clip);
    }
    let [left, top, right, bottom] = world;
    if right <= left || bottom <= top {
        return Ok(());
    }
    let alpha = f32::from(paint.alpha) / 255.0 * state.alpha;
    if alpha <= 0.0 {
        return Ok(());
    }
    let color = [
        f32::from(paint.red) / 255.0,
        f32::from(paint.green) / 255.0,
        f32::from(paint.blue) / 255.0,
        alpha,
    ];
    #[allow(clippy::cast_precision_loss)]
    let to_ndc = |x: f32, y: f32| -> [f32; 2] {
        [x / width as f32 * 2.0 - 1.0, 1.0 - y / height as f32 * 2.0]
    };
    let corners = [
        to_ndc(left, top),
        to_ndc(right, top),
        to_ndc(right, bottom),
        to_ndc(left, bottom),
    ];
    for index in [0_usize, 1, 2, 0, 2, 3] {
        vertices.push(Vertex {
            position: corners[index],
            color,
        });
    }
    Ok(())
}

fn concat_affine(base: [f32; 6], next: [f32; 6]) -> Result<[f32; 6], ProbeError> {
    let combined = [
        base[0] * next[0] + base[2] * next[1],
        base[1] * next[0] + base[3] * next[1],
        base[0] * next[2] + base[2] * next[3],
        base[1] * next[2] + base[3] * next[3],
        base[0] * next[4] + base[2] * next[5] + base[4],
        base[1] * next[4] + base[3] * next[5] + base[5],
    ];
    if combined[1] != 0.0 || combined[2] != 0.0 {
        return Err(ProbeError::Unsupported(
            "rotational transforms are outside the probe subset",
        ));
    }
    Ok(combined)
}

fn transform_rect(transform: [f32; 6], rect: [f32; 4]) -> Result<[f32; 4], ProbeError> {
    if transform[1] != 0.0 || transform[2] != 0.0 {
        return Err(ProbeError::Unsupported(
            "rotational transforms are outside the probe subset",
        ));
    }
    let [x, y, w, h] = rect;
    let x0 = transform[0] * x + transform[4];
    let y0 = transform[3] * y + transform[5];
    let x1 = transform[0] * (x + w) + transform[4];
    let y1 = transform[3] * (y + h) + transform[5];
    Ok([x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)])
}

fn intersect(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [
        a[0].max(b[0]),
        a[1].max(b[1]),
        a[2].min(b[2]),
        a[3].min(b[3]),
    ]
}

/// Backend differential summary with the documented tolerance decision.
#[derive(Debug, PartialEq, Eq)]
pub struct DiffReport {
    /// Largest per-channel absolute delta.
    pub max_channel_delta: u8,
    /// Pixels whose delta exceeded the per-channel tolerance of 2.
    pub mismatched_pixels: usize,
    /// Total compared pixels.
    pub total_pixels: usize,
}

/// Compares GPU output against the headless oracle, straight-alpha RGBA8.
#[must_use]
pub fn compare_pixels(gpu: &[u8], oracle: &[u8]) -> DiffReport {
    let total_pixels = gpu.len().min(oracle.len()) / 4;
    let mut max_channel_delta = 0_u8;
    let mut mismatched_pixels = 0_usize;
    for pixel in 0..total_pixels {
        let mut pixel_delta = 0_u8;
        for channel in 0..4 {
            let index = pixel * 4 + channel;
            let delta = gpu[index].abs_diff(oracle[index]);
            pixel_delta = pixel_delta.max(delta);
        }
        max_channel_delta = max_channel_delta.max(pixel_delta);
        if pixel_delta > 2 {
            mismatched_pixels += 1;
        }
    }
    DiffReport {
        max_channel_delta,
        mismatched_pixels,
        total_pixels,
    }
}

#[cfg(test)]
mod tests {
    use doper_abi::{
        DisplayInstruction, EditorDecorationKind, Mutation, MutationBatch, MutationInstruction,
        NULL_NODE_ID, NodeKind, ResourceKind,
    };
    use doper_headless::HeadlessRenderer;

    use super::*;

    fn fixture() -> (Scene, Vec<u8>) {
        let mut scene = Scene::new();
        scene
            .commit(MutationBatch {
                frame_seq: 1,
                instructions: vec![
                    MutationInstruction {
                        flags: 0,
                        mutation: Mutation::CreateNode {
                            node_id: doper_scene::NodeId::new(0, 1).expect("root id").raw(),
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
                            bytes: SolidPaint {
                                red: 30,
                                green: 60,
                                blue: 120,
                                alpha: 255,
                            }
                            .encode()
                            .to_vec(),
                        },
                    },
                    MutationInstruction {
                        flags: 0,
                        mutation: Mutation::DefineResource {
                            resource_id: 2,
                            kind: ResourceKind::Paint,
                            bytes: SolidPaint {
                                red: 220,
                                green: 40,
                                blue: 40,
                                alpha: 128,
                            }
                            .encode()
                            .to_vec(),
                        },
                    },
                ],
            })
            .expect("fixture scene");
        let commands = vec![
            DisplayCommand::FillRect {
                rect: [0.0, 0.0, 128.0, 96.0],
                paint_id: 1,
            },
            DisplayCommand::Save,
            DisplayCommand::Transform([2.0, 0.0, 0.0, 2.0, 8.0, 4.0]),
            DisplayCommand::ClipRect([0.0, 0.0, 40.0, 30.0]),
            DisplayCommand::FillRect {
                rect: [4.0, 2.0, 48.0, 40.0],
                paint_id: 2,
            },
            DisplayCommand::Restore,
            DisplayCommand::DrawEditorDecoration {
                rect: [10.0, 70.0, 3.0, 16.0],
                rgba: 0x2050_a0ff,
                kind: EditorDecorationKind::Caret,
            },
        ];
        let bytes = DisplayList {
            instructions: commands
                .into_iter()
                .map(|command| DisplayInstruction { flags: 0, command })
                .collect(),
        }
        .encode()
        .expect("fixture display list");
        (scene, bytes)
    }

    #[test]
    fn matches_the_headless_oracle_on_the_shared_display_list() {
        let renderer = match GpuProbeRenderer::new() {
            Ok(renderer) => renderer,
            Err(ProbeError::NoAdapter) => {
                eprintln!("skipped: no GPU adapter available");
                return;
            }
            Err(error) => panic!("device acquisition failed: {error}"),
        };
        let (scene, bytes) = fixture();
        let gpu = renderer
            .render(&bytes, &scene, 128, 96)
            .expect("gpu render");
        let mut oracle = HeadlessRenderer::new();
        let image = oracle
            .render(&bytes, &scene, 128, 96)
            .expect("oracle render");
        let report = compare_pixels(&gpu, image.pixels());
        assert_eq!(report.total_pixels, 128 * 96);
        assert_eq!(
            report.mismatched_pixels, 0,
            "backend differential exceeded the documented tolerance: {report:?}"
        );
    }

    #[test]
    fn rejects_rotational_transforms_and_unknown_commands() {
        let (scene, _) = fixture();
        let rotated = DisplayList {
            instructions: vec![DisplayInstruction {
                flags: 0,
                command: DisplayCommand::Transform([0.0, 1.0, -1.0, 0.0, 0.0, 0.0]),
            }],
        }
        .encode()
        .expect("encode");
        assert!(matches!(
            build_vertices(&rotated, &scene, 8, 8),
            Err(ProbeError::Unsupported(_))
        ));
    }
}
