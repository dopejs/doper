//! Cost of exporting observed geometry, as a function of what is observed.
//!
//! The design claim is that observation costs `O(observed x depth)` and is
//! independent of scene size (docs/e8-layout-readback-design.md D4). m1 and m3
//! never observe anything, so they can only show the idle path; this measures
//! the one they cannot see.
//!
//! Two scene widths with identical depth isolate the variable: if the exported
//! cost tracked scene size instead of the observed set, the wide scene would be
//! proportionally slower at the same observation count.

use std::hint::black_box;
use std::time::Instant;

use pingo_abi::{
    Mutation, MutationBatch, MutationInstruction, NULL_NODE_ID, NodeKind,
    OBSERVE_GEOMETRY_FLAG_ACTIVE, Prop,
};
use pingo_core::CoreEngine;
use pingo_scene::NodeId;

const SMALL_NODES: u32 = 1_000;
const LARGE_NODES: u32 = 8_000;
const OBSERVED_COUNTS: [u32; 3] = [0, 16, 64];
const WARMUP_FRAMES: u32 = 20;
const SAMPLE_FRAMES: u32 = 200;

fn main() {
    let mut cases = Vec::new();
    for nodes in [SMALL_NODES, LARGE_NODES] {
        for observed in OBSERVED_COUNTS {
            cases.push(measure(nodes, observed));
        }
    }
    let report = cases
        .iter()
        .map(|case| {
            format!(
                "{{\"nodes\":{},\"observed\":{},\"records\":{},\"exportP50Micros\":{:.4},\"exportP95Micros\":{:.4},\"framePlusExportP95Micros\":{:.4}}}",
                case.nodes,
                case.observed,
                case.records,
                case.export_p50,
                case.export_p95,
                case.frame_p95
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    println!(
        "{{\"version\":1,\"scenario\":\"e8-observed-geometry\",\"samples\":{SAMPLE_FRAMES},\"cases\":[{report}]}}"
    );
}

struct Case {
    nodes: u32,
    observed: u32,
    records: u32,
    export_p50: f64,
    export_p95: f64,
    frame_p95: f64,
}

fn measure(nodes: u32, observed: u32) -> Case {
    let mut engine = CoreEngine::new(1280.0, 720.0).expect("benchmark viewport");
    engine.commit(&initial_frame(nodes)).expect("initial frame");
    if observed > 0 {
        engine
            .commit(&observe_frame(2, observed))
            .expect("observe frame");
    }
    // The record count is asserted rather than assumed: a benchmark that
    // silently measured zero records would look like excellent scaling.
    let records = engine.layout_geometry()[2];

    for frame in 0..WARMUP_FRAMES {
        black_box(
            engine
                .commit(&update_frame(frame + 3, nodes))
                .expect("warmup"),
        );
        black_box(engine.layout_geometry());
    }

    let mut exports = Vec::with_capacity(SAMPLE_FRAMES as usize);
    let mut frames = Vec::with_capacity(SAMPLE_FRAMES as usize);
    for frame in 0..SAMPLE_FRAMES {
        let bytes = update_frame(frame + WARMUP_FRAMES + 3, nodes);
        let frame_start = Instant::now();
        black_box(engine.commit(&bytes).expect("sample frame"));
        let export_start = Instant::now();
        black_box(engine.layout_geometry());
        let export = export_start.elapsed().as_secs_f64() * 1_000_000.0;
        frames.push(frame_start.elapsed().as_secs_f64() * 1_000_000.0);
        exports.push(export);
    }
    exports.sort_by(f64::total_cmp);
    frames.sort_by(f64::total_cmp);
    Case {
        nodes,
        observed,
        records,
        export_p50: percentile(&exports, 50),
        export_p95: percentile(&exports, 95),
        frame_p95: percentile(&frames, 95),
    }
}

fn initial_frame(nodes: u32) -> Vec<u8> {
    let root = node(0);
    let mut mutations = vec![Mutation::CreateNode {
        node_id: root,
        kind: NodeKind::Root,
        parent: NULL_NODE_ID,
        before_sibling: NULL_NODE_ID,
    }];
    for index in 1..=nodes {
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
        ]);
    }
    encode(1, mutations)
}

fn observe_frame(frame_seq: u32, observed: u32) -> Vec<u8> {
    encode(
        frame_seq,
        (1..=observed)
            .map(|index| Mutation::ObserveGeometry {
                node_id: node(index),
                flags: OBSERVE_GEOMETRY_FLAG_ACTIVE,
            })
            .collect(),
    )
}

fn update_frame(frame_seq: u32, nodes: u32) -> Vec<u8> {
    let start = frame_seq.wrapping_mul(20) % nodes;
    encode(
        frame_seq,
        (0..20)
            .map(|offset| Mutation::SetF32 {
                node_id: node((start + offset) % nodes + 1),
                prop: Prop::Opacity,
                value: if frame_seq.is_multiple_of(2) {
                    0.99
                } else {
                    1.0
                },
            })
            .collect(),
    )
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

fn percentile(samples: &[f64], numerator: usize) -> f64 {
    let rank = (samples.len() * numerator).div_ceil(100);
    samples[rank.saturating_sub(1).min(samples.len() - 1)]
}
