use std::hint::black_box;
use std::time::Instant;

use pingo_abi::{
    CaretDirection, CaretGranularity, EditTransactionBatch, InputBatch, InputCommand,
    InputInstruction, Mutation, MutationBatch, MutationInstruction, NULL_NODE_ID, NodeKind, Prop,
    ResourceKind,
};
use pingo_core::CoreEngine;
use pingo_paint::{SolidPaint, TextStyleResource};
use pingo_scene::NodeId;

const WARMUP_KEYSTROKES: u32 = 50;
const SAMPLE_KEYSTROKES: u32 = 1_000;
const FRAME_BUDGET_MS: f64 = 16.7;

fn main() {
    let mut engine = CoreEngine::new(1280.0, 720.0).expect("benchmark viewport");
    black_box(engine.commit(&initial_frame()).expect("initial frame"));

    let mut sequence = 1_u32;
    let mut revision = 0_u64;

    submit(
        &mut engine,
        &mut sequence,
        &mut revision,
        InputCommand::FocusEditable {
            node_id: editable(),
        },
    );

    for step in 0..WARMUP_KEYSTROKES {
        let command = keystroke(step, revision);
        submit(&mut engine, &mut sequence, &mut revision, command);
    }

    let mut samples = Vec::with_capacity(SAMPLE_KEYSTROKES as usize);
    for step in 0..SAMPLE_KEYSTROKES {
        let command = keystroke(step + WARMUP_KEYSTROKES, revision);
        let bytes = input(sequence, command);
        sequence += 1;
        let start = Instant::now();
        black_box(engine.input(&bytes).expect("sample input"));
        samples.push(start.elapsed().as_secs_f64() * 1_000.0);
        drain_revision(&mut engine, &mut revision);
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
        / f64::from(SAMPLE_KEYSTROKES);
    println!(
        "{{\"version\":1,\"scenario\":\"m4-editing-keystroke\",\"samples\":{SAMPLE_KEYSTROKES},\"p50Ms\":{p50:.6},\"p95Ms\":{p95:.6},\"p99Ms\":{p99:.6},\"maxMs\":{maximum:.6},\"droppedFrameRate\":{dropped_rate:.8}}}",
    );
}

fn submit(engine: &mut CoreEngine, sequence: &mut u32, revision: &mut u64, command: InputCommand) {
    let bytes = input(*sequence, command);
    *sequence += 1;
    black_box(engine.input(&bytes).expect("editing input"));
    drain_revision(engine, revision);
}

fn drain_revision(engine: &mut CoreEngine, revision: &mut u64) {
    let drained = engine.take_edit_transactions().expect("drain edits");
    if !drained.is_empty() {
        let batch = EditTransactionBatch::decode(&drained).expect("edit batch");
        if let Some(record) = batch.records.last() {
            *revision = record.revision;
        }
    }
}

/// Rotates through insert, caret navigation, and delete like real typing.
fn keystroke(step: u32, revision: u64) -> InputCommand {
    match step % 8 {
        7 => InputCommand::DeleteBackward {
            node_id: editable(),
            base_revision: revision,
        },
        5 => InputCommand::MoveCaret {
            node_id: editable(),
            direction: CaretDirection::Backward,
            granularity: CaretGranularity::Grapheme,
            extend: false,
        },
        6 => InputCommand::MoveCaret {
            node_id: editable(),
            direction: CaretDirection::LineEnd,
            granularity: CaretGranularity::Grapheme,
            extend: false,
        },
        index => InputCommand::Insert {
            node_id: editable(),
            base_revision: revision,
            text: ["a", "b", "文", "字", "e"][index as usize % 5].to_owned(),
        },
    }
}

fn editable() -> u32 {
    NodeId::new(1, 1).expect("editable id").raw()
}

fn input(sequence: u32, command: InputCommand) -> Vec<u8> {
    InputBatch {
        frame_seq: sequence,
        instructions: vec![InputInstruction { flags: 0, command }],
    }
    .encode()
    .expect("input batch")
}

fn initial_frame() -> Vec<u8> {
    let root = NodeId::new(0, 1).expect("root id").raw();
    let mutations = vec![
        Mutation::CreateNode {
            node_id: root,
            kind: NodeKind::Root,
            parent: NULL_NODE_ID,
            before_sibling: NULL_NODE_ID,
        },
        Mutation::CreateNode {
            node_id: editable(),
            kind: NodeKind::EditableText,
            parent: root,
            before_sibling: NULL_NODE_ID,
        },
        Mutation::SetF32 {
            node_id: editable(),
            prop: Prop::Width,
            value: 600.0,
        },
        Mutation::SetF32 {
            node_id: editable(),
            prop: Prop::Height,
            value: 400.0,
        },
        Mutation::DefineResource {
            resource_id: 1,
            kind: ResourceKind::Paint,
            bytes: SolidPaint {
                red: 20,
                green: 20,
                blue: 20,
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
                font_size: 16.0,
                line_height: 22.0,
                weight: 400,
                family: "sans-serif".to_owned(),
            }
            .encode()
            .expect("text style"),
        },
        Mutation::DefineResource {
            resource_id: 3,
            kind: ResourceKind::Utf8String,
            bytes: Vec::new(),
        },
        Mutation::SetTextRun {
            node_id: editable(),
            string_id: 3,
            style_id: 2,
        },
        Mutation::ConfigureEditable {
            node_id: editable(),
            revision: 0,
            flags: 1,
            max_graphemes: 1_000_000,
        },
    ];
    MutationBatch {
        frame_seq: 1,
        instructions: mutations
            .into_iter()
            .map(|mutation| MutationInstruction { flags: 0, mutation })
            .collect(),
    }
    .encode()
    .expect("initial mutation batch")
}

fn percentile(samples: &[f64], numerator: usize, denominator: usize) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let rank = (samples.len() * numerator).div_ceil(denominator);
    samples[rank.saturating_sub(1).min(samples.len() - 1)]
}
