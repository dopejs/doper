import { useEffect, useRef, useState, type ReactNode } from "react";

interface AppFrameProps {
  readonly src: string;
  readonly title: string;
  readonly forwardHash?: boolean;
}

export function AppFrame({ src, title, forwardHash = false }: AppFrameProps): ReactNode {
  const frame = useRef<HTMLIFrameElement>(null);
  const [initialSource] = useState(() =>
    typeof location !== "undefined" && forwardHash && location.hash !== ""
      ? `${src}${location.hash}`
      : src,
  );

  useEffect(() => {
    let syncing = false;
    const adoptFrameHash = (): void => {
      const window_ = frame.current?.contentWindow;
      if (window_ === null || window_ === undefined || syncing) return;
      try {
        const hash = window_.location.hash;
        if (hash === "" || hash === location.hash) return;
        syncing = true;
        history.replaceState(null, "", `${location.pathname}${hash}`);
      } catch {
        return;
      } finally {
        syncing = false;
      }
    };
    const pushHashToFrame = (): void => {
      const window_ = frame.current?.contentWindow;
      if (window_ === null || window_ === undefined || syncing) return;
      try {
        if (window_.location.hash !== location.hash) window_.location.hash = location.hash;
      } catch {
        // Cross-origin frames cannot be synchronized.
      }
    };
    const onLoad = (): void => {
      frame.current?.contentWindow?.addEventListener("hashchange", adoptFrameHash);
      adoptFrameHash();
    };
    const element = frame.current;
    element?.addEventListener("load", onLoad);
    window.addEventListener("hashchange", pushHashToFrame);
    return () => {
      element?.removeEventListener("load", onLoad);
      element?.contentWindow?.removeEventListener("hashchange", adoptFrameHash);
      window.removeEventListener("hashchange", pushHashToFrame);
    };
  }, []);

  return (
    <main className="app-frame">
      <iframe ref={frame} src={initialSource} title={title} />
    </main>
  );
}
