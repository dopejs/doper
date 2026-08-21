use std::fmt::Write;

use pingo_abi::{
    InputBatch, InputCommand, InputInstruction, Mutation, MutationBatch, MutationInstruction,
    NULL_NODE_ID, NodeKind, Prop,
};
use pingo_core::CoreEngine;
use pingo_scene::NodeId;

fn main() {
    let mutation = mutation_frame(1, scene());
    let input = input_frame(
        1,
        vec![InputCommand::ScrollDelta {
            node_id: id(1),
            delta_x: 0.0,
            delta_y: 80.0,
            elapsed_micros: 16_667,
        }],
    );
    let rollback_mutation = mutation_frame(2, Vec::new());
    let mut core = CoreEngine::new(160.0, 80.0).expect("viewport");
    core.set_incremental_pictures_enabled(true)
        .expect("enable Pictures");
    let initial = core.commit(&mutation).expect("initial Picture frame");
    let initial_resources = core.take_picture_resources();
    core.acknowledge_picture_resources(initial.frame_seq)
        .expect("initial ack");
    let scrolled = core
        .input(&input)
        .expect("scroll input")
        .expect("scroll frame");
    let scroll_resources = core.take_picture_resources();
    core.acknowledge_picture_resources(scrolled.frame_seq)
        .expect("scroll ack");
    core.set_incremental_pictures_enabled(false)
        .expect("rollback Pictures");
    let rollback = core.commit(&rollback_mutation).expect("inline rollback");
    let rollback_resources = core.take_picture_resources();
    core.acknowledge_picture_resources(rollback.frame_seq)
        .expect("rollback ack");
    println!(
        "{{\"version\":1,\"mutation\":\"{}\",\"input\":\"{}\",\"rollbackMutation\":\"{}\",\"displays\":[\"{}\",\"{}\",\"{}\"],\"resources\":[\"{}\",\"{}\",\"{}\"],\"diagnostics\":[{},{},{}]}}",
        hex(&mutation),
        hex(&input),
        hex(&rollback_mutation),
        hex(&initial.display_list),
        hex(&scrolled.display_list),
        hex(&rollback.display_list),
        hex(&initial_resources),
        hex(&scroll_resources),
        hex(&rollback_resources),
        words_json(&initial.diagnostics.to_words()),
        words_json(&scrolled.diagnostics.to_words()),
        words_json(&rollback.diagnostics.to_words()),
    );
}

fn scene() -> Vec<Mutation> {
    vec![
        create(0, NodeKind::Root, None),
        create(1, NodeKind::Scroll, Some(0)),
        create(2, NodeKind::Container, Some(1)),
        create(3, NodeKind::Container, Some(2)),
        set_f32(1, Prop::Width, 160.0),
        set_f32(1, Prop::Height, 80.0),
        set_f32(2, Prop::Width, 160.0),
        set_f32(2, Prop::Height, 1_000.0),
        set_f32(3, Prop::Width, 40.0),
        set_f32(3, Prop::Height, 40.0),
    ]
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

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("String writes do not fail");
    }
    output
}

fn words_json(words: &[u32]) -> String {
    let mut output = String::from("[");
    for (index, word) in words.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        write!(&mut output, "{word}").expect("String writes do not fail");
    }
    output.push(']');
    output
}
