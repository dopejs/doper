import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Import specifiers business code may use; everything else is engine-internal. */
const ALLOWED_PACKAGES = new Set(["@dopejs/doper", "@dopejs/doper-compat"]);

/**
 * Scans migrated business source for patterns the public contract forbids:
 * engine-internal imports, per-widget HTML input controls, and forceUpdate
 * escape hatches. Returns machine-readable findings for rollout tooling.
 */
export async function scanMigrationSources(directories) {
  const findings = [];
  for (const directory of directories) {
    for (const file of await collectSources(directory)) {
      const source = await readFile(file, "utf8");
      const relative = path.relative(repositoryRoot, file);
      findings.push(...scanSource(relative, source));
    }
  }
  return findings;
}

/** Pure single-file rule engine, exported for tests. */
export function scanSource(file, source) {
  const findings = [];
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    const record = (rule, detail) => {
      findings.push({ file, line: index + 1, rule, detail });
    };
    const importMatch =
      /from\s+["'](@dopejs\/[^"']+)["']|require\(["'](@dopejs\/[^"']+)["']\)/u.exec(line);
    const specifier = importMatch?.[1] ?? importMatch?.[2];
    if (specifier !== undefined) {
      const packageName = specifier.split("/").slice(0, 2).join("/");
      const isFacadeSubpath = specifier.startsWith("@dopejs/doper/");
      if (!ALLOWED_PACKAGES.has(packageName) || (!isFacadeSubpath && specifier !== packageName)) {
        record(
          "internal-package-import",
          `import "${specifier}" bypasses the public facade contract`,
        );
      }
    }
    if (/createElement\(\s*["'](?:input|textarea)["']/u.test(line)) {
      record(
        "embed-dom-input",
        "per-widget HTML input controls are owned by the engine input bridge",
      );
    }
    if (/\bforceUpdate\b/u.test(line)) {
      record("force-update", "forceUpdate escape hatches are not part of the invalidation model");
    }
  });
  return findings;
}

async function collectSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      files.push(...(await collectSources(full)));
    } else if (/\.(?:ts|tsx|js|jsx|mjs)$/u.test(entry.name) && !/\.test\./u.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** Compat must depend only on the facade so deleting it never touches Core. */
export async function checkShimDependencyDirection() {
  const problems = [];
  const compat = JSON.parse(
    await readFile(path.join(repositoryRoot, "packages/compat/package.json"), "utf8"),
  );
  for (const dependency of Object.keys(compat.dependencies ?? {})) {
    if (dependency !== "@dopejs/doper") {
      problems.push(`packages/compat depends on ${dependency}; only the facade is allowed`);
    }
  }
  const packages = await readdir(path.join(repositoryRoot, "packages"), { withFileTypes: true });
  for (const entry of packages) {
    if (!entry.isDirectory() || entry.name === "compat") continue;
    const manifestPath = path.join(repositoryRoot, "packages", entry.name, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    if (Object.keys(dependencies).includes("@dopejs/doper-compat")) {
      problems.push(`packages/${entry.name} depends on the compat shim; the shim must stay a leaf`);
    }
  }
  return problems;
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const targets = process.argv.slice(2);
  const directories = (targets.length === 0 ? ["fixtures/migration"] : targets).map((target) =>
    path.resolve(repositoryRoot, target),
  );
  const findings = await scanMigrationSources(directories);
  const direction = await checkShimDependencyDirection();
  const report = { version: 1, directories, findings, shimDependencyProblems: direction };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (findings.length > 0 || direction.length > 0) {
    process.exitCode = 1;
  }
}
