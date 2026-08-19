import type { DoperNode, HostedCanvasRoot, HostedCanvasRootOptions } from "@dopejs/pingo";

import type { PlaygroundMessages } from "./messages";

/** Live surface a demo may use after its root is mounted. */
export interface DemoContext {
  readonly root: HostedCanvasRoot;
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  /** Renders control widgets into the HUD panel. */
  readonly controls: HTMLElement;
  /** Strings for the active site locale. */
  readonly messages: PlaygroundMessages;
  /** Publishes a demo-specific metric row into the HUD. */
  setMetric(label: string, value: string): void;
}

export interface Demo {
  readonly id: string;
  /** Localized name shown in the demo tabs and the page header. */
  title(messages: PlaygroundMessages): string;
  /** Localized summary shown under the title. */
  description(messages: PlaygroundMessages): string;
  /** Extra root options; the shell always supplies observability callbacks. */
  readonly rootOptions?: Omit<HostedCanvasRootOptions, "onFrame" | "onHostError">;
  /** Builds the scene for the current viewport. */
  render(context: DemoContext): DoperNode;
  /** Runs after the first render; returns a cleanup function when needed. */
  activate?(context: DemoContext): (() => void) | void;
}
