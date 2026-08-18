import { describe, expect, it, vi } from "vitest";

import { RasterTileCache, type RasterSurface } from "./raster-cache";
import type { Canvas2DContext } from "./replayer";

describe("RasterTileCache", () => {
  it("draws a new picture directly and only tiles one that repeats", () => {
    // A tile is keyed by the picture it came from, so nothing is reusable
    // across two different pictures: every tile would miss, and a miss replays
    // the whole list into that tile. Tiling a picture the first time it appears
    // therefore draws it once per tile instead of once, which is what made
    // scrolling -- where the picture changes every frame -- seven times slower.
    const surfaces: FakeContext[] = [];
    const target = new FakeContext("target");
    const cache = new RasterTileCache<number>({
      budgetBytes: 300 * 300 * 4 * 2,
      surfaceFactory: (width, height) => surface(width, height, surfaces),
      tileSize: 256,
    });
    let paints = 0;
    const request = { devicePixelRatio: 1, height: 300, pictureKey: "picture-a", width: 300 };
    // Seen once: drawn straight to the target, no surfaces allocated.
    const first = cache.render(target.context, request, () => ++paints);
    expect(first).toMatchObject({ bypassed: true, hits: 0, misses: 0, value: 1 });
    expect(surfaces).toHaveLength(0);
    // Seen again: worth rasterizing, so the tiles are populated.
    const second = cache.render(target.context, request, () => ++paints);
    expect(second).toMatchObject({ bypassed: false, hits: 0, misses: 4, value: 2 });
    // And served from then on.
    const third = cache.render(target.context, request, () => ++paints);
    expect(third).toMatchObject({ bypassed: false, hits: 4, misses: 0, value: 2 });
    expect(paints).toBe(5);
    expect(target.draws.filter(([operation]) => operation === "drawImage")).toHaveLength(8);
    expect(cache.metrics()).toMatchObject({ entries: 4, hits: 4, misses: 4 });
  });

  it("never tiles a picture that changes every frame", () => {
    const surfaces: FakeContext[] = [];
    const target = new FakeContext("target");
    const cache = new RasterTileCache<number>({
      budgetBytes: 1_000 * 1_000 * 4,
      surfaceFactory: (width, height) => surface(width, height, surfaces),
      tileSize: 256,
    });
    let paints = 0;
    for (let frame = 0; frame < 8; frame += 1) {
      const result = cache.render(
        target.context,
        { devicePixelRatio: 1, height: 300, pictureKey: `frame-${String(frame)}`, width: 300 },
        () => ++paints,
      );
      expect(result.bypassed).toBe(true);
    }
    // One paint per frame, not one per tile per frame.
    expect(paints).toBe(8);
    expect(surfaces).toHaveLength(0);
    expect(cache.metrics()).toMatchObject({ bypassedFrames: 8, entries: 0, hits: 0, misses: 0 });
  });

  it("bypasses without allocating when one frame exceeds the hard budget", () => {
    const target = new FakeContext("target");
    const factory = vi.fn();
    const cache = new RasterTileCache<string>({ budgetBytes: 1024, surfaceFactory: factory });
    const paint = vi.fn(() => "direct");
    expect(
      cache.render(
        target.context,
        { devicePixelRatio: 1, height: 100, pictureKey: "large", width: 100 },
        paint,
      ),
    ).toEqual({ bypassed: true, hits: 0, misses: 0, value: "direct" });
    expect(factory).not.toHaveBeenCalled();
    expect(paint).toHaveBeenCalledWith(target.context);
    expect(target.draws).toContainEqual(["clearRect", 0, 0, 100, 100]);
  });

  it("evicts least-recently-used pictures and remains within budget", () => {
    const target = new FakeContext("target");
    const cache = new RasterTileCache<string>({
      budgetBytes: 64 * 64 * 4 * 2,
      surfaceFactory: (width, height) => surface(width, height, []),
    });
    const render = (pictureKey: string) =>
      cache.render(
        target.context,
        { devicePixelRatio: 1, height: 64, pictureKey, width: 64 },
        () => pictureKey,
      );
    // Each picture is rendered twice: the first sight of a key is drawn
    // directly, and only a repeat is worth rasterizing into tiles.
    const tile = (key: string) => {
      render(key);
      return render(key);
    };
    tile("a");
    tile("b");
    expect(tile("a").hits).toBe(1);
    tile("c");
    expect(tile("b").misses).toBe(1);
    expect(cache.metrics()).toMatchObject({ entries: 2, evictions: 2 });
    expect(cache.metrics().bytes).toBeLessThanOrEqual(cache.metrics().budgetBytes);
  });

  it("falls back on cache allocation failure but never masks paint failures", () => {
    const target = new FakeContext("target");
    const onError = vi.fn();
    const allocationFailure = new RasterTileCache<number>({
      budgetBytes: 64 * 64 * 4,
      onError,
      surfaceFactory: () => {
        throw new Error("out of memory");
      },
    });
    const failing = { devicePixelRatio: 1, height: 64, pictureKey: "a", width: 64 };
    // The first sight of a picture never allocates, so the repeat is what
    // reaches the allocation path this test is about.
    allocationFailure.render(target.context, failing, () => 1);
    expect(allocationFailure.render(target.context, failing, () => 1).bypassed).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
    expect(target.draws).toContainEqual(["clearRect", 0, 0, 64, 64]);

    const paintFailure = new RasterTileCache<number>({
      budgetBytes: 64 * 64 * 4,
      surfaceFactory: (width, height) => surface(width, height, []),
    });
    let calls = 0;
    expect(() =>
      paintFailure.render(
        target.context,
        { devicePixelRatio: 1, height: 64, pictureKey: "b", width: 64 },
        () => {
          calls += 1;
          throw new Error("invalid display list");
        },
      ),
    ).toThrow(/invalid display list/u);
    expect(calls).toBe(1);
  });

  it("clears under memory pressure and validates configuration", () => {
    const target = new FakeContext("target");
    const cache = new RasterTileCache<number>({
      budgetBytes: 64 * 64 * 4,
      surfaceFactory: (width, height) => surface(width, height, []),
    });
    const request = { devicePixelRatio: 1, height: 64, pictureKey: "a", width: 64 };
    // Twice, so a tile actually exists for the budget change to evict.
    cache.render(target.context, request, () => 1);
    cache.render(target.context, request, () => 1);
    cache.setBudgetBytes(0);
    expect(cache.metrics()).toMatchObject({ budgetBytes: 0, bytes: 0, entries: 0, evictions: 1 });
    expect(() => new RasterTileCache({ budgetBytes: -1 })).toThrow(/budget/u);
  });

  it("stays within its hard budget during sustained picture churn", () => {
    const target = new FakeContext("target");
    let created = 0;
    let disposed = 0;
    const cache = new RasterTileCache<number>({
      budgetBytes: 64 * 64 * 4 * 4,
      surfaceFactory: (width, height) => {
        created += 1;
        const result = surface(width, height, []);
        return { ...result, dispose: () => (disposed += 1) };
      },
      tileSize: 64,
    });
    for (let frame = 0; frame < 5_000; frame += 1) {
      cache.render(
        target.context,
        { devicePixelRatio: 1, height: 64, pictureKey: `picture-${String(frame)}`, width: 64 },
        () => frame,
      );
      expect(cache.metrics().bytes).toBeLessThanOrEqual(cache.metrics().budgetBytes);
    }
    // Sustained churn no longer allocates at all: a picture that is never seen
    // twice can never be served from a tile, so rasterizing it only costs an
    // extra draw per tile. The budget is respected trivially because nothing is
    // retained, and the surface factory is never reached.
    expect(cache.metrics()).toMatchObject({
      bypassedFrames: 5_000,
      entries: 0,
      evictions: 0,
      hits: 0,
      misses: 0,
    });
    expect(created).toBe(0);
    expect(created - disposed).toBe(cache.metrics().entries);
    cache.clear();
    expect(disposed).toBe(created);
  });
});

class FakeContext {
  public readonly draws: unknown[][] = [];
  public readonly context: Canvas2DContext;

  public constructor(public readonly name: string) {
    this.context = {
      clearRect: (...values: number[]) => this.draws.push(["clearRect", ...values]),
      drawImage: (...values: unknown[]) => this.draws.push(["drawImage", ...values]),
      resetTransform: () => this.draws.push(["resetTransform"]),
      restore: () => this.draws.push(["restore"]),
      save: () => this.draws.push(["save"]),
      translate: (...values: number[]) => this.draws.push(["translate", ...values]),
    } as unknown as Canvas2DContext;
  }
}

function surface(width: number, height: number, contexts: FakeContext[]): RasterSurface {
  const context = new FakeContext(`surface-${String(contexts.length)}`);
  contexts.push(context);
  return {
    context: context.context,
    image: { height, width } as unknown as CanvasImageSource,
  };
}
