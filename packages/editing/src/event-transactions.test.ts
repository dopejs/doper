import { describe, expect, it } from "vitest";

import {
  ABI_VERSION,
  EVENT_TRANSACTIONS_MAGIC,
  EventTransactionOpcode,
  STREAM_HEADER_BYTES,
} from "./generated";
import { EventTransactionDecodingError, decodeEventTransactionBatch } from "./event-transactions";

function eventBytes(path: readonly number[] = [1, 2, 3]): Uint8Array {
  const bytes = new Uint8Array(16 + 52 + path.length * 4);
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
  view.setUint16(24, 1, true);
  view.setUint32(28, path.at(-1) ?? 0xffff_ffff, true);
  view.setFloat32(32, 12.5, true);
  view.setFloat32(36, 20, true);
  view.setFloat32(40, -2, true);
  view.setFloat32(44, 3, true);
  view.setUint32(48, 1, true);
  view.setUint32(52, 4, true);
  view.setUint32(56, 1, true);
  view.setUint32(60, 16_667, true);
  view.setUint32(64, path.length, true);
  path.forEach((nodeId, index) => view.setUint32(68 + index * 4, nodeId, true));
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
        path: [1, 2, 3],
      },
    ]);
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
    for (let length = 0; length < 96; length += 1) {
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
