import { describe, expect, it } from "vitest";

import {
  availableOn,
  flipSide,
  intersectRects,
  isAnchorHidden,
  oppositeSide,
  placeAnchored,
  shiftIntoBounds,
  type Side,
} from "./positioning";

const viewport = { left: 0, top: 0, width: 400, height: 300 };
const unclipped = {
  left: Number.NEGATIVE_INFINITY,
  top: Number.NEGATIVE_INFINITY,
  width: Number.POSITIVE_INFINITY,
  height: Number.POSITIVE_INFINITY,
};

describe("intersectRects", () => {
  it("survives the unbounded clip an unclipped node reports", () => {
    expect(intersectRects(unclipped, viewport)).toEqual(viewport);
  });

  it("returns an empty rectangle rather than a negative one", () => {
    const apart = intersectRects(
      { left: 0, top: 0, width: 10, height: 10 },
      { left: 50, top: 50, width: 10, height: 10 },
    );
    expect(apart.width).toBe(0);
    expect(apart.height).toBe(0);
  });
});

describe("flip", () => {
  it("flips only when the requested side is short and the other is not", () => {
    const panel = { left: 0, top: 0, width: 100, height: 120 };
    // Anchor near the bottom edge: below has 36px, above has 236.
    const low = { left: 10, top: 240, width: 80, height: 20 };
    expect(availableOn("bottom", low, viewport, 4)).toBe(36);
    expect(flipSide("bottom", low, panel, viewport, 4)).toBe("top");
    // Room below: the requested side wins even though above also fits.
    const high = { left: 10, top: 20, width: 80, height: 20 };
    expect(flipSide("bottom", high, panel, viewport, 4)).toBe("bottom");
  });

  it("keeps the requested side when neither fits, so overflow stays predictable", () => {
    const huge = { left: 0, top: 0, width: 100, height: 1000 };
    const middle = { left: 10, top: 140, width: 80, height: 20 };
    expect(flipSide("bottom", middle, huge, viewport, 0)).toBe("bottom");
  });

  it("has an involutive opposite", () => {
    for (const side of ["top", "bottom", "left", "right"] as Side[]) {
      expect(oppositeSide(oppositeSide(side))).toBe(side);
    }
  });
});

describe("shift", () => {
  it("slides a panel back inside without changing its size", () => {
    const shifted = shiftIntoBounds({ left: 380, top: 10, width: 100, height: 20 }, viewport);
    expect(shifted.left).toBe(300);
    expect(shifted.top).toBe(10);
  });

  it("pins to the start edge when the panel is larger than the bounds", () => {
    // Sliding cannot fix a size problem; `size` is the strategy that can.
    const shifted = shiftIntoBounds({ left: 50, top: 10, width: 900, height: 20 }, viewport);
    expect(shifted.left).toBe(0);
  });
});

describe("hide", () => {
  it("reports an anchor scrolled entirely out of its clipping ancestor", () => {
    const scroller = { left: 0, top: 0, width: 200, height: 100 };
    expect(isAnchorHidden({ left: 10, top: 120, width: 40, height: 20 }, scroller)).toBe(true);
    expect(isAnchorHidden({ left: 10, top: 90, width: 40, height: 20 }, scroller)).toBe(false);
  });

  it("places nothing and says so when the anchor is gone", () => {
    const placement = placeAnchored({
      anchor: { left: 10, top: 500, width: 40, height: 20 },
      panel: { left: 0, top: 0, width: 100, height: 50 },
      clip: { left: 0, top: 0, width: 200, height: 100 },
      viewport,
      side: "bottom",
    });
    expect(placement.hidden).toBe(true);
    expect(placement.maxHeight).toBe(0);
  });
});

describe("placeAnchored", () => {
  it("bounds the panel by the clipping ancestor, not just the viewport", () => {
    // A scroller 100 tall inside a 300-tall viewport: the panel gets the
    // scroller's room, which is the case a viewport-only rule gets wrong.
    const placement = placeAnchored({
      anchor: { left: 10, top: 10, width: 40, height: 20 },
      panel: { left: 0, top: 0, width: 100, height: 500 },
      clip: { left: 0, top: 0, width: 200, height: 100 },
      viewport,
      side: "bottom",
      offset: 4,
    });
    expect(placement.side).toBe("bottom");
    expect(placement.maxHeight).toBe(66);
  });

  it("starts a top-side panel at the bounds edge once size has shortened it", () => {
    // Bounds start at y=100, so a panel constrained to the room above the
    // anchor must begin exactly there — not at the negative origin its natural
    // height would imply.
    const placement = placeAnchored({
      anchor: { left: 10, top: 260, width: 40, height: 20 },
      panel: { left: 0, top: 0, width: 100, height: 400 },
      clip: { left: 0, top: 100, width: 400, height: 200 },
      viewport,
      side: "top",
      offset: 0,
    });
    expect(placement.side).toBe("top");
    expect(placement.maxHeight).toBe(160);
    expect(placement.top).toBe(100);
  });

  it("never places a panel outside the bounds it was given", () => {
    const sides: Side[] = ["top", "bottom", "left", "right"];
    let state = 0x9e37_79b9;
    const next = (limit: number): number => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state % limit;
    };
    for (let iteration = 0; iteration < 4000; iteration += 1) {
      const anchor = {
        left: next(400) - 50,
        top: next(300) - 50,
        width: next(120) + 1,
        height: next(80) + 1,
      };
      const panel = { left: 0, top: 0, width: next(300) + 1, height: next(300) + 1 };
      const clip = { left: next(80), top: next(80), width: next(400) + 1, height: next(300) + 1 };
      const side = sides[next(sides.length)] ?? "bottom";
      const placement = placeAnchored({ anchor, panel, clip, viewport, side, offset: next(8) });
      if (placement.hidden) continue;
      const bounds = intersectRects(clip, viewport);
      const width = Math.min(panel.width, placement.maxWidth);
      const height = Math.min(panel.height, placement.maxHeight);
      // Either the placed panel is inside the bounds, or it could not fit on
      // that axis at all — in which case it is pinned to the start edge and the
      // caller has an explicit max extent telling it to scroll instead.
      if (width <= bounds.width) {
        expect(placement.left).toBeGreaterThanOrEqual(bounds.left);
        expect(placement.left + width).toBeLessThanOrEqual(bounds.left + bounds.width);
      } else {
        expect(placement.left).toBe(bounds.left);
      }
      if (height <= bounds.height) {
        expect(placement.top).toBeGreaterThanOrEqual(bounds.top);
        expect(placement.top + height).toBeLessThanOrEqual(bounds.top + bounds.height);
      } else {
        expect(placement.top).toBe(bounds.top);
      }
    }
  });

  it("agrees with availableOn about how much room the chosen side has", () => {
    const anchor = { left: 10, top: 100, width: 40, height: 20 };
    const panel = { left: 0, top: 0, width: 100, height: 50 };
    const placement = placeAnchored({ anchor, panel, clip: unclipped, viewport, side: "bottom" });
    expect(placement.maxHeight).toBe(availableOn(placement.side, anchor, viewport, 0));
  });
});
