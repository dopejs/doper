use std::hint::black_box;
use std::time::Instant;

use pingo_abi::{
    Mutation, MutationBatch, MutationInstruction, NULL_NODE_ID, NodeKind, Prop, ResourceKind,
};
use pingo_core::CoreEngine;
use pingo_paint::SolidPaint;
use pingo_scene::NodeId;

const NODE_COUNT: u32 = 5_000;
const UPDATES_PER_FRAME: u32 = 20;
const WARMUP_FRAMES: u32 = 30;
const SAMPLE_FRAMES: u32 = 300;
const FRAME_BUDGET_MS: f64 = 16.7;

fn main() {
    let mut engine = CoreEngine::new(1280.0, 720.0).expect("benchmark viewport");
    let initial = initial_frame();
    let initial_start = Instant::now();
    let initial_output = engine.commit(&initial).expect("initial frame");
    let initial_ms = initial_start.elapsed().as_secs_f64() * 1_000.0;
    black_box(&initial_output);

    for frame in 0..WARMUP_FRAMES {
        let bytes = update_frame(frame + 2);
        black_box(engine.commit(&bytes).expect("warmup frame"));
    }

    let mut samples = Vec::with_capacity(SAMPLE_FRAMES as usize);
    for frame in 0..SAMPLE_FRAMES {
        let bytes = update_frame(frame + WARMUP_FRAMES + 2);
        let start = Instant::now();
        black_box(engine.commit(&bytes).expect("sample frame"));
        samples.push(start.elapsed().as_secs_f64() * 1_000.0);
    }
    samples.sort_by(f64::total_cmp);
    let p50 = percentile(&samples, 50, 100);
    let p95 = percentile(&samples, 95, 100);
    let p99 = percentile(&samples, 99, 100);
    let maximum = *samples.last().expect("samples");
    let dropped = samples
        .iter()
        .filter(|sample| **sample > FRAME_BUDGET_MS)
        .count();
    let dropped_rate = f64::from(u32::try_from(dropped).expect("bounded dropped count"))
        / f64::from(SAMPLE_FRAMES);
    let paint = engine.paint_metrics();
    println!(
        "{{\"version\":1,\"scenario\":\"m1-core-update-5000\",\"nodes\":{NODE_COUNT},\"updatesPerFrame\":{UPDATES_PER_FRAME},\"samples\":{SAMPLE_FRAMES},\"initialMs\":{initial_ms:.6},\"p50Ms\":{p50:.6},\"p95Ms\":{p95:.6},\"p99Ms\":{p99:.6},\"maxMs\":{maximum:.6},\"droppedFrameRate\":{dropped_rate:.8},\"pictureBuilds\":{},\"overInvalidatedFrames\":{}}}",
        paint.builds, paint.over_invalidated_frames,
    );
}

fn initial_frame() -> Vec<u8> {
    let root = node(0);
    let mut mutations = Vec::with_capacity((NODE_COUNT as usize) * 4 + 2);
    mutations.push(Mutation::CreateNode {
        node_id: root,
        kind: NodeKind::Root,
        parent: NULL_NODE_ID,
        before_sibling: NULL_NODE_ID,
    });
    mutations.push(Mutation::DefineResource {
        resource_id: 1,
        kind: ResourceKind::Paint,
        bytes: SolidPaint {
            red: 32,
            green: 96,
            blue: 192,
            alpha: 255,
        }
        .encode()
        .to_vec(),
    });
    for index in 1..=NODE_COUNT {
        let node_id = node(index);
        mutations.extend([
            Mutation::CreateNode {
                node_id,
                kind: NodeKind::Container,
                parent: root,
                before_sibling: NULL_NODE_ID,
            },
            Mutation::SetF32 {
                node_id,
                prop: Prop::Width,
                value: 1280.0,
            },
            Mutation::SetF32 {
                node_id,
                prop: Prop::Height,
                value: 1.0,
            },
            Mutation::SetRef {
                node_id,
                prop: Prop::BackgroundColor,
                resource_id: 1,
            },
        ]);
    }
    encode(1, mutations)
}

fn update_frame(frame_seq: u32) -> Vec<u8> {
    let mut mutations = Vec::with_capacity(UPDATES_PER_FRAME as usize);
    let start = frame_seq.wrapping_mul(UPDATES_PER_FRAME) % NODE_COUNT;
    for offset in 0..UPDATES_PER_FRAME {
        let index = (start + offset) % NODE_COUNT + 1;
        mutations.push(Mutation::SetF32 {
            node_id: node(index),
            prop: Prop::Opacity,
            value: if frame_seq.is_multiple_of(2) {
                0.99
            } else {
                1.0
            },
        });
    }
    encode(frame_seq, mutations)
}

fn encode(frame_seq: u32, mutations: Vec<Mutation>) -> Vec<u8> {
    MutationBatch {
        frame_seq,
        instructions: mutations
            .into_iter()
            .map(|mutation| MutationInstruction { flags: 0, mutation })
            .collect(),
    }
    .encode()
    .expect("benchmark Mutation Stream")
}

fn node(index: u32) -> u32 {
    NodeId::new(index, 1).expect("benchmark node id").raw()
}

fn percentile(samples: &[f64], numerator: usize, denominator: usize) -> f64 {
    let rank = samples
        .len()
        .checked_mul(numerator)
        .and_then(|value| value.checked_add(denominator - 1))
        .map(|value| value / denominator)
        .expect("bounded percentile rank");
    samples[rank.saturating_sub(1).min(samples.len() - 1)]
}
