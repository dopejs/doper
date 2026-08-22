/**
 * The glyphs the component library draws for itself.
 *
 * Path data is Lucide's (https://lucide.dev), used under the ISC licence
 * reproduced below. Only the handful this library needs is vendored, so the
 * component set carries no runtime dependency on an icon package and the
 * glyphs stay available to the storybook and the pixel tests without a network.
 *
 * **The data here was transcribed, not generated.** `pnpm icons:check` diffs it
 * against `lucide-static` and is the only thing that proves it matches upstream;
 * run it before trusting these paths.
 *
 * Choosing an icon set for application use is deliberately not this library's
 * decision — `createSvg` accepts any of them, and this module is not a
 * recommendation, only what the components themselves draw.
 *
 * ---
 *
 * ISC License
 *
 * Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part
 * of Feather (MIT). All other copyright (c) for Lucide are held by Lucide
 * Contributors 2022.
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */

import { createSvg, type PingoSvg } from "@dopejs/pingo-jsx";

/**
 * Lucide's shared attributes, so only the body differs between glyphs.
 *
 * `pnpm icons:check` compares the body against upstream, which is why the
 * wrapper is built here instead of being part of each entry.
 */
function lucide(body: string): string {
  return [
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"`,
    ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`,
    body,
    `</svg>`,
  ].join("");
}

/**
 * Upstream file name to markup body, in the form `icons:check` compares.
 *
 * Exported for that script rather than for callers: it is the list of what has
 * been vendored, and a glyph missing from it is a glyph nobody verified.
 */
export const LUCIDE_SOURCES: Readonly<Record<string, string>> = {
  "check": `<path d="M20 6 9 17l-5-5"/>`,
  "minus": `<path d="M5 12h14"/>`,
  "chevron-down": `<path d="m6 9 6 6 6-6"/>`,
  "chevron-up": `<path d="m18 15-6-6-6 6"/>`,
  "chevron-right": `<path d="m9 18 6-6-6-6"/>`,
  "chevron-left": `<path d="m15 18-6-6 6-6"/>`,
  "x": `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
  "search": `<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`,
};

function icon(name: keyof typeof LUCIDE_SOURCES): PingoSvg {
  return createSvg(lucide(LUCIDE_SOURCES[name] ?? ""));
}

// Parsed once at module load. The PURE annotations let a bundler drop the
// glyphs an application never renders, which is why these are separate
// constants rather than one lazily indexed map.

/** Confirmation tick, for a checked control. */
export const CheckIcon: PingoSvg = /*#__PURE__*/ icon("check");

/** Horizontal bar, for a partially checked control. */
export const MinusIcon: PingoSvg = /*#__PURE__*/ icon("minus");

/** Disclosure chevron pointing down, for an expanded section. */
export const ChevronDownIcon: PingoSvg = /*#__PURE__*/ icon("chevron-down");

/** Disclosure chevron pointing up. */
export const ChevronUpIcon: PingoSvg = /*#__PURE__*/ icon("chevron-up");

/** Disclosure chevron pointing right, for a collapsed section. */
export const ChevronRightIcon: PingoSvg = /*#__PURE__*/ icon("chevron-right");

/** Disclosure chevron pointing left. */
export const ChevronLeftIcon: PingoSvg = /*#__PURE__*/ icon("chevron-left");

/** Cross, for a dismiss affordance. */
export const CloseIcon: PingoSvg = /*#__PURE__*/ icon("x");

/** Magnifier, for a search field. */
export const SearchIcon: PingoSvg = /*#__PURE__*/ icon("search");
