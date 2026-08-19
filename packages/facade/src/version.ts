import { ABI_VERSION } from "@dopejs/pingo-host";

/** Engine release version for incident reports and rollout dashboards. */
export const ENGINE_VERSION = "0.1.0";

/** Binary protocol version negotiated across the Shell/Core boundary. */
export const ENGINE_ABI_VERSION: number = ABI_VERSION;

/** Structured identity attached to error reports and qualification evidence. */
export function engineIdentity(): { readonly version: string; readonly abiVersion: number } {
  return { version: ENGINE_VERSION, abiVersion: ENGINE_ABI_VERSION };
}
