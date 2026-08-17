import { createHostedCanvasRoot, type DoperNode, type HostedCanvasRoot } from "@dopejs/doper";

/**
 * Mounts one doper scene on its own canvas for a story.
 *
 * doper renders to canvas rather than DOM, so each story returns a host
 * element and drives an engine root inside it. Roots are closed when the
 * element leaves the document so switching stories never leaks a Worker.
 */
export function mountStory(
  render: () => DoperNode,
  options: { width?: number; height?: number } = {},
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

  let root: HostedCanvasRoot | undefined;
  let disposed = false;
  void createHostedCanvasRoot(canvas, {
    onHostError: (error) => {
      const box = document.createElement("pre");
      box.style.cssText = "margin:0;padding:8px;color:#b3261e;font-size:12px";
      box.textContent = `${error.name}: ${error.message}`;
      host.append(box);
    },
  })
    .then((created) => {
      if (disposed) return created.close();
      root = created;
      created.render(render());
      return undefined;
    })
    .catch((cause: unknown) => {
      const box = document.createElement("pre");
      box.style.cssText = "margin:0;padding:8px;color:#b3261e;font-size:12px";
      box.textContent = String(cause);
      host.append(box);
    });

  const observer = new MutationObserver(() => {
    if (host.isConnected) return;
    disposed = true;
    observer.disconnect();
    void root?.close();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return host;
}
