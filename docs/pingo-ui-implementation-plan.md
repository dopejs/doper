# pingo-ui 实现总计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

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
  A3 第三批：产品分子，按需立项（本文不展开）

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

- [ ] **Step 1: 修订 m10 决策表**

将"overlay/absolute positioning 与 widgets placeholder"行从 Defer 改为 Adopt（附
决策日期与理由）：产品 fixture = pingo-ui 第二批弹层组件（Dialog/Popover/Tooltip/
DropdownMenu/Select/Command/Sheet/Toast 的层叠、锚点、焦点场景）；采用前预算与
oracle 列不变，转为 E2/E3 的出口条件；回滚边界不变（feature bit 关闭拒绝新值）。

- [ ] **Step 2: 同步 design.md §12.1**

在 CSS 支持表段落追加 position/zIndex 为"已立项、feature-bit 门控、未交付"状态；
遵守 AGENTS.md"未来 CSS/事件扩展在实现和自动验证前不得写成已交付 API"。

- [ ] **Step 3: Commit**

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
  4. pingo-ui 组件接入（Button/Badge/Card 等纯展示组件包 memo）+ 门禁。

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

| # | 组件 | props（除通用） | variants / 皮肤类 | 关键皮肤值（引用 token） |
| --- | --- | --- | --- | --- |
| 1 | IconButton | `icon: PingoNode`、`onPress?`、`disabled?` | variant 同 Button（复用 `.pui-button--*` + `.pui-button--icon`） | 36×36；icon slot 透传（§6.2.1 契约） |
| 2 | Divider | `orientation?: "horizontal"\|"vertical"` | `.pui-divider` / `.pui-divider--vertical` | horizontal: height 1px、background `$border`；vertical: width 1px、stretch |
| 3 | Skeleton | `width?`、`height?` | `.pui-skeleton` | background `$accent`（dark `$dark-accent`）、radius `$radius-md`；无动画（CSS 动画不在子集） |
| 4 | Alert | `title: string`、`children: string`、`variant?: "default"\|"destructive"` | `.pui-alert` / `.pui-alert--destructive` + `.pui-alert__title` / `.pui-alert__description` | padding 16、radius `$radius-lg`、border `$border`；destructive: border `$destructive`、title color `$destructive` |
| 5 | Avatar | `src?: string`、`fallback: string`、`size?: number`（默认 40） | `.pui-avatar` + `.pui-avatar__fallback` | 圆形 radius = size/2；无 src 时显示 fallback 文本（conditional render，不需要引擎能力） |
| 6 | Progress | `value: number`（0–100）、`max?: number` | `.pui-progress` + `.pui-progress__indicator` | 轨道 height 8、radius 4、background `$secondary`；指示条 width 由 style prop 百分比设置（`width: "${pct}%"`——% 长度已支持，不需要引擎能力） |
| 7 | Switch | `checked: boolean`、`onCheckedChange?`、`disabled?` | `.pui-switch`(+`--checked`/`--disabled`) + `.pui-switch__thumb` | 轨道 44×24 radius 12；thumb 20×20 radius 10；checked 位移用 margin-left 20px（无 transform 需要）；Pressable 承载交互 |
| 8 | Checkbox | 同 Switch + `label?: string` | `.pui-checkbox`(+`--checked`) + `.pui-checkbox__indicator` | 16×16 radius 4 border；checked: background `$primary` + 勾选标记用 Text "✓"（字体回退风险→设计时用图片或几何图形评估，子计划定） |
| 9 | RadioGroup | **组合式（E7 context）**：`RadioGroup({ value?, onValueChange?, disabled?, children })` + `RadioGroupItem({ value, label? })` | `.pui-radio`(+`--checked`) + `.pui-radio__indicator` | 16×16 圆形 border；checked 内点 8×8 圆形 `$primary`；组状态经 RadioGroupContext 分发 |
| 10 | Tabs | **组合式（E7 context）**：`Tabs({ value?, onValueChange?, children })` + `TabsList` + `TabsTrigger({ value, children })` + `TabsContent({ value, children })` | `.pui-tabs` + `.pui-tabs__list` + `.pui-tabs__trigger`(+`--active`) + `.pui-tabs__content` | list: background `$secondary` padding 4 radius；trigger active: background `$background`；pointer 交互，方向键导航等 E1 后升级 |
| 11 | Accordion | **组合式（E7 context）**：`Accordion({ openValue?, onValueChange?, children })` + `AccordionItem({ value, title, children })` | `.pui-accordion__item` / `__trigger`(+`--open`) / `__content` | item border-bottom `$border`；open 状态条件渲染 content |
| 12 | TextArea 装饰版 | 同 Input（无 slot） | `.pui-input` 复用 + `.pui-textarea` | rows 默认 3；复用 Task 8 Input 的 controller 模式 |

- [ ] **A1 Tasks 1–12**：按上表逐组件实施（皮肤 → 组件 → 测试 → storybook 展区）。
  每组件 commit 一次。token 缺口（如 muted 背景）在 tokens.scss 追加并记录。
- [ ] **A1 Task 13**：E6 接入——全部展示组件用 `memo` 包装；补 memo 行为测试。
- [ ] **A1 Task 14**：暗色全覆盖审查——storybook 每组件 light/dark 双 story；
  像素快照（补充断言，语义树 E2E 为主）。
- [ ] **A1 Task 15**：覆盖约定文档化——`packages/ui/README.md`：sheet 注册顺序
  （用户 sheet 必须在 pingo-ui sheet 之后）、token-only 约束、preset 定制方法
  （`@use ... with`）、已知视觉缺口清单。
- [ ] **A1 Task 16**：门禁——`npx vitest run packages/ui` 全绿、`pnpm test:run`
  全仓回归、storybook build。Commit。

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

### A3 第三批（按需立项）

TopBar、Sidebar、StatCard、ListRow 等产品分子。启动条件：试点业务有明确需求
fixture；届时按 A1 模式写子计划。本文不展开（YAGNI）。

---

## 验证矩阵（每个阶段出口必过）

| 层 | 命令 / 方式 | 适用 |
| --- | --- | --- |
| 组件单元 | `npx vitest run packages/ui` | A0/A1/A2 每 Task |
| 皮肤解析 | `packages/ui/src/styles.test.ts`（resolveStyle 断言） | 每皮肤变更 |
| 全仓回归 | `pnpm test:run` | 每阶段出口 |
| Rust | `pnpm rust:test`（不用裸 cargo） | E1–E5 每 Task |
| ABI | golden bytes + TS/Rust 往返 + fuzz | E1/E4/E5（凡 ABI 变更） |
| 差分 oracle | 增量↔全量 layout/paint/hit/semantics | E2/E3/E4/E5 |
| 像素 | 后端差分（tolerance 内） | E4、A2 弹层 |
| storybook | build + 明暗人工/browser 截图验证 | A0/A1/A2 出口 |
| 边界 | `check-style-preprocess-boundary.mjs` 等既有脚本 | 全仓回归内含 |

## 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| E2/E3 周期拖累 A2 | A0/A1 独立交付 17 组件；弹层不阻塞 |
| m10 修订后 oracle 不达标 | feature bit 关闭即回滚，flow layout 不变（决策表原边界） |
| E6 memo 与 signal 交互出微妙 bug | 出口门禁含 signal 正交性测试；memo 包装逐组件可回退 |
| 弹层 API 提前泄露给业务 | A2 启动门前 facade 不导出任何 Overlay 符号 |
| 皮肤体积随组件数增长 | themed 规则仅皮肤属性；按组件分包 sheet 留作后续优化 |
| **overflow 容器内百分比尺寸归零**（2026-08-21 实证）：非 visible overflow 使 View 成为滚动容器，内容获得不定 inline basis，子节点百分比宽/高解析为 0 | 组件规避（Progress 轨道已去掉 overflow:hidden）；引擎语义是否修正（clip-only overflow 不应给出不定 inline 约束）列入 E  track 候选，E5 设计门时一并评估 |

---

## 执行顺序（任务级）

```
1. C0（m10 修订）────────── 完成（a88dfa9）
2. A0（11 Tasks）────────── 完成（阶段0 出口全绿）
3. E6 组件级 memo ───────── 完成（a923e61…abc3d8d）
4. E7 context 子计划 + 执行  A1 之前（组合式 API 前置）
5. A1（16 Tasks）────────── E7 出口后；其中 E6 接入（A1 Task 13）已提前完成
6. E5 设计门 → 子计划 → 执行 │ A1 期间并行（Input slot 前置）
7. E1 设计门 → 子计划 → 执行 │ C0 后启动
8. E4 设计门 → 子计划 → 执行 │ 与 E1/E5 并行
9. E2 设计门 → 子计划 → 执行 │ E1 后
10. E3 设计门 → 子计划 → 执行 │ E2 后
11. A2 子计划 → 执行 ─────── E1/E2/E3 出口后
12. A3 ──────────────────── 按需
```
