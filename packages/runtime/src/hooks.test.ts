import { describe, expect, it } from "vitest";

import { ComponentScope } from "./hooks";
import { useEffect, useMemo, useSignal, useState } from "./hooks";

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
