# Pingo

Pingo 是一套从零设计的 Web Canvas 渲染引擎：Rust/WASM Core 负责 Scene、布局、文本、
命中、滚动、绘制与动画，TypeScript Shell 负责组件树、样式与调度，两者之间只通过
版本化的二进制 ABI 通信。目标是高性能 TSX 运行时、原生虚拟滚动、确定性渲染，以及
Canvas 原生的可编辑文本。

仓库：<https://github.com/dopejs/pingo>

> 品牌已切换为 pingo；现有公开包在兼容迁移完成前仍使用 `@dopejs/pingo`，因此下面的
> 安装命令保持可直接运行。

技术决策以 [`docs/design.md`](docs/design.md) 为准，交付顺序与出口门禁见
[`docs/plan.md`](docs/plan.md)。修改架构或行为前先读 [`AGENTS.md`](AGENTS.md)。

## 现在能做什么

以下均已在仓库中实现并由自动门禁覆盖，不是路线图：

- **组件运行时**：TSX 函数组件、hooks 与 signal、`memo`、context。
- **CSS 子集**：67 个属性、版本化（当前 `1.6.0`）、逐属性 feature bit。子集外的写法
  在编译期被拒绝并带属性名与源位置，而不是静默降级。
- **布局**：flex 单行布局（含 `flex-grow/shrink/basis`）、`position: absolute` +
  inset、`z-index`、`box-shadow`、overflow 与滚动。
- **原生虚拟滚动**：窗口由 Core 规划，百万行的代价等于一屏。
- **文本与编辑**：引擎自绘文本、光标、选区、IME 组合、剪贴板、撤销/重做。
- **矢量**：SVG 路径与文档子集，图标可直接用 `createSvg` 接入。
- **组件库** `@dopejs/pingo-ui`：46 个 shadcn 形状的组件（含自带虚拟滚动的 `Table`）。
- **无障碍**：语义树随帧导出，键盘导航、焦点与角色贯穿组件库。
- **降级链**：SharedArrayBuffer → `postMessage` → 主线程 Canvas2D。

**尚未具备**：CSS 选择器与层叠的完整兼容、SSR/HTML 首屏、`flex-wrap`、渐变与图案
填充、图表。各组件的已知缺口见
[`packages/ui/README.md`](packages/ui/README.md)，CSS 子集的既知偏差见
[`docs/style-support.md`](docs/style-support.md)。

## 工作区

| 目录                  | 内容                                                            |
| --------------------- | --------------------------------------------------------------- |
| `core/`               | Rust workspace：scene、layout、text、hit、scroll、paint、abi 等 |
| `packages/`           | TypeScript：runtime、jsx、style、reconciler、host、backend、ui  |
| `packages/facade`     | `@dopejs/pingo` 门面，只重导出公开 API                          |
| `apps/storybook`      | 组件库明暗展区                                                  |
| `apps/platform-probe` | 平台能力探针（Worker 时钟、SAB、OffscreenCanvas、IME 回放）     |

## 本地运行

前置要求：Node.js 22.12+、pnpm 10.33.2、Rust 1.96.0，并安装
`wasm32-unknown-unknown` target。

```bash
pnpm install --frozen-lockfile
pnpm check           # 构建、lint、类型、测试、覆盖率门槛与帧时基准
pnpm storybook:build # 组件库
pnpm probe:dev       # 平台探针；开发服务器发送 COOP/COEP 以启用跨源隔离
```

## 当前实测

下表取自同一次完整门禁执行，不是历史累积：

| 项目        | 实测                                                  |
| ----------- | ----------------------------------------------------- |
| 测试        | 116 文件 / 795 用例                                   |
| Rust 行覆盖 | 整仓 ≥85%，`pingo-abi` / `scene` / `scroll` ≥95%      |
| Core 帧时   | 5000 节点、每帧 20 次更新，p95 3.180ms（预算 16.7ms） |
| 虚拟滚动    | 百万行，每帧 p95 0.833µs                              |
| WASM        | 372,852 / 393,216 gzip                                |
| ABI 版本    | 22（跨语言往返 + golden bytes + fuzz 覆盖）           |

门禁全绿**不等于**可以发布：打标签、GitHub Release 与 npm 发布在发布流程升级到当前
门禁之前保持关闭，这是有意的。

## 平台资格

真机帧时、真实输入法、跨浏览器矩阵属于**平台资格认证**，与工程里程碑分离：它们必须
保持可见，但不把已完成的工程项标记为未完成。具备正式设备与环境时使用
`pnpm platform:qualify`；未认证的平台不得对外宣称已达到对应指标。

完整的门禁清单与各自的口径见 [`docs/plan.md`](docs/plan.md)。

采集口径与已知限制见 [`docs/m0-probes.md`](docs/m0-probes.md)。

## 许可证

当前开发分支及其下一次 npm 发布使用 [Apache License 2.0](LICENSE)。v0.2.1
及以前的已发布版本继续适用其原有 MIT 许可证。

`packages/ui` 内联了少量 Lucide 图标路径（ISC），声明见
[`packages/ui/src/icons.ts`](packages/ui/src/icons.ts)。
