import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export async function bootstrapAndLocatePinnedWasmOpt({ build, locate }) {
  const result = await build();
  const tool = await locate();
  return { result, ...tool };
}

export async function locatePinnedWasmOpt({
  expectedVersion,
  readVersion,
  roots = wasmPackCacheRoots(),
}) {
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !entry.name.startsWith("wasm-opt-")) continue;
      const executable = path.join(root, entry.name, "bin", "wasm-opt");
      try {
        if (!(await stat(executable)).isFile()) continue;
        const version = (await readVersion(executable)).trim();
        if (version === expectedVersion) return { executable, version };
      } catch {
        // Try the next wasm-pack cache entry.
      }
    }
  }
  throw new Error(
    `wasm-pack did not install required Binaryen ${expectedVersion} after a product Core build`,
  );
}

function wasmPackCacheRoots(home = homedir()) {
  return [path.join(home, "Library/Caches/.wasm-pack"), path.join(home, ".cache/.wasm-pack")];
}
