# E5 flexGrow / flexShrink / flexBasis 实现计划

> **进度**：本文件全部条目已完成，交付于 `40f06a1…feedf85`。复选框是**事后回填**的——
> 执行期间没有逐条勾选，因此不要把它读作实时记录；权威完成记录是
> [`pingo-ui-implementation-plan.md`](./pingo-ui-implementation-plan.md)
> 的进度总览表与验收标准表。

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。Steps 用 checkbox 语法。

**Goal:** 按 [`docs/e5-flex-grow-design.md`](./e5-flex-grow-design.md) 交付主轴伸缩三属性、
`flex` shorthand、reference oracle、滚动容器百分比基准修复与真实 feature gate，
并在出口后补齐 pingo-ui `Input` 的 `prefix` / `suffix` slot。

**执行顺序是硬约束**：oracle（Task 1）必须先于语法开放（Task 3）落地——这是
`css-events-plan.md` 既定节奏，也是本 Track 的出口条件之一。

---

### Task E5-1: reference oracle（先于语法开放）

**Files:**

- Create: `core/pingo-layout/src/reference.rs`
- Modify: `core/pingo-layout/src/lib.rs`（导出 `reference_layout`）

- [x] **Step 1**：递归实现 `reference_layout`，覆盖当前已交付的 flow 语义
      （padding/border/margin/auto margin、min/max、box-sizing、gap、justify、align、
      reverse、display:none、百分比基准），暂不含 flex 伸缩。
- [x] **Step 2**：proptest 断言 `LayoutEngine` 全量结果与 oracle 在 `1e-3` 内一致；
      失败可 shrinking。
- [x] **Step 3**：`pnpm rust:test`。Commit。

### Task E5-2: 百分比基准与测量约束分离

**Files:** `core/pingo-layout/src/engine.rs`、`core/pingo-layout/src/reference.rs`

- [x] **Step 1**：失败测试——`overflow: hidden` 容器内 `width: 50%` 子节点应得容器
      content box 的一半（当前得 0）。
- [x] **Step 2**：`Frame` 增 `percent_width` / `percent_height`；新增
      `PercentBasis`；`constraints_for_child` 返回 `(BoxConstraints, PercentBasis)`；
      `make_frame` 接收显式 basis。
- [x] **Step 3**：断言非滚动轴行为不变（既有全部布局测试 + oracle 差分）。
- [x] **Step 4**：`pnpm rust:test`。Commit。

### Task E5-3: schema / 生成代码 / Shell 语法

**Files:** `schemas/style.v1.json`、`scripts/generate-style.mjs`、
`packages/style/src/values.ts`、生成产物三件

- [x] **Step 1**：schema 增 `non-negative-number` grammar、`flex-sizing` feature
      （bit 1）、三条属性（id 59/60/61）、`flex` shorthand；`cssSubsetVersion` → `1.2.0`。
- [x] **Step 2**：`generate-style.mjs` 的 `grammarTypes` 增 `non-negative-number`
      与 `flex`。
- [x] **Step 3**：`values.ts` 增 `non-negative-number` 解析与 `flex` shorthand 展开
      （对照设计 §D1 表格逐行测试，含非法输入）。
- [x] **Step 4**：`pnpm style:generate`、`pnpm contracts:check`、
      `vitest run packages/style`。Commit。

### Task E5-4: feature gate 落地

**Files:** `packages/reconciler/src/computed-style-resource.ts`、
`core/pingo-abi/src/computed_style.rs`

- [x] **Step 1**：Shell 资源头 `featureBits` 改为"实际用到的属性 feature 位 OR"。
- [x] **Step 2**：Core `decode` 逐条校验 feature 位，事务性拒绝。
- [x] **Step 3**：测试——只用 m6 属性的资源头只声明 bit 0；用 flexGrow 的声明 bit 0|1；
      伪造"用 flexGrow 但头里没有 bit 1"的字节被拒且无部分状态。
- [x] **Step 4**：`pnpm rust:test`、`vitest run packages/reconciler`。Commit。

### Task E5-5: Core 主轴伸缩求解

**Files:** `core/pingo-layout/src/engine.rs`、`core/pingo-layout/src/reference.rs`

- [x] **Step 1**：oracle 先加 flex 伸缩（按设计 §D3 直写，不优化）。
- [x] **Step 2**：`Frame` 增 `flex_pass` / `flex_targets`；实现 `resolve_flex`
      冻结循环；`compute_subtree` 弹出路径接入第二遍；`constraints_for_child` 支持
      主轴收紧；第二遍跳过未变子树但仍累加尺寸。
- [x] **Step 3**：`LayoutMetrics` 增 `flex_resolutions` / `flex_relayouts`。
- [x] **Step 4**：proptest —— 引擎 ↔ oracle 差分（含 grow/shrink/basis/min/max/gap/
      reverse/嵌套）；单测覆盖 `Σgrow < 1`、shrink 到 0、max 夹取、冻结循环多轮。
- [x] **Step 5**：`pnpm rust:test`、`pnpm m1:perf`。Commit。

### Task E5-6: 出口门禁 + Input slot

**Files:** `packages/ui/src/input.tsx`、`packages/ui/src/styles/input.scss`、
`packages/ui/src/index.ts`、storybook 展区、`docs/style-support.md`

- [x] **Step 1**：`Input` 增 `prefix?` / `suffix?` slot，输入区 `flex: 1 1 0px`。
- [x] **Step 2**：descriptor 测试 + 皮肤解析测试 + storybook 明暗展区。
- [x] **Step 3**：全量门禁 `pnpm test:run`、`pnpm typecheck`、`pnpm api:check`、
      `pnpm rust:test`、`pnpm contracts:check`。
- [x] **Step 4**：回写 `pingo-ui-implementation-plan.md` 进度表。Commit。
