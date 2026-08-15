import { describe, expect, it } from "vitest";

import { batch, computed, effect, signal } from "./signal";

describe("signals", () => {
  it("tracks dynamic dependencies without duplicate or stale subscriptions", () => {
    const useLeft = signal(true);
    const left = signal(1);
    const right = signal(10);
    const values: number[] = [];
    const dispose = effect(() => {
      values.push(useLeft.get() ? left.get() : right.get());
    });

    left.set(2);
    useLeft.set(false);
    left.set(3);
    right.set(11);
    dispose();
    right.set(12);
    expect(values).toEqual([1, 2, 10, 11]);
  });

  it("coalesces invalidations and computes lazily", () => {
    const first = signal(1);
    const second = signal(2);
    let computations = 0;
    const total = computed(() => {
      computations += 1;
      return first.get() + second.get();
    });
    expect(computations).toBe(0);
    expect(total.get()).toBe(3);
    expect(total.get()).toBe(3);
    expect(computations).toBe(1);

    const values: number[] = [];
    const dispose = effect(() => {
      values.push(total.get());
    });
    batch(() => {
      first.set(3);
      second.set(4);
    });
    expect(values).toEqual([3, 7]);
    expect(computations).toBe(2);
    dispose();
  });

  it("runs cleanup before rerun and once on disposal", () => {
    const source = signal(0);
    const events: string[] = [];
    const dispose = effect(() => {
      const value = source.get();
      events.push(`run:${String(value)}`);
      return () => events.push(`clean:${String(value)}`);
    });
    source.set(1);
    dispose();
    expect(events).toEqual(["run:0", "clean:0", "run:1", "clean:1"]);
  });

  it("disposes dependencies when the initial effect execution fails", () => {
    const source = signal(0);
    let runs = 0;
    expect(() =>
      effect(() => {
        source.get();
        runs += 1;
        throw new Error("initial failure");
      }),
    ).toThrow("initial failure");

    source.set(1);
    expect(runs).toBe(1);
  });

  it("preserves operation and observer errors from the same batch", () => {
    const source = signal(0);
    const dispose = effect(() => {
      if (source.get() === 1) throw new Error("observer failure");
    });

    let caught: unknown;
    try {
      batch(() => {
        source.set(1);
        throw new Error("operation failure");
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "operation failure" }),
      expect.objectContaining({ message: "observer failure" }),
    ]);
    dispose();
  });

  it("continues an effect rerun after cleanup failure and cleans only once", () => {
    const source = signal(0);
    const events: string[] = [];
    const dispose = effect(() => {
      const value = source.get();
      events.push(`run:${String(value)}`);
      return () => {
        events.push(`clean:${String(value)}`);
        if (value === 0) throw new Error("cleanup failure");
      };
    });

    expect(() => source.set(1)).toThrow("cleanup failure");
    expect(events).toEqual(["run:0", "clean:0", "run:1"]);
    dispose();
    expect(events).toEqual(["run:0", "clean:0", "run:1", "clean:1"]);
  });

  it("normalizes non-Error observer failures", () => {
    const source = signal(0);
    const dispose = effect(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercises trust-boundary normalization
      if (source.get() === 1) throw undefined;
    });
    expect(() => source.set(1)).toThrow("reactive observer threw a non-Error value");
    dispose();
  });
});
