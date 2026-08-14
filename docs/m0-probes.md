# M0 平台能力探针

本文记录 `apps/platform-probe` 的运行口径。探针的职责是收集架构决策证据，
不是 benchmark 结论，也不代表 M0 已通过出口门禁。

## 运行方式

```bash
pnpm install --frozen-lockfile
pnpm probe:dev
```

浏览器打开终端输出的地址，点击 **Run full probe**，完成后使用 **Export JSON**
保存包含环境、构建标识、原始样本、汇总和错误的报告。正式采集时通过
`VITE_DOPER_BUILD_ID` 注入 commit 或构建标识；未设置时报告使用
`local-uncommitted`，不得把该结果上传为正式基线。
报告 v1 的机器可读契约位于
[`schemas/platform-probe-report.schema.json`](schemas/platform-probe-report.schema.json)。

Vite 开发与预览服务器发送：

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

这用于验证 SAB 路径。业务环境是否能部署同等策略仍需单独盘点第三方资源、
iframe、登录跳转、下载和监控 SDK。

## 采集内容

| 探针                  | 当前口径                                             | 主要用途                          |
| --------------------- | ---------------------------------------------------- | --------------------------------- |
| Worker frame driver   | 60 个 Worker rAF 帧间隔                              | 检查可用性和帧间隔长尾            |
| SAB timestamp latency | 60 个主线程 rAF 发布时间到 Worker 观测时间           | 评估共享传输延迟                  |
| Main-thread stall     | Worker 自驱 450ms，主线程延迟 50ms 后阻塞 200ms      | 验证 Worker 时钟是否继续推进      |
| Canvas2D throughput   | 主线程与 Worker 各执行 250ms fill、250ms scroll-copy | 形成相同实现的粗粒度对照          |
| Rust/WASM cold start  | no-store fetch、instantiate、首次导出调用            | 跟踪最小基线和预算余量            |
| Canvas IME            | EditContext；不可用时使用唯一的隐藏 textarea proxy   | 验证 caret/selection/IME 基础路径 |

SAB 延迟必须将各全局上下文的 `performance.timeOrigin + performance.now()`
统一后再比较；直接相减两个上下文的 `performance.now()` 会得到无效结果。

## 报告语义

- `samples` 保存原始值，`summary` 保存 count、min、max、mean、P50、P95、P99。
- 单项能力不可用或运行失败时，其他探针继续执行；状态显示
  `Complete with gaps`，具体原因写入 `errors`。
- 页面只展示时序样本的汇总，完整原始数据以导出的 JSON 为准。
- 本地桌面结果只用于校验探针自身，不能替代低端 Android、iOS 与目标 PC
  的重复采样。

## 当前已验证范围

2026-08-14 在本地 Chrome 开发环境完成一次探针自检：Worker rAF、SAB、
OffscreenCanvas、EditContext 和 Rust/WASM 路径均可运行，Canvas 编辑能收到
`textupdate` 并执行 grapheme 级光标移动。该记录不进入产品性能基线。

尚未验证且阻止 M0 关闭的项目包括：

- 目标真机矩阵与重复采样；
- postMessage 和主线程 Canvas2D 两档完整原型；
- COOP/COEP 对实际业务的影响结论；
- 中文、日文、韩文与复杂 composition 的录制回放；
- 候选窗 bounds、软键盘和 textarea proxy 的跨浏览器/OS 验证；
- Faster 黑盒同口径基线、数据上传与趋势展示。

## 失败与回滚

探针不写入业务数据。关闭开发服务器即可停止；导出的 JSON 是唯一持久产物。
若 COOP/COEP 使目标页面不可运行，应保留失败报告并切换到无隔离部署验证
postMessage 路径，而不是伪造 SAB 可用性。
