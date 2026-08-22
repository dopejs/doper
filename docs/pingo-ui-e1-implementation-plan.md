# E1 keyboard 事件实现计划

> **进度**：本文件全部条目已完成，交付于 `ba9d1fd…055c117`。复选框是**事后回填**的——
> 执行期间没有逐条勾选，因此不要把它读作实时记录；权威完成记录是
> [`pingo-ui-implementation-plan.md`](./pingo-ui-implementation-plan.md)
> 的进度总览表与验收标准表。

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。

**Goal:** 按 [`docs/e1-keyboard-events-design.md`](./e1-keyboard-events-design.md)
交付 keydown/keyup 全链路：schema/ABI → Core 焦点路由 → Shell 事件面 → Host 监听，
并升级 Tabs/Accordion/RadioGroup 的方向键导航。

---

### Task E1-1: schema 与生成代码

**Files:** `schemas/protocol.v1.json`、`scripts/generate-protocol.mjs`、生成产物

- [x] `abiVersion` 17 → 18。
- [x] `keyboardCodes` / `keyboardKeyNames` 闭集表（仅生成 TypeScript）。
- [x] `InputOpcode::DispatchKeyEvent = 54`（24 字节布局，见设计 §D2）。
- [x] `eventTransactions.Event` 追加 `keyCode/keyName/repeat/reserved/keyText`。
- [x] `pnpm protocol:generate`；Rust 侧只暴露两个上界常量。

### Task E1-2: ABI 编解码

**Files:** `core/pingo-abi/src/{input.rs,event_transactions.rs}`、
`packages/editing/src/{input-stream.ts,event-transactions.ts}`

- [x] `InputEventKind::KeyDown = 17`、`KeyUp = 18`（两侧）。
- [x] `InputCommand::DispatchKeyEvent` 编解码 + 校验（kind 必须是键类、
      id 上界、flags 保留位为零）。
- [x] `EventTransactionRecord` 四个新字段编解码 + 校验。
- [x] golden fixture 重生成 + TS↔Rust 往返 + malformed/fuzz。

### Task E1-3: Core 焦点路由

**Files:** `core/pingo-core/src/{interaction.rs,engine.rs}`

- [x] `InteractionCommand::DispatchKey`；无焦点则不产生记录。
- [x] 键事件不改变 interaction state（hover/active/focus 全部不动）。
- [x] 单测：有焦点→路径为 root→focus；无焦点→零记录；焦点失效后丢弃；
      编辑会话活跃时键事件与编辑事务互不影响。

### Task E1-4: Shell 事件面

**Files:** `packages/jsx/src/types.ts`、`packages/reconciler/src/reconciler.ts`、
`packages/facade`、api 快照

- [x] `PingoEvent` 增 `"keydown" | "keyup"` 与 `key` / `code` / `repeat`。
- [x] `CommonProps` 增 `onKeyDown(Capture)` / `onKeyUp(Capture)`。
- [x] 事件类型映射表与 `eventBubbles` 更新（键事件冒泡）。
- [x] `pnpm api:check` 快照按 docs/api/index.md 程序更新。

### Task E1-5: Host 监听与三 transport 一致性

**Files:** `packages/host/src/hosted-root.ts`

- [x] canvas `tabIndex` 兜底 + keydown/keyup 监听（非 passive）。
- [x] 组合中把 `keyName` 置为 `Process`。
- [x] 契约测试：三条 transport 下 keydown→keyup 顺序一致。
- [x] IME replay fixture 无回归（`pnpm ime:replay`）。

### Task E1-6: 组件方向键导航 + 门禁

**Files:** `packages/ui/src/components/{tabs,accordion,radio-group}.ts`

- [x] Tabs：Left/Right/Home/End 在 trigger 间移动并激活。
- [x] RadioGroup：Up/Down/Left/Right 在 item 间移动并选中。
- [x] Accordion：Up/Down 在 trigger 间移动，Enter/Space 展开。
- [x] 行为测试；全量门禁。
