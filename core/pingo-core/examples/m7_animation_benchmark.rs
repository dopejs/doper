use std::time::Instant;

use pingo_abi::{
    Mutation, MutationBatch, MutationInstruction, NULL_NODE_ID, NodeKind, Prop, ResourceKind,
};
use pingo_core::CoreEngine;
use pingo_scene::NodeId;

const ANIMATIONS: u32 = 500;
const SAMPLED_FRAMES: usize = 240;

fn main() {
    let mut core = CoreEngine::new(500.0, 1.0).expect("viewport");
    core.commit(&frame(1, initial())).expect("initial frame");
    core.commit(&frame(2, targets())).expect("target frame");

    let mut samples = Vec::with_capacity(SAMPLED_FRAMES);
    let mut checksum = 0_u64;
    let mut retained_bytes = 0_u64;
    for _ in 0..SAMPLED_FRAMES {
        let start = Instant::now();
        let output = core
            .advance(1.0 / 60.0)
            .expect("animation tick")
            .expect("active animation frame");
        samples.push(start.elapsed().as_secs_f64() * 1_000.0);
        checksum ^= output.diagnostics.picture_hash;
        retained_bytes = output.diagnostics.animation_retained_bytes;
        assert_eq!(output.diagnostics.layout_visited_nodes, 0);
        assert_eq!(output.diagnostics.animation_layout_nodes, 0);
        assert_eq!(output.diagnostics.animation_active, u64::from(ANIMATIONS));
    }
    samples.sort_by(f64::total_cmp);
    let p95 = percentile(&samples, 95);
    let p99 = percentile(&samples, 99);
    println!(
        "{{\"version\":1,\"animations\":{ANIMATIONS},\"frames\":{SAMPLED_FRAMES},\"p95Ms\":{p95:.6},\"p99Ms\":{p99:.6},\"retainedBytes\":{retained_bytes},\"checksum\":{checksum}}}"
    );
}

fn initial() -> Vec<Mutation> {
    let mut mutations = Vec::with_capacity(usize::try_from(ANIMATIONS).unwrap_or(0) * 6 + 2);
    mutations.push(Mutation::CreateNode {
        node_id: id(0),
        kind: NodeKind::Root,
        parent: NULL_NODE_ID,
        before_sibling: NULL_NODE_ID,
    });
    mutations.push(Mutation::DefineResource {
        resource_id: 1,
        kind: ResourceKind::Animation,
        bytes: transition_resource(),
    });
    for index in 1..=ANIMATIONS {
        mutations.extend([
            Mutation::CreateNode {
                node_id: id(index),
                kind: NodeKind::Container,
                parent: id(0),
                before_sibling: NULL_NODE_ID,
            },
            Mutation::SetF32 {
                node_id: id(index),
                prop: Prop::Width,
                value: 1.0,
            },
            Mutation::SetF32 {
                node_id: id(index),
                prop: Prop::Height,
                value: 1.0,
            },
            Mutation::SetF32 {
                node_id: id(index),
                prop: Prop::Opacity,
                value: 0.0,
            },
            Mutation::SetRef {
                node_id: id(index),
                prop: Prop::Animation,
                resource_id: 1,
            },
        ]);
    }
    mutations
}

fn targets() -> Vec<Mutation> {
    (1..=ANIMATIONS)
        .map(|index| Mutation::SetF32 {
            node_id: id(index),
            prop: Prop::Opacity,
            value: 1.0,
        })
        .collect()
}

fn transition_resource() -> Vec<u8> {
    let mut bytes = vec![0_u8; 36];
    bytes[0] = 1;
    bytes[1] = 1;
    bytes[4..8].copy_from_slice(&36_u32.to_le_bytes());
    bytes[8] = 1;
    bytes[9] = 4;
    bytes[12..16].copy_from_slice(&60_000_000_u32.to_le_bytes());
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

fn percentile(samples: &[f64], percentile: usize) -> f64 {
    let index = samples
        .len()
        .saturating_mul(percentile)
        .div_ceil(100)
        .saturating_sub(1)
        .min(samples.len().saturating_sub(1));
    samples[index]
}
