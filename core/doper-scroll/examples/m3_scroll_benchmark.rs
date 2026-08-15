use std::{hint::black_box, time::Instant};

use doper_scroll::{HeightIndex, ScrollPlatform, Virtualizer, VirtualizerConfig};

const ITEMS: usize = 1_000_000;
const FRAMES: usize = 20_000;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let initialization_started = Instant::now();
    let heights = HeightIndex::with_uniform(ITEMS, 20.0)?;
    let mut virtualizer = Virtualizer::new(
        heights,
        800.0,
        ScrollPlatform::Android,
        VirtualizerConfig::default(),
    )?;
    virtualizer.mark_available(0..ITEMS)?;
    let initialization_micros = initialization_started.elapsed().as_secs_f64() * 1_000_000.0;
    let heap_bytes = virtualizer.estimated_heap_bytes();

    let middle = virtualizer.heights().total_extent() / 2.0;
    virtualizer.physics_mut().jump_to(middle)?;
    virtualizer.physics_mut().end_drag(80_000.0)?;
    let mut samples = Vec::with_capacity(FRAMES);
    let mut checksum = 0_usize;
    for frame_index in 0..FRAMES {
        if frame_index != 0 && frame_index % 2_000 == 0 {
            let direction = if (frame_index / 2_000) % 2 == 0 {
                1.0
            } else {
                -1.0
            };
            virtualizer.physics_mut().begin_drag();
            virtualizer.physics_mut().drag_by(direction * 10.0)?;
            virtualizer.physics_mut().end_drag(direction * 80_000.0)?;
        }
        if frame_index % 257 == 0 {
            let item = (frame_index * 7_919) % ITEMS;
            let height = if frame_index % 514 == 0 { 24.0 } else { 20.0 };
            virtualizer.update_height(item, height)?;
        }
        let started = Instant::now();
        virtualizer.physics_mut().advance(1.0 / 120.0)?;
        let planned = virtualizer.plan_frame()?;
        checksum = checksum
            .wrapping_add(planned.visible.start)
            .wrapping_add(planned.visible.end)
            .wrapping_add(planned.preheat.start)
            .wrapping_add(planned.preheat.end);
        black_box(&planned);
        samples.push(started.elapsed().as_secs_f64() * 1_000_000.0);
    }
    samples.sort_by(f64::total_cmp);
    let p95_micros = percentile(&samples, 95);
    let p99_micros = percentile(&samples, 99);
    let maximum_micros = samples.last().copied().unwrap_or(0.0);
    println!(
        "{{\"version\":1,\"items\":{ITEMS},\"frames\":{FRAMES},\"initializationMicros\":{initialization_micros:.3},\"p95Micros\":{p95_micros:.3},\"p99Micros\":{p99_micros:.3},\"maximumMicros\":{maximum_micros:.3},\"heapBytes\":{heap_bytes},\"checksum\":{checksum}}}"
    );
    Ok(())
}

fn percentile(samples: &[f64], percentile: usize) -> f64 {
    let index = (samples.len() - 1).saturating_mul(percentile).div_ceil(100);
    samples[index]
}
