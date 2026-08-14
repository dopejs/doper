# doper Engineering Guide

This file is the working agreement for coding agents and contributors in this
repository. Read [`docs/design.md`](docs/design.md) before making architectural
or behavioral changes, and use [`docs/plan.md`](docs/plan.md) for delivery
sequence and milestone gates. The design document is the technical source of
truth; this file turns its decisions into day-to-day engineering rules.

## Project status

doper is a ground-up Web canvas rendering engine for high-performance
interaction, virtual scrolling, and canvas-native editing. It is currently in
the design/prototyping stage. The planned stack is a Rust-to-WASM core, a
TypeScript shell, and a pluggable rendering backend with Canvas2D first.

Existing engines are migration inputs, not implementation blueprints or
performance baselines. Redesign the architecture from first principles. Do not
copy source, reproduce internal abstractions by default, or carry forward
compatibility quirks without a measured product need. Performance gates use
doper's absolute targets. Target-branch and historical data are diagnostic
signals only; they must not become a substitute for the absolute targets.

Do not present planned packages, crates, APIs, benchmarks, or platform support
as implemented until they exist in the repository and have been verified.

## Priorities

When requirements compete, use this order:

1. Rendering correctness and deterministic behavior.
2. Smooth scrolling on low-end mobile devices, especially P95/P99 frame time.
3. API and ABI compatibility, including explicit versioning and downgrade
   behavior.
4. Debuggability, observability, and reproducibility.
5. Maintainability and measured performance; avoid speculative optimization.

The acceptance targets in `docs/design.md` are product requirements, not
aspirational notes. In particular, changes must not silently weaken the PC
benchmark gate, WASM size budget, mobile frame-time targets, or fallback paths.

## Scope boundaries

The current scope includes TSX function components, hooks/signals, native
virtual scrolling, multi-level caches, engine-native editable text,
accessibility, and a pluggable backend.

The current scope explicitly excludes SSR/HTML first paint, general CSS
compatibility, mini-program/native adapters, and business-level rich-text
document semantics such as collaboration, formulas, or Markdown commands. The
engine does own caret, selection, IME composition, clipboard, undo/redo, and
editable-text primitives; do not push those responsibilities back to business
EmbedDOM components.

Compatibility work is an edge adapter for migration, not a constraint on the
core architecture. Keep legacy shims outside the core and make them removable
once migration is complete.

## Intended repository layout

Keep responsibilities aligned with the module boundaries in `docs/design.md`:

- `core/`: Rust workspace. Scene, layout, text, hit testing, scrolling, paint,
  animation, ABI, and orchestration remain separate crates.
- `packages/`: TypeScript packages. Runtime, JSX, reconciler, host, backend,
  widgets, accessibility, and devtools remain independently testable.
- `@dopejs/doper`: facade package only. It re-exports public APIs and contains
  no implementation logic.
- Shared schemas: the single source for opcodes, props, invalidation metadata,
  and binary layouts. Generate Rust and TypeScript representations from them;
  never maintain matching constants by hand.

Do not introduce imports that invert these boundaries or make the facade a
mandatory internal dependency. Business code must depend only on the facade's
public surface.

## Architectural invariants

Preserve the following invariants in every implementation and review:

- The TypeScript shell owns the component tree; the Rust core owns the Scene.
  They do not share mutable objects.
- Shell-to-core updates use a one-way, batched, little-endian, four-byte-aligned
  Mutation Stream. The core consumes only committed frames.
- The core emits a flat binary DisplayList. Canvas2D replay is a thin,
  allocation-conscious typed-array loop; per-draw WASM-to-JS calls are not an
  acceptable rendering path.
- UI and rendering clocks are independent. Scrolling, animation, layout, and
  composition continue from the worker when the main thread is stalled.
- Scrolling frames do not call into the shell. Missing shell data uses a
  placeholder and is filled on a later frame.
- Scene node IDs include a generation. Reuse must never make stale IDs valid.
- Scene storage remains topology ordered after commit: parents precede
  children. Structural edits are compacted once per commit, not once per
  mutation.
- Prop semantics determine invalidation domains. Callers do not manually mark
  layout or paint dirty, and no `forceUpdate` escape hatch is provided.
- Layout results are compared in bulk from double-buffered SoA data. Do not add
  per-node closure/listener allocation to the layout hot path.
- Time, randomness, and input streams are injectable or replayable. Core output
  must not depend on thread scheduling order.
- Accessibility semantics are part of the architecture, not a post-release
  overlay.
- Editable text is a Core subsystem. Business code must not create or position
  per-widget HTML inputs; EditContext is preferred and the host owns one
  centralized native-input fallback for unsupported platforms.
- The Shell owns durable application data while the Core owns active editing
  session state. Synchronize them with revisioned transactions; stale
  acknowledgements or external values must never overwrite newer input.
- Editing boundaries explicitly map UTF-16 offsets, UTF-8 storage, graphemes,
  shaping clusters, glyphs, and lines. Caret movement, deletion, and selection
  must not split grapheme or shaping clusters.

If a requested change conflicts with one of these invariants, stop and propose
an explicit update to `docs/design.md` with migration and rollback impact.

## Public API and compatibility

Treat the exports of `@dopejs/doper` as the public contract. Keep internal
packages private to applications and preserve tree shaking:

- Provide `@dopejs/doper/jsx-runtime` and
  `@dopejs/doper/jsx-dev-runtime` subpath exports.
- Keep devtools and optional backends out of the main entry point.
- Track the facade with API extraction once that tooling exists.
- Preserve existing API behavior unless a breaking change is explicitly
  approved and documented.

`useLayoutEffect`-style synchronous worker layout reads are not supported.
Layout-dependent application state must use the asynchronous
`useLayoutValue(nodeRef, selector)` contract described in the design.

## ABI and unsafe-input rules

Mutation Stream and DisplayList decoders are trust boundaries even when bytes
normally come from this project:

- Validate opcode, length, alignment, IDs, resource bounds, and arithmetic
  before accessing memory.
- Reject truncated, malformed, unsupported-version, and oversized input without
  panic, out-of-bounds access, or partial state mutation.
- Keep decoding transactional at commit boundaries.
- Version incompatible layout changes and update golden fixtures explicitly.
- Require TypeScript-to-Rust round trips for shared binary contracts.
- Fuzz all binary decoders; never rely on "our encoder produced it" as a safety
  argument.

## Performance rules

Optimize only against representative benchmarks or profiles. For hot paths:

- Prefer contiguous SoA data, bitmap scans, interned integer IDs, and batched
  operations.
- Avoid per-frame object, string, closure, listener, or proxy allocation.
- Avoid pointer-heavy structures and repeated sorting where a sequential scan
  is possible.
- Make cache budgets explicit and observable. Raster caches must be bounded and
  evict under memory pressure.
- Record cache hit rate, over-invalidation rate, frame phases, frame-time
  percentiles, and memory usage.
- Track changes against comparable doper history when it exists and investigate
  material regressions, but decide acceptance from the absolute product targets.
  External-engine comparisons are optional research, never a merge or release
  prerequisite.

Performance work must preserve the unoptimized/reference path when it is used
as a differential oracle.

## Capability detection and fallback

Advanced browser capabilities are optional at runtime. Keep the fallback chain
functional and behaviorally equivalent:

1. SharedArrayBuffer transport when cross-origin isolation is available.
2. `postMessage` transport when SharedArrayBuffer is unavailable.
3. Main-thread Canvas2D when Worker or OffscreenCanvas is unavailable.

Worker frame driving must support the measured combination of worker rAF,
main-thread timestamps, and worker self-driving described in the design. Do not
assume browser support from desktop testing alone. Worker mode and future
WebGPU mode must remain feature-flagged and reversible.

## Implementation workflow

Before changing code:

1. Read the relevant design section and nearby module tests.
2. Verify actual repository conventions and available commands; do not invent
   tooling from this planned layout.
3. State any assumption that affects an API, ABI, browser capability, or
   performance result.

While changing code:

- Make the smallest coherent change and keep fallback/reference paths working.
- Update schemas, generated code, fixtures, and both language implementations
  atomically when changing a cross-language contract.
- Add observability with new cache, scheduling, invalidation, or fallback
  behavior.
- Do not mix broad cleanup with a functional or performance change.

After changing code:

- Run the narrowest relevant checks first, then the repository-wide gates that
  exist.
- Report exact commands and results. If a required environment or device is
  unavailable, state what remains unverified.
- For non-trivial changes, document failure modes and the rollback or feature
  flag that contains them.

## Testing requirements

Use the test layers and thresholds in section 15 of `docs/design.md`. New code
must include the appropriate layer rather than relying only on unit tests.

Minimum expectations by change type:

- Scene/layout/scroll/hit-test logic: unit tests plus property tests against
  invariants or a naive reference implementation.
- Prop or invalidation changes: schema coverage plus incremental-versus-full
  pixel comparison with shrinking to a minimal failure.
- ABI changes: generated definitions, golden bytes, cross-language round trip,
  malformed-input tests, and fuzz coverage.
- Ring buffer or clock changes: deterministic tests, concurrency model checks,
  stress tests, and stall/fault injection.
- Backend changes: DisplayList conformance and differential image testing with
  the documented tolerance. Incremental/full and optimized/reference paths
  require exact output where the design specifies it.
- Performance changes: correctness tests plus automated before/after
  measurements using the same workload, build mode, sample count, and
  percentile method. Physical-device measurements qualify support claims but
  do not block engineering completion when no automated device service exists.
- User-visible behavior: semantic-tree-driven E2E coverage; pixel snapshots are
  supplementary, not the only assertion.
- Editing changes: property tests for offset/revision/undo invariants, recorded
  composition fixtures, and automated EditContext/fallback contract tests.
  Real browser/OS/input-method results belong to platform qualification.

Never update a golden image, binary fixture, benchmark baseline, or tolerance
solely to make a failure pass. Explain and review the intended semantic change.

## Milestone discipline

Follow the dependency order in `docs/design.md`:

- M0 validates worker timing, SAB/COOP-COEP, OffscreenCanvas, and WASM
  startup/size through automated repository gates. Real-device measurement is
  platform qualification, not an engineering milestone blocker.
- M1 establishes the deterministic single-threaded core and shared headless
  differential-test infrastructure.
- M2 adds the worker, dual clocks, caches, and fallback chain.
- M3 adds native virtual scrolling and the initial text subsystem.
- M4 adds complete hit testing, event phases, and accessibility behavior.
- M5 adds migration tooling and evaluates WebGPU with measured device data.

Engineering milestone completion is determined only by automated, reproducible
repository/CI gates. Physical-device performance, real IME, authenticated
business deployment, and external storage exercises determine whether a
platform is qualified for a support claim; missing qualification must remain
visible but must not mark completed engineering work incomplete.

Do not pull WebGPU work before M2 is proven, or complex text work before the
minimal text path and core are stable. A prototype may cross milestone
boundaries only when it is isolated, disposable, and clearly marked as such.

## Documentation decisions

Update `docs/design.md` when a change alters architecture, an invariant, a
public API, an ABI, milestone scope/order, acceptance criteria, or fallback
behavior. Record why the decision changed, compatibility impact, verification,
and rollback path.

Keep this guide concise and operational. Do not duplicate detailed algorithms
from the design document when a link and an enforceable rule are sufficient.
