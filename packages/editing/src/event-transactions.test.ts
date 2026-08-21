import { describe, expect, it } from "vitest";

import {
  ABI_VERSION,
  EVENT_TRANSACTIONS_MAGIC,
  EventTransactionOpcode,
  STREAM_HEADER_BYTES,
} from "./generated";
import { EventTransactionDecodingError, decodeEventTransactionBatch } from "./event-transactions";

function eventBytes(
  path: readonly number[] = [1, 2, 3],
  key: {
    readonly kind?: number;
    readonly code?: number;
    readonly name?: number;
    readonly text?: number;
    readonly repeat?: number;
  } = {},
): Uint8Array {
  const bytes = new Uint8Array(108 + path.length * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, EVENT_TRANSACTIONS_MAGIC, true);
  view.setUint16(4, ABI_VERSION, true);
  view.setUint16(6, STREAM_HEADER_BYTES, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, 1, true);
  view.setUint8(16, EventTransactionOpcode.Event);
  // Instruction length in four-byte words, covering the header and payload.
  view.setUint16(18, (bytes.byteLength - 16) / 4, true);
  view.setUint32(20, 9, true);
  view.setUint16(24, key.kind ?? 1, true);
  view.setUint32(28, path.at(-1) ?? 0xffff_ffff, true);
  view.setFloat32(32, 12.5, true);
  view.setFloat32(36, 20, true);
  view.setFloat32(40, -2, true);
  view.setFloat32(44, 3, true);
  view.setUint32(48, 1, true);
  view.setUint32(52, 4, true);
  // Core zeroes pointer identity on a key record, the same way it does on focus.
  const keyEvent = (key.kind ?? 1) === 17 || (key.kind ?? 1) === 18;
  view.setUint32(56, keyEvent ? 0 : 1, true);
  view.setUint32(60, 16_667, true);
  view.setUint32(64, 0xffff_ffff, true);
  view.setUint8(68, keyEvent ? 0 : 1);
  view.setUint8(69, keyEvent ? 0 : 1);
  view.setFloat32(72, 0.5, true);
  view.setFloat32(76, 10, true);
  view.setFloat32(80, -5, true);
  view.setFloat32(84, 2, true);
  view.setFloat32(88, 3, true);
  view.setUint16(92, 34, true);
  view.setUint16(94, key.code ?? 0, true);
  view.setUint16(96, key.name ?? 0, true);
  view.setUint8(98, key.repeat ?? 0);
  view.setUint32(100, key.text ?? 0, true);
  view.setUint32(104, path.length, true);
  path.forEach((nodeId, index) => view.setUint32(108 + index * 4, nodeId, true));
  return bytes;
}

describe("event transactions", () => {
  it("decodes a complete validated root-to-target path", () => {
    expect(decodeEventTransactionBatch(eventBytes())).toEqual([
      {
        eventId: 9,
        kind: "pointerdown",
        target: 3,
        x: 12.5,
        y: 20,
        deltaX: -2,
        deltaY: 3,
        buttons: 1,
        modifiers: 4,
        pointerId: 1,
        elapsedMicros: 16_667,
        relatedTarget: null,
        pointerType: "mouse",
        isPrimary: true,
        pressure: 0.5,
        tiltX: 10,
        tiltY: -5,
        width: 2,
        height: 3,
        cursor: "pointer",
        code: "",
        key: "",
        repeat: false,
        path: [1, 2, 3],
      },
    ]);
  });

  it("rebuilds key and code strings from their interned identifiers", () => {
    const [named] = decodeEventTransactionBatch(
      eventBytes([1, 2, 3], { kind: 17, code: 37, name: 8, repeat: 1 }),
    );
    expect(named?.kind).toBe("keydown");
    expect(named?.code).toBe("Enter");
    expect(named?.key).toBe("ArrowUp");
    expect(named?.repeat).toBe(true);

    const [printable] = decodeEventTransactionBatch(
      eventBytes([1, 2, 3], { kind: 18, code: 1, text: 0x61 }),
    );
    expect(printable?.kind).toBe("keyup");
    expect(printable?.code).toBe("KeyA");
    expect(printable?.key).toBe("a");
    expect(printable?.repeat).toBe(false);

    const [unknown] = decodeEventTransactionBatch(eventBytes([1, 2, 3], { kind: 17 }));
    expect(unknown?.code).toBe("");
    expect(unknown?.key).toBe("Unidentified");
  });

  it("rejects a key payload on an event that is not a key event", () => {
    expect(() => decodeEventTransactionBatch(eventBytes([1, 2, 3], { code: 1 }))).toThrow(
      /non-key event carries a key payload/u,
    );
    expect(() =>
      decodeEventTransactionBatch(eventBytes([1, 2, 3], { kind: 17, name: 1, text: 0x61 })),
    ).toThrow(/named and printable/u);
    expect(() =>
      decodeEventTransactionBatch(eventBytes([1, 2, 3], { kind: 17, text: 0xd800 })),
    ).toThrow(/Unicode scalar/u);
    expect(() =>
      decodeEventTransactionBatch(eventBytes([1, 2, 3], { kind: 17, code: 0xffff })),
    ).toThrow(/out of range/u);
  });

  it("rejects cycles, truncation, non-finite values, and reserved bytes", () => {
    expect(() => decodeEventTransactionBatch(eventBytes([1, 1]))).toThrow(/repeated/u);

    // Truncation is now caught by the instruction framing, before the payload
    // parser ever runs: the declared length no longer fits the stream.
    const truncated = eventBytes().slice(0, -4);
    new DataView(truncated.buffer).setUint32(8, truncated.byteLength, true);
    expect(() => decodeEventTransactionBatch(truncated)).toThrow(/runs past the stream/u);

    const nonFinite = eventBytes();
    new DataView(nonFinite.buffer).setFloat32(32, Number.NaN, true);
    expect(() => decodeEventTransactionBatch(nonFinite)).toThrow(/not finite/u);

    const reserved = eventBytes();
    reserved[26] = 1;
    expect(() => decodeEventTransactionBatch(reserved)).toThrow(/reserved/u);
  });

  it("fails closed on arbitrary bytes", () => {
    for (let length = 0; length < 100; length += 1) {
      const bytes = new Uint8Array(length);
      bytes.fill(length);
      try {
        decodeEventTransactionBatch(bytes);
      } catch (error) {
        expect(error).toBeInstanceOf(EventTransactionDecodingError);
      }
    }
  });
});
