# Pingo brand assets

`pingo` comes from Latin `pingō`: to draw, paint, or depict.

The mark is a **pixel P**: a coarse pixel grid forming the letter P, with one
pixel detached above the bowl — the pixel being placed. It reads as both
"canvas/raster" and "work in progress". Full design spec:
[`docs/superpowers/specs/2026-08-20-pingo-logo-design.md`](../../docs/superpowers/specs/2026-08-20-pingo-logo-design.md).

## Files

- `pingo-mark.svg`: primary color mark, transparent background
- `pingo-mark-dark.svg`: mark for dark backgrounds (paper-colored grid)
- `pingo-mark-mono.svg`: `currentColor` single-color version for inline SVG
- `pingo-icon.svg`: dark rounded app tile (app icon / avatar)
- `pingo-favicon.svg`: small-size-optimized, auto-inverts via
  `prefers-color-scheme`

## Rules

- Color lives only on the detached pixel (`#2E5BFF`). The grid is always
  single-color: ink `#14161B` on light, paper `#F7F6F2` on dark.
- Do not rotate the whole mark, change pixel size/gap/radius, add outlines,
  shadows, or gradients. The detached pixel keeps its 18° tilt.
- Minimum size: standard geometry at 24px and above; use the favicon
  geometry at 16px.
- Wordmark: "Pingo" (capital P), geometric sans, ~650 weight, tight tracking.
