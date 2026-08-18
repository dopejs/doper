<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { useData } from "vitepress";

import type { Demo, DemoContext } from "./demo";
import { playgroundMessages } from "./messages";

type EngineModule = typeof import("@dopejs/doper");
type HostedRoot = Awaited<ReturnType<EngineModule["createHostedCanvasRoot"]>>;

const { lang } = useData();
const messages = computed(() => playgroundMessages(lang.value));

const host = ref<HTMLElement>();
const controls = ref<HTMLElement>();
const catalog = shallowRef<readonly Demo[]>([]);
const active = shallowRef<Demo>();
const badges = ref<Array<[string, string]>>([]);
const metrics = ref<Array<[string, string]>>([]);
const status = ref("");
const failure = ref("");

const root = shallowRef<HostedRoot>();
let engine: EngineModule | undefined;
let cleanup: (() => void) | void;
let frames = 0;
let generation = 0;
const metricRows = new Map<string, string>();

let lastPublish = 0;

function publish(force = false): void {
  // The HUD is diagnostics, not content. Rebuilding this array and re-rendering
  // it on every engine frame put Vue work on the main thread in direct
  // competition with the refill microtask that materializes rows.
  const now = performance.now();
  if (!force && now - lastPublish < 100) return;
  lastPublish = now;
  metrics.value = [...metricRows];
}

async function teardown(): Promise<void> {
  if (typeof cleanup === "function") cleanup();
  cleanup = undefined;
  const previous = root.value;
  root.value = undefined;
  if (previous !== undefined) {
    try {
      await previous.close();
    } catch {
      // A failed teardown must never block the next demo from mounting.
    }
  }
}

async function mount(demo: Demo): Promise<void> {
  const container = host.value;
  const panel = controls.value;
  if (container === undefined || panel === undefined || engine === undefined) return;

  // Demo switches and hash changes can overlap with an in-flight mount; only
  // the newest one is allowed to install a root or write the HUD.
  const token = ++generation;
  active.value = demo;
  failure.value = "";
  status.value = messages.value.loading;
  metricRows.clear();
  publish();
  panel.replaceChildren();
  frames = 0;
  await teardown();
  if (token !== generation) return;

  const bounds = container.getBoundingClientRect();
  const width = Math.max(320, Math.floor(bounds.width));
  const height = Math.max(240, Math.floor(bounds.height));
  const canvas = document.createElement("canvas");
  // Backing store in device pixels; the engine treats scene units as CSS
  // pixels and applies the ratio when replaying.
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.tabIndex = 0;
  container.replaceChildren(canvas);

  try {
    const created = await engine.createHostedCanvasRoot(canvas, {
      ...demo.rootOptions,
      // A cold load over a slow CDN can exceed the default budget and would
      // otherwise abandon the worker path before the WASM arrives.
      initializationTimeoutMs: 45_000,
      onFrame: (report) => {
        if (token !== generation) return;
        // Devtools affordance: the HUD is throttled, so expose the unthrottled
        // report for inspection and measurement from the console.
        (globalThis as { __doperFrame?: unknown }).__doperFrame = report;
        frames += 1;
        const text = messages.value;
        metricRows.set(text.frames, String(frames));
        metricRows.set(text.commands, String(report.commands));
        metricRows.set(text.displayList, `${String(report.displayListBytes)} B`);
        if (report.core !== undefined) {
          metricRows.set(text.sceneNodes, String(report.core.sceneNodes));
          metricRows.set(text.layoutVisited, String(report.core.layoutVisitedNodes));
          metricRows.set(text.dirtyPaint, String(report.core.dirtyPaintNodes));
          // Visible items still drawn as skeletons. Anything other than a brief
          // blip here means the viewport is showing placeholders, not content.
          metricRows.set(text.placeholders, String(report.core.visiblePlaceholders));
        }
        publish();
      },
      onHostError: (error) => {
        if (token === generation) failure.value = `${error.name}: ${error.message}`;
      },
      onVirtualRefills: (requests) => {
        // Devtools affordance: when Core asked for a window, so the round trip
        // to a materialized window can be measured from the console.
        const log = ((globalThis as { __doperRefills?: unknown[] }).__doperRefills ??= []);
        for (const request of requests) {
          log.push({ at: performance.now(), start: request.start, end: request.end });
        }
        if (log.length > 200) log.splice(0, log.length - 200);
      },
    });
    if (token !== generation) {
      await created.close();
      return;
    }
    status.value = "";
    root.value = created;
    const context: DemoContext = {
      root: created,
      canvas,
      width,
      height,
      controls: panel,
      messages: messages.value,
      setMetric: (label, value) => {
        if (token !== generation) return;
        metricRows.set(label, value);
        publish();
      },
    };
    created.render(demo.render(context));
    cleanup = demo.activate?.(context);
    const identity = engine.engineIdentity();
    badges.value = [
      ["engine", `v${identity.version}`],
      ["abi", `v${String(identity.abiVersion)}`],
      ["transport", created.mode],
      ["isolated", String(globalThis.crossOriginIsolated ?? false)],
    ];
  } catch (cause) {
    if (token !== generation) return;
    status.value = "";
    failure.value = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  }
}

function resolve(id: string): Demo | undefined {
  return catalog.value.find((demo) => demo.id === id);
}

function select(demo: Demo): void {
  if (demo.id === active.value?.id && root.value !== undefined) return;
  // Docs link to demos as `/playground#/<id>`; keep the address bar in that form.
  history.replaceState(null, "", `${location.pathname}${location.search}#/${demo.id}`);
  void mount(demo);
}

function fromHash(): Demo | undefined {
  return resolve(location.hash.replace(/^#\/?/u, "")) ?? catalog.value[0];
}

function onHashChange(): void {
  const demo = fromHash();
  if (demo !== undefined && demo.id !== active.value?.id) void mount(demo);
}

onMounted(() => {
  window.addEventListener("hashchange", onHashChange);
  status.value = messages.value.loading;
  void (async () => {
    try {
      // Loaded lazily so the static site build never evaluates browser-only
      // engine code during server-side rendering.
      const [engineModule, demoModule] = await Promise.all([
        import("@dopejs/doper"),
        import("./demos"),
      ]);
      engine = engineModule;
      catalog.value = demoModule.demos;
      const demo = fromHash();
      if (demo !== undefined) await mount(demo);
    } catch (cause) {
      status.value = "";
      failure.value = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    }
  })();
});

onBeforeUnmount(() => {
  generation += 1;
  window.removeEventListener("hashchange", onHashChange);
  void teardown();
});
</script>

<template>
  <div class="pg">
    <nav class="pg__nav" aria-label="Demos">
      <button
        v-for="demo in catalog"
        :key="demo.id"
        type="button"
        class="pg__tab"
        :aria-current="demo.id === active?.id ? 'page' : undefined"
        @click="select(demo)"
      >
        {{ demo.title(messages) }}
      </button>
    </nav>

    <header class="pg__header">
      <div>
        <h2>{{ active === undefined ? "Playground" : active.title(messages) }}</h2>
        <p>{{ active === undefined ? "" : active.description(messages) }}</p>
      </div>
      <div class="pg__badges">
        <span v-for="[label, value] in badges" :key="label" class="pg__badge">
          {{ label }} <strong>{{ value }}</strong>
        </span>
      </div>
    </header>

    <section class="pg__stage">
      <div class="pg__canvas">
        <!-- The canvas host is mutated imperatively, so it must never also be a
             Vue render target; the overlays are siblings, not children. -->
        <div ref="host" class="pg__surface" />
        <p v-if="status !== ''" class="pg__status">{{ status }}</p>
        <p v-if="failure !== ''" class="pg__error">{{ failure }}</p>
      </div>
      <aside class="pg__hud">
        <h3>Frame metrics</h3>
        <dl>
          <template v-for="[label, value] in metrics" :key="label">
            <dt>{{ label }}</dt>
            <dd>{{ value }}</dd>
          </template>
        </dl>
        <div ref="controls" class="pg__controls" />
      </aside>
    </section>
  </div>
</template>

<style scoped>
.pg {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px 32px 32px;
  max-width: 1280px;
  margin: 0 auto;
}

.pg__nav {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  border-bottom: 1px solid var(--vp-c-divider);
  padding-bottom: 12px;
  min-height: 45px;
}

.pg__tab {
  padding: 6px 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--vp-c-text-2);
  font-size: 14px;
  cursor: pointer;
}

.pg__tab:hover {
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-1);
}

.pg__tab[aria-current="page"] {
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}

.pg__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
}

.pg__header h2 {
  margin: 0 0 4px;
  padding: 0;
  border: 0;
  font-size: 18px;
  font-weight: 600;
}

.pg__header p {
  margin: 0;
  max-width: 68ch;
  color: var(--vp-c-text-2);
  font-size: 14px;
  line-height: 1.6;
}

.pg__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}

.pg__badge {
  padding: 3px 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  font-size: 11px;
  color: var(--vp-c-text-2);
  white-space: nowrap;
}

.pg__badge strong {
  color: var(--vp-c-brand-1);
}

.pg__stage {
  display: grid;
  grid-template-columns: 1fr 260px;
  gap: 20px;
  min-height: 0;
}

.pg__canvas {
  position: relative;
  height: 62vh;
  min-height: 380px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: #fff;
  overflow: hidden;
}

.pg__surface {
  position: absolute;
  inset: 0;
}

.pg__surface :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
  outline: none;
}

.pg__status,
.pg__error {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  padding: 16px;
  text-align: center;
  font-size: 13px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
}

.pg__error {
  background: var(--vp-c-danger-soft);
  color: var(--vp-c-danger-1);
  font-family: var(--vp-font-family-mono);
}

.pg__hud {
  align-self: start;
  padding: 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
}

.pg__hud h3 {
  margin: 0 0 10px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--vp-c-text-3);
}

.pg__hud dl {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px 12px;
  margin: 0;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.pg__hud dt {
  color: var(--vp-c-text-2);
}

.pg__hud dd {
  margin: 0;
  text-align: right;
}

.pg__controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
  font-size: 12px;
  color: var(--vp-c-text-2);
}

.pg__controls:empty {
  display: none;
}

.pg__controls :deep(button) {
  padding: 6px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.pg__controls :deep(button:hover) {
  border-color: var(--vp-c-brand-1);
}

@media (max-width: 900px) {
  .pg {
    padding: 16px;
  }

  .pg__stage {
    grid-template-columns: 1fr;
  }
}
</style>
