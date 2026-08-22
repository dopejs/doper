# pingo-ui 实现总计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

## 进度总览（2026-08-22 更新）

| Track                                                    | 状态    | 证据                                                                                                                                           |
| -------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| C0 m10 决策修订                                          | ✅ 完成 | `a88dfa9`                                                                                                                                      |
| A0 阶段0（骨架+cva+theme+皮肤管线+5 样板组件+storybook） | ✅ 完成 | 子计划 `pingo-ui-phase0-implementation-plan.md`，35/35 测试                                                                                    |
| A1 阶段1（第一批剩余 12 组件 + README + 暗色覆盖）       | ✅ 完成 | 17 组件全部交付，104/104 包测试、496/496 全仓、明暗截图验证                                                                                    |
| E6 组件级 memo                                           | ✅ 完成 | `a923e61…abc3d8d`，子计划 `pingo-ui-e6-implementation-plan.md`                                                                                 |
| E7 context（Provider+useContext）                        | ✅ 完成 | `34145ee…bf81554`，子计划 `pingo-ui-e7-implementation-plan.md`                                                                                 |
| E5 flexGrow/Shrink/Basis                                 | ✅ 完成 | 设计门 `e5-flex-grow-design.md`，子计划 `pingo-ui-e5-implementation-plan.md`；`40f06a1…feedf85`                                                |
| E1 keyboard 事件                                         | ✅ 完成 | 设计门 `e1-keyboard-events-design.md`，子计划 `pingo-ui-e1-implementation-plan.md`；`ba9d1fd…055c117`                                          |
| W0 WASM 体积归因与回收                                   | ✅ 完成 | **计划外必需前置**（见下）；`30d33e8`，回收 30,321 gzip bytes                                                                                  |
| E4 boxShadow                                             | ✅ 完成 | 设计门 `e4-boxshadow-design.md`；`d462a96`                                                                                                     |
| E2 zIndex                                                | ✅ 完成 | 设计门 `e2-zindex-design.md`；`62850ea…e0b9347`                                                                                                |
| E3 position/inset                                        | ✅ 完成 | 设计门 `e3-position-design.md`；`6c72939`                                                                                                      |
| A2 第二批弹层组件                                        | ✅ 完成 | 子计划 `pingo-ui-overlay-components-plan.md`；`0a43cf1`                                                                                        |
| A3 第三批产品分子                                        | ✅ 完成 | 子计划 `pingo-ui-product-molecules-plan.md`；`55cde8d`。无试点 fixture，规格取自计划点名的四个组件                                             |
| E8 布局回读 + 碰撞感知定位                               | ✅ 完成 | 设计门 `e8-layout-readback-design.md`（Accepted，D1–D9），子计划 `pingo-ui-e8-implementation-plan.md`；`7d49cdf…` 共 8 个 Task。默认 flag 关闭 |

**接手指引**：引擎工作包按各自设计门启动（设计文档评审 → 写 `docs/pingo-ui-e<N>-implementation-plan.md` 子计划 → subagent 执行）；组件批次按本文件规格表执行。已完成的子计划内 checkbox 状态以本表为准。

**执行期新发现**（影响后续工作）：

- overflow 容器内子节点百分比尺寸解析为 0 —— **已在 E5 修复**（`40f06a1`）：
  百分比基准与测量约束分离，按容器自身 content box 解析。
- 有 hooks 的组件必须经 createElement/JSX 使用（已写入 packages/ui/README.md 与组件 docstring）。
- **WASM 工程预算一度耗尽（新增 Track W0）**：E5+E1 交付后产品 Core WASM 为
  393,174 gzip bytes，工程上限 393,216，余量仅 42 bytes。
  `docs/wasm-size-attribution.md` 规定"gzip 超过 384 KiB：停止新增 Rust 能力"，
  E4/E2/E3 因此全部阻塞。按需求方决策先做体积归因与回收：
  `scripts/attribute-wasm-code.mjs`（新增诊断脚本）把 code section 按函数归因，
  查出 `BTreeMap`/`BTreeSet` 的约 20 组单态化占了整个 code section 的 **22.2%**；
  新增 `core/pingo-collections` 用有序 Vec 替换其中"小的或批量重建的"映射，
  产品模块降到 362,853 gzip bytes。E4/E2/E3/A2 之后仍余 23,401 bytes。
- **两处既有门禁在本轮之前已经是红的**，顺带修复：
  `pnpm format:check` 对 41 个文件失败（`1d3cdc7`），
  `packages/ui` 的皮肤生成器产出未经 Prettier 格式化因而每次构建都会再次变红
  （`feedf85`）。这两条意味着 `pnpm m0:check` 在本轮之前无法通过。
- **修复的既有缺陷**（差分测试与归因过程中发现）：百分比 margin 在测量与排布阶段
  用了不同基准；读取父百分比基准的节点被当作 relayout 包含边界，增量与全量结果
  会不一致；跨分支重叠的命中判定用拓扑序而不是绘制序。

---

**Goal:** 交付 `@dopejs/pingo-ui` 组件库全量：三批组件（17 静态 + 8 弹层 + 产品分子按需）、六个引擎工作包（E1–E6）、m10 决策修订，全部过既有工程门禁。

**Spec:** [`docs/pingo-ui-capability-plan.md`](./pingo-ui-capability-plan.md)。本文件是执行总控；各 Track 的子计划在启动门前单独成文，本文只维护索引与接口契约。

**结构判断**：组件库 Track（A）设计已定，给完整任务分解；引擎 Track（B）每项涉及 ABI/协议/布局语义决策，设计未定——直接写实现任务等于编造，因此每个 E 包设**设计门**（设计文档评审通过 → 写子计划 → 执行），本文给出范围、接口契约、门禁与预估分解。

---

## 0. 全局依赖与排序

```
Track A（组件库，纯 TS，不依赖 Track B 即可交付第一批）
  A0 阶段0：包骨架 + cva + theme + 皮肤管线 + 5 样板组件 + storybook
  A1 阶段1：第一批剩余 12 组件 + E6 接入 + 暗色全覆盖 + 覆盖约定文档
  A2 阶段3：第二批 8 弹层组件（硬依赖 E1/E2/E3，视觉完整依赖 E4）
  A3 第三批：产品分子（TopBar/Sidebar/StatCard/ListRow）

Track B（引擎工作包，各自独立 feature bit）
  E6 组件级 memo        纯 Shell runtime  │ 已完成（2026-08-21）
  E7 context（Provider + useContext）     │ 纯 Shell runtime/reconciler，无 ABI；
                                           复合组件（Tabs/Accordion/RadioGroup/Select/Menu）
                                           的 shadcn 组合式 API 前置；排在 A1 之前
  E5 flexGrow/Shrink/Basis               │ 前置：flex reference oracle 设计
  E4 boxShadow                           │ 前置：value tag/DisplayList 设计
  E1 keyboard 事件                       │ 前置：协议 Input 指令设计
  E2 zIndex                              │ 前置：Track C
  E3 position/inset                      │ 前置：Track C + E2

Track C（决策修订）
  C0 修订 m10-capability-decisions.md 的 overlay/absolute positioning Defer
     （以 pingo-ui 弹层需求为产品 fixture）→ 同步 design.md §12.1 支持表

关键路径：C0 → E1 → E2 → E3 → A2
并行线：A0 → A1（不等 B）；E4/E5/E6 随时可插入
```

排序原则：A0/A1 不等任何引擎工作；E6 在 A1 期间落地以支撑 slot 契约；E5 在
Input slot 补齐前落地；C0 是 E2/E3 的唯一解锁点，**最早启动**。

---

## Track C：m10 决策修订（最先启动，1 个任务）

### Task C0: 修订 overlay/absolute positioning Defer 决策

**Files:**

- Modify: `docs/m10-capability-decisions.md`
- Modify: `docs/design.md`（§12.1 支持表段落）

- [x] **Step 1: 修订 m10 决策表**

将"overlay/absolute positioning 与 widgets placeholder"行从 Defer 改为 Adopt（附
决策日期与理由）：产品 fixture = pingo-ui 第二批弹层组件（Dialog/Popover/Tooltip/
DropdownMenu/Select/Command/Sheet/Toast 的层叠、锚点、焦点场景）；采用前预算与
oracle 列不变，转为 E2/E3 的出口条件；回滚边界不变（feature bit 关闭拒绝新值）。

- [x] **Step 2: 同步 design.md §12.1**

在 CSS 支持表段落追加 position/zIndex 为"已立项、feature-bit 门控、未交付"状态；
遵守 AGENTS.md"未来 CSS/事件扩展在实现和自动验证前不得写成已交付 API"。

- [x] **Step 3: Commit**

```bash
git add docs/m10-capability-decisions.md docs/design.md
git commit -m "docs(m10): adopt overlay positioning for pingo-ui fixture"
```

---

## Track B：引擎工作包

每个 E 包的统一生命周期：

```
设计门：子设计文档（docs/ 下，评审通过）
  → 子计划：docs/pingo-ui-e<N>-implementation-plan.md（bite-sized TDD）
  → 执行 → 出口门禁（下表）→ feature bit 默认关闭合并或按门禁开启
```

统一约束（全部 E 包）：schema/ABI/Core/Shell 原子提交；生成代码、fixtures、双语言
同步；每项带独立 feature bit；遵守 design.md §15 测试层级。

### E1 keyboard 事件

- **设计门**：`docs/e1-keyboard-events-design.md`。内容：Core 输入流非编辑 key
  record 的语义（keydown/keyup、key/code/repeat/修饰键、与 editing transaction 的
  边界——编辑态输入绝不退化为 key 拼装）、焦点目标解析（事件路由到当前 focus
  节点，capture/bubble 与 pointer 同路径）、三 transport 行为一致性。
- **范围**：protocol.v1.json Input 指令 + 编码 → Core 路由 → `PingoEvent` 增加
  `keydown/keyup`（`key/code/repeat`）→ `CommonProps.onKeyDown/onKeyUp`。
- **出口门禁**：ABI golden bytes + TS/Rust 往返 + malformed-input/fuzz；事件顺序
  跨三 transport 一致；编辑 fixture（IME composition）无回归。
- **预估分解**：协议与编码 → Core 路由与焦点集成 → Shell 事件面 → 测试与 fuzz →
  门禁。5 个子计划任务。

### E2 zIndex

- **前置**：C0。
- **设计门**：`docs/e2-zindex-design.md`。内容：paint/hit/semantics 顺序与 Scene
  拓扑序的关系（重叠命中从"拓扑序最后绘制者"改为"paint 序最后绘制者"）、稳定
  排序结果的缓存策略（禁止每帧排序）、无障碍顺序资格方案。
- **范围**：schema 新 longhand（canonical keyword 或 integer，设计门定）→ Core
  paint/hit/semantics 顺序。
- **出口门禁**：增量↔全量 paint/hit oracle；semantics 顺序 E2E；帧时预算不回归。
- **预估分解**：schema+生成 → paint 顺序 → hit 顺序 → semantics 顺序 → 缓存与
  门禁。5 个子计划任务。

### E3 position:absolute + inset

- **前置**：C0 + E2。
- **设计门**：`docs/e3-position-design.md`。内容：`static/absolute` 语义、inset
  展开、最近 positioned 祖先解析、脱离 flex 流的布局路径、hit/clip/semantics 同步、
  与滚动容器的交互（absolute 节点是否参与 scroll extent——设计门定）。
- **出口门禁**（m10 决策表原文）：layout/hit/clip/semantics 增量↔全量 oracle、
  帧时与节点预算、feature bit 关闭后拒绝新值且 flow layout 不变。
- **预估分解**：schema+Shell parser → Core layout 定位路径 → hit/clip/semantics →
  oracle 与差分 → 门禁。5–6 个子计划任务。

### E4 boxShadow

- **设计门**：`docs/e4-boxshadow-design.md`。内容：canonical value tag（shadow
  列表）、rgba8 半透明色、DisplayList shadow 指令 vs 资源、Canvas2D `shadow*` 映射
  与圆角矩形语义、picture cache paintSelf 失效、`stateStyleProperties` 注册（仅
  paint 失效）。
- **出口门禁**：增量↔全量像素差分（含 hover 阴影切换）；picture cache 失效正确
  性；后端差分测试 tolerance 内。
- **预估分解**：schema+value tag+编解码 → Shell parser → Core paint → Canvas2D
  回放 → 缓存失效与门禁。5 个子计划任务。

### E5 flexGrow / flexShrink / flexBasis

- **设计门**：`docs/e5-flex-grow-design.md`。内容：reference oracle 选型（ naive
  全量布局参考实现做差分）、三 longhand 的 canonical（`number`/`length` 复用）、
  主轴剩余空间分配语义（与 css-events-plan 既定口径对齐）。
- **出口门禁**：oracle 先行——reference 建立并通过评审后才开放语法；增量↔全量
  差分 + shrinking 到最小失败；invalidation 域与 flexDirection 一致。
- **预估分解**：reference oracle → schema+生成 → solver 扩展 → 差分测试 → 开放
  语法与门禁。5 个子计划任务。

### E6 组件级 memo（无设计门，直接子计划）

- **理由**：纯 Shell runtime，无 ABI、无 Core、无 m10 前置；语义照 React.memo。
- **范围**：`packages/runtime` 或 `packages/reconciler` 增加
  `memo(Component, arePropsEqual?)`；reconciler `updateInstance` 在组件 descriptor
  变化时先走 props 浅比较 bailout（`arePropsEqual` 默认浅比较，函数 prop 按引用）；
  signal 订阅的 dirty marking 与 memo 正交，不受影响。
- **出口门禁**：现有 reconciler 测试全绿；新测试覆盖——props 未变不 re-render、
  props 变 re-render、signal 命中仍 re-render（memo 不挡 signal）、自定义
  arePropsEqual、key 变化绕过 memo。
- **预估分解**（4 个任务，子计划 `docs/pingo-ui-e6-implementation-plan.md`）：
  1. memo wrapper + 类型；2. reconciler bailout 接入；3. signal 正交性测试；
  2. pingo-ui 组件接入（Button/Badge/Card 等纯展示组件包 memo）+ 门禁。

---

## Track A：组件库

### A0 阶段0（设计已定，子计划已就绪）

**子计划**：[`docs/pingo-ui-phase0-implementation-plan.md`](./pingo-ui-phase0-implementation-plan.md)
（11 个 Task：包骨架、cva-lite、theme signal、SCSS 皮肤管线 + shadcn preset、
Button/Badge/Card/Input/Label、storybook 明暗切换、全量门禁）。

出口：32 条 vitest 全绿 + storybook 明暗两主题人工验证 + `pnpm test:run` 全仓回归。

### A1 阶段1：第一批剩余 12 组件

统一模式（每个组件一个 Task，TDD 同 A0）：皮肤 SCSS（token-only）→ 组件 TS →
descriptor 测试 + 皮肤解析测试 → storybook 展区。**组件模板以 A0 Button/Card 为
基准；下表给出每个组件的 API 与皮肤规格，全部值具体可执行。**

通用 props：`className?`（追加最后）、`semanticLabel?`、theme 经 `useTheme()` 内部
注入。所有组件在 E6 落地后用 `memo` 包装（A1 Task 13）。

| #   | 组件            | props（除通用）                                                                                                                                               | variants / 皮肤类                                                                          | 关键皮肤值（引用 token）                                                                                                                    |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | IconButton      | `icon: PingoNode`、`onPress?`、`disabled?`                                                                                                                    | variant 同 Button（复用 `.pui-button--*` + `.pui-button--icon`）                           | 36×36；icon slot 透传（§6.2.1 契约）                                                                                                        |
| 2   | Divider         | `orientation?: "horizontal"\|"vertical"`                                                                                                                      | `.pui-divider` / `.pui-divider--vertical`                                                  | horizontal: height 1px、background `$border`；vertical: width 1px、stretch                                                                  |
| 3   | Skeleton        | `width?`、`height?`                                                                                                                                           | `.pui-skeleton`                                                                            | background `$accent`（dark `$dark-accent`）、radius `$radius-md`；无动画（CSS 动画不在子集）                                                |
| 4   | Alert           | `title: string`、`children: string`、`variant?: "default"\|"destructive"`                                                                                     | `.pui-alert` / `.pui-alert--destructive` + `.pui-alert__title` / `.pui-alert__description` | padding 16、radius `$radius-lg`、border `$border`；destructive: border `$destructive`、title color `$destructive`                           |
| 5   | Avatar          | `src?: string`、`fallback: string`、`size?: number`（默认 40）                                                                                                | `.pui-avatar` + `.pui-avatar__fallback`                                                    | 圆形 radius = size/2；无 src 时显示 fallback 文本（conditional render，不需要引擎能力）                                                     |
| 6   | Progress        | `value: number`（0–100）、`max?: number`                                                                                                                      | `.pui-progress` + `.pui-progress__indicator`                                               | 轨道 height 8、radius 4、background `$secondary`；指示条 width 由 style prop 百分比设置（`width: "${pct}%"`——% 长度已支持，不需要引擎能力） |
| 7   | Switch          | `checked: boolean`、`onCheckedChange?`、`disabled?`                                                                                                           | `.pui-switch`(+`--checked`/`--disabled`) + `.pui-switch__thumb`                            | 轨道 44×24 radius 12；thumb 20×20 radius 10；checked 位移用 margin-left 20px（无 transform 需要）；Pressable 承载交互                       |
| 8   | Checkbox        | 同 Switch + `label?: string`                                                                                                                                  | `.pui-checkbox`(+`--checked`) + `.pui-checkbox__indicator`                                 | 16×16 radius 4 border；checked: background `$primary` + 勾选标记用 Text "✓"（字体回退风险→设计时用图片或几何图形评估，子计划定）            |
| 9   | RadioGroup      | **组合式（E7 context）**：`RadioGroup({ value?, onValueChange?, disabled?, children })` + `RadioGroupItem({ value, label? })`                                 | `.pui-radio`(+`--checked`) + `.pui-radio__indicator`                                       | 16×16 圆形 border；checked 内点 8×8 圆形 `$primary`；组状态经 RadioGroupContext 分发                                                        |
| 10  | Tabs            | **组合式（E7 context）**：`Tabs({ value?, onValueChange?, children })` + `TabsList` + `TabsTrigger({ value, children })` + `TabsContent({ value, children })` | `.pui-tabs` + `.pui-tabs__list` + `.pui-tabs__trigger`(+`--active`) + `.pui-tabs__content` | list: background `$secondary` padding 4 radius；trigger active: background `$background`；pointer 交互，方向键导航等 E1 后升级              |
| 11  | Accordion       | **组合式（E7 context）**：`Accordion({ openValue?, onValueChange?, children })` + `AccordionItem({ value, title, children })`                                 | `.pui-accordion__item` / `__trigger`(+`--open`) / `__content`                              | item border-bottom `$border`；open 状态条件渲染 content                                                                                     |
| 12  | TextArea 装饰版 | 同 Input（无 slot）                                                                                                                                           | `.pui-input` 复用 + `.pui-textarea`                                                        | rows 默认 3；复用 Task 8 Input 的 controller 模式                                                                                           |

- [x] **A1 Tasks 1–12**：按上表逐组件实施（皮肤 → 组件 → 测试 → storybook 展区）。
      每组件 commit 一次。token 缺口（如 muted 背景）在 tokens.scss 追加并记录。
      **已完成（Batch A/B/C，2026-08-21）**：12 组件全部交付，组合式 API 经 E7 context 落地。
- [x] **A1 Task 13**：E6 接入——全部展示组件用 `memo` 包装；补 memo 行为测试。
      **提前完成**（E6-4 随 memo 落地一并接入；Input 在 A1-D 补齐一致性包装）。
- [x] **A1 Task 14**：暗色全覆盖审查——storybook 每组件 light/dark 双 story；
      像素快照（补充断言，语义树 E2E 为主）。**已完成**：showcase 明暗双 story + browser 截图验证。
- [x] **A1 Task 15**：覆盖约定文档化——`packages/ui/README.md`：sheet 注册顺序
      （用户 sheet 必须在 pingo-ui sheet 之后）、token-only 约束、preset 定制方法
      （`@use ... with`）、已知视觉缺口清单。**已完成**（1fd7af4 + 31f8b34 评审修正）。
- [x] **A1 Task 16**：门禁——`npx vitest run packages/ui` 全绿、`pnpm test:run`
      全仓回归、storybook build。**已完成**（104/104、496/496、typecheck/api:check 全绿）。

### A2 阶段3：第二批弹层组件（硬依赖 E1/E2/E3，视觉完整依赖 E4）

**启动门**：E1/E2/E3 出口门禁通过；E4 至少合并（可 feature-flag）。启动时先写
子计划 `docs/pingo-ui-overlay-components-plan.md`，内容必须含：

- `Overlay` 基元设计：zIndex 层叠管理（分层 token：dropdown 1000 / overlay 1100 /
  toast 1200）、position/inset 锚定 API（`anchor: () => Rect` 或 `placement`，
  子计划定）、Esc 关闭与焦点导航（E1）、焦点陷阱/restore 语义（基于已有 focus
  事件面评估后定，不提前承诺 API）、滚动中锚点跟随（Core 定位天然跟随，需验证）。
- 8 组件清单：Dialog、Sheet、Popover、Tooltip、DropdownMenu、Select、Command、
  Toast。统一 API 契约沿用 §6（variant/size/className/slot 透传）。
- 测试：层叠顺序、锚点定位、Esc/焦点导航、滚动中跟随、light/dark。

### A3 第三批：产品分子（已交付）

TopBar、Sidebar、StatCard、ListRow。子计划：
[`docs/pingo-ui-product-molecules-plan.md`](./pingo-ui-product-molecules-plan.md)。

**立项偏差（必须记录）**：原定启动条件是"试点业务有明确需求 fixture"，实际是
需求方直接要求交付，**没有 fixture**。因此规格来源只有本文与
`pingo-ui-capability-plan.md` §8 点名的四个组件，"等"字覆盖的其余组件不做——
没有 fixture 就扩清单正是原计划要避免的事。若后续试点提出新组件，按同一模式
在子计划里追加。

四个组件都不需要新引擎能力，是 E5 `flexGrow` 的第一批真实消费者：
TopBar 的标题列、StatCard 的数值、ListRow 的文本列都是伸缩件，尾部 slot 因此
落在边缘，不需要任何测量。

---

## 验收标准（每步出口的固化门禁）

所有步骤的通用门禁（缺一不可）：`pnpm test:run` 全绿、`pnpm typecheck` 全绿、
`pnpm api:check` 通过（公开面变更必须按 docs/api/index.md 程序更新快照并说明理由）、
凡动 `core/` 必须 `pnpm rust:test`（禁止裸 cargo）、凡动 ABI 必须 golden bytes +
TS/Rust 往返 + malformed-input/fuzz。

### 已完成步骤的验收记录

| 步骤 | 验收标准                                                                                                                                                                                                                                                                                                                                                                       | 证据              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| C0   | m10 决策行 Defer→Adopt；design.md §12.1 同步                                                                                                                                                                                                                                                                                                                                   | `a88dfa9`         |
| A0   | cva/theme/皮肤/组件测试 35 全绿；storybook 明暗截图确认；全仓回归绿                                                                                                                                                                                                                                                                                                            | `2addeb3…6a5fa4b` |
| E6   | memo 5 语义测试 + signal 正交测试；api:check 快照纯增量；全仓 416 绿                                                                                                                                                                                                                                                                                                           | `a923e61…abc3d8d` |
| E7   | 7 条 context 行为测试；repo typecheck 绿；全仓 429 绿                                                                                                                                                                                                                                                                                                                          | `34145ee…bf81554` |
| A1   | 17 组件交付；104/104 包测试；全仓 496 绿；明暗 showcase 截图确认；README 覆盖约定/约束/缺口清单                                                                                                                                                                                                                                                                                | `a8b8b66…31f8b34` |
| E5   | reference oracle（递归、非增量、`#[cfg(test)]`）与引擎差分 8000 例；flex 单测 6 条；增量↔全量 flex proptest；schema/生成/`style-support.md` 原子同步；feature gate 逐条拒绝；Input `prefix`/`suffix` slot                                                                                                                                                                      | `40f06a1…feedf85` |
| E1   | ABI golden 重生成（逐字节审计）；TS↔Rust 往返；malformed/fuzz；Core 焦点路由 3 条；Shell 传播 2 条；Host 键表/组合/焦点性 3 条；三 transport 顺序一致；IME fixture 无回归；组件方向键导航 8 条                                                                                                                                                                                 | `ba9d1fd…055c117` |
| W0   | 按函数归因（`scripts/attribute-wasm-code.mjs`）；`OrderedMap`/`OrderedSet` 与 `BTreeMap` 的 4000 步随机操作流差分；gzip 393,174 → 362,853；m1 回到基线 ±1%                                                                                                                                                                                                                     | `30d33e8`         |
| E4   | box-shadow 解析 7 条非法输入拒绝；paint 顺序/spread 折叠单测；hover 阴影像素差分 + 增量↔冷启动一致；replayer 契约测试；headless box-blur oracle；display-list golden 含 shadow 指令                                                                                                                                                                                            | `d462a96`         |
| E2   | z-index 解析（整数/auto/拒绝小数）；paint 顺序单测；hit 顺序（BVH 与 naive 双路）；无 z-index 时零开销路径                                                                                                                                                                                                                                                                     | `62850ea…e0b9347` |
| E3   | oracle 差分 8000 例（含 position/inset 生成）；insets 定位与尺寸单测；脱离流不撑大容器单测；`inset` shorthand 与关键字拒绝                                                                                                                                                                                                                                                     | `6c72939`         |
| A2   | 8 组件 + Overlay 基元；33 条组件测试（层叠顺序、锚定结构、Escape、焦点交接、键盘导航、过滤、明暗）；skin 层级断言；storybook 明暗展区                                                                                                                                                                                                                                          | `0a43cf1`         |
| E8   | `ObserveGeometry` opcode 96 + `layoutGeometryBatch`（golden/往返/malformed/fuzz）；Core 循环外重算几何并断言与循环内逐位一致；观察集上界 64 双层执行（Shell 排队 + Core 兜底）；三处 Host 通道与乱序丢弃；`useLayoutValue`/`useViewport` + facade 快照；四条定位策略含 4000 例 property test；四个弹层接入 + storybook 三展区；`pnpm e8:perf` 断言成本随观察数而非场景规模增长 | `7d49cdf…`        |
| A3   | 4 产品分子；22 条组件测试（伸缩列位置、slot 缺省、trend 三态、禁用无 handler、键盘导航、明暗）；skin 断言伸缩件与 trend 色；storybook 明暗展区                                                                                                                                                                                                                                 | `55cde8d`         |

**全量门禁（2026-08-22 收尾复跑，全部通过）**：`pnpm m1:check` 退出码 0——它包含
`m0:check`（lockfile、format:check、build、lint、typecheck、vitest、
contracts:check、rust:check）、`coverage:ts`、`coverage:rust`（整仓行覆盖 ≥85%，
`pingo-abi` / `pingo-scene` / `pingo-scroll` ≥95%、`pingo-text` ≥94%）、
`test:browser`、`m1:perf`。`pnpm m1:perf` p95 **3.000ms** / dropped 0 /
over-invalidated 0；`pnpm m2:check`、`m3:check`、`m3:scroll:check`、
`m3:text:check` 全绿；`pnpm m3:perf` p95 0.792µs；`pnpm m3:diff` 与
`m3:scroll:check` native/wasm 逐字节一致；`pnpm m5:backend:diff` GPU 与 headless
oracle 一致；`pnpm release:check`、`pnpm migration:check`、`pnpm storybook:build`
通过；WASM **369,945 / 393,216** gzip（余量 23,271）。

> 复跑发现并修掉一个此前**没被发现的红灯**：`pingo-abi` 行覆盖 94.77% 低于
> `coverage:rust` 的 95% 门槛，`m1:check` 因此一直是红的——之前的验收只跑到
> `rust:check`（跑测试，不跑覆盖率门槛）。未覆盖的正是 computed-style 解码器的
> 拒绝分支，其中 box-shadow 那批是 E4 引入却没有补 malformed-input 测试，而
> AGENTS.md 对 ABI 变更明确要求这一层。已补齐（`f2400c2`），95.20%。

### 残余风险与验证缺口

逐条处置见下。**已收口**的条目保留在这里是为了记录判断依据，不代表仍有敞口。

- **帧时相对基线上升约 5%** —— **已收口**。原判断认为"是否有节点声明该属性"必须
  每帧每节点查一次、只能留作后续优化；实际它是**提交期**才会变的事实。Scene 现在
  在两条 commit 路径上各维护一次 `StyleCapabilities`（`2933441`），z-index 与
  position 的每节点查询降为每帧一次布尔读。m1 p95 从 3.23ms 回到 3.158ms，相对
  基线 3.048ms 剩余 +3.6%，其中 +2.7% 是 W0 本身——即用 2.7% 帧时换 30KB WASM，
  没有它 E4/E2/E3 都上不了。绝对门禁仍有大量余量。
- **弹层焦点陷阱** —— **已收口，且原判断是错的**（`8171d7d`）。原因写的是"需要
  引擎侧 tab order"，方向反了：Core **根本没有** tab order，所以 Tab 不会移动焦点，
  焦点也不可能从弹层漏出去，模态的 backdrop 吸掉了唯一另一种移动焦点的方式（指针
  按下）。没有可陷之物。真正缺的是反面——键盘用户**进不去**面板内的控件。现在
  `OverlayFocus` 带 `focusable(order)` / `cycle(backward)` 登记表，
  `overlayKeyHandler` 在其上循环 Tab / Shift+Tab 并保留 Escape；Dialog / Sheet /
  Popover 通过 `OverlayFocusContext` 把登记表交给调用方渲染的内容，
  `useFocusableRef(order)` 是公开入口。Menu / Select / Command 保留方向键，那是这
  几个 role 的正确模式。
- **CSS 子集既知偏差中唯一"静默"的一条** —— **已收口**（`5c09b91`）。`min-width` /
  `min-height` 沿用了 `width` 的 `length-auto` grammar，但 `auto` 在最小值上无法
  兑现：解析通过、`outer_dimension` 落到 `unwrap_or(0.0)`，写了内容下限的样式表干净
  编译然后运行时缩成零。现改为 `non-negative-length`，`auto` 与负值都在编译期报
  `unsupported-value`（带属性与源位置），`cssSubsetVersion` → `1.6.0`。其余九条要么
  本来就有诊断（`position: relative`、`flex-wrap`、`inset` 阴影），要么偏差本身被
  note 精确描述，属于**刻意的子集边界**而非缺陷。
- **自动翻转** —— **已实现（E8）**，默认 flag 关闭。下面是立项时的分析，保留是为了
  记录判断依据。设计门
  [`e8-layout-readback-design.md`](./e8-layout-readback-design.md)（D1–D8）与子计划
  [`pingo-ui-e8-implementation-plan.md`](./pingo-ui-e8-implementation-plan.md)
  （E8-1…E8-8）已就绪；下面是立项时的分析，方案取舍见
  [`overlay-auto-flip-design.md`](./overlay-auto-flip-design.md)。"翻转"是窄化说法：
  浮层定位需要 `flip` / `shift` / `size` / `hide` 一族策略，它们吃同一个输入（锚点
  绝对 rect + 裁剪边界 + 浮层自身尺寸），因此要立的项是**碰撞感知定位**。阻塞点是
  Shell 没有面向组件的几何查询：`NodeHandle` 无几何，`useLayoutValue` 没有实现。
  已有的两条几何通道都不顶用——编辑几何是单主体的，语义快照虽然带每节点根坐标
  绝对 rect（Popover trigger 因为有 `semanticRole` 已在其中），但不含无 role 的浮层
  内容本身、是 a11y 节奏的全量快照、也不带裁剪信息。它是可行性先例，不是捷径。
  **裁剪边界已定为视口**（设计文档 §2.1）：canvas 根盒子，Shell 本来就拥有；且
  `pingo-hit` 已在每节点做裁剪祖先按轴求交，有效裁剪框现成，Shell 不必走祖先链，
  只需 Core 侧把未裁剪的 `own_aabb` 一并保留。该决定同时**解耦**了本项与"包含块是
  父节点"偏差——定位基准与裁剪边界是两个问题，可单独推进。建议先补
  `useLayoutValue`（A 方案），策略上线顺序 `size` → `shift` → `flip` → `hide`；
  在那之前维持静态方向并在 README 明说。
- **E8 的两处验证缺口** —— 其一，几何只有两条路径（主线程直调、worker 消息），两条
  各有测试，但**没有把同一场景跑完整两遍再比较结果**——那需要能驱动真实 worker 的夹具，
  本仓库没有。其二，定位在**真实浏览器里的视觉正确性**只有 storybook 的三个展区供人工
  查看，没有像素断言；`placeAnchored` 的数学有 4000 例 property test，但"算对了"和
  "看起来对"之间那一步仍靠人眼。
- **A3 是无 fixture 立项** —— **无法收口，属于立项前提缺失**。原计划要求"试点业务有
  明确需求 fixture"才启动，实际没有。因此只做了计划点名的四个组件，API 由"分子=组合
  前两批"与"shadcn superset"两条约束推导。试点接入后若与实际需求不符，改的是这四个
  的 API，不是引擎。
- **平台资格未做** —— **本环境无法收口**。真机帧时、真实 IME、跨浏览器均未验证，且
  没有可用的自动化设备服务。按 AGENTS.md 这属于平台资格而不是工程完成度：它必须保持
  可见，但不把已完成的工程项标记为未完成。
- **CSS 子集的其余既知偏差**共 9 条，集中记录在 `docs/style-support.md`
  「Known deviations from CSS」，其中最可能被踩到的是：绝对定位的包含块是父节点、
  不确定轴上的百分比解析为 0。

## 验证矩阵（每个阶段出口必过）

| 层          | 命令 / 方式                                           | 适用                    |
| ----------- | ----------------------------------------------------- | ----------------------- |
| 组件单元    | `npx vitest run packages/ui`                          | A0/A1/A2 每 Task        |
| 观察态性能  | `pnpm e8:perf`（导出成本随观察数而非场景规模增长）    | E8-3 及之后每次改动     |
| 皮肤解析    | `packages/ui/src/styles.test.ts`（resolveStyle 断言） | 每皮肤变更              |
| 全仓回归    | `pnpm test:run`                                       | 每阶段出口              |
| Rust        | `pnpm rust:test`（不用裸 cargo）                      | E1–E5 每 Task           |
| ABI         | golden bytes + TS/Rust 往返 + fuzz                    | E1/E4/E5（凡 ABI 变更） |
| 差分 oracle | 增量↔全量 layout/paint/hit/semantics                  | E2/E3/E4/E5             |
| 像素        | 后端差分（tolerance 内）                              | E4、A2 弹层             |
| storybook   | build + 明暗人工/browser 截图验证                     | A0/A1/A2 出口           |
| 边界        | `check-style-preprocess-boundary.mjs` 等既有脚本      | 全仓回归内含            |

## 风险与回滚

| 风险                                                                                                                                                 | 缓解                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E2/E3 周期拖累 A2                                                                                                                                    | A0/A1 独立交付 17 组件；弹层不阻塞                                                                                                                     |
| m10 修订后 oracle 不达标                                                                                                                             | feature bit 关闭即回滚，flow layout 不变（决策表原边界）                                                                                               |
| E6 memo 与 signal 交互出微妙 bug                                                                                                                     | 出口门禁含 signal 正交性测试；memo 包装逐组件可回退                                                                                                    |
| 弹层 API 提前泄露给业务                                                                                                                              | A2 启动门前 facade 不导出任何 Overlay 符号                                                                                                             |
| 皮肤体积随组件数增长                                                                                                                                 | themed 规则仅皮肤属性；按组件分包 sheet 留作后续优化                                                                                                   |
| **overflow 容器内百分比尺寸归零**（2026-08-21 实证）：非 visible overflow 使 View 成为滚动容器，内容获得不定 inline basis，子节点百分比宽/高解析为 0 | 组件规避（Progress 轨道已去掉 overflow:hidden）；引擎语义是否修正（clip-only overflow 不应给出不定 inline 约束）列入 E track 候选，E5 设计门时一并评估 |

---

## 执行顺序（任务级）

```
1.  C0（m10 修订）──────────── 完成（a88dfa9）
2.  A0（11 Tasks）──────────── 完成
3.  E6 组件级 memo ─────────── 完成（a923e61…abc3d8d）
4.  E7 context ─────────────── 完成（34145ee…bf81554）
5.  A1（12 组件 + README）──── 完成
6.  E5 flex 主轴伸缩 ───────── 完成（40f06a1…feedf85）
7.  E1 keyboard 事件 ───────── 完成（ba9d1fd…055c117）
8.  W0 WASM 归因与回收 ─────── 完成（30d33e8）※ 计划外，E4/E2/E3 的解锁前置
9.  E4 boxShadow ───────────── 完成（d462a96）
10. E2 zIndex ──────────────── 完成（62850ea…e0b9347）
11. E3 position/inset ──────── 完成（6c72939）
12. A2 八个弹层组件 ────────── 完成（0a43cf1）
13. A3 四个产品分子 ────────── 完成
```

原计划把 E5/E1/E4 视为可并行、E2→E3 串行。实际执行按串行推进，因为每一项都要
独立过 ABI/差分/预算门禁；W0 是执行期新增的强制前置。A3 原为"按需"，由需求方
直接要求交付，规格取自计划点名的四个组件。
