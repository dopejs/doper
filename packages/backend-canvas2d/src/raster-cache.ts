import type { Canvas2DContext } from "./replayer";

const BYTES_PER_PIXEL = 4;
const MAX_BUDGET_BYTES = 1024 * 1024 * 1024;

export interface RasterSurface {
  readonly context: Canvas2DContext;
  readonly image: CanvasImageSource;
  dispose?(): void;
}

export type RasterSurfaceFactory = (width: number, height: number) => RasterSurface;

export interface RasterTileCacheOptions {
  readonly budgetBytes: number;
  readonly onError?: (error: Error) => void;
  readonly surfaceFactory?: RasterSurfaceFactory;
  readonly tileSize?: number;
}

export interface RasterTileCacheMetrics {
  readonly budgetBytes: number;
  readonly bypassedFrames: number;
  readonly bytes: number;
  readonly compositedTiles: number;
  readonly entries: number;
  readonly evictions: number;
  readonly hits: number;
  readonly misses: number;
}

export interface RasterFrameRequest {
  readonly devicePixelRatio: number;
  readonly height: number;
  readonly pictureKey: string;
  readonly width: number;
}

export interface RasterFrameResult<T> {
  readonly bypassed: boolean;
  readonly hits: number;
  readonly misses: number;
  readonly value: T;
}

interface CacheEntry<T> {
  readonly bytes: number;
  lastUsed: number;
  readonly surface: RasterSurface;
  readonly value: T;
}

/** Bounded LRU tile cache; a frame is prepared fully before the target canvas is touched. */
export class RasterTileCache<T> {
  readonly #entries = new Map<string, CacheEntry<T>>();
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #surfaceFactory: RasterSurfaceFactory;
  readonly #tileSize: number;
  #budgetBytes: number;
  #bypassedFrames = 0;
  #bytes = 0;
  #compositedTiles = 0;
  #evictions = 0;
  #hits = 0;
  #misses = 0;
  #useSequence = 0;
  #lastPictureKey: string | undefined;

  public constructor(options: RasterTileCacheOptions) {
    this.#budgetBytes = budget(options.budgetBytes);
    this.#tileSize = integer(options.tileSize ?? 256, 32, 2048, "tileSize");
    this.#surfaceFactory = options.surfaceFactory ?? createBrowserRasterSurface;
    this.#onError = options.onError;
  }

  public render(
    target: Canvas2DContext,
    request: RasterFrameRequest,
    paint: (context: Canvas2DContext) => T,
  ): RasterFrameResult<T> {
    const width = integer(request.width, 1, 1_048_576, "raster width");
    const height = integer(request.height, 1, 1_048_576, "raster height");
    if (!Number.isFinite(request.devicePixelRatio) || request.devicePixelRatio <= 0) {
      throw new RangeError("devicePixelRatio must be positive");
    }
    if (request.pictureKey.length === 0) throw new RangeError("pictureKey must not be empty");
    const frameBytes = checkedPixelBytes(width, height);
    if (frameBytes > this.#budgetBytes) return this.bypass(target, width, height, paint);
    // A tile is keyed by the picture it was rasterized from, so nothing can be
    // reused across two different pictures: every tile misses, and a miss
    // replays the whole DisplayList into that tile. Tiling a picture that
    // changed therefore draws it once per tile instead of once. During a scroll
    // the picture changes every frame, which measured as a sevenfold replay
    // cost and was the whole of the observed jank. Only spend tiles on a
    // picture that has repeated at least once.
    const repeated = this.#lastPictureKey === request.pictureKey;
    this.#lastPictureKey = request.pictureKey;
    if (!repeated) return this.bypass(target, width, height, paint);

    const prepared: Array<{
      readonly entry: CacheEntry<T>;
      readonly height: number;
      readonly width: number;
      readonly x: number;
      readonly y: number;
    }> = [];
    let frameHits = 0;
    let frameMisses = 0;
    let frameValue!: T;
    let hasFrameValue = false;
    for (let y = 0; y < height; y += this.#tileSize) {
      const tileHeight = Math.min(this.#tileSize, height - y);
      for (let x = 0; x < width; x += this.#tileSize) {
        const tileWidth = Math.min(this.#tileSize, width - x);
        const key = tileKey(request, x, y, tileWidth, tileHeight);
        let entry = this.#entries.get(key);
        if (entry === undefined) {
          const tileBytes = checkedPixelBytes(tileWidth, tileHeight);
          let surface: RasterSurface;
          try {
            this.evictUntilFits(tileBytes);
            surface = this.#surfaceFactory(tileWidth, tileHeight);
          } catch (cause) {
            const error =
              cause instanceof Error
                ? cause
                : new Error("raster cache allocation failed", { cause });
            this.#onError?.(error);
            return this.bypass(target, width, height, paint);
          }
          let value: T;
          surface.context.save();
          try {
            surface.context.translate(-x, -y);
            value = paint(surface.context);
          } catch (cause) {
            surface.dispose?.();
            throw cause;
          } finally {
            surface.context.restore();
          }
          entry = { bytes: tileBytes, lastUsed: ++this.#useSequence, surface, value };
          this.#entries.set(key, entry);
          this.#bytes += tileBytes;
          this.#misses += 1;
          frameMisses += 1;
        } else {
          entry.lastUsed = ++this.#useSequence;
          this.#hits += 1;
          frameHits += 1;
        }
        if (!hasFrameValue) {
          frameValue = entry.value;
          hasFrameValue = true;
        }
        prepared.push({ entry, height: tileHeight, width: tileWidth, x, y });
      }
    }

    target.save();
    try {
      target.resetTransform();
      target.clearRect(0, 0, width, height);
      for (const tile of prepared) {
        target.drawImage(
          tile.entry.surface.image,
          0,
          0,
          tile.width,
          tile.height,
          tile.x,
          tile.y,
          tile.width,
          tile.height,
        );
        this.#compositedTiles += 1;
      }
    } finally {
      target.restore();
    }
    if (!hasFrameValue) throw new Error("raster frame produced no tiles");
    return { bypassed: false, hits: frameHits, misses: frameMisses, value: frameValue };
  }

  public setBudgetBytes(value: number): void {
    this.#budgetBytes = budget(value);
    this.evictUntilFits(0);
  }

  public clear(): void {
    for (const entry of this.#entries.values()) entry.surface.dispose?.();
    this.#entries.clear();
    this.#bytes = 0;
  }

  public metrics(): RasterTileCacheMetrics {
    return {
      budgetBytes: this.#budgetBytes,
      bypassedFrames: this.#bypassedFrames,
      bytes: this.#bytes,
      compositedTiles: this.#compositedTiles,
      entries: this.#entries.size,
      evictions: this.#evictions,
      hits: this.#hits,
      misses: this.#misses,
    };
  }

  private bypass(
    target: Canvas2DContext,
    width: number,
    height: number,
    paint: (context: Canvas2DContext) => T,
  ): RasterFrameResult<T> {
    this.#bypassedFrames += 1;
    target.save();
    try {
      target.resetTransform();
      target.clearRect(0, 0, width, height);
      return { bypassed: true, hits: 0, misses: 0, value: paint(target) };
    } finally {
      target.restore();
    }
  }

  private evictUntilFits(incomingBytes: number): void {
    while (this.#bytes + incomingBytes > this.#budgetBytes && this.#entries.size > 0) {
      let oldestKey: string | undefined;
      let oldestUse = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.#entries) {
        if (entry.lastUsed < oldestUse) {
          oldestKey = key;
          oldestUse = entry.lastUsed;
        }
      }
      if (oldestKey === undefined) throw new Error("raster LRU could not select an entry");
      const entry = this.#entries.get(oldestKey);
      if (entry === undefined) throw new Error("raster LRU selected a missing entry");
      this.#entries.delete(oldestKey);
      this.#bytes -= entry.bytes;
      this.#evictions += 1;
      entry.surface.dispose?.();
    }
  }
}

/** Default cross-thread surface factory with a DOM canvas fallback. */
export function createBrowserRasterSurface(width: number, height: number): RasterSurface {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: true });
    if (context === null) throw new Error("OffscreenCanvas 2D context is unavailable");
    return { context, image: canvas };
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (context === null) throw new Error("Canvas2D cache context is unavailable");
    return { context, image: canvas };
  }
  throw new Error("no Canvas2D raster surface implementation is available");
}

function tileKey(
  request: RasterFrameRequest,
  x: number,
  y: number,
  width: number,
  height: number,
): string {
  return `${request.pictureKey}:${request.devicePixelRatio}:${String(x)}:${String(y)}:${String(width)}:${String(height)}`;
}

function checkedPixelBytes(width: number, height: number): number {
  const bytes = width * height * BYTES_PER_PIXEL;
  if (!Number.isSafeInteger(bytes) || bytes > MAX_BUDGET_BYTES) {
    throw new RangeError("raster allocation exceeds the maximum budget");
  }
  return bytes;
}

function budget(value: number): number {
  return integer(value, 0, MAX_BUDGET_BYTES, "budgetBytes");
}

function integer(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${label} must be an integer from ${String(minimum)} to ${String(maximum)}`,
    );
  }
  return value;
}
