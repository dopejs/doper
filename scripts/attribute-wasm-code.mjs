/**
 * Attributes WASM code-section bytes to individual functions.
 *
 * Diagnostic, never a gate: `measure-wasm-budget.mjs` owns the budget and reads
 * section totals, which say how big the module is but not what made it big. When
 * the engineering budget tightens, this says which functions and which crates to
 * look at first.
 *
 * The shipped module is stripped, so build one that keeps its name section:
 *
 *   cargo build -p pingo-core --target wasm32-unknown-unknown --release \
 *     --config 'profile.release.strip="none"' --config 'profile.release.debug=1'
 *   node scripts/attribute-wasm-code.mjs \
 *     target/wasm32-unknown-unknown/release/pingo_core.wasm 40
 *
 * That build skips wasm-opt, so its absolute sizes run about 12% above the
 * shipped module. Relative weight is what this is for.
 */
import { readFile } from "node:fs/promises";

const input = process.argv[2];
if (input === undefined) {
  process.stderr.write("usage: node scripts/attribute-wasm-code.mjs <module.wasm> [topN]\n");
  process.exit(2);
}
const bytes = new Uint8Array(await readFile(input));
let offset = 8;

function leb() {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[offset++];
    result |= (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7;
  }
}

const sections = [];
while (offset < bytes.length) {
  const id = bytes[offset++];
  const size = leb();
  sections.push({ id, start: offset, size });
  offset += size;
}

let importedFunctions = 0;
const importSection = sections.find((s) => s.id === 2);
if (importSection) {
  offset = importSection.start;
  const count = leb();
  for (let i = 0; i < count; i += 1) {
    const modLen = leb();
    offset += modLen;
    const nameLen = leb();
    offset += nameLen;
    const kind = bytes[offset++];
    if (kind === 0) {
      leb();
      importedFunctions += 1;
    } else if (kind === 1) {
      offset += 1;
      const flags = bytes[offset++];
      leb();
      if (flags & 1) leb();
    } else if (kind === 2) {
      const flags = bytes[offset++];
      leb();
      if (flags & 1) leb();
    } else {
      offset += 1;
      offset += 1;
    }
  }
}

const sizes = new Map();
const code = sections.find((s) => s.id === 10);
offset = code.start;
const bodyCount = leb();
for (let i = 0; i < bodyCount; i += 1) {
  const bodySize = leb();
  sizes.set(importedFunctions + i, bodySize);
  offset += bodySize;
}

const names = new Map();
for (const section of sections.filter((s) => s.id === 0)) {
  offset = section.start;
  const nameLen = leb();
  const label = new TextDecoder().decode(bytes.subarray(offset, offset + nameLen));
  offset += nameLen;
  if (label !== "name") continue;
  const end = section.start + section.size;
  while (offset < end) {
    const subId = bytes[offset++];
    const subSize = leb();
    const subEnd = offset + subSize;
    if (subId === 1) {
      const count = leb();
      for (let i = 0; i < count; i += 1) {
        const index = leb();
        const length = leb();
        names.set(index, new TextDecoder().decode(bytes.subarray(offset, offset + length)));
        offset += length;
      }
    }
    offset = subEnd;
  }
}

const rows = [...sizes.entries()]
  .map(([index, size]) => ({ size, name: names.get(index) ?? `func[${index}]` }))
  .sort((a, b) => b.size - a.size);

const total = rows.reduce((sum, row) => sum + row.size, 0);
const byCrate = new Map();
for (const row of rows) {
  const crate =
    /^_?ZN?[0-9]*(\w+?)(?:\.\.|::)/u.exec(row.name)?.[1] ??
    row.name
      .split("::")[0]
      .replace(/^_+/u, "")
      .split(/[^A-Za-z0-9_]/u)[0];
  byCrate.set(crate, (byCrate.get(crate) ?? 0) + row.size);
}
console.log(`code bodies: ${total} bytes across ${rows.length} functions\n`);
console.log("== top functions ==");
for (const row of rows.slice(0, Number(process.argv[3] ?? 40))) {
  console.log(`${String(row.size).padStart(7)}  ${row.name.slice(0, 130)}`);
}
console.log("\n== by leading path segment ==");
for (const [crate, size] of [...byCrate.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`${String(size).padStart(7)}  ${crate}`);
}
