import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type * as PingoEngine from "@dopejs/pingo";

import type { Demo, DemoContext } from "../../../../docs/.vitepress/theme/playground/demo";
import { playgroundMessages } from "../../../../docs/.vitepress/theme/playground/messages";

type EngineModule = typeof PingoEngine;
type HostedRoot = Awaited<ReturnType<EngineModule["createHostedCanvasRoot"]>>;

interface PlaygroundProps {
  readonly lang: string;
}

export function Playground({ lang }: PlaygroundProps): ReactNode {
  const messages = useMemo(() => playgroundMessages(lang), [lang]);
  const host = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const root = useRef<HostedRoot | undefined>(undefined);
  const engine = useRef<EngineModule | undefined>(undefined);
  const cleanup = useRef<(() => void) | void>(undefined);
  const frames = useRef(0);
  const generation = useRef(0);
  const metricRows = useRef(new Map<string, string>());
  const lastPublish = useRef(0);

  const [catalog, setCatalog] = useState<readonly Demo[]>([]);
  const [active, setActive] = useState<Demo>();
  const [badges, setBadges] = useState<readonly [string, string][]>([]);
  const [metrics, setMetrics] = useState<readonly [string, string][]>([]);
  const [status, setStatus] = useState("");
  const [failure, setFailure] = useState("");

  const publish = useCallback((force = false): void => {
    const now = performance.now();
    if (!force && now - lastPublish.current < 100) return;
    lastPublish.current = now;
    setMetrics([...metricRows.current]);
  }, []);

  const teardown = useCallback(async (): Promise<void> => {
    if (typeof cleanup.current === "function") cleanup.current();
    cleanup.current = undefined;
    const previous = root.current;
    root.current = undefined;
    if (previous !== undefined) {
      try {
        await previous.close();
      } catch {
        // A failed teardown must not prevent a later demo from mounting.
      }
    }
  }, []);

  const mount = useCallback(
    async (demo: Demo): Promise<void> => {
      const container = host.current;
      const panel = controls.current;
      const engineModule = engine.current;
      if (container === null || panel === null || engineModule === undefined) return;

      const token = ++generation.current;
      setActive(demo);
      setFailure("");
      setStatus(messages.loading);
      metricRows.current.clear();
      publish(true);
      panel.replaceChildren();
      frames.current = 0;
      await teardown();
      if (token !== generation.current) return;

      const bounds = container.getBoundingClientRect();
      const width = Math.max(320, Math.floor(bounds.width));
      const height = Math.max(240, Math.floor(bounds.height));
      const canvas = document.createElement("canvas");
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.tabIndex = 0;
      container.replaceChildren(canvas);

      try {
        const search = new URLSearchParams(location.search);
        const created = await engineModule.createHostedCanvasRoot(canvas, {
          ...demo.rootOptions,
          ...(search.get("rasterCache") === "off" ? { rasterCache: false } : {}),
          ...(search.get("a11y") === "off" ? { accessibility: false } : {}),
          initializationTimeoutMs: 45_000,
          onFrame: (report) => {
            if (token !== generation.current) return;
            (globalThis as { __pingoFrame?: unknown }).__pingoFrame = report;
            const log = ((globalThis as { __pingoFrameLog?: number[][] }).__pingoFrameLog ??= []);
            log.push([
              performance.now(),
              report.core?.dirtyPaintNodes ?? 0,
              report.core?.layoutVisitedNodes ?? 0,
              report.commands,
              report.replayMs ?? 0,
              report.coreMs ?? 0,
            ]);
            if (log.length > 600) log.splice(0, log.length - 600);
            frames.current += 1;
            const rows = metricRows.current;
            rows.set(messages.frames, String(frames.current));
            rows.set(messages.commands, String(report.commands));
            rows.set(messages.displayList, `${String(report.displayListBytes)} B`);
            if (report.core !== undefined) {
              rows.set(messages.sceneNodes, String(report.core.sceneNodes));
              rows.set(messages.layoutVisited, String(report.core.layoutVisitedNodes));
              rows.set(messages.dirtyPaint, String(report.core.dirtyPaintNodes));
              rows.set(messages.placeholders, String(report.core.visiblePlaceholders));
              if (report.core.skippedInstructions !== 0) {
                rows.set(
                  messages.skippedInstructions,
                  `${String(report.core.skippedInstructions)} (abi v${String(report.core.producerAbiVersion)})`,
                );
              }
            }
            publish();
          },
          onClockMetrics: (clockMetrics) => {
            (globalThis as { __pingoClock?: unknown }).__pingoClock = clockMetrics;
          },
          onHostError: (error) => {
            if (token === generation.current) setFailure(`${error.name}: ${error.message}`);
          },
          onVirtualRefills: (requests) => {
            const log = ((globalThis as { __pingoRefills?: unknown[] }).__pingoRefills ??= []);
            for (const request of requests) {
              log.push({ at: performance.now(), start: request.start, end: request.end });
            }
            if (log.length > 200) log.splice(0, log.length - 200);
          },
        });
        if (token !== generation.current) {
          await created.close();
          return;
        }
        setStatus("");
        root.current = created;
        const context: DemoContext = {
          root: created,
          canvas,
          width,
          height,
          controls: panel,
          messages,
          setMetric: (label, value) => {
            if (token !== generation.current) return;
            metricRows.current.set(label, value);
            publish();
          },
        };
        created.render(demo.render(context));
        cleanup.current = demo.activate?.(context);
        const identity = engineModule.engineIdentity();
        setBadges([
          ["engine", `v${identity.version}`],
          ["abi", `v${String(identity.abiVersion)}`],
          ["transport", created.mode],
          ["isolated", String(globalThis.crossOriginIsolated ?? false)],
        ]);
      } catch (cause) {
        if (token !== generation.current) return;
        setStatus("");
        setFailure(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause));
      }
    },
    [messages, publish, teardown],
  );

  useEffect(() => {
    const resolveHash = (demos: readonly Demo[]): Demo | undefined =>
      demos.find((demo) => demo.id === location.hash.replace(/^#\/?/u, "")) ?? demos[0];
    const onHashChange = (): void => {
      const demo = resolveHash(catalog);
      if (demo !== undefined && demo.id !== active?.id) void mount(demo);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [active?.id, catalog, mount]);

  useEffect(() => {
    let cancelled = false;
    setStatus(messages.loading);
    void Promise.all([
      import("@dopejs/pingo"),
      import("../../../../docs/.vitepress/theme/playground/demos"),
    ])
      .then(async ([engineModule, demoModule]) => {
        if (cancelled) return;
        engine.current = engineModule;
        setCatalog(demoModule.demos);
        const selected =
          demoModule.demos.find((demo) => demo.id === location.hash.replace(/^#\/?/u, "")) ??
          demoModule.demos[0];
        if (selected !== undefined) await mount(selected);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setStatus("");
        setFailure(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause));
      });
    return () => {
      cancelled = true;
      generation.current += 1;
      void teardown();
    };
  }, [messages.loading, mount, teardown]);

  const select = (demo: Demo): void => {
    if (demo.id === active?.id && root.current !== undefined) return;
    history.replaceState(null, "", `${location.pathname}${location.search}#/${demo.id}`);
    void mount(demo);
  };

  return (
    <main className="pg">
      <nav className="pg__nav" aria-label="Demos">
        {catalog.map((demo) => (
          <button
            key={demo.id}
            type="button"
            className="pg__tab"
            aria-current={demo.id === active?.id ? "page" : undefined}
            onClick={() => select(demo)}
          >
            {demo.title(messages)}
          </button>
        ))}
      </nav>
      <header className="pg__header">
        <div>
          <h1>{active === undefined ? "Playground" : active.title(messages)}</h1>
          <p>{active?.description(messages) ?? ""}</p>
        </div>
        <div className="pg__badges">
          {badges.map(([label, value]) => (
            <span key={label} className="pg__badge">
              {label} <strong>{value}</strong>
            </span>
          ))}
        </div>
      </header>
      <section className="pg__stage">
        <div className="pg__canvas">
          <div ref={host} className="pg__surface" />
          {status !== "" && <p className="pg__status">{status}</p>}
          {failure !== "" && <p className="pg__error">{failure}</p>}
        </div>
        <aside className="pg__hud">
          <h2>Frame metrics</h2>
          <dl>
            {metrics.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <div ref={controls} className="pg__controls" />
        </aside>
      </section>
    </main>
  );
}
