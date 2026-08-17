//! Same-workload replay comparison: wgpu probe vs the headless CPU oracle.

use std::time::Instant;

use doper_abi::{
    DisplayCommand, DisplayInstruction, DisplayList, Mutation, MutationBatch, MutationInstruction,
    NULL_NODE_ID, NodeKind, ResourceKind,
};
use doper_gpu_probe::GpuProbeRenderer;
use doper_headless::HeadlessRenderer;
use doper_paint::SolidPaint;
use doper_scene::Scene;

const WIDTH: u32 = 512;
const HEIGHT: u32 = 512;
const RECTS: u32 = 400;
const SAMPLES: usize = 100;

fn main() {
    let (scene, bytes) = workload();
    let mut oracle = HeadlessRenderer::new();
    let oracle_samples = measure(SAMPLES, || {
        let _ = oracle
            .render(&bytes, &scene, WIDTH, HEIGHT)
            .expect("oracle render");
    });
    let gpu = match GpuProbeRenderer::new() {
        Ok(renderer) => renderer,
        Err(error) => {
            println!(
                "{{\"version\":1,\"scenario\":\"m5-backend-replay\",\"gpu\":\"unavailable: {error}\"}}"
            );
            return;
        }
    };
    let gpu_samples = measure(SAMPLES, || {
        let _ = gpu
            .render(&bytes, &scene, WIDTH, HEIGHT)
            .expect("gpu render");
    });
    println!(
        "{{\"version\":1,\"scenario\":\"m5-backend-replay\",\"rects\":{RECTS},\"samples\":{SAMPLES},\"oracleP50Ms\":{:.6},\"oracleP95Ms\":{:.6},\"gpuP50Ms\":{:.6},\"gpuP95Ms\":{:.6}}}",
        percentile(&oracle_samples, 50),
        percentile(&oracle_samples, 95),
        percentile(&gpu_samples, 50),
        percentile(&gpu_samples, 95),
    );
}

fn measure(samples: usize, mut work: impl FnMut()) -> Vec<f64> {
    // Warm caches and pipeline state before sampling.
    for _ in 0..10 {
        work();
    }
    let mut timings = Vec::with_capacity(samples);
    for _ in 0..samples {
        let start = Instant::now();
        work();
        timings.push(start.elapsed().as_secs_f64() * 1_000.0);
    }
    timings.sort_by(f64::total_cmp);
    timings
}

fn percentile(samples: &[f64], numerator: usize) -> f64 {
    let rank = (samples.len() * numerator).div_ceil(100);
    samples[rank.saturating_sub(1).min(samples.len() - 1)]
}

fn workload() -> (Scene, Vec<u8>) {
    let mut scene = Scene::new();
    let mut mutations = vec![MutationInstruction {
        flags: 0,
        mutation: Mutation::CreateNode {
            node_id: doper_scene::NodeId::new(0, 1).expect("root id").raw(),
            kind: NodeKind::Root,
            parent: NULL_NODE_ID,
            before_sibling: NULL_NODE_ID,
        },
    }];
    for paint in 0..8_u32 {
        mutations.push(MutationInstruction {
            flags: 0,
            mutation: Mutation::DefineResource {
                resource_id: paint + 1,
                kind: ResourceKind::Paint,
                bytes: SolidPaint {
                    red: u8::try_from(paint * 30 % 255).expect("byte"),
                    green: 90,
                    blue: 160,
                    alpha: 200,
                }
                .encode()
                .to_vec(),
            },
        });
    }
    scene
        .commit(MutationBatch {
            frame_seq: 1,
            instructions: mutations,
        })
        .expect("workload scene");
    let mut commands = Vec::new();
    for index in 0..RECTS {
        let column = index % 20;
        let row = index / 20;
        commands.push(DisplayCommand::FillRect {
            #[allow(clippy::cast_precision_loss)]
            rect: [(column * 25) as f32, (row * 25) as f32, 24.0, 24.0],
            paint_id: index % 8 + 1,
        });
    }
    let bytes = DisplayList {
        instructions: commands
            .into_iter()
            .map(|command| DisplayInstruction { flags: 0, command })
            .collect(),
    }
    .encode()
    .expect("workload display list");
    (scene, bytes)
}
