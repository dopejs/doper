import {
  createHostedCanvasRoot,
  type PingoNode,
  type HostedCanvasRoot,
  type PingoStyleSheet,
} from "@dopejs/pingo";

/**
 * Mounts one pingo scene on its own canvas for a story.
 *
 * pingo renders to canvas rather than DOM, so each story returns a host
 * element and drives an engine root inside it. Roots are closed when the
 * element leaves the document so switching stories never leaks a Worker.
 */
export function mountStory(
  render: () => PingoNode,
  options: { width?: number; height?: number; styleSheets?: readonly PingoStyleSheet[] } = {},
): HTMLElement {
  const width = options.width ?? 480;
  const height = options.height ?? 220;
  const host = document.createElement("div");
  host.style.cssText = `width:${String(width)}px;height:${String(height)}px;border:1px solid #e3e6ea;border-radius:8px;overflow:hidden;background:#fff`;

  const canvas = document.createElement("canvas");
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  canvas.style.cssText = "display:block;width:100%;height:100%;outline:none";
  canvas.tabIndex = 0;
  host.append(canvas);

  // Fast starts stay visually quiet. If startup is actually slow, show a
  // compact status instead of covering the canvas with a loading surface.
  host.style.position = "relative";
  host.setAttribute("aria-busy", "true");
  let loading: HTMLSpanElement | undefined;
  const loadingTimer = window.setTimeout(() => {
    loading = document.createElement("span");
    loading.style.cssText =
      "position:absolute;right:8px;top:8px;padding:3px 6px;border-radius:999px;background:#f4f6f8;color:#6f7b8d;font-size:11px;line-height:1.4;pointer-events:none";
    loading.textContent = "加载中…";
    host.append(loading);
  }, 200);

  const finishLoading = (): void => {
    window.clearTimeout(loadingTimer);
    loading?.remove();
    host.removeAttribute("aria-busy");
  };

  let root: HostedCanvasRoot | undefined;
  let disposed = false;
  void createHostedCanvasRoot(canvas, {
    // A cold load over a slow CDN can exceed the default budget and abandon
    // the worker path before the WASM arrives.
    initializationTimeoutMs: 45_000,
    ...(options.styleSheets === undefined ? {} : { styleSheets: options.styleSheets }),
    onHostError: (error) => {
      const box = document.createElement("pre");
      box.style.cssText = "margin:0;padding:8px;color:#b3261e;font-size:12px";
      box.textContent = `${error.name}: ${error.message}`;
      host.append(box);
    },
  })
    .then((created) => {
      finishLoading();
      if (disposed) return created.close();
      root = created;
      created.render(render());
      return undefined;
    })
    .catch((cause: unknown) => {
      finishLoading();
      const box = document.createElement("pre");
      box.style.cssText = "margin:0;padding:8px;color:#b3261e;font-size:12px";
      box.textContent = String(cause);
      host.append(box);
    });

  const observer = new MutationObserver(() => {
    if (host.isConnected) return;
    disposed = true;
    finishLoading();
    observer.disconnect();
    void root?.close();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return host;
}
