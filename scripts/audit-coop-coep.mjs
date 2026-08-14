import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parse } from "parse5";

const resourceAttributes = new Map([
  ["audio", ["src"]],
  ["iframe", ["src"]],
  ["img", ["src", "srcset"]],
  ["link", ["href"]],
  ["script", ["src"]],
  ["source", ["src", "srcset"]],
  ["video", ["src", "poster"]],
]);

export function discoverSubresources(html, documentUrl) {
  const document = parse(html);
  const discovered = [];
  let baseUrl = documentUrl;

  walk(document, (node) => {
    if (node.tagName === "base") {
      const href = attribute(node, "href");
      if (href !== undefined) baseUrl = resolveUrl(href, documentUrl) ?? baseUrl;
    }
  });

  walk(document, (node) => {
    const names = resourceAttributes.get(node.tagName);
    if (names === undefined || (node.tagName === "link" && !isFetchedLink(node))) return;
    for (const name of names) {
      const rawValue = attribute(node, name);
      if (rawValue === undefined) continue;
      const candidates = name === "srcset" ? parseSrcset(rawValue) : [rawValue];
      for (const candidate of candidates) {
        const url = resolveUrl(candidate, baseUrl);
        if (url === undefined) continue;
        discovered.push({
          corsMode: resourceCorsMode(node),
          tag: node.tagName,
          url,
        });
      }
    }
  });

  return [...new Map(discovered.map((item) => [`${item.tag}\0${item.url}`, item])).values()];
}

export function evaluateResourcePolicy(resource, documentUrl, headers) {
  const resourceUrl = new URL(resource.url);
  const origin = new URL(documentUrl).origin;
  if (resourceUrl.origin === origin) {
    return { reason: "same-origin resource", status: "pass" };
  }

  if (resource.tag === "iframe") {
    return {
      reason: "cross-origin iframe requires an explicit nested-context COEP review",
      status: "manual",
    };
  }

  const corp = normalizeHeader(headers, "cross-origin-resource-policy");
  const acao = normalizeHeader(headers, "access-control-allow-origin");
  if (resource.corsMode !== "no-cors") {
    const credentials = resource.corsMode === "cors-with-credentials";
    const credentialsAllowed = normalizeHeader(headers, "access-control-allow-credentials");
    if (
      (acao === origin || (acao === "*" && !credentials)) &&
      (!credentials || credentialsAllowed === "true")
    ) {
      return { reason: `CORS permits ${origin}`, status: "pass" };
    }
    return {
      reason: credentials
        ? "credentialed CORS requires an exact Access-Control-Allow-Origin and Access-Control-Allow-Credentials: true"
        : `CORS response does not permit ${origin}`,
      status: "block",
    };
  }

  if (corp === "cross-origin") {
    return {
      reason: "Cross-Origin-Resource-Policy permits cross-origin embedding",
      status: "pass",
    };
  }
  if (corp === "same-site") {
    return {
      reason: "CORP is same-site; registrable-domain and scheme compatibility need review",
      status: "manual",
    };
  }
  return {
    reason: "cross-origin no-cors resource lacks Cross-Origin-Resource-Policy: cross-origin",
    status: "block",
  };
}

export async function auditPage(url, fetchImplementation = fetch) {
  const page = await fetchDocument(url, fetchImplementation);
  const finalUrl = page.url;
  const coop = normalizeHeader(page.headers, "cross-origin-opener-policy");
  const coep = normalizeHeader(page.headers, "cross-origin-embedder-policy");
  const resources = discoverSubresources(page.body, finalUrl);
  const inspected = await mapWithConcurrency(resources, 8, async (resource) => {
    try {
      const response = await fetchHeaders(resource.url, fetchImplementation);
      const policy =
        response.status >= 200 && response.status < 400
          ? evaluateResourcePolicy({ ...resource, url: response.url }, finalUrl, response.headers)
          : { reason: `resource returned HTTP ${String(response.status)}`, status: "error" };
      return {
        ...resource,
        finalUrl: response.url,
        httpStatus: response.status,
        policy,
        responseHeaders: selectedHeaders(response.headers),
      };
    } catch (error) {
      return {
        ...resource,
        finalUrl: resource.url,
        httpStatus: null,
        policy: { reason: error instanceof Error ? error.message : String(error), status: "error" },
        responseHeaders: {},
      };
    }
  });
  const counts = countStatuses(inspected);
  const secureContextCandidate = isSecureContextCandidate(finalUrl);
  const pagePolicyReady =
    secureContextCandidate && coop === "same-origin" && coep === "require-corp";

  return {
    counts,
    finalUrl,
    pagePolicy: {
      coep: coep ?? null,
      coop: coop ?? null,
      ready: pagePolicyReady,
      secureContextCandidate,
    },
    redirects: page.redirects,
    requestedUrl: url,
    resources: inspected,
    responseHeaders: selectedHeaders(page.headers),
    status: pagePolicyReady && counts.block === 0 && counts.error === 0 ? "ready" : "not-ready",
  };
}

async function fetchDocument(url, fetchImplementation) {
  const { response, redirects } = await fetchFollowingRedirects(
    url,
    { method: "GET" },
    fetchImplementation,
  );
  if (!response.ok) throw new Error(`document returned HTTP ${String(response.status)}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) {
    throw new Error(`document content-type is not HTML: ${contentType || "missing"}`);
  }
  return {
    body: await response.text(),
    headers: response.headers,
    redirects,
    url: response.url || url,
  };
}

async function fetchHeaders(url, fetchImplementation) {
  let result = await fetchFollowingRedirects(url, { method: "HEAD" }, fetchImplementation);
  if ([405, 501].includes(result.response.status)) {
    result = await fetchFollowingRedirects(
      url,
      { headers: { Range: "bytes=0-0" }, method: "GET" },
      fetchImplementation,
    );
  }
  return {
    headers: result.response.headers,
    status: result.response.status,
    url: result.response.url || url,
  };
}

async function fetchFollowingRedirects(url, init, fetchImplementation) {
  const redirects = [];
  let current = new URL(url).href;
  for (let count = 0; count <= 10; count += 1) {
    const response = await fetchImplementation(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { redirects, response };
    const location = response.headers.get("location");
    if (location === null) throw new Error(`redirect ${String(response.status)} has no Location`);
    const next = new URL(location, current).href;
    redirects.push({ from: current, status: response.status, to: next });
    current = next;
  }
  throw new Error("more than 10 redirects");
}

function resourceCorsMode(node) {
  if (node.tagName === "script" && attribute(node, "type")?.toLowerCase() === "module") {
    return "cors";
  }
  const crossorigin = attribute(node, "crossorigin");
  if (crossorigin === undefined) return "no-cors";
  return crossorigin.toLowerCase() === "use-credentials" ? "cors-with-credentials" : "cors";
}

function isFetchedLink(node) {
  const rel = new Set((attribute(node, "rel") ?? "").toLowerCase().split(/\s+/u));
  return ["stylesheet", "preload", "modulepreload", "icon", "manifest"].some((value) =>
    rel.has(value),
  );
}

function attribute(node, name) {
  return node.attrs?.find((item) => item.name === name)?.value;
}

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
  if (node.content !== undefined) walk(node.content, visit);
}

function parseSrcset(value) {
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/u)[0])
    .filter(Boolean);
}

function resolveUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function normalizeHeader(headers, name) {
  return headers.get(name)?.trim().toLowerCase();
}

function selectedHeaders(headers) {
  const names = [
    "access-control-allow-credentials",
    "access-control-allow-origin",
    "content-security-policy",
    "cross-origin-embedder-policy",
    "cross-origin-opener-policy",
    "cross-origin-resource-policy",
    "permissions-policy",
  ];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = headers.get(name);
      return value === null ? [] : [[name, value]];
    }),
  );
}

function isSecureContextCandidate(url) {
  const parsed = new URL(url);
  return (
    parsed.protocol === "https:" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "::1" ||
    parsed.hostname.startsWith("127.")
  );
}

function countStatuses(resources) {
  const counts = { block: 0, error: 0, manual: 0, pass: 0 };
  for (const resource of resources) counts[resource.policy.status] += 1;
  return counts;
}

async function mapWithConcurrency(values, concurrency, operation) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

async function main() {
  const { output, urls } = parseArguments(process.argv.slice(2));
  if (urls.length === 0) {
    throw new Error("Usage: pnpm coop:check [--output audit.json] <business-url>...");
  }
  const pages = [];
  for (const url of urls) pages.push(await auditPage(url));
  const audit = {
    generatedAt: new Date().toISOString(),
    pages,
    status: pages.every((page) => page.status === "ready") ? "ready" : "not-ready",
    version: 1,
  };
  const serialized = `${JSON.stringify(audit, null, 2)}\n`;
  if (output === undefined) {
    process.stdout.write(serialized);
  } else {
    await writeFile(path.resolve(output), serialized, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`wrote ${output}\n`);
  }
  if (audit.status !== "ready") process.exitCode = 2;
}

function parseArguments(arguments_) {
  const urls = [];
  let output;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") {
      continue;
    } else if (argument === "--output") {
      output = arguments_[index + 1];
      if (output === undefined) throw new Error("--output requires a filename");
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      urls.push(new URL(argument).href);
    }
  }
  return { output, urls };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
