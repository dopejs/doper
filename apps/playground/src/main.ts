import {
  createHostedCanvasRoot,
  engineIdentity,
  type FrameReport,
  type HostedCanvasRoot,
} from "@dopejs/doper";

import type { Demo, DemoContext } from "./demo";
import { demos } from "./demos";

const nav = requireElement("nav");
const host = requireElement("canvas-host");
const hud = requireElement("hud");
const controls = requireElement("demo-controls");
const badges = requireElement("badges");
const titleElement = requireElement("demo-title");
const descriptionElement = requireElement("demo-description");

let root: HostedCanvasRoot | undefined;
let cleanup: (() => void) | void;
let frames = 0;
const metrics = new Map<string, string>();

buildNavigation();
window.addEventListener("hashchange", () => void activate(currentDemo()));
window.addEventListener("resize", scheduleRelayout);
await activate(currentDemo());

function currentDemo(): Demo {
  const id = window.location.hash.replace(/^#\/?/u, "");
  return demos.find((demo) => demo.id === id) ?? demos[0]!;
}

function buildNavigation(): void {
  for (const demo of demos) {
    const link = document.createElement("a");
    link.href = `#/${demo.id}`;
    link.textContent = demo.title;
    link.dataset.demo = demo.id;
    nav.append(link);
  }
}

async function activate(demo: Demo): Promise<void> {
  for (const link of nav.querySelectorAll("a")) {
    if (link.dataset.demo === demo.id) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  titleElement.textContent = demo.title;
  descriptionElement.textContent = demo.description;
  controls.replaceChildren();
  metrics.clear();
  frames = 0;
  await teardown();

  const canvas = document.createElement("canvas");
  const bounds = host.getBoundingClientRect();
  const width = Math.max(320, Math.floor(bounds.width));
  const height = Math.max(240, Math.floor(bounds.height));
  // Backing store in device pixels; the engine treats scene units as CSS
  // pixels and applies the ratio when replaying, so no cap is needed.
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.tabIndex = 0;
  const loading = document.createElement("p");
  loading.className = "loading";
  loading.textContent = "正在加载引擎核心（约 1MB WASM）…";
  host.replaceChildren(canvas, loading);

  try {
    const created = await createHostedCanvasRoot(canvas, {
      ...demo.rootOptions,
      // A cold load over a slow CDN can exceed the default budget; without a
      // longer window the worker path is abandoned before the WASM arrives and
      // the demo silently drops to the main thread.
      initializationTimeoutMs: 45_000,
      onFrame: (report) => reportFrame(report),
      onHostError: (error) => showError(error),
    });
    loading.remove();
    root = created;
    const context: DemoContext = {
      root: created,
      canvas,
      width,
      height,
      controls,
      setMetric: (label, value) => {
        metrics.set(label, value);
        renderHud();
      },
    };
    created.render(demo.render(context));
    cleanup = demo.activate?.(context);
    renderBadges(created);
  } catch (cause) {
    loading.remove();
    showError(cause instanceof Error ? cause : new Error(String(cause)));
  }
}

async function teardown(): Promise<void> {
  if (typeof cleanup === "function") cleanup();
  cleanup = undefined;
  const previous = root;
  root = undefined;
  if (previous !== undefined) {
    try {
      await previous.close();
    } catch {
      // A failed teardown must never block the next demo from mounting.
    }
  }
}

let relayoutHandle: number | undefined;
function scheduleRelayout(): void {
  if (relayoutHandle !== undefined) clearTimeout(relayoutHandle);
  relayoutHandle = window.setTimeout(() => void activate(currentDemo()), 200);
}

function reportFrame(report: FrameReport): void {
  frames += 1;
  metrics.set("帧数", String(frames));
  metrics.set("命令数", String(report.commands));
  metrics.set("DisplayList", `${String(report.displayListBytes)} B`);
  if (report.core !== undefined) {
    metrics.set("Scene 节点", String(report.core.sceneNodes));
    metrics.set("布局访问", String(report.core.layoutVisitedNodes));
    metrics.set("脏绘制", String(report.core.dirtyPaintNodes));
  }
  renderHud();
}

function renderHud(): void {
  hud.replaceChildren();
  for (const [label, value] of metrics) {
    const term = document.createElement("dt");
    term.textContent = label;
    const definition = document.createElement("dd");
    definition.textContent = value;
    hud.append(term, definition);
  }
}

function renderBadges(created: HostedCanvasRoot): void {
  const identity = engineIdentity();
  const entries: Array<[string, string]> = [
    ["engine", `v${identity.version}`],
    ["abi", `v${String(identity.abiVersion)}`],
    ["transport", created.mode],
    ["isolated", String(globalThis.crossOriginIsolated ?? false)],
  ];
  badges.replaceChildren();
  for (const [label, value] of entries) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.append(`${label} `);
    const strong = document.createElement("strong");
    strong.textContent = value;
    badge.append(strong);
    badges.append(badge);
  }
}

function showError(error: Error): void {
  const box = document.createElement("p");
  box.className = "error";
  box.textContent = `${error.name}: ${error.message}`;
  host.append(box);
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing #${id}`);
  return element;
}
