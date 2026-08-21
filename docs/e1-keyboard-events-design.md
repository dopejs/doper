# E1 设计门：keyboard 事件

- 状态：Accepted
- 日期：2026-08-22
- 关联计划：[`pingo-ui-implementation-plan.md`](./pingo-ui-implementation-plan.md) Track B E1
- 后继解锁：E2（zIndex）、A2 弹层组件的 Esc/焦点导航

## 1. 问题

Core 已经拥有完整的 pointer/focus 事件面（`InputEventKind` 1–16），但没有任何
非编辑键盘输入通路。直接后果：

- Tabs / Accordion / RadioGroup 只能点，方向键导航无法实现（WAI-ARIA 要求）。
- A2 弹层组件的 Esc 关闭、Tab 焦点循环没有事件源。
- `packages/editing/src/native-input.ts` 里已有的 `keydown` 监听只服务
  undo/redo 快捷键，且只在编辑会话活跃时生效；它不是通用事件源，也不应该被扩成
  通用事件源——它属于编辑子系统。

## 2. 事实取证

- `InputEventKind`（`core/pingo-abi/src/input.rs:112`）是 `#[repr(u16)]`，
  1–16 已用，17 起可用。
- `InputCommand::DispatchEvent` = opcode 48，48–53 已用于 pointer/capture/focus，
  54 起可用。
- `EventTransactionRecord`（`core/pingo-abi/src/event_transactions.rs:15`）是
  **单一记录类型**：focus 记录已经把 pointer 字段整体置零
  （`focus_record`，同文件 543 行）。新增一类事件不需要新记录类型。
- `InteractionController` 已持有 `focus: Option<FocusState>`
  （`core/pingo-core/src/interaction.rs:73`），焦点目标解析不需要新状态。
- `scripts/generate-protocol.mjs` 从 schema 生成 opcode 枚举与
  `INPUT_LAYOUTS` 字节长度，Rust/TS 各一份；**编解码体是手写的**
  （`input.rs` / `packages/editing/src/input-stream.ts`）。

## 3. 决策

### D1：键标识用 schema 闭集 id，字符串只存在于 Shell

`KeyboardEvent.key` / `.code` 是字符串。逐帧把字符串塞进二进制流会带来分配与
不确定长度，且违反"避免 per-frame string allocation"。

编码三元组：

| 字段      | 类型  | 含义                                                      |
| --------- | ----- | --------------------------------------------------------- |
| `keyCode` | `u16` | `KeyboardEvent.code` 的 schema 闭集 id；`0` = 未识别      |
| `keyName` | `u16` | `KeyboardEvent.key` 中**具名键**的闭集 id；`0` = 非具名键 |
| `keyText` | `u32` | `key` 为单个 Unicode 标量时的码点；否则 `0`               |

Shell 侧重建 `key`：`keyName != 0` → 查表得名字；否则 `keyText != 0` →
`String.fromCodePoint`；否则 `"Unidentified"`。`code` 同理，查不到得 `""`。

**Core 不解释键。** 它只做路由，把三个标识原样透传。因此两张表**只生成
TypeScript**；Rust 只拿到 `MAX_KEYBOARD_CODE_ID` / `MAX_KEYBOARD_KEY_NAME_ID`
两个常量做边界校验。这与"Shell 拥有 CSS 文本与选择器、Core 只消费 canonical
typed values"是同一条边界。

**未识别键的行为**：Host 查不到 id 时写 `0`，事件照常路由。这是**有损但安全**的
降级——业务拿到空 `code`，但 `keyText` 仍然给出可打印字符。表可以增量扩充；
新增 id 对旧 Core 不构成破坏，因为 Core 只做上界校验，上界随 ABI 版本前进。

### D2：新增一条 Input 指令，而不是复用 DispatchEvent

`DispatchEvent`（68 字节）全是 pointer 几何，键盘事件一个都用不上。新增：

```
DispatchKeyEvent = 54:
  u32 eventId
  u16 kind          // InputEventKind::KeyDown = 17 | KeyUp = 18
  u16 flags         // bit0 = repeat
  u16 keyCode
  u16 keyName
  u32 keyText
  u32 modifiers
  u32 elapsedMicros
```

24 字节，四字节对齐。

### D3：反向记录复用 EventTransactionRecord，追加四个字段

`EventTransactionRecord` 追加 `key_code: u16`、`key_name: u16`、`key_text: u32`、
`repeat: bool`。pointer/focus 记录把它们置零，正如 focus 记录今天已经把
pointer 字段置零。

线上布局在 `cursor` 之后插入（原 `pad16` 被 `keyCode` 占用）：

```
... u16 cursor, u16 keyCode, u16 keyName, u8 repeat, u8 reserved, u32 keyText,
    u32 pathCount, bytes path, align4
```

每条记录 +8 字节。事件流是低频流（`maxBytes` 16 MiB，实际每帧几条），代价可接受。
**代价换来的是单一记录类型、单一解码器、单一传播路径**——Shell 的
`EventTransaction → PingoEvent` 映射不分叉。

`abiVersion` 17 → 18；golden fixture `benchmarks/abi/event-transactions.v1.json`
显式重生成并在提交信息里说明语义变更。

### D4：焦点即路由目标；无焦点即丢弃

键盘事件没有坐标，不做命中测试。路由路径 = `scene.path_to_root(focus_node)`，
capture/bubble 与 pointer 完全同一条 `dispatch_path` 实现（Shell 侧
`EventHandlerKey` 机制不变）。

- 无焦点节点 → **不产生任何记录**。这是刻意的：没有焦点时把事件送给 root 会让
  任意组件在未聚焦时截获按键，是 Web 上最常见的键盘 bug 来源。
- 焦点节点在本帧已失效 → `reconcile_scene` 已经会先清掉焦点，随后到达的键事件
  自然被丢弃。
- 键盘事件**不改变**焦点、hover、active 或任何 interaction state。焦点迁移仍由
  `FocusNode` / `BlurNode` / pointerdown 驱动；Tab 键的焦点循环是 Shell 的
  职责（业务在 `onKeyDown` 里调用 focus API），Core 不内建 tab order。

### D5：与编辑事务的边界（硬约束）

**编辑态输入绝不退化为 key 拼装。** 具体规则：

1. 文本插入只来自 `Insert` / `UpdateComposition` / `CommitComposition`
   指令，其来源是 EditContext / `beforeinput` / 剪贴板。**Core 永远不会**从
   `DispatchKeyEvent` 派生任何编辑事务。
2. `DispatchKeyEvent` 与编辑指令走同一条输入流、同一个 `frame_seq`，因此顺序
   确定；但它们在 Core 内是两个互不调用的子系统
   （`InteractionController` vs `EditingController`）。
3. 组合（IME）期间键事件照常路由——DOM 也是这样（`keydown` 的 `key` 为
   `"Process"`）。Host 在 `isComposing` 为真时把 `keyName` 置为 `Process` 的 id，
   业务据此忽略。既有 IME replay fixture 不得回归。
4. `preventDefault()` 对键事件只影响 Shell 侧传播（`stopPropagation` 语义），
   **不会**抑制编辑；编辑路径不读键事件。这条写进 `PingoEvent` 文档注释。

### D6：Host 侧监听点

- 监听器挂在 canvas 上，`keydown` / `keyup`，非 passive（业务要能
  `preventDefault` 阻止页面滚动）。
- canvas 需要可聚焦才能收到键盘事件：Host 在挂载时设置 `tabIndex = 0`
  （若宿主未显式设置）。这是 Host 的职责，不是业务的。
- `native-input.ts` 里既有的 `keydown` 监听**保持原样**：它服务编辑快捷键，与本
  通路正交，两者都会收到同一个 DOM 事件。

## 4. 出口门禁

1. ABI golden bytes 更新并解释；TS↔Rust 往返；malformed-input 与 fuzz 覆盖新字段。
2. keydown/keyup 事件顺序跨三条 transport（SAB / postMessage / 主线程）一致。
3. 既有编辑 fixture（IME composition replay）无回归。
4. `onKeyDown` / `onKeyUp` 进入 facade 公开面，api 快照按程序更新。
5. Tabs / Accordion / RadioGroup 方向键导航落地并有行为测试。

## 5. 备选方案

| 方案                                             | 未采用原因                                                     |
| ------------------------------------------------ | -------------------------------------------------------------- |
| key/code 以 UTF-8 变长字节进流                   | 逐事件分配 + 变长解码，违反热路径分配规则                      |
| Host 用 eventId 侧表把字符串带给 Shell           | 破坏录制/回放确定性（`ReplayRecording` 是一等能力）            |
| 复用 `DispatchEvent`，把键塞进 buttons/pointerId | 字段语义撒谎，解码器无法校验，评审不可读                       |
| 新增独立的 KeyEventTransaction 流                | 第二条反向流 + 第二套排序规则，事件顺序一致性成本远高于 8 字节 |
| 无焦点时路由到 root                              | 未聚焦组件截获按键，Web 上最常见的键盘 bug                     |
| Core 内建 Tab order                              | 焦点顺序是语义树与业务的职责；Core 不持有 DOM 式 tabindex 语义 |

## 6. 失败模式与回滚

| 失败模式                  | 表现             | 缓解                                                                  |
| ------------------------- | ---------------- | --------------------------------------------------------------------- |
| Host 键表缺项             | `code` 为空      | `keyText` 仍给出字符；表可增量补                                      |
| 焦点丢失导致按键"消失"    | 组件不响应方向键 | 无焦点不路由是显式语义，组件必须先聚焦；有行为测试                    |
| 键事件与编辑事务竞态      | 重复输入         | 两子系统不互调；IME replay fixture 守门                               |
| 新记录字段被旧 Shell 误读 | 解码失败         | 每条指令自带声明长度，长度不符即整批拒绝（fail closed），不会错位解析 |

**回滚**：从 schema 移除 `DispatchKeyEvent` 与两条 `InputEventKind`，重新生成；
Host 不再注册监听器；`EventTransactionRecord` 的四个字段恒为零，可在后续版本
随 ABI 变更移除。Shell 的 `onKeyDown/onKeyUp` 从 facade 撤出。
