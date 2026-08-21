/** Structural copy of the Host semantic node; kept dependency-free. */
export interface SemanticMirrorNode {
  readonly bounds: {
    readonly height: number;
    readonly left: number;
    readonly top: number;
    readonly width: number;
  };
  readonly focusable: boolean;
  readonly focused: boolean;
  readonly label: string;
  readonly nodeId: number;
  readonly password: boolean;
  readonly role: string;
  readonly value: string;
}

export interface SemanticTreeMirrorOptions {
  /** Called when the user focuses a mirrored focusable element. */
  readonly onFocusRequest?: (nodeId: number) => void;
  /** Native Enter/Space activation for focusable button semantics. */
  readonly onActivateRequest?: (nodeId: number) => void;
}

/**
 * Absolute-positioned DOM shadow tree kept beside the canvas for screen
 * readers and semantic E2E selectors. Elements are visually transparent but
 * present in the accessibility tree and focus order.
 */
export class SemanticTreeMirror {
  readonly #container: HTMLElement;
  readonly #elements = new Map<number, HTMLElement>();
  readonly #options: SemanticTreeMirrorOptions;
  #disposed = false;

  public constructor(canvas: HTMLElement, options: SemanticTreeMirrorOptions = {}) {
    this.#options = options;
    const document = canvas.ownerDocument;
    this.#container = document.createElement("div");
    this.#container.setAttribute("data-pingo-semantics", "");
    Object.assign(this.#container.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: "0",
      height: "0",
      overflow: "visible",
      pointerEvents: "none",
    });
    canvas.insertAdjacentElement("afterend", this.#container);
  }

  public get container(): HTMLElement {
    return this.#container;
  }

  /** Applies one full semantic snapshot with per-node incremental DOM updates. */
  public update(nodes: readonly SemanticMirrorNode[]): void {
    if (this.#disposed) return;
    const seen = new Set<number>();
    for (const node of nodes) {
      seen.add(node.nodeId);
      let element = this.#elements.get(node.nodeId);
      if (element === undefined) {
        element = this.#container.ownerDocument.createElement("div");
        element.setAttribute("data-pingo-node", String(node.nodeId));
        Object.assign(element.style, {
          position: "absolute",
          color: "transparent",
          background: "transparent",
          overflow: "hidden",
        });
        element.addEventListener("focus", () => {
          const raw = element?.getAttribute("data-pingo-node");
          if (raw !== null && raw !== undefined) {
            this.#options.onFocusRequest?.(Number(raw));
          }
        });
        element.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          if (element?.getAttribute("role") !== "button") return;
          event.preventDefault();
          if (event.key === "Enter") this.activate(element);
        });
        element.addEventListener("keyup", (event) => {
          if (event.key !== " " || element?.getAttribute("role") !== "button") return;
          event.preventDefault();
          this.activate(element);
        });
        this.#container.append(element);
        this.#elements.set(node.nodeId, element);
      }
      element.style.left = `${String(node.bounds.left)}px`;
      element.style.top = `${String(node.bounds.top)}px`;
      element.style.width = `${String(node.bounds.width)}px`;
      element.style.height = `${String(node.bounds.height)}px`;
      if (node.role === "") element.removeAttribute("role");
      else element.setAttribute("role", node.role);
      if (node.label === "") element.removeAttribute("aria-label");
      else element.setAttribute("aria-label", node.label);
      const value = node.password ? "" : node.value;
      if (element.textContent !== value) element.textContent = value;
      if (node.password) element.setAttribute("aria-invalid", "false");
      const disabled = node.role === "button" && value === "disabled";
      if (disabled) element.setAttribute("aria-disabled", "true");
      else element.removeAttribute("aria-disabled");
      element.tabIndex = node.focusable && !disabled ? 0 : -1;
      if (node.focusable && !disabled) {
        element.style.pointerEvents = "none";
      }
    }
    for (const [nodeId, element] of this.#elements) {
      if (!seen.has(nodeId)) {
        element.remove();
        this.#elements.delete(nodeId);
      }
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#container.remove();
    this.#elements.clear();
  }

  private activate(element: HTMLElement): void {
    const raw = element.getAttribute("data-pingo-node");
    if (raw !== null) this.#options.onActivateRequest?.(Number(raw));
  }
}

/** Semantic E2E selector: finds mirrored elements by role and optional name. */
export function queryAllByRole(
  root: ParentNode,
  role: string,
  options: { readonly name?: string } = {},
): HTMLElement[] {
  const matches: HTMLElement[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(`[data-pingo-node][role]`)) {
    if (element.getAttribute("role") !== role) continue;
    if (options.name !== undefined && element.getAttribute("aria-label") !== options.name) continue;
    matches.push(element);
  }
  return matches;
}

/** Semantic E2E selector returning exactly one match or throwing. */
export function getByRole(
  root: ParentNode,
  role: string,
  options: { readonly name?: string } = {},
): HTMLElement {
  const matches = queryAllByRole(root, role, options);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one "${role}" element${
        options.name === undefined ? "" : ` named "${options.name}"`
      }, found ${String(matches.length)}`,
    );
  }
  const [match] = matches;
  if (match === undefined) throw new Error("unreachable: single match missing");
  return match;
}
