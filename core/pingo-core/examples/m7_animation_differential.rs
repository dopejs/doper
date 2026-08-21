use std::fmt::Write;

use pingo_abi::{
    Mutation, MutationBatch, MutationInstruction, NULL_NODE_ID, NodeKind, Prop, ResourceKind,
};
use pingo_core::CoreEngine;
use pingo_scene::NodeId;

fn main() {
    let initial_mutation = frame(1, initial_mutations());
    let target_mutation = frame(
        2,
        vec![Mutation::SetF32 {
            node_id: id(1),
            prop: Prop::Opacity,
            value: 1.0,
        }],
    );
    let retarget_mutation = frame(
        3,
        vec![Mutation::SetF32 {
            node_id: id(1),
            prop: Prop::Opacity,
            value: 0.25,
        }],
    );
    let mut core = CoreEngine::new(160.0, 80.0).expect("viewport");
    let initial = core.commit(&initial_mutation).expect("initial");
    let target = core.commit(&target_mutation).expect("target");
    let first = core.advance(0.25).expect("tick").expect("first frame");
    let middle = core.advance(0.25).expect("tick").expect("middle frame");
    let retarget = core.commit(&retarget_mutation).expect("retarget");
    let retargeted = core.advance(0.25).expect("tick").expect("retargeted frame");
    let reduced = core
        .set_reduced_motion(true)
        .expect("reduced motion")
        .expect("reduced frame");

    println!(
        "{{\"version\":1,\"initialMutation\":\"{}\",\"targetMutation\":\"{}\",\"retargetMutation\":\"{}\",\"displays\":[\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\"],\"diagnostics\":[{},{},{},{},{},{},{}]}}",
        hex(&initial_mutation),
        hex(&target_mutation),
        hex(&retarget_mutation),
        hex(&initial.display_list),
        hex(&target.display_list),
        hex(&first.display_list),
        hex(&middle.display_list),
        hex(&retarget.display_list),
        hex(&retargeted.display_list),
        hex(&reduced.display_list),
        words_json(&initial.diagnostics.to_words()),
        words_json(&target.diagnostics.to_words()),
        words_json(&first.diagnostics.to_words()),
        words_json(&middle.diagnostics.to_words()),
        words_json(&retarget.diagnostics.to_words()),
        words_json(&retargeted.diagnostics.to_words()),
        words_json(&reduced.diagnostics.to_words()),
    );
}

fn initial_mutations() -> Vec<Mutation> {
    vec![
        Mutation::CreateNode {
            node_id: id(0),
            kind: NodeKind::Root,
            parent: NULL_NODE_ID,
            before_sibling: NULL_NODE_ID,
        },
        Mutation::CreateNode {
            node_id: id(1),
            kind: NodeKind::Container,
            parent: id(0),
            before_sibling: NULL_NODE_ID,
        },
        Mutation::SetF32 {
            node_id: id(1),
            prop: Prop::Width,
            value: 40.0,
        },
        Mutation::SetF32 {
            node_id: id(1),
            prop: Prop::Height,
            value: 40.0,
        },
        Mutation::SetF32 {
            node_id: id(1),
            prop: Prop::Opacity,
            value: 0.0,
        },
        Mutation::DefineResource {
            resource_id: 20,
            kind: ResourceKind::Animation,
            bytes: opacity_transition(),
        },
        Mutation::SetRef {
            node_id: id(1),
            prop: Prop::Animation,
            resource_id: 20,
        },
        Mutation::CreateNode {
            node_id: id(2),
            kind: NodeKind::Container,
            parent: id(0),
            before_sibling: NULL_NODE_ID,
        },
        Mutation::SetF32 {
            node_id: id(2),
            prop: Prop::Width,
            value: 40.0,
        },
        Mutation::SetF32 {
            node_id: id(2),
            prop: Prop::Height,
            value: 40.0,
        },
        Mutation::DefineResource {
            resource_id: 21,
            kind: ResourceKind::Animation,
            bytes: transform_keyframes(),
        },
        Mutation::SetRef {
            node_id: id(2),
            prop: Prop::Animation,
            resource_id: 21,
        },
    ]
}

fn opacity_transition() -> Vec<u8> {
    let mut bytes = vec![0_u8; 36];
    bytes[0] = 1;
    bytes[1] = 1;
    bytes[4..8].copy_from_slice(&36_u32.to_le_bytes());
    bytes[8] = 1;
    bytes[9] = 0;
    bytes[12..16].copy_from_slice(&1_000_000_u32.to_le_bytes());
    bytes
}

fn transform_keyframes() -> Vec<u8> {
    let mut bytes = vec![0_u8; 104];
    bytes[0] = 1;
    bytes[2] = 1;
    bytes[4..8].copy_from_slice(&104_u32.to_le_bytes());
    bytes[8] = 2;
    bytes[9] = 0;
    bytes[11] = 1;
    bytes[16..20].copy_from_slice(&1_000_000_u32.to_le_bytes());
    bytes[24..28].copy_from_slice(&1.0_f32.to_le_bytes());
    bytes[28..30].copy_from_slice(&2_u16.to_le_bytes());
    let identity = [1.0_f32, 0.0, 0.0, 1.0, 0.0, 0.0];
    let translated = [1.0_f32, 0.0, 0.0, 1.0, 20.0, 0.0];
    bytes[48..52].copy_from_slice(&0.0_f32.to_le_bytes());
    for (index, value) in identity.into_iter().enumerate() {
        let offset = 52 + index * 4;
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    bytes[76..80].copy_from_slice(&1.0_f32.to_le_bytes());
    for (index, value) in translated.into_iter().enumerate() {
        let offset = 80 + index * 4;
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn frame(frame_seq: u32, mutations: Vec<Mutation>) -> Vec<u8> {
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
