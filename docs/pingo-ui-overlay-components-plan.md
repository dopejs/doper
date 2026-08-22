# A2 第二批弹层组件实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。

**Goal:** 交付 Dialog、Sheet、Popover、Tooltip、DropdownMenu、Select、Command、Toast，
以及它们共用的 `Overlay` 基元。

**启动门（已达成）**：E1（`ba9d1fd…055c117`）、E2（`62850ea…e0b9347`）、
E3（`6c72939`）全部出口；E4（`d462a96`）已合并。

---

## 0. Overlay 基元设计

### 层叠：z-index token 分层

```
$z-dropdown: 1000   // Popover / DropdownMenu / Select / Command 的浮层
$z-overlay:  1100   // Dialog / Sheet 的遮罩与面板
$z-toast:    1200   // Toast 视口
```

E2 的 z-index 只在**兄弟之间**排序，没有 stacking context。因此分层 token 只在
同一个父节点下的兄弟之间有意义：把 Dialog 的遮罩和面板放在同一个父节点里，
用 token 区分它们与页面内容的先后。

### 锚定：包含块就是父节点

E3 把包含块定为**父节点的 padding box**，这直接决定了锚定 API 的形状：

- **锚定型**（Popover / Tooltip / DropdownMenu / Select）：trigger 与 content 包在
  同一个 `.pui-anchor` View 里，content 用 `position: absolute` + `top: 100%`
  贴在 trigger 下方。**滚动时自动跟随**——几何由 Core 从父节点推出，不需要任何
  JS 重新定位，这一条要有测试证明。
- **视口型**（Dialog / Sheet / Toast）：用 `position: absolute` + `inset: 0`
  铺满**它自己的父节点**。因此调用方必须把它们挂在靠近根的容器下；
  这是 E3 偏差的直接后果，写进组件 docstring 与 README。

不提供 `placement: "top" | "bottom" | ...` 的自动翻转：那需要测量后再定位，即
"布局后回读"，而 `useLayoutValue` 至今没有实现，仓库里也没有别的几何通道。v1 只
提供 `side` 静态方向。后续处置与候选方案见
[`overlay-auto-flip-design.md`](./overlay-auto-flip-design.md)。

### Esc 关闭与焦点

E1 的键事件**只送达当前焦点节点**，所以：

1. 打开时，`Overlay` 通过 `ref` 拿到面板节点并立即 `handle.focus()`；
2. `onKeyDown` 挂在面板上，`Escape` 触发 `onOpenChange(false)`；
3. 关闭时把焦点还给 trigger（trigger 也通过 `ref` 注册）。

**不承诺焦点陷阱**：Tab 循环需要引擎侧的 tab order，E1 明确不内建它
（`docs/e1-keyboard-events-design.md` §D4）。README 记为已知缺口。

> 后续修正（`8171d7d`）：这条的因果反了。Core 没有 tab order，所以 Tab 根本不移动
> 焦点，焦点也漏不出弹层——不需要陷阱。缺的是键盘用户进不到面板内的控件。现在
> `OverlayFocus` 提供 `focusable(order)` 登记表，Tab / Shift+Tab 在登记项之间循环，
> 公开入口是 `useFocusableRef(order)`。下面 A2-1 的验收项按此理解。

---

## Task A2-1: Overlay 基元 + z-index token

- [ ] `styles/tokens.scss` 增三个层级 token 与浮层的圆角/内边距/阴影。
- [ ] `styles/components/overlay.scss`：`.pui-overlay`（视口铺满）、
      `.pui-overlay__backdrop`、`.pui-overlay__panel`、`.pui-anchor`、
      `.pui-anchor__content`。
- [ ] `src/overlay.ts`：`useOverlayFocus()` —— 打开时聚焦面板、关闭时还焦，
      以及 `escapeHandler(onClose)`。
- [ ] 单测：聚焦/还焦顺序、Escape 触发、非 Escape 键不触发。

## Task A2-2: Dialog + Sheet（视口型）

- [ ] `Dialog` / `DialogContent` / `DialogHeader` / `DialogTitle` /
      `DialogDescription` / `DialogFooter`；`Sheet` / `SheetContent`（`side`）。
- [ ] 关闭时不渲染任何节点；遮罩点击关闭。
- [ ] 测试：层叠顺序（遮罩在面板之前）、Escape、明暗。

## Task A2-3: Popover + Tooltip（锚定型）

- [ ] `Popover` / `PopoverTrigger` / `PopoverContent`；`Tooltip`（hover 驱动）。
- [ ] 测试：锚定结构（content 是 anchor 的直接子节点且 absolute）、
      滚动跟随（几何由父节点推出，无 JS 重定位）、Escape、明暗。

## Task A2-4: DropdownMenu + Select（锚定 + 列表）

- [ ] `DropdownMenu` / `Trigger` / `Content` / `Item`；
      `Select` / `Trigger` / `Content` / `Item`（受控 value）。
- [ ] 方向键在 item 间移动焦点、Enter 选中（复用 `src/keyboard.ts`）。
- [ ] 测试：键盘导航、选中回调、Escape、明暗。

## Task A2-5: Command + Toast

- [ ] `Command`：Input + 过滤列表 + 方向键导航 + Enter 选中。
- [ ] `Toast` / `ToastViewport`：角落定位、variant、关闭。
- [ ] 测试：过滤、导航、Toast 层级与 variant、明暗。

## Task A2-6: 出口门禁

- [ ] storybook 明暗双 story 覆盖八个组件。
- [ ] `pnpm test:run`、`pnpm typecheck`、`pnpm api:check`、`pnpm rust:test`、
      `pnpm contracts:check`、`pnpm storybook:build` 全绿。
- [x] README 更新导出清单与已知缺口（Tab 遍历需显式登记、无自动翻转、视口型需挂近根）。
- [ ] 回写 `pingo-ui-implementation-plan.md` 进度表。
