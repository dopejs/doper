import { describe, expect, it } from "vitest";

import { ABI_VERSION, EDIT_TRANSACTIONS_MAGIC, STREAM_HEADER_BYTES } from "./generated";
import { decodeEditTransactionBatch } from "./edit-transactions";

describe("Edit Transaction Stream", () => {
  it("decodes exact u64 revisions, unicode delta, selection, and composition", () => {
    const bytes = transactionStream({
      nodeId: 7,
      baseRevision: 0x1234_5678_9abc_def0n,
      revision: 0x1234_5678_9abc_def1n,
      delta: { start: 1, end: 2, text: "你🙂" },
      selection: [4, 4],
      composition: [1, 4],
      kind: 2,
      affinities: [0, 1],
    });

    expect(decodeEditTransactionBatch(bytes)).toEqual([
      {
        nodeId: 7,
        baseRevision: 0x1234_5678_9abc_def0n,
        revision: 0x1234_5678_9abc_def1n,
        delta: { range: { start: 1, end: 2 }, text: "你🙂" },
        selection: {
          anchor: 4,
          anchorAffinity: "upstream",
          focus: 4,
          focusAffinity: "downstream",
        },
        composition: { start: 1, end: 4 },
        kind: "composition",
      },
    ]);
  });

  it("rejects malformed UTF-8, reserved flags, and non-canonical absence payloads", () => {
    const canonical = transactionStream({
      nodeId: 1,
      baseRevision: 0n,
      revision: 1n,
      delta: { start: 0, end: 0, text: "a" },
      selection: [1, 1],
      kind: 1,
      affinities: [1, 1],
    });
    const invalidUtf8 = canonical.slice();
    invalidUtf8[72] = 0xff;
    expect(() => decodeEditTransactionBatch(invalidUtf8)).toThrow(/UTF-8/u);

    const reservedFlags = canonical.slice();
    reservedFlags[65] = 0x80;
    expect(() => decodeEditTransactionBatch(reservedFlags)).toThrow(/reserved/u);

    const absentDelta = canonical.slice();
    absentDelta[65] = 0;
    expect(() => decodeEditTransactionBatch(absentDelta)).toThrow(/absent edit delta/u);
  });
});

interface Fixture {
  readonly nodeId: number;
  readonly baseRevision: bigint;
  readonly revision: bigint;
  readonly delta?: { readonly start: number; readonly end: number; readonly text: string };
  readonly selection: readonly [number, number];
  readonly composition?: readonly [number, number];
  readonly kind: number;
  readonly affinities: readonly [number, number];
}

function transactionStream(fixture: Fixture): Uint8Array {
  const text = new TextEncoder().encode(fixture.delta?.text ?? "");
  const padding = (4 - (text.byteLength % 4)) % 4;
  const bytes = new Uint8Array(72 + text.byteLength + padding);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, EDIT_TRANSACTIONS_MAGIC, true);
  view.setUint16(4, ABI_VERSION, true);
  view.setUint16(6, STREAM_HEADER_BYTES, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, 1, true);
  bytes[16] = 1;
  view.setUint32(20, fixture.nodeId, true);
  writeU64(view, 24, fixture.baseRevision);
  writeU64(view, 32, fixture.revision);
  view.setUint32(40, fixture.delta?.start ?? 0, true);
  view.setUint32(44, fixture.delta?.end ?? 0, true);
  view.setUint32(48, fixture.selection[0], true);
  view.setUint32(52, fixture.selection[1], true);
  view.setUint32(56, fixture.composition?.[0] ?? 0, true);
  view.setUint32(60, fixture.composition?.[1] ?? 0, true);
  bytes[64] = fixture.kind;
  bytes[65] = (fixture.delta === undefined ? 0 : 1) | (fixture.composition === undefined ? 0 : 2);
  bytes[66] = fixture.affinities[0];
  bytes[67] = fixture.affinities[1];
  view.setUint32(68, text.byteLength, true);
  bytes.set(text, 72);
  return bytes;
}

function writeU64(view: DataView, offset: number, value: bigint): void {
  view.setUint32(offset, Number(value & 0xffff_ffffn), true);
  view.setUint32(offset + 4, Number(value >> 32n), true);
}
