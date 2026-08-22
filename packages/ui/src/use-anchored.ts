import { useLayoutValue, useViewport, type LayoutGeometry } from "@dopejs/pingo-runtime";

import { placeAnchored, placementStyle, type PlacementStyle, type Side } from "./positioning";

/** What an anchored panel needs to position itself against its trigger. */
export interface AnchoredPlacement {
  /** Ref for the anchor wrapper; the panel is positioned against this box. */
  readonly anchorRef: (handle: { readonly nodeId: number } | null) => void;
  /** Ref for the panel itself, measured to decide whether it fits. */
  readonly panelRef: (handle: { readonly nodeId: number } | null) => void;
  /**
   * Inline style for the panel, or undefined while readback is off or the
   * panel has not been measured.
   *
   * Undefined means "use the skin's static side", which is the same path the
   * component takes when the feature flag is off.
   */
  readonly style: PlacementStyle | undefined;
}

/**
 * Measures an anchored overlay and places it inside its visible bounds.
 *
 * Both observations are bound to `open`, not to mount: a table of a hundred
 * closed popovers must consume no slots in Core's bounded observation set.
 *
 * The panel is hidden on the frame it is first measured on. Measurement is a
 * frame late by construction, and an overlay that appears in the wrong place
 * and jumps is worse than one that appears a frame later.
 */
export function useAnchoredPlacement(open: boolean, side: Side, offset = 0): AnchoredPlacement {
  const [anchorRef, anchor] = useLayoutValue((geometry: LayoutGeometry) => geometry, {
    enabled: open,
  });
  const [panelRef, panel] = useLayoutValue((geometry: LayoutGeometry) => geometry, {
    enabled: open,
  });
  const viewport = useViewport();
  if (!open || anchor === undefined || panel === undefined || viewport === undefined) {
    return { anchorRef, panelRef, style: undefined };
  }
  const placement = placeAnchored({
    anchor: anchor.bounds,
    panel: panel.bounds,
    clip: anchor.clip,
    viewport,
    side,
    offset,
  });
  return { anchorRef, panelRef, style: placementStyle(placement, anchor.bounds) };
}
