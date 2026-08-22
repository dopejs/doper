# A3 第三批产品分子实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。

**Goal:** 交付 TopBar、Sidebar、StatCard、ListRow 四个产品分子。

## 立项说明（重要）

总计划把 A3 定为"按需立项，启动条件 = 试点业务有明确需求 fixture"。
**本次立项没有试点 fixture**，是需求方直接要求交付。因此规格来源只有总计划与
`pingo-ui-capability-plan.md` §8 里点名的四个组件名，其余"等"字覆盖的组件
**不做**——没有 fixture 就扩清单，正是原计划要避免的事。

四个组件的 API 由这两条约束推导，不做发明：

1. **它们是"分子"**：由第一/二批的原子组合而成，不引入新的引擎能力需求。
2. **shadcn superset**：shadcn 没有对应物，所以 API 只对齐 shadcn 的**风格**
   （variant / size / className / slot 透传），不对齐任何具体组件。

## 与引擎能力的关系

四个组件都不需要新引擎能力。它们是 E5 `flexGrow` 的第一批真实消费者：
TopBar 的 actions 靠伸缩件推到右侧，ListRow 的文本列吃掉 leading/trailing 之外的
剩余宽度，StatCard 的数值行同理。这也是本批次的价值之一——把 E5 从"有测试"
推进到"有产品用法"。

---

## Task A3-1: 皮肤与 token

**Files:** `packages/ui/styles/tokens.scss`、`packages/ui/styles/components/molecules.scss`

- [ ] token：`$topbar-height`、`$sidebar-width`、`$list-row-min-height`、
      `$stat-value-size`、`$trend-up` / `$trend-down` 及其 dark 镜像、
      结构性 token（`$grow-1` 等，皮肤 lint 不接受字面量）。
- [ ] 皮肤类：`.pui-topbar`、`.pui-sidebar`、`.pui-sidebar__item`、
      `.pui-statcard`、`.pui-list-row` 及其修饰类，全部含 `.pui-dark` 镜像。
- [ ] 皮肤解析测试断言伸缩件与层级值。

## Task A3-2: TopBar

- [ ] `TopBar({ title?, leading?, actions?, className? })`。
- [ ] 结构：row + 底边框；标题列 `flex: 1 1 0px` 把 actions 推到右侧。
- [ ] `semanticRole: "banner"`。
- [ ] descriptor 测试：三个 slot 的存在/缺省、伸缩件位置、明暗。

## Task A3-3: Sidebar（组合式）

- [ ] `Sidebar({ value?, defaultValue?, onValueChange?, children })` +
      `SidebarSection({ title, children })` + `SidebarItem({ value, label, icon? })`。
- [ ] 选中项高亮；`semanticRole: "navigation"` / `"link"`。
- [ ] 键盘：Up/Down 在 item 间移动焦点与选中，Home/End 到端点，复用
      `src/keyboard.ts` 的 `orderedValues` / `step`，焦点随选中移动（ref 注册）。
- [ ] 测试：选中回调、键盘导航、非导航键不被吞、明暗。

## Task A3-4: StatCard

- [ ] `StatCard({ label, value, delta?, trend?, description?, className? })`。
- [ ] trend 三态着色：`up` 正向、`down` 破坏性、`flat` 静默；无 delta 时不渲染该行。
- [ ] 测试：三态类名、缺省分支、明暗。

## Task A3-5: ListRow

- [ ] `ListRow({ title, description?, leading?, trailing?, selected?, disabled?, onPress? })`。
- [ ] 文本列 `flex: 1 1 0px`；disabled 时不挂交互 handler（与 RadioGroupItem 同口径）。
- [ ] 测试：slot 组合、选中/禁用、按下回调、明暗。

## Task A3-6: 出口门禁

- [ ] 导出与类型进入 `packages/ui/src/index.ts`。
- [ ] storybook 明暗展区。
- [ ] README 组件清单与约束更新。
- [ ] `pnpm m0:check` 全绿；`pnpm storybook:build` 通过。
- [ ] 回写 `pingo-ui-implementation-plan.md` 进度表与验收记录。
