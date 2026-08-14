import type { ClockAnchorMessage, WorkerMethod, WorkerRequest, WorkerResponse } from "./protocol";

interface PendingRequest {
  readonly reject: (reason: Error) => void;
  readonly resolve: (result: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export class ProbeWorkerClient {
  readonly #pending = new Map<number, PendingRequest>();
  readonly #worker: Worker;
  #nextId = 1;

  constructor() {
    this.#worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.#worker.addEventListener("message", this.#handleMessage);
    this.#worker.addEventListener("error", this.#handleWorkerError);
  }

  call<Result>(method: WorkerMethod, payload: unknown, timeoutMs = 10_000): Promise<Result> {
    const id = this.#nextId++;
    const request: WorkerRequest = { id, kind: "request", method, payload };

    return new Promise<Result>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Worker probe timed out: ${method}`));
      }, timeoutMs);

      this.#pending.set(id, {
        reject,
        resolve: (result) => resolve(result as Result),
        timeout,
      });
      this.#worker.postMessage(request);
    });
  }

  publishClockAnchor(sequence: number, timestamp: number): void {
    const message: ClockAnchorMessage = { kind: "clock-anchor", sequence, timestamp };
    this.#worker.postMessage(message);
  }

  dispose(): void {
    this.#worker.removeEventListener("message", this.#handleMessage);
    this.#worker.removeEventListener("error", this.#handleWorkerError);
    this.#worker.terminate();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Probe worker disposed"));
    }
    this.#pending.clear();
  }

  readonly #handleMessage = (event: MessageEvent<WorkerResponse>): void => {
    const response = event.data;
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timeout);
    this.#pending.delete(response.id);
    if (response.error !== undefined) {
      pending.reject(new Error(response.error));
      return;
    }
    pending.resolve(response.result);
  };

  readonly #handleWorkerError = (event: ErrorEvent): void => {
    const error = new Error(event.message || "Probe worker failed");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  };
}
