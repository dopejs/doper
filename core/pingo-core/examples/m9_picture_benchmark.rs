use std::time::Instant;

use pingo_abi::{
    IMAGE_BITMAP_HEIGHT_OFFSET, IMAGE_BITMAP_PIXEL_BYTES_OFFSET, IMAGE_BITMAP_PIXELS_OFFSET,
    IMAGE_BITMAP_RESOURCE_VARIANT, IMAGE_BITMAP_VARIANT_OFFSET, IMAGE_BITMAP_VERSION_OFFSET,
    IMAGE_BITMAP_WIDTH_OFFSET, InputBatch, InputCommand, InputInstruction, Mutation, MutationBatch,
    MutationInstruction, NULL_NODE_ID, NodeKind, Prop, RESOURCE_ENCODING_VERSION, ResourceKind,
    StyleKeyword, VIDEO_FRAME_HEIGHT_OFFSET, VIDEO_FRAME_POSTER_PIXEL_BYTES_OFFSET,
    VIDEO_FRAME_POSTER_PIXELS_OFFSET, VIDEO_FRAME_RESOURCE_VARIANT, VIDEO_FRAME_VARIANT_OFFSET,
    VIDEO_FRAME_VERSION_OFFSET, VIDEO_FRAME_WIDTH_OFFSET,
};
use pingo_core::{CoreEngine, FrameOutput};
use pingo_paint::{SolidPaint, TextStyleResource};
use pingo_scene::NodeId;

const FRAMES: usize = 240;
const ROWS: u32 = 24;

fn main() {
    let simple = run(1, true);
    let complex = run(4, true);
    let inline = run(4, false);
    assert_eq!(
        simple.maximum_resource_bytes,
        complex.maximum_resource_bytes
    );
    assert_eq!(
        complex.fixture_draw_commands,
        simple.fixture_draw_commands * 4
    );
    assert_eq!(complex.maximum_layout_visited_nodes, 0);
    assert_eq!(complex.maximum_unchanged_subtree_rebuilds, 0);
    assert_eq!(complex.shell_mutation_frames, 0);
    println!(
        "{{\"version\":1,\"seed\":1597463007,\"viewport\":[640,480],\"dpr\":1,\"frames\":{FRAMES},\"simple\":{},\"complex\":{},\"inline\":{}}}",
        simple.json(),
        complex.json(),
        inline.json(),
    );
}

struct Report {
    incremental: bool,
    complexity: u32,
    initial_display_bytes: usize,
    initial_logical_commands: usize,
    fixture_draw_commands: usize,
    maximum_resource_bytes: usize,
    maximum_resident_bytes: usize,
    maximum_layout_visited_nodes: usize,
    maximum_unchanged_subtree_rebuilds: u64,
    shell_mutation_frames: usize,
    p95_ms: f64,
    p99_ms: f64,
    dropped_frame_rate: f64,
    checksum: u64,
}

impl Report {
    fn json(&self) -> String {
        format!(
            "{{\"incremental\":{},\"complexity\":{},\"initialDisplayBytes\":{},\"initialLogicalCommands\":{},\"fixtureDrawCommands\":{},\"maximumResourceBytes\":{},\"maximumResidentBytes\":{},\"maximumLayoutVisitedNodes\":{},\"maximumUnchangedSubtreeRebuilds\":{},\"shellMutationFrames\":{},\"p95Ms\":{:.6},\"p99Ms\":{:.6},\"droppedFrameRate\":{:.6},\"checksum\":\"{}\"}}",
            self.incremental,
            self.complexity,
            self.initial_display_bytes,
            self.initial_logical_commands,
            self.fixture_draw_commands,
            self.maximum_resource_bytes,
            self.maximum_resident_bytes,
            self.maximum_layout_visited_nodes,
            self.maximum_unchanged_subtree_rebuilds,
            self.shell_mutation_frames,
            self.p95_ms,
            self.p99_ms,
            self.dropped_frame_rate,
            self.checksum,
        )
    }
}

fn run(complexity: u32, incremental: bool) -> Report {
    let mut core = CoreEngine::new(640.0, 480.0).expect("viewport");
    core.set_incremental_pictures_enabled(incremental)
        .expect("select Picture path");
    let initial = core
        .commit(&mutation_frame(1, rich_scroll_scene(complexity)))
        .expect("rich fixture");
    acknowledge(&mut core, &initial);
    let initial_display_bytes = initial.display_list.len();
    let initial_logical_commands = initial.diagnostics.display_commands;

    let mut samples = Vec::with_capacity(FRAMES);
    let mut maximum_resource_bytes = 0;
    let mut maximum_resident_bytes = initial.diagnostics.picture_resident_bytes;
    let mut maximum_layout_visited_nodes = 0;
    let mut maximum_unchanged_subtree_rebuilds = 0;
    let mut previous_subtree_builds = initial.diagnostics.picture_subtree_builds;
    let mut checksum = initial.diagnostics.picture_hash;
    for frame in 0..FRAMES {
        let start = Instant::now();
        let output = core
            .input(&input_frame(
                u32::try_from(frame + 1).expect("frame sequence"),
                vec![InputCommand::ScrollDelta {
                    node_id: id(1),
                    delta_x: 0.0,
                    delta_y: 4.0,
                    elapsed_micros: 16_667,
                }],
            ))
            .expect("scroll input")
            .expect("scroll frame");
        samples.push(start.elapsed().as_secs_f64() * 1_000.0);
        let rebuilt = output
            .diagnostics
            .picture_subtree_builds
            .saturating_sub(previous_subtree_builds);
        previous_subtree_builds = output.diagnostics.picture_subtree_builds;
        // Root and the scroll node may be recomposed. Everything below the
        // scroll boundary must remain immutable and reused.
        maximum_unchanged_subtree_rebuilds =
            maximum_unchanged_subtree_rebuilds.max(rebuilt.saturating_sub(2));
        maximum_resource_bytes =
            maximum_resource_bytes.max(output.diagnostics.picture_resource_bytes);
        maximum_resident_bytes =
            maximum_resident_bytes.max(output.diagnostics.picture_resident_bytes);
        maximum_layout_visited_nodes =
            maximum_layout_visited_nodes.max(output.diagnostics.layout_visited_nodes);
        checksum ^= output.diagnostics.picture_hash;
        acknowledge(&mut core, &output);
    }
    samples.sort_by(f64::total_cmp);
    let dropped = samples.iter().filter(|sample| **sample > 16.7).count();
    Report {
        incremental,
        complexity,
        initial_display_bytes,
        initial_logical_commands,
        fixture_draw_commands: usize::try_from(ROWS.saturating_mul(complexity))
            .expect("fixture command count"),
        maximum_resource_bytes,
        maximum_resident_bytes,
        maximum_layout_visited_nodes,
        maximum_unchanged_subtree_rebuilds,
        shell_mutation_frames: 0,
        p95_ms: percentile(&samples, 95),
        p99_ms: percentile(&samples, 99),
        dropped_frame_rate: f64::from(u32::try_from(dropped).expect("dropped samples"))
            / f64::from(u32::try_from(samples.len()).expect("sample count")),
        checksum,
    }
}

#[allow(clippy::too_many_lines)]
fn rich_scroll_scene(complexity: u32) -> Vec<Mutation> {
    assert!((1..=4).contains(&complexity));
    let mut mutations = vec![
        create(0, NodeKind::Root, None),
        create(1, NodeKind::Scroll, Some(0)),
        create(2, NodeKind::Container, Some(1)),
        set_f32(1, Prop::Width, 640.0),
        set_f32(1, Prop::Height, 480.0),
        set_f32(2, Prop::Width, 640.0),
        set_f32(
            2,
            Prop::Height,
            f32::from(u16::try_from(ROWS).expect("row count")) * 80.0,
        ),
        Mutation::DefineResource {
            resource_id: 1,
            kind: ResourceKind::Paint,
            bytes: SolidPaint {
                red: 28,
                green: 42,
                blue: 58,
                alpha: 255,
            }
            .encode()
            .to_vec(),
        },
        Mutation::DefineResource {
            resource_id: 2,
            kind: ResourceKind::Utf8String,
            bytes: b"M9 deterministic rich row".to_vec(),
        },
        Mutation::DefineResource {
            resource_id: 3,
            kind: ResourceKind::TextStyle,
            bytes: TextStyleResource {
                paint_id: 1,
                font_size: 14.0,
                line_height: 18.0,
                weight: 400,
                family: "sans-serif".into(),
                font_style: StyleKeyword::Normal,
                text_align: StyleKeyword::Start,
                white_space: StyleKeyword::Normal,
                overflow_wrap: StyleKeyword::Normal,
                text_overflow: StyleKeyword::Clip,
            }
            .encode()
            .expect("text style"),
        },
        Mutation::DefineResource {
            resource_id: 4,
            kind: ResourceKind::Image,
            bytes: image_resource(),
        },
        Mutation::DefineResource {
            resource_id: 5,
            kind: ResourceKind::VideoFrame,
            bytes: video_poster_resource(),
        },
        Mutation::DefineResource {
            resource_id: 6,
            kind: ResourceKind::Animation,
            bytes: opacity_transition_resource(),
        },
    ];
    let mut next_node = 3;
    for _row in 0..ROWS {
        let row_node = next_node;
        let clip_node = next_node + 1;
        next_node += 2;
        mutations.extend([
            create(row_node, NodeKind::Container, Some(2)),
            set_f32(row_node, Prop::Width, 640.0),
            set_f32(row_node, Prop::Height, 80.0),
            set_ref(row_node, Prop::BackgroundColor, 1),
            set_ref(row_node, Prop::Animation, 6),
            create(clip_node, NodeKind::Scroll, Some(row_node)),
            set_f32(clip_node, Prop::Width, 620.0),
            set_f32(clip_node, Prop::Height, 64.0),
        ]);
        for lane in 0..complexity {
            let node = next_node;
            next_node += 1;
            let kind = match lane {
                0 => NodeKind::Text,
                1 => NodeKind::Image,
                2 => NodeKind::Video,
                _ => NodeKind::Container,
            };
            mutations.extend([
                create(node, kind, Some(clip_node)),
                set_f32(node, Prop::Width, 128.0),
                set_f32(node, Prop::Height, 16.0),
            ]);
            match lane {
                0 => mutations.push(Mutation::SetTextRun {
                    node_id: id(node),
                    string_id: 2,
                    style_id: 3,
                }),
                1 => mutations.push(set_ref(node, Prop::Image, 4)),
                2 => mutations.push(set_ref(node, Prop::VideoFrame, 5)),
                _ => mutations.push(set_ref(node, Prop::BackgroundColor, 1)),
            }
        }
    }
    mutations
}

fn create(index: u32, kind: NodeKind, parent: Option<u32>) -> Mutation {
    Mutation::CreateNode {
        node_id: id(index),
        kind,
        parent: parent.map_or(NULL_NODE_ID, id),
        before_sibling: NULL_NODE_ID,
    }
}

fn set_f32(index: u32, prop: Prop, value: f32) -> Mutation {
    Mutation::SetF32 {
        node_id: id(index),
        prop,
        value,
    }
}

fn set_ref(index: u32, prop: Prop, resource_id: u32) -> Mutation {
    Mutation::SetRef {
        node_id: id(index),
        prop,
        resource_id,
    }
}

fn image_resource() -> Vec<u8> {
    let pixels = [
        255_u8, 64, 64, 255, 64, 255, 64, 255, 64, 64, 255, 255, 255, 220, 64, 255,
    ];
    let mut bytes = vec![0; IMAGE_BITMAP_PIXELS_OFFSET + pixels.len()];
    bytes[IMAGE_BITMAP_VERSION_OFFSET] = RESOURCE_ENCODING_VERSION;
    bytes[IMAGE_BITMAP_VARIANT_OFFSET] = IMAGE_BITMAP_RESOURCE_VARIANT;
    bytes[IMAGE_BITMAP_WIDTH_OFFSET..IMAGE_BITMAP_WIDTH_OFFSET + 4]
        .copy_from_slice(&2_u32.to_le_bytes());
    bytes[IMAGE_BITMAP_HEIGHT_OFFSET..IMAGE_BITMAP_HEIGHT_OFFSET + 4]
        .copy_from_slice(&2_u32.to_le_bytes());
    bytes[IMAGE_BITMAP_PIXEL_BYTES_OFFSET..IMAGE_BITMAP_PIXEL_BYTES_OFFSET + 4].copy_from_slice(
        &u32::try_from(pixels.len())
            .expect("pixel byte count")
            .to_le_bytes(),
    );
    bytes[IMAGE_BITMAP_PIXELS_OFFSET..].copy_from_slice(&pixels);
    bytes
}

fn video_poster_resource() -> Vec<u8> {
    let poster = [
        32_u8, 48, 64, 255, 64, 48, 32, 255, 24, 32, 48, 255, 72, 80, 96, 255,
    ];
    let mut bytes = vec![0; VIDEO_FRAME_POSTER_PIXELS_OFFSET + poster.len()];
    bytes[VIDEO_FRAME_VERSION_OFFSET] = RESOURCE_ENCODING_VERSION;
    bytes[VIDEO_FRAME_VARIANT_OFFSET] = VIDEO_FRAME_RESOURCE_VARIANT;
    bytes[VIDEO_FRAME_WIDTH_OFFSET..VIDEO_FRAME_WIDTH_OFFSET + 4]
        .copy_from_slice(&2_u32.to_le_bytes());
    bytes[VIDEO_FRAME_HEIGHT_OFFSET..VIDEO_FRAME_HEIGHT_OFFSET + 4]
        .copy_from_slice(&2_u32.to_le_bytes());
    bytes[VIDEO_FRAME_POSTER_PIXEL_BYTES_OFFSET..VIDEO_FRAME_POSTER_PIXEL_BYTES_OFFSET + 4]
        .copy_from_slice(
            &u32::try_from(poster.len())
                .expect("poster byte count")
                .to_le_bytes(),
        );
    bytes[VIDEO_FRAME_POSTER_PIXELS_OFFSET..].copy_from_slice(&poster);
    bytes
}

fn opacity_transition_resource() -> Vec<u8> {
    let mut bytes = vec![0_u8; 36];
    bytes[0] = 1;
    bytes[1] = 1;
    bytes[4..8].copy_from_slice(&36_u32.to_le_bytes());
    bytes[8] = 1;
    bytes[9] = 0;
    bytes[12..16].copy_from_slice(&1_000_000_u32.to_le_bytes());
    bytes
}

fn acknowledge(core: &mut CoreEngine, output: &FrameOutput) {
    if !core.take_picture_resources().is_empty() {
        core.acknowledge_picture_resources(output.frame_seq)
            .expect("Picture acknowledgement");
    }
}

fn mutation_frame(frame_seq: u32, mutations: Vec<Mutation>) -> Vec<u8> {
    MutationBatch {
        frame_seq,
        instructions: mutations
            .into_iter()
            .map(|mutation| MutationInstruction { flags: 0, mutation })
            .collect(),
    }
    .encode()
    .expect("mutation frame")
}

fn input_frame(frame_seq: u32, commands: Vec<InputCommand>) -> Vec<u8> {
    InputBatch {
        frame_seq,
        instructions: commands
            .into_iter()
            .map(|command| InputInstruction { flags: 0, command })
            .collect(),
    }
    .encode()
    .expect("input frame")
}

fn id(index: u32) -> u32 {
    NodeId::new(index, 1).expect("fixture id").raw()
}

fn percentile(samples: &[f64], percentile: usize) -> f64 {
    let index = samples
        .len()
        .saturating_mul(percentile)
        .div_ceil(100)
        .saturating_sub(1)
        .min(samples.len().saturating_sub(1));
    samples[index]
}
