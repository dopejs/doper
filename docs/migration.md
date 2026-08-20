# pingo 迁移指南

> 状态：M6。面向按页面粒度从存量渲染引擎迁移到 pingo 的业务团队。
> 存量引擎代码不在本仓库；本指南约定的是边界契约与回退操作。

## 1. 迁移模型

迁移以**页面**为最小粒度，通过 `@dopejs/pingo-compat` 的
`mountCompatPage` 建立边界：

```ts
import { mountCompatPage } from "@dopejs/pingo-compat";

const page = await mountCompatPage({
  pageId: "orders",
  container,
  render: renderOrdersPage, // 返回 pingo JSX/PingoNode
  legacy: legacyOrdersRenderer, // 存量路径，必须保持可挂载
  enabled: rollout.isEnabled("orders"), // 灰度开关
  onFallback: (reason) => report(reason), // 观测钩子
});
```

- `enabled: false` 时页面完全由存量渲染器接管，pingo 不初始化。
- `page.enable()` / `page.fallback(detail)` 支持运行时切换；
  初始化失败与连续运行时错误（默认 3 次）自动回退到存量路径。
- shim 只依赖 `@dopejs/pingo` 公开 facade；删除 shim 不需要修改引擎。

## 2. 业务代码约束

自动扫描器（`node scripts/check-migration.mjs <业务源码目录>`）强制以下
约束，违规即报告并以非零码退出：

| 规则                      | 说明                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `internal-package-import` | 只能 import `@dopejs/pingo`（含 `/jsx-runtime` 等子路径）与 `@dopejs/pingo-compat`；`@dopejs/pingo-host` 等内部包不属于公开契约 |
| `embed-dom-input`         | 禁止 per-widget HTML `input`/`textarea`；caret、selection、IME、剪贴板由引擎输入桥统一托管                                      |
| `force-update`            | 不存在 `forceUpdate` 逃生口；失效由 prop 语义驱动                                                                               |

报告中的 `migrationHints` 是非阻断建议：旧 `container/text/image/editableText/scroll/virtualList`
可逐页迁到 `View/Text/Image/Input/UnstyledTextArea`，direct style props 可迁到
`style`/`className`。旧路径在 M6 保持兼容，因此 warning 不改变命令退出码。

## 3. 能力矩阵与已知限制

- 支持：TSX function component、hooks/signals、原生虚拟滚动、
  `EditableText`/`TextField`/`TextArea`、语义树 E2E 选择器、
  M6 CSS 子集与同节点交互伪类、SAB → postMessage → 主线程 Canvas2D 降级链。
- 显式延后：bidi 视觉导航（随 bidi 文本能力）、widgets placeholder
  （待 overlay 布局能力）、WebGPU 后端（默认关闭，见 ADR）。
- 不做：SSR/HTML 首屏、通用 CSS 兼容、业务级富文本语义。

## 4. 回退操作

1. **灰度关断**：把页面的 `enabled` 置 false 并重新加载，pingo 不再初始化。
2. **运行时回退**：调用 `page.fallback("原因")`；存量渲染器立即重新挂载。
3. **自动回退**：初始化失败或连续 host 错误达到阈值时自动触发，
   `onFallback` 携带 `initialization-failed` / `runtime-error` 原因。
4. **能力降级**：Worker/SAB 不可用时引擎自动退到主线程 Canvas2D，
   无需业务参与（见 design.md 降级链）。

事故处置步骤见 `docs/runbook.md`（M5-C）。
