import { describe, expect, it, vi } from "vitest";

import { createDrag, positionToValue } from "./drag";

function target() {
  return {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    focus: vi.fn(),
  };
}

function event(x: number, y: number, pointerId = 1, currentTarget = target()) {
  return { x, y, pointerId, currentTarget } as never;
}

describe("createDrag", () => {
  it("captures on press and releases on end", () => {
    // Without capture a drag stops the moment the pointer leaves the node, and
    // every draggable control would grow that bug separately.
    const handle = target();
    const drag = createDrag({ onMove: vi.fn() });
    drag.onPointerDown(event(0, 0, 1, handle));
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
    drag.onPointerUp(event(0, 0, 1, handle));
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("reports movement relative to where the drag began", () => {
    const onMove = vi.fn();
    const drag = createDrag({ onMove });
    drag.onPointerDown(event(10, 20));
    drag.onPointerMove(event(13, 24));
    expect(onMove).toHaveBeenCalledWith([3, 4], [13, 24]);
  });

  it("ignores movement before a press and after a release", () => {
    const onMove = vi.fn();
    const drag = createDrag({ onMove });
    drag.onPointerMove(event(5, 5));
    expect(onMove).not.toHaveBeenCalled();
    drag.onPointerDown(event(0, 0));
    drag.onPointerUp(event(1, 1));
    drag.onPointerMove(event(9, 9));
    expect(onMove).not.toHaveBeenCalled();
  });

  it("lets only the pointer that started the drag move or end it", () => {
    // A stray second touch releasing the capture mid-gesture is the failure
    // this guards; it looks like the control sticking to the cursor.
    const onMove = vi.fn();
    const onEnd = vi.fn();
    const handle = target();
    const drag = createDrag({ onMove, onEnd });
    drag.onPointerDown(event(0, 0, 1, handle));
    drag.onPointerMove(event(5, 5, 2, handle));
    expect(onMove).not.toHaveBeenCalled();
    drag.onPointerUp(event(0, 0, 2, handle));
    expect(handle.releasePointerCapture).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("ignores a second press while a drag is already running", () => {
    const onStart = vi.fn();
    const drag = createDrag({ onMove: vi.fn(), onStart });
    drag.onPointerDown(event(0, 0, 1));
    drag.onPointerDown(event(5, 5, 2));
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("distinguishes a cancel from a release", () => {
    const onEnd = vi.fn();
    const drag = createDrag({ onMove: vi.fn(), onEnd });
    drag.onPointerDown(event(0, 0));
    drag.onPointerCancel(event(0, 0));
    expect(onEnd).toHaveBeenCalledWith(true);

    drag.onPointerDown(event(0, 0));
    drag.onPointerUp(event(0, 0));
    expect(onEnd).toHaveBeenLastCalledWith(false);
  });
});

describe("positionToValue", () => {
  const track = { start: 100, length: 200 };

  it("maps the ends and the middle", () => {
    expect(positionToValue(100, track, { min: 0, max: 10 })).toBe(0);
    expect(positionToValue(300, track, { min: 0, max: 10 })).toBe(10);
    expect(positionToValue(200, track, { min: 0, max: 10 })).toBe(5);
  });

  it("clamps outside the track instead of extrapolating", () => {
    expect(positionToValue(0, track, { min: 0, max: 10 })).toBe(0);
    expect(positionToValue(9999, track, { min: 0, max: 10 })).toBe(10);
  });

  it("snaps to the nearest step measured from min", () => {
    expect(positionToValue(210, track, { min: 0, max: 10, step: 2 })).toBe(6);
    expect(positionToValue(150, track, { min: 1, max: 11, step: 5 })).toBe(6);
  });

  it("stays on the step grid at the top end rather than clamping off it", () => {
    // 0..10 by 3 has no grid point at 10. Returning 10 would hand the caller a
    // value its own step rule says cannot exist, so the top steps back to 9.
    expect(positionToValue(300, track, { min: 0, max: 10, step: 3 })).toBe(9);
    expect(positionToValue(300, track, { min: 0, max: 10, step: 4 })).toBe(8);
    // A span that divides evenly still reaches max.
    expect(positionToValue(300, track, { min: 0, max: 10, step: 5 })).toBe(10);
  });

  it("returns min for a zero-length track rather than dividing by zero", () => {
    expect(positionToValue(50, { start: 0, length: 0 }, { min: 2, max: 8 })).toBe(2);
  });
});
