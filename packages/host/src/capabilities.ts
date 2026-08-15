/** Rendering transports supported by the production Host. */
export type HostTransportMode = "sab" | "post-message" | "main-thread";

/** Public transport preference. Unsupported Worker preferences degrade unless strict is set. */
export type HostTransportPreference = "auto" | HostTransportMode;

/** Browser capabilities that can be established before starting a render Worker. */
export interface HostCapabilities {
  readonly crossOriginIsolated: boolean;
  readonly offscreenCanvas: boolean;
  readonly sharedArrayBuffer: boolean;
  readonly transferableCanvas: boolean;
  readonly worker: boolean;
}

/** Reversible policy layers; any disabled Worker layer forces the M1 path. */
export interface HostTransportPolicy {
  readonly deviceWorkerEnabled?: boolean;
  readonly globalWorkerEnabled?: boolean;
  readonly pageWorkerEnabled?: boolean;
  readonly preference?: HostTransportPreference;
  readonly strict?: boolean;
}

/** Auditable mode decision used by diagnostics and recovery. */
export interface HostTransportDecision {
  readonly capabilities: HostCapabilities;
  readonly mode: HostTransportMode;
  readonly reasons: readonly string[];
  readonly requested: HostTransportPreference;
}

export interface CapabilityEnvironment {
  readonly crossOriginIsolated?: boolean;
  readonly OffscreenCanvas?: unknown;
  readonly SharedArrayBuffer?: unknown;
  readonly Worker?: unknown;
}

export interface TransferableCanvasCandidate {
  readonly transferControlToOffscreen?: unknown;
}

/** Takes a stable snapshot instead of reading mutable globals during selection. */
export function detectHostCapabilities(
  canvas: TransferableCanvasCandidate,
  environment: CapabilityEnvironment = globalThis,
): HostCapabilities {
  return {
    crossOriginIsolated: environment.crossOriginIsolated === true,
    offscreenCanvas: typeof environment.OffscreenCanvas === "function",
    sharedArrayBuffer: typeof environment.SharedArrayBuffer === "function",
    transferableCanvas: typeof canvas.transferControlToOffscreen === "function",
    worker: typeof environment.Worker === "function",
  };
}

/** Applies the ADR-0001 SAB → postMessage → main-thread fallback chain. */
export function selectHostTransport(
  capabilities: HostCapabilities,
  policy: HostTransportPolicy = {},
): HostTransportDecision {
  const requested = policy.preference ?? "auto";
  const reasons: string[] = [];
  const workerEnabled =
    policy.globalWorkerEnabled !== false &&
    policy.deviceWorkerEnabled !== false &&
    policy.pageWorkerEnabled !== false;
  const workerCapable =
    capabilities.worker && capabilities.offscreenCanvas && capabilities.transferableCanvas;

  if (requested === "main-thread") {
    return decision(capabilities, requested, "main-thread", ["main-thread explicitly requested"]);
  }
  if (!workerEnabled) {
    return decision(capabilities, requested, "main-thread", ["Worker disabled by policy"]);
  }
  if (!workerCapable) {
    if (!capabilities.worker) reasons.push("Worker unavailable");
    if (!capabilities.offscreenCanvas) reasons.push("OffscreenCanvas unavailable");
    if (!capabilities.transferableCanvas) reasons.push("canvas is not transferable");
    return unavailable(capabilities, policy, requested, "main-thread", reasons);
  }

  const sabCapable = capabilities.crossOriginIsolated && capabilities.sharedArrayBuffer;
  if (requested === "post-message") {
    return decision(capabilities, requested, "post-message", ["postMessage explicitly requested"]);
  }
  if (requested === "sab" && !sabCapable) {
    if (!capabilities.crossOriginIsolated) reasons.push("cross-origin isolation unavailable");
    if (!capabilities.sharedArrayBuffer) reasons.push("SharedArrayBuffer unavailable");
    return unavailable(capabilities, policy, requested, "post-message", reasons);
  }
  if (sabCapable) {
    return decision(capabilities, requested, "sab", ["SAB Worker path available"]);
  }

  if (!capabilities.crossOriginIsolated) reasons.push("cross-origin isolation unavailable");
  if (!capabilities.sharedArrayBuffer) reasons.push("SharedArrayBuffer unavailable");
  reasons.push("using bounded postMessage fallback");
  return decision(capabilities, requested, "post-message", reasons);
}

function unavailable(
  capabilities: HostCapabilities,
  policy: HostTransportPolicy,
  requested: HostTransportPreference,
  fallback: HostTransportMode,
  reasons: string[],
): HostTransportDecision {
  if (policy.strict === true) {
    throw new Error(`${requested} transport is unavailable: ${reasons.join(", ")}`);
  }
  reasons.push(`falling back to ${fallback}`);
  return decision(capabilities, requested, fallback, reasons);
}

function decision(
  capabilities: HostCapabilities,
  requested: HostTransportPreference,
  mode: HostTransportMode,
  reasons: readonly string[],
): HostTransportDecision {
  return { capabilities, mode, reasons: [...reasons], requested };
}
