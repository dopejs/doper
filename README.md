# doper

doper 是一套从零设计的 Web Canvas 渲染引擎，目标是提供高性能 TSX 运行时、
原生虚拟滚动、确定性的 Rust/WASM Core、版本化二进制 ABI，以及完整的文本
渲染与 Canvas 原生编辑能力。

仓库已经完成 **P0 / M0、M1、M2 与 M3-A**，正在实现 M3-B 文本主链；目前仍不是可供
业务直接使用的完整渲染引擎。技术决策以
[`docs/design.md`](docs/design.md) 为准，交付顺序与出口门禁见
[`docs/plan.md`](docs/plan.md)。

## 当前可运行内容

`apps/platform-probe` 是第一条可运行切片，用于采集：

- Worker rAF 帧间隔；
- 主线程时间戳经 SharedArrayBuffer 到 Worker 的观测延迟；
- 主线程阻塞 200ms 时 Worker 自驱情况；
- 主线程与 Worker Canvas2D / scroll-copy 吞吐；
- 最小 Rust/WASM 与代表性文本包络的体积、加载和首次调用；
- EditContext 优先、集中式 textarea proxy 降级的 Canvas 编辑输入路径；
- 带环境、几何和原始事件的 IME v2 录制，以及确定性回放校验。

## 本地运行

前置要求：Node.js 22.12+、pnpm 10.33.2、Rust 1.96.0，并安装
`wasm32-unknown-unknown` target。

```bash
pnpm install --frozen-lockfile
pnpm m0:check
pnpm probe:dev
```

打开终端输出的本地地址后运行完整探针并导出 JSON。开发服务器会发送
COOP/COEP 响应头以启用跨源隔离；这只证明本地探针环境可用，不代表业务部署
已经满足这些条件。采集口径与已知限制见 [`docs/m0-probes.md`](docs/m0-probes.md)。

真机性能、真实输入法和业务部署属于平台资格认证，不阻止工程里程碑完成。具备正式
设备与环境时使用 `pnpm platform:qualify`；未认证平台不得对外宣称已达到对应指标。

## 工程约束

在修改架构或行为前阅读 [`AGENTS.md`](AGENTS.md)，并遵守设计文档中的模块边界、
性能门禁和测试要求。
