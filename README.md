# doper

doper 是一套从零设计的 Web Canvas 渲染引擎，目标是在保留 Faster 已验证的
TSX、虚拟滚动和 PC 性能优势的同时，重新构建移动端帧调度、Rust/WASM Core、
二进制 ABI、文本与原生编辑能力。

仓库当前处于 **P0 / M0 探针阶段**，尚不是可供业务使用的渲染引擎。技术决策以
[`docs/design.md`](docs/design.md) 为准，交付顺序与出口门禁见
[`docs/plan.md`](docs/plan.md)。

## 当前可运行内容

`apps/platform-probe` 是第一条可运行切片，用于采集：

- Worker rAF 帧间隔；
- 主线程时间戳经 SharedArrayBuffer 到 Worker 的观测延迟；
- 主线程阻塞 200ms 时 Worker 自驱情况；
- 主线程与 Worker Canvas2D / scroll-copy 吞吐；
- 最小 Rust/WASM 模块的体积、加载和首次调用；
- EditContext 优先、集中式 textarea proxy 降级的 Canvas 编辑输入路径。

## 本地运行

前置要求：Node.js 22.12+、pnpm 10.33.2、Rust 1.96+，并安装
`wasm32-unknown-unknown` target。

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm probe:dev
```

打开终端输出的本地地址后运行完整探针并导出 JSON。开发服务器会发送
COOP/COEP 响应头以启用跨源隔离；这只证明本地探针环境可用，不代表业务部署
已经满足这些条件。采集口径与已知限制见 [`docs/m0-probes.md`](docs/m0-probes.md)。

## 工程约束

在修改架构或行为前阅读 [`AGENTS.md`](AGENTS.md)。Faster 只作为黑盒行为、
性能和迁移基线；不得复制其源码或默认沿用内部抽象。
