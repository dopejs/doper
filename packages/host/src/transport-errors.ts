/** Recoverable capacity exhaustion; HostedRoot preserves the Scene and changes transport. */
export class MutationTransportBackpressureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MutationTransportBackpressureError";
  }
}
