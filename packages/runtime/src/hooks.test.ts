import { describe, expect, it } from "vitest";

import { ComponentScope } from "./hooks";
import { useEffect, useLayoutValue, useMemo, useSignal, useState } from "./hooks";
import type { LayoutGeometry, LayoutGeometryAccess } from "./hooks";

describe("component hooks", () => {
  it("retains state and schedules exactly one owning scope invalidation", () => {
    let invalidations = 0;
    let setCount: ((value: number) => void) | undefined;
    const scope = new ComponentScope(() => {
      invalidations += 1;
    });
    const render = (): number =>
      scope.render(() => {
        const [count, set] = useState(1);
        setCount = set;
        return count;
      });

    expect(render()).toBe(1);
    setCount?.(2);
    setCount?.(2);
    expect(invalidations).toBe(1);
    expect(render()).toBe(2);
  });

  it("observes a node only while attached and enabled, and releases on unmount", () => {
    const observed: number[] = [];
    const released: number[] = [];
    const geometry = new Map<number, LayoutGeometry>();
    const notifiers = new Map<number, () => void>();
    const access: LayoutGeometryAccess = {
      observe: (nodeId, notify) => {
        observed.push(nodeId);
        notifiers.set(nodeId, notify);
        return () => {
          released.push(nodeId);
          notifiers.delete(nodeId);
        };
      },
      read: (nodeId) => geometry.get(nodeId),
    };
    let invalidations = 0;
    const scope = new ComponentScope(
      () => {
        invalidations += 1;
      },
      undefined,
      access,
    );

    let enabled = true;
    let attach: ((handle: { readonly nodeId: number } | null) => void) | undefined;
    let width: number | undefined;
    const render = (): void => {
      scope.render(() => {
        const [ref, value] = useLayoutValue((next) => next.bounds.width, { enabled });
        attach = ref;
        width = value;
        return undefined;
      });
      scope.flushEffects();
    };

    // Nothing attached: no observation, and undefined rather than zero — a zero
    // is indistinguishable from a node that really is empty.
    render();
    expect(observed).toEqual([]);
    expect(width).toBeUndefined();

    attach?.({ nodeId: 7 });
    expect(observed).toEqual([7]);
    geometry.set(7, {
      bounds: { left: 0, top: 0, width: 120, height: 20 },
      clip: { left: 0, top: 0, width: 500, height: 500 },
    });
    // Geometry arriving must wake the component, or the value it computed from
    // the previous frame is what stays on screen.
    const before = invalidations;
    notifiers.get(7)?.();
    expect(invalidations).toBe(before + 1);
    render();
    expect(width).toBe(120);

    // Turning it off must release the slot without a remount: an overlay that
    // closes has to give its observation back or Core's bounded set leaks.
    enabled = false;
    render();
    expect(released).toEqual([7]);
    expect(width).toBeUndefined();

    enabled = true;
    render();
    expect(observed).toEqual([7, 7]);

    scope.dispose();
    expect(released).toEqual([7, 7]);
  });

  it("reports undefined and observes nothing when the host provides no access", () => {
    const scope = new ComponentScope(() => undefined);
    let attach: ((handle: { readonly nodeId: number } | null) => void) | undefined;
    const value = scope.render(() => {
      const [ref, next] = useLayoutValue((geometry) => geometry.bounds.width);
      attach = ref;
      return next;
    });
    expect(value).toBeUndefined();
    // The flag-off path must not throw when a component still attaches a ref.
    expect(() => attach?.({ nodeId: 3 })).not.toThrow();
  });

  it("tracks signals read by a component scope", () => {
    let invalidations = 0;
    let count: ReturnType<typeof useSignal<number>> | undefined;
    const scope = new ComponentScope(() => {
      invalidations += 1;
    });
    const read = (): number =>
      scope.render(() => {
        count = useSignal(1);
        return count.get();
      });
    expect(read()).toBe(1);
    count?.set(2);
    expect(invalidations).toBe(1);
    expect(read()).toBe(2);
  });

  it("runs passive effects only after commit and cleans up on changes/dispose", () => {
    const events: string[] = [];
    const scope = new ComponentScope(() => undefined);
    const render = (value: number): void =>
      scope.render(() => {
        useEffect(() => {
          events.push(`run:${String(value)}`);
          return () => events.push(`clean:${String(value)}`);
        }, [value]);
      });

    render(1);
    expect(events).toEqual([]);
    scope.flushEffects();
    render(1);
    scope.flushEffects();
    render(2);
    scope.flushEffects();
    scope.dispose();
    expect(events).toEqual(["run:1", "clean:1", "run:2", "clean:2"]);
  });

  it("rejects hook order changes and restores memo slots after failed renders", () => {
    const scope = new ComponentScope(() => undefined);
    expect(
      scope.render(() => {
        const value = useMemo(() => 1, []);
        useState(0);
        return value;
      }),
    ).toBe(1);
    expect(() => scope.render(() => useMemo(() => 2, [1]))).toThrow(/hook count/u);
    expect(
      scope.render(() => {
        const value = useMemo(() => 3, []);
        useState(0);
        return value;
      }),
    ).toBe(1);
  });

  it("continues flushing and disposing effects while reporting all failures", () => {
    const events: string[] = [];
    const scope = new ComponentScope(() => undefined);
    scope.render(() => {
      useEffect(() => {
        events.push("run:first");
        return () => {
          events.push("clean:first");
          throw new Error("first cleanup");
        };
      }, []);
      useEffect(() => {
        events.push("run:second");
        return () => {
          events.push("clean:second");
          throw new Error("second cleanup");
        };
      }, []);
    });
    scope.flushEffects();

    let caught: unknown;
    try {
      scope.dispose();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(2);
    expect(events).toEqual(["run:first", "run:second", "clean:first", "clean:second"]);
    expect(() => scope.dispose()).not.toThrow();
  });

  it("runs later effects when an earlier effect creation fails", () => {
    const events: string[] = [];
    const scope = new ComponentScope(() => undefined);
    scope.render(() => {
      useEffect(() => {
        events.push("run:first");
        throw new Error("effect failure");
      }, []);
      useEffect(() => {
        events.push("run:second");
      }, []);
    });
    expect(() => scope.flushEffects()).toThrow("effect failure");
    expect(events).toEqual(["run:first", "run:second"]);
  });
});
