import {
  createHostedCanvasRoot,
  type DoperNode,
  type HostedCanvasRoot,
  type HostedCanvasRootOptions,
} from "@dopejs/pingo";

/** Why an active page left the doper rendering path. */
export type CompatFallbackReason =
  | { readonly kind: "disabled" }
  | { readonly kind: "initialization-failed"; readonly error: Error }
  | { readonly kind: "runtime-error"; readonly error: Error }
  | { readonly kind: "manual"; readonly detail?: string };

/** The page-granular legacy rendering path doper migrates away from. */
export interface LegacyRenderer {
  /** Re-takes ownership of the container after a fallback or while disabled. */
  mount(container: HTMLElement): void;
  /** Releases the container before doper takes over. */
  unmount(container: HTMLElement): void;
}

/** Injectable root factory; production uses the public facade entry point. */
export type CompatRootFactory = (
  canvas: HTMLCanvasElement,
  options: HostedCanvasRootOptions,
) => Promise<HostedCanvasRoot>;

export interface CompatPageOptions {
  /** Stable page identity used in reports and rollout decisions. */
  readonly pageId: string;
  readonly container: HTMLElement;
  /** Produces the doper content for this page. */
  readonly render: () => DoperNode;
  /** Legacy path that must stay mountable for page-granular rollback. */
  readonly legacy: LegacyRenderer;
  /** Rollout switch; false keeps the legacy renderer active. */
  readonly enabled?: boolean;
  /** Consecutive host errors tolerated before an automatic fallback. */
  readonly maxRuntimeErrors?: number;
  readonly onFallback?: (reason: CompatFallbackReason) => void;
  /** Extra root options; transport/observability stay overridable. */
  readonly rootOptions?: Omit<HostedCanvasRootOptions, "onHostError">;
  /** Test seam; defaults to createHostedCanvasRoot from the facade. */
  readonly rootFactory?: CompatRootFactory;
  readonly canvasWidth?: number;
  readonly canvasHeight?: number;
}

/** One migrated page whose rendering path can be flipped at runtime. */
export interface CompatPage {
  readonly pageId: string;
  readonly active: "doper" | "legacy";
  /** Switches to doper; resolves to the path that ended up active. */
  enable(): Promise<"doper" | "legacy">;
  /** Switches back to the legacy renderer immediately. */
  fallback(detail?: string): void;
  close(): Promise<void>;
}

/**
 * Mounts a migration boundary that renders through doper when enabled and
 * falls back to the legacy renderer on initialization or repeated runtime
 * failures. The shim depends only on the public facade; removing it never
 * requires Core changes.
 */
export async function mountCompatPage(options: CompatPageOptions): Promise<CompatPage> {
  const page = new CompatPageController(options);
  if (options.enabled === false) {
    page.mountLegacy({ kind: "disabled" });
  } else {
    await page.enable();
  }
  return page;
}

class CompatPageController implements CompatPage {
  readonly #options: CompatPageOptions;
  #active: "doper" | "legacy" = "legacy";
  #canvas: HTMLCanvasElement | undefined;
  #closed = false;
  #legacyMounted = false;
  #root: HostedCanvasRoot | undefined;
  #runtimeErrors = 0;
  #switching = false;

  public constructor(options: CompatPageOptions) {
    if (options.pageId.length === 0) throw new TypeError("pageId must be non-empty");
    this.#options = options;
  }

  public get pageId(): string {
    return this.#options.pageId;
  }

  public get active(): "doper" | "legacy" {
    return this.#active;
  }

  public async enable(): Promise<"doper" | "legacy"> {
    if (this.#closed) throw new Error("compat page is closed");
    if (this.#active === "doper" || this.#switching) return this.#active;
    this.#switching = true;
    try {
      const document = this.#options.container.ownerDocument;
      const canvas = document.createElement("canvas");
      canvas.width = this.#options.canvasWidth ?? Math.max(1, this.#options.container.clientWidth);
      canvas.height =
        this.#options.canvasHeight ?? Math.max(1, this.#options.container.clientHeight);
      const factory = this.#options.rootFactory ?? createHostedCanvasRoot;
      const root = await factory(canvas, {
        ...this.#options.rootOptions,
        onHostError: (error) => this.handleRuntimeError(error),
      });
      root.render(this.#options.render());
      this.unmountLegacy();
      this.#options.container.append(canvas);
      this.#canvas = canvas;
      this.#root = root;
      this.#runtimeErrors = 0;
      this.#active = "doper";
    } catch (cause) {
      this.mountLegacy({
        kind: "initialization-failed",
        error: cause instanceof Error ? cause : new Error(String(cause)),
      });
    } finally {
      this.#switching = false;
    }
    return this.#active;
  }

  public fallback(detail?: string): void {
    if (this.#closed || this.#active === "legacy") return;
    this.mountLegacy(detail === undefined ? { kind: "manual" } : { kind: "manual", detail });
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.teardownDoper();
    if (this.#legacyMounted) {
      this.#options.legacy.unmount(this.#options.container);
      this.#legacyMounted = false;
    }
  }

  /** Mounts the legacy path and reports why doper is not active. */
  public mountLegacy(reason: CompatFallbackReason): void {
    void this.teardownDoper();
    if (!this.#legacyMounted) {
      this.#options.legacy.mount(this.#options.container);
      this.#legacyMounted = true;
    }
    this.#active = "legacy";
    this.#options.onFallback?.(reason);
  }

  private handleRuntimeError(error: Error): void {
    if (this.#active !== "doper") return;
    this.#runtimeErrors += 1;
    if (this.#runtimeErrors >= (this.#options.maxRuntimeErrors ?? 3)) {
      this.mountLegacy({ kind: "runtime-error", error });
    }
  }

  private unmountLegacy(): void {
    if (this.#legacyMounted) {
      this.#options.legacy.unmount(this.#options.container);
      this.#legacyMounted = false;
    }
  }

  private async teardownDoper(): Promise<void> {
    const root = this.#root;
    const canvas = this.#canvas;
    this.#root = undefined;
    this.#canvas = undefined;
    if (canvas !== undefined) canvas.remove();
    if (root !== undefined) {
      try {
        await root.close();
      } catch {
        // A failing close must never block the legacy path from mounting.
      }
    }
  }
}
