use std::time::Instant;

use pingo_abi::{
    InputBatch, InputCommand, InputInstruction, Mutation, MutationBatch, MutationInstruction,
    NULL_NODE_ID, NodeKind, Prop, RESOURCE_ENCODING_VERSION, ResourceKind, StyleKeyword,
    VIDEO_FRAME_HEIGHT_OFFSET, VIDEO_FRAME_POSTER_PIXEL_BYTES_OFFSET,
    VIDEO_FRAME_POSTER_PIXELS_OFFSET, VIDEO_FRAME_RESOURCE_VARIANT, VIDEO_FRAME_VARIANT_OFFSET,
    VIDEO_FRAME_VERSION_OFFSET, VIDEO_FRAME_WIDTH_OFFSET,
};
use pingo_core::{CoreEngine, FrameOutput};
use pingo_paint::{SolidPaint, TextStyleResource};
use pingo_scene::NodeId;

const FRAMES: usize = 30 * 60 * 60;

#[allow(clippy::too_many_lines)]
fn main() {
    let mut core = CoreEngine::new(160.0, 80.0).expect("viewport");
    core.set_incremental_pictures_enabled(true)
        .expect("enable Pictures");
    let initial = core.commit(&mutation_frame()).expect("initial frame");
    let expected_count = initial.diagnostics.picture_resident_count;
    let expected_bytes = initial.diagnostics.picture_resident_bytes;
    acknowledge(&mut core, &initial);
    let start = Instant::now();
    let mut checksum = initial.diagnostics.picture_hash;
    let mut maximum_resource_bytes = 0;
    let mut maximum_resident_bytes = expected_bytes;
    let mut animation_frames = 0_usize;
    let mut input_output_frames = 0_usize;
    let mut editing_operations = 0_usize;
    let mut editing_layout_frames = 0_usize;
    let mut edit_revision = 0_u64;
    for frame in 0..FRAMES {
        let phase = u16::try_from(frame % 360).expect("scroll phase");
        let scroll_y = f32::from(if phase < 180 { phase } else { 360 - phase }) * 4.0;
        let mut commands = vec![InputCommand::ScrollTo {
            node_id: id(1),
            x: 0.0,
            y: scroll_y,
        }];
        if frame == 0 {
            commands.push(InputCommand::FocusEditable { node_id: id(5) });
        } else if frame % 600 == 1 {
            commands.push(if editing_operations.is_multiple_of(2) {
                InputCommand::Insert {
                    node_id: id(5),
                    base_revision: edit_revision,
                    text: "文".to_owned(),
                }
            } else {
                InputCommand::DeleteBackward {
                    node_id: id(5),
                    base_revision: edit_revision,
                }
            });
            edit_revision = edit_revision.saturating_add(1);
            editing_operations = editing_operations.saturating_add(1);
        }
        let editing_frame = frame == 0 || frame % 600 == 1;
        let output = core
            .input(&input_frame(
                u32::try_from(frame + 1).expect("input sequence"),
                commands,
            ))
            .expect("scroll input");
        if let Some(output) = output {
            assert!(output.diagnostics.layout_visited_nodes <= usize::from(editing_frame));
            editing_layout_frames = editing_layout_frames
                .saturating_add(usize::from(output.diagnostics.layout_visited_nodes > 0));
            assert_eq!(output.diagnostics.picture_resident_count, expected_count);
            assert_eq!(output.diagnostics.picture_budget_fallbacks, 0);
            maximum_resident_bytes =
                maximum_resident_bytes.max(output.diagnostics.picture_resident_bytes);
            maximum_resource_bytes =
                maximum_resource_bytes.max(output.diagnostics.picture_resource_bytes);
            checksum ^= output.diagnostics.picture_hash;
            acknowledge(&mut core, &output);
            input_output_frames = input_output_frames.saturating_add(1);
        }
        core.take_edit_transactions()
            .expect("drain edit transactions");
        if let Some(animation) = core.advance(1.0 / 60.0).expect("advance animation") {
            assert_eq!(animation.diagnostics.layout_visited_nodes, 0);
            assert_eq!(animation.diagnostics.picture_budget_fallbacks, 0);
            maximum_resident_bytes =
                maximum_resident_bytes.max(animation.diagnostics.picture_resident_bytes);
            maximum_resource_bytes =
                maximum_resource_bytes.max(animation.diagnostics.picture_resource_bytes);
            checksum ^= animation.diagnostics.picture_hash;
            acknowledge(&mut core, &animation);
            animation_frames = animation_frames.saturating_add(1);
        }
    }
    let blurred = core
        .input(&input_frame(
            u32::try_from(FRAMES + 1).expect("blur sequence"),
            vec![InputCommand::BlurEditable { node_id: id(5) }],
        ))
        .expect("blur input")
        .expect("blur frame");
    acknowledge(&mut core, &blurred);
    core.take_edit_transactions()
        .expect("drain blur transaction");
    let final_resident_bytes = blurred.diagnostics.picture_resident_bytes;
    let final_resident_count = blurred.diagnostics.picture_resident_count;
    assert!(maximum_resident_bytes <= expected_bytes + 256);
    assert!(final_resident_bytes <= maximum_resident_bytes);
    assert_eq!(final_resident_count, expected_count);
    assert_eq!(editing_operations, 180);
    assert_eq!(edit_revision, 180);
    assert!(editing_layout_frames <= editing_operations + 1);
    assert!(animation_frames >= FRAMES);
    let scroll_input_commands = core.scroll_metrics().input_commands;
    assert_eq!(
        scroll_input_commands,
        u64::try_from(FRAMES).expect("frame count")
    );
    assert!(input_output_frames >= FRAMES - 1);
    println!(
        "{{\"version\":1,\"logicalMinutes\":30,\"frames\":{FRAMES},\"scrollInputCommands\":{scroll_input_commands},\"inputOutputFrames\":{input_output_frames},\"animationFrames\":{animation_frames},\"editingOperations\":{editing_operations},\"editingLayoutFrames\":{editing_layout_frames},\"videoNodes\":1,\"residentCount\":{expected_count},\"residentBytes\":{expected_bytes},\"finalResidentCount\":{final_resident_count},\"finalResidentBytes\":{final_resident_bytes},\"maximumResidentBytes\":{maximum_resident_bytes},\"maximumResourceBytes\":{maximum_resource_bytes},\"wallMs\":{:.3},\"checksum\":\"{checksum}\"}}",
        start.elapsed().as_secs_f64() * 1_000.0,
    );
}

fn mutation_frame() -> Vec<u8> {
    let mutations = vec![
        create(0, NodeKind::Root, None),
        create(1, NodeKind::Scroll, Some(0)),
        create(2, NodeKind::Container, Some(1)),
        create(3, NodeKind::Container, Some(2)),
        create(4, NodeKind::Video, Some(2)),
        create(5, NodeKind::EditableText, Some(2)),
        set_f32(1, Prop::Width, 160.0),
        set_f32(1, Prop::Height, 80.0),
        set_f32(2, Prop::Width, 160.0),
        set_f32(2, Prop::Height, 2_000.0),
        set_f32(3, Prop::Width, 40.0),
        set_f32(3, Prop::Height, 40.0),
        set_f32(4, Prop::Width, 40.0),
        set_f32(4, Prop::Height, 40.0),
        set_f32(5, Prop::Width, 120.0),
        set_f32(5, Prop::Height, 24.0),
        Mutation::DefineResource {
            resource_id: 1,
            kind: ResourceKind::Paint,
            bytes: SolidPaint {
                red: 255,
                green: 255,
                blue: 255,
                alpha: 255,
            }
            .encode()
            .to_vec(),
        },
        Mutation::DefineResource {
            resource_id: 2,
            kind: ResourceKind::TextStyle,
            bytes: TextStyleResource {
                paint_id: 1,
                font_size: 14.0,
                line_height: 18.0,
                weight: 400,
                family: "sans-serif".into(),
                font_style: StyleKeyword::Normal,
                text_align: StyleKeyword::Start,
                white_space: StyleKeyword::PreWrap,
                overflow_wrap: StyleKeyword::Anywhere,
                text_overflow: StyleKeyword::Clip,
            }
            .encode()
            .expect("text style"),
        },
        Mutation::DefineResource {
            resource_id: 3,
            kind: ResourceKind::Utf8String,
            bytes: Vec::new(),
        },
        Mutation::DefineResource {
            resource_id: 4,
            kind: ResourceKind::VideoFrame,
            bytes: video_poster_resource(),
        },
        Mutation::DefineResource {
            resource_id: 5,
            kind: ResourceKind::Animation,
            bytes: opacity_keyframes_resource(),
        },
        Mutation::SetTextRun {
            node_id: id(5),
            string_id: 3,
            style_id: 2,
        },
        Mutation::ConfigureEditable {
            node_id: id(5),
            revision: 0,
            flags: 0,
            max_graphemes: 4,
        },
        set_ref(3, Prop::Animation, 5),
        set_ref(4, Prop::VideoFrame, 4),
    ];
    MutationBatch {
        frame_seq: 1,
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

fn set_ref(index: u32, prop: Prop, resource_id: u32) -> Mutation {
    Mutation::SetRef {
        node_id: id(index),
        prop,
        resource_id,
    }
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

fn opacity_keyframes_resource() -> Vec<u8> {
    let mut bytes = vec![0_u8; 64];
    bytes[0] = 1;
    bytes[2] = 1;
    bytes[4..8].copy_from_slice(&64_u32.to_le_bytes());
    bytes[8] = 1;
    bytes[11] = 1;
    bytes[16..20].copy_from_slice(&1_000_000_u32.to_le_bytes());
    bytes[24..28].copy_from_slice(&1_801.0_f32.to_le_bytes());
    bytes[28..30].copy_from_slice(&2_u16.to_le_bytes());
    bytes[48..52].copy_from_slice(&0.0_f32.to_le_bytes());
    bytes[52..56].copy_from_slice(&0.25_f32.to_le_bytes());
    bytes[56..60].copy_from_slice(&1.0_f32.to_le_bytes());
    bytes[60..64].copy_from_slice(&0.75_f32.to_le_bytes());
    bytes
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

fn acknowledge(core: &mut CoreEngine, output: &FrameOutput) {
    if !core.take_picture_resources().is_empty() {
        core.acknowledge_picture_resources(output.frame_seq)
            .expect("Picture acknowledgement");
    }
}

fn id(index: u32) -> u32 {
    NodeId::new(index, 1).expect("fixture id").raw()
}
