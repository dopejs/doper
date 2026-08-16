import { describe, expect, it } from "vitest";
import { compress } from "woff2-encoder";

import { DoperFontLoadError, loadFont } from "./font-loader";

describe("explicit font loading", () => {
  it("loads copied SFNT bytes from buffers and successful responses", async () => {
    const source = Uint8Array.of(0x4f, 0x54, 0x54, 0x4f, 1, 2, 3, 4);
    const direct = await loadFont(source, { faceIndex: 2, fallbackFamily: "Inter" });
    source[4] = 99;
    expect(direct.copyBytes()).toEqual(Uint8Array.of(0x4f, 0x54, 0x54, 0x4f, 1, 2, 3, 4));
    expect(direct.faceIndex).toBe(2);

    const fetched = await loadFont("/font.otf", {
      fetch: () => Promise.resolve(new Response(Uint8Array.of(0x4f, 0x54, 0x54, 0x4f))),
    });
    expect(fetched.copyBytes()).toEqual(Uint8Array.of(0x4f, 0x54, 0x54, 0x4f));
  });

  it("reconstructs both stored and deflated WOFF1 tables", async () => {
    const storedData = Uint8Array.of(1, 2, 3, 4, 5);
    const stored = await loadFont(await woff(storedData, false));
    expect(sfntTable(stored.copyBytes())).toEqual(storedData);

    const compressedData = new Uint8Array(256).fill(0x41);
    const deflated = await loadFont(await woff(compressedData, true));
    expect(sfntTable(deflated.copyBytes())).toEqual(compressedData);
  });

  it("preflights WOFF2 before invoking an isolated decoder", async () => {
    const source = minimalWoff2();
    let decoderInput: Uint8Array | undefined;
    const font = await loadFont(source, {
      woff2Decoder: (input) => {
        decoderInput = input;
        input[0] = 0;
        return Uint8Array.of(0x4f, 0x54, 0x54, 0x4f, 1, 2, 3, 4);
      },
    });
    expect(decoderInput).toBeDefined();
    expect(source[0]).toBe(0x77);
    expect(font.copyBytes()).toEqual(Uint8Array.of(0x4f, 0x54, 0x54, 0x4f, 1, 2, 3, 4));

    const malformed = minimalWoff2();
    new DataView(malformed.buffer).setUint32(8, malformed.byteLength + 1);
    await expect(
      loadFont(malformed, { woff2Decoder: () => new Uint8Array() }),
    ).rejects.toMatchObject({ code: "invalid-data" });
  });

  it("loads a real WOFF2 through the lazy default decoder", async () => {
    const sfnt = await readTestFont();
    const encoded = await compress(sfnt);
    const font = await loadFont(encoded);
    const decoded = font.copyBytes();
    expect(decoded.byteLength).toBe(sfnt.byteLength);
    expect(decoded.slice(0, 4)).toEqual(Uint8Array.of(0, 1, 0, 0));
  });

  it("reports bounded network, abort, format, and decoder failures", async () => {
    await expect(
      loadFont("/too-large.woff2", {
        fetch: () =>
          Promise.resolve(
            new Response(Uint8Array.of(1), { headers: { "content-length": "9000000" } }),
          ),
      }),
    ).rejects.toMatchObject({ code: "response-too-large" });

    const controller = new AbortController();
    controller.abort("test abort");
    await expect(
      loadFont(Uint8Array.of(1, 2, 3, 4), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });

    const streamingAbort = new AbortController();
    const stalled = loadFont(new Response(new ReadableStream<Uint8Array>()), {
      signal: streamingAbort.signal,
    });
    streamingAbort.abort("stream abort");
    await expect(stalled).rejects.toMatchObject({ code: "aborted" });

    await expect(loadFont(Uint8Array.of(1, 2, 3, 4))).rejects.toMatchObject({
      code: "unsupported-format",
    });
    await expect(
      loadFont(minimalWoff2(), {
        woff2Decoder: () => {
          throw new Error("decoder failed");
        },
      }),
    ).rejects.toMatchObject({ code: "decode-failed" });
    await expect(
      loadFont("/missing.woff", {
        fetch: () => Promise.resolve(new Response(null, { status: 404 })),
      }),
    ).rejects.toMatchObject({ code: "fetch-failed" });
  });

  it("exposes stable error metadata", () => {
    const cause = new Error("cause");
    const error = new DoperFontLoadError("decode-failed", "bad font", { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DoperFontLoadError");
    expect(error.code).toBe("decode-failed");
    expect(error.cause).toBe(cause);
  });

  it("fails closed for single-byte corruption across a canonical WOFF", async () => {
    const canonical = await woff(Uint8Array.of(1, 2, 3, 4, 5), false);
    for (let index = 0; index < canonical.byteLength; index += 1) {
      const corrupted = canonical.slice();
      corrupted[index] = (corrupted[index] ?? 0) ^ 0xff;
      try {
        await loadFont(corrupted);
      } catch (error) {
        expect(error).toBeInstanceOf(DoperFontLoadError);
      }
    }
  });
});

async function woff(data: Uint8Array, shouldCompress: boolean): Promise<Uint8Array> {
  const encoded = shouldCompress ? await deflate(data) : data;
  if (shouldCompress && encoded.byteLength >= data.byteLength) {
    throw new Error("test table did not compress");
  }
  const tableOffset = 64;
  const length = align4(tableOffset + encoded.byteLength);
  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  view.setUint32(0, tag("wOFF"));
  view.setUint32(4, tag("OTTO"));
  view.setUint32(8, length);
  view.setUint16(12, 1);
  view.setUint32(16, 28 + align4(data.byteLength));
  view.setUint32(44, tag("name"));
  view.setUint32(48, tableOffset);
  view.setUint32(52, encoded.byteLength);
  view.setUint32(56, data.byteLength);
  output.set(encoded, tableOffset);
  return output;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice().buffer])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function sfntTable(sfnt: Uint8Array): Uint8Array {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const offset = view.getUint32(20);
  const length = view.getUint32(24);
  return sfnt.slice(offset, offset + length);
}

function minimalWoff2(): Uint8Array {
  const output = new Uint8Array(20);
  const view = new DataView(output.buffer);
  view.setUint32(0, tag("wOF2"));
  view.setUint32(4, tag("OTTO"));
  view.setUint32(8, output.byteLength);
  view.setUint16(12, 1);
  view.setUint32(16, 8);
  return output;
}

async function readTestFont(): Promise<Uint8Array> {
  const moduleName = "node:fs/promises";
  const fileSystem = (await import(moduleName)) as {
    readdir(path: string): Promise<string[]>;
    readFile(path: string): Promise<Uint8Array>;
  };
  const runtime = globalThis as typeof globalThis & {
    process: { cwd(): string };
  };
  const store = `${runtime.process.cwd()}/node_modules/.pnpm`;
  const packageName = (await fileSystem.readdir(store))
    .filter((name) => name.startsWith("playwright-core@"))
    .sort()
    .at(-1);
  if (packageName === undefined) throw new Error("Playwright Core test fixture is unavailable");
  const directory = `${store}/${packageName}/node_modules/playwright-core/lib/vite/traceViewer`;
  const fontName = (await fileSystem.readdir(directory)).find(
    (name) => name.startsWith("codicon.") && name.endsWith(".ttf"),
  );
  if (fontName === undefined) throw new Error("Codicon SFNT test fixture is unavailable");
  return fileSystem.readFile(`${directory}/${fontName}`);
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function tag(value: string): number {
  return (
    (((value.charCodeAt(0) << 24) >>> 0) |
      (value.charCodeAt(1) << 16) |
      (value.charCodeAt(2) << 8) |
      value.charCodeAt(3)) >>>
    0
  );
}
