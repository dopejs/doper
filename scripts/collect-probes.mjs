import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadProbeReports, summarizeReports, validateProbeReport } from "./summarize-probes.mjs";

const maximumBodyBytes = 10 * 1024 * 1024;
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

export function safeArchiveSegment(value, label) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new HttpError(400, `${label} is not a safe archive identifier`);
  }
  return value;
}

export async function archiveProbeReport(report, archiveRoot) {
  const root = path.resolve(archiveRoot);
  await mkdir(root, { recursive: true });
  const resolvedRoot = await realpath(root);
  const deviceId = safeArchiveSegment(report.deviceId, "deviceId");
  const buildId = safeArchiveSegment(report.build.id, "build.id");
  const runId = safeArchiveSegment(report.runId, "runId");
  const directory = path.join(resolvedRoot, "v1", deviceId, buildId);
  await mkdir(directory, { recursive: true });
  const resolvedDirectory = await realpath(directory);
  assertWithin(resolvedRoot, resolvedDirectory, "archive directory");
  const filename = path.join(resolvedDirectory, `${runId}.json`);
  try {
    await writeFile(filename, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "EEXIST") {
      throw new HttpError(409, `runId ${runId} is already archived`);
    }
    throw error;
  }
  return path.relative(resolvedRoot, filename);
}

export async function createProbeCollector(options) {
  const distributionRoot = await realpath(path.resolve(options.dist));
  const archiveRoot = path.resolve(options.output);
  await mkdir(archiveRoot, { recursive: true });
  const serverOptions =
    options.cert === undefined
      ? undefined
      : {
          cert: await readFile(options.cert),
          key: await readFile(options.key),
        };
  const handle = (request, response) => {
    void handleRequest(request, response, {
      allowLocal: options.allowLocal,
      archiveRoot,
      distributionRoot,
      token: options.token,
    }).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, status, { error: message });
    });
  };
  return serverOptions === undefined
    ? createHttpServer(handle)
    : createHttpsServer(serverOptions, handle);
}

async function handleRequest(request, response, context) {
  setIsolationHeaders(response);
  const url = new URL(request.url ?? "/", "http://collector.invalid");
  if (
    (url.pathname === "/api/reports" ||
      url.pathname === "/api/summary" ||
      url.pathname === "/trends") &&
    !isAuthorized(request, context.token)
  ) {
    response.setHeader("WWW-Authenticate", 'Basic realm="doper probe collector"');
    sendJson(response, 401, { error: "collector authorization required" });
    return;
  }
  if (url.pathname === "/api/reports" && request.method === "POST") {
    const body = await readBody(request, maximumBodyBytes);
    let report;
    try {
      report = JSON.parse(body);
    } catch {
      throw new HttpError(400, "request body is not valid JSON");
    }
    await validateProbeReport(report, {
      allowLocal: context.allowLocal,
      label: "uploaded probe report",
    });
    const archivedPath = await archiveProbeReport(report, context.archiveRoot);
    sendJson(response, 201, { archivedPath, runId: report.runId, trends: "/trends" });
    return;
  }
  if (url.pathname === "/api/summary" && request.method === "GET") {
    sendJson(response, 200, await archiveSummary(context.archiveRoot, context.allowLocal));
    return;
  }
  if (url.pathname === "/trends" && request.method === "GET") {
    const summary = await archiveSummary(context.archiveRoot, context.allowLocal);
    send(response, 200, renderTrendHtml(summary), "text/html; charset=utf-8");
    return;
  }
  if (!["GET", "HEAD"].includes(request.method ?? "")) {
    throw new HttpError(405, "method not allowed");
  }
  await serveStatic(response, url.pathname, context.distributionRoot, request.method === "HEAD");
}

async function archiveSummary(archiveRoot, allowLocal) {
  const filenames = await listJsonFiles(archiveRoot);
  const reports = await loadProbeReports(filenames, { allowLocal });
  return summarizeReports(reports);
}

async function listJsonFiles(root) {
  const filenames = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile() && entry.name.endsWith(".json")) filenames.push(filename);
    }
  }
  await visit(root);
  return filenames;
}

async function serveStatic(response, pathname, distributionRoot, headOnly) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "invalid URL encoding");
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = path.resolve(distributionRoot, relative);
  assertWithin(distributionRoot, candidate, "static asset");
  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new HttpError(404, "asset not found");
  }
  assertWithin(distributionRoot, resolved, "static asset");
  const fileStats = await stat(resolved);
  if (!fileStats.isFile()) throw new HttpError(404, "asset not found");
  const body = headOnly ? Buffer.alloc(0) : await readFile(resolved);
  send(response, 200, body, mimeTypes.get(path.extname(resolved)) ?? "application/octet-stream", {
    "Cache-Control":
      relative === "index.html" || relative.startsWith("wasm/")
        ? "no-store"
        : "public, max-age=31536000, immutable",
    ...(headOnly ? { "Content-Length": fileStats.size } : {}),
  });
}

async function readBody(request, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new HttpError(413, "probe report exceeds 10 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function assertWithin(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpError(400, `${label} escapes configured root`);
  }
}

function setIsolationHeaders(response) {
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function isAuthorized(request, token) {
  if (token === undefined) return true;
  const authorization = request.headers.authorization;
  if (authorization === undefined) return false;
  const separator = authorization.indexOf(" ");
  if (separator < 1) return false;
  const scheme = authorization.slice(0, separator).toLowerCase();
  const credential = authorization.slice(separator + 1);
  if (scheme === "bearer") return secureEqual(credential, token);
  if (scheme !== "basic") return false;
  let decoded;
  try {
    decoded = Buffer.from(credential, "base64").toString("utf8");
  } catch {
    return false;
  }
  return secureEqual(decoded, `doper:${token}`);
}

function secureEqual(actual, expected) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function sendJson(response, status, value) {
  send(response, status, `${JSON.stringify(value, null, 2)}\n`, "application/json; charset=utf-8");
}

function send(response, status, body, contentType, extraHeaders = {}) {
  if (response.headersSent) return;
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  response.writeHead(status, {
    "Content-Length": bytes.length,
    "Content-Type": contentType,
    ...extraHeaders,
  });
  response.end(bytes);
}

function renderTrendHtml(summary) {
  const batchRows = summary.batches
    .map(
      (batch) =>
        `<tr><td>${escapeHtml(batch.deviceId)}</td><td>${escapeHtml(batch.buildId)}</td><td>${escapeHtml(batch.batchId)}</td><td>${batch.complete ? "complete" : "incomplete"}</td><td>${String(batch.receivedSamples)}/${escapeHtml(batch.expectedSamples ?? "inconsistent")}</td><td><pre>${escapeHtml(JSON.stringify(batch.metrics, null, 2))}</pre></td></tr>`,
    )
    .join("");
  const reproducibilityRows = summary.reproducibility
    .map(
      (comparison) =>
        `<tr><td>${escapeHtml(comparison.previousBatchId)}</td><td>${escapeHtml(comparison.currentBatchId)}</td><td>${comparison.pass ? "pass" : "fail"}</td><td>${escapeHtml(comparison.reasons.join("; ") || "within thresholds")}</td><td><pre>${escapeHtml(JSON.stringify(comparison.metrics, null, 2))}</pre></td></tr>`,
    )
    .join("");
  const runRows = summary.runs
    .map(
      (run) =>
        `<tr><td>${escapeHtml(run.deviceId)}</td><td>${escapeHtml(run.buildId)}</td><td>${escapeHtml(run.runId)}</td><td>${escapeHtml(run.finishedAt ?? "incomplete")}</td><td>${run.complete ? "complete" : "failed/incomplete"}</td><td><pre>${escapeHtml(JSON.stringify(run.metrics, null, 2))}</pre></td></tr>`,
    )
    .join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>doper probe trends</title><style>body{font:14px system-ui;margin:24px;color:#172033}table{border-collapse:collapse;width:100%;margin-bottom:32px}th,td{border:1px solid #ccd3df;padding:8px;text-align:left;vertical-align:top}pre{margin:0;white-space:pre-wrap}th{background:#edf2f8}</style><h1>doper probe trends</h1><p>Report count: ${String(summary.reportCount)} · format v${String(summary.version)}</p><h2>Batches</h2><table><thead><tr><th>Device</th><th>Build</th><th>Batch</th><th>Status</th><th>Samples</th><th>Metrics</th></tr></thead><tbody>${batchRows}</tbody></table><h2>Reproducibility</h2><table><thead><tr><th>Previous batch</th><th>Current batch</th><th>Result</th><th>Reasons</th><th>Deltas</th></tr></thead><tbody>${reproducibilityRows}</tbody></table><h2>Runs</h2><table><thead><tr><th>Device</th><th>Build</th><th>Run</th><th>Finished</th><th>Status</th><th>Metrics</th></tr></thead><tbody>${runRows}</tbody></table>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseArguments(arguments_) {
  const options = {
    allowLocal: false,
    dist: "apps/platform-probe/dist",
    host: "127.0.0.1",
    output: "target/probe-archive",
    port: 4174,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--allow-local") {
      options.allowLocal = true;
      continue;
    }
    const key = argument.slice(2);
    if (!["cert", "dist", "host", "key", "output", "port"].includes(key)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    options[key] = key === "port" ? Number(value) : value;
    index += 1;
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  if ((options.cert === undefined) !== (options.key === undefined)) {
    throw new Error("--cert and --key must be provided together");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  options.token = process.env.DOPER_PROBE_COLLECTOR_TOKEN;
  if (!isLoopbackHost(options.host)) {
    if (options.cert === undefined) {
      throw new Error("non-loopback collection requires --cert and --key");
    }
    if (options.token === undefined || options.token.length < 24) {
      throw new Error(
        "non-loopback collection requires DOPER_PROBE_COLLECTOR_TOKEN with at least 24 characters",
      );
    }
  }
  const server = await createProbeCollector(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  const protocol = options.cert === undefined ? "http" : "https";
  process.stdout.write(
    `doper probe collector: ${protocol}://${options.host}:${String(options.port)}/?collector=1&deviceId=<asset-id>\narchive: ${path.resolve(options.output)}\n`,
  );
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
