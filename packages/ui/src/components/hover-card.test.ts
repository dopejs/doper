import { describe, expect, it, vi } from "vitest";

import { hoverCardDescriptor } from "./hover-card";

type Node = { readonly props: Record<string, unknown> };

function parts(open: boolean, schedule = vi.fn()): { trigger: Node; card: Node | null } {
  const node = hoverCardDescriptor(
    { children: null, content: null },
    open,
    schedule,
  ) as unknown as Node;
  const [trigger, card] = node.props["children"] as [Node, Node | null];
  return { trigger, card };
}

describe("hoverCardDescriptor", () => {
  it("schedules rather than toggling, so the delay can be honoured", () => {
    const schedule = vi.fn();
    const { trigger } = parts(false, schedule);
    (trigger.props["onPointerEnter"] as () => void)();
    expect(schedule).toHaveBeenCalledWith(true);
    (trigger.props["onPointerLeave"] as () => void)();
    expect(schedule).toHaveBeenLastCalledWith(false);
  });

  it("keeps itself open while the pointer is over the card", () => {
    // Without this the close delay would only ever buy time to reach the card
    // and never time to stay in it.
    const schedule = vi.fn();
    const { card } = parts(true, schedule);
    (card?.props["onPointerEnter"] as () => void)();
    expect(schedule).toHaveBeenLastCalledWith(true);
    (card?.props["onPointerLeave"] as () => void)();
    expect(schedule).toHaveBeenLastCalledWith(false);
  });

  it("opens on focus too, so it is reachable without a pointer", () => {
    const schedule = vi.fn();
    const { trigger } = parts(false, schedule);
    (trigger.props["onFocus"] as () => void)();
    expect(schedule).toHaveBeenCalledWith(true);
    (trigger.props["onBlur"] as () => void)();
    expect(schedule).toHaveBeenLastCalledWith(false);
  });

  it("renders no card while closed", () => {
    expect(parts(false).card).toBeNull();
    expect(parts(true).card).not.toBeNull();
  });
});
