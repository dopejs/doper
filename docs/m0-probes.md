# M0 平台能力探针

本文记录 `apps/platform-probe` 的运行口径。探针的职责是收集架构决策证据，
不是 benchmark 结论，也不代表 M0 已通过出口门禁。

## 运行方式

```bash
pnpm install --frozen-lockfile
pnpm probe:dev
```

浏览器打开终端输出的地址，点击 **Run full probe**，完成后使用 **Export JSON**
保存包含环境、构建标识、设备标识、唯一 run id、原始样本、汇总和错误的报告。
正式采集时通过 `VITE_DOPER_BUILD_ID` 注入 commit 或构建标识，并通过
`VITE_DOPER_DEVICE_ID` 注入 `device-matrix.md` 中登记的物理设备资产 ID；未设置时
分别使用 `local-uncommitted` 与 `local-dev`，不得把该结果上传为正式基线。
报告 v1 的机器可读契约位于
[`schemas/platform-probe-report.schema.json`](schemas/platform-probe-report.schema.json)。

默认使用 EditContext；访问 `?editing=proxy` 可强制使用唯一的 textarea 输入代理，
用于在同一浏览器验证降级行为。该开关只属于 M0 探针，不是业务 API。
编辑快照中的 `recordingVersion: 1`、`records` 和 `droppedRecords` 用于录制真实 IME
事件。每条记录包含相对时间、事件类型、事件数据、composition 状态、文本和 UTF-16
selection；单次最多保留 512 条，溢出必须显式计数，不能静默丢失。

Vite 开发与预览服务器发送：

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

这用于验证 SAB 路径。业务环境是否能部署同等策略仍需单独盘点第三方资源、
iframe、登录跳转、下载和监控 SDK。

无跨源隔离路径使用独立端口运行，验证自动选择 postMessage：

```bash
pnpm probe:dev:no-isolation
```

## 报告汇总与趋势

对导出的原始报告执行：

```bash
pnpm probe:summary -- report-a.json report-b.json
```

汇总格式带 `version: 1`，保留每次运行的完成状态和错误，并分别输出同设备趋势与
同设备、同 build 的重复性差异。正式汇总默认拒绝 `local-uncommitted` 和
`local-dev`；只做探针开发自检时可显式添加 `--allow-local`。使用
`--output new-summary.json` 可创建新文件；为防止误覆盖，目标已存在时命令失败。

该工具只负责验证、汇总和生成可归档 JSON，不冒充外部持久化服务。真机原始报告
仍需上传到项目选定的不可变 artifact/指标存储，存储地址和保留策略是 M0 外部决策。

## 业务 COOP/COEP 审计

对无需登录即可访问的候选业务页面执行：

```bash
pnpm coop:check -- https://business.example.com/page
```

工具记录重定向、页面 COOP/COEP/CSP 等响应头，解析静态 HTML 中实际会获取的
script、style、image、media、font preload 与 iframe，并检查跨域资源的 CORS/CORP
响应。当前 `ready` 要求 HTTPS（或 loopback）、`COOP: same-origin` 与
`COEP: require-corp`。`block`
表示在 `require-corp` 下有明确阻断，`manual` 表示 iframe 或 `same-site` 等必须人工
复核的情况。带登录态、动态注入资源、Service Worker、弹窗/下载和监控 SDK 仍必须
在真实业务会话中补充浏览器验证；命令行审计不能覆盖这些行为。

## 采集内容

| 探针                  | 当前口径                                             | 主要用途                          |
| --------------------- | ---------------------------------------------------- | --------------------------------- |
| Worker frame driver   | 60 个 Worker rAF 帧间隔                              | 检查可用性和帧间隔长尾            |
| SAB timestamp latency | 60 个主线程 rAF 发布时间到 Worker 观测时间           | 评估共享传输延迟                  |
| Main-thread stall     | Worker 自驱 450ms，主线程延迟 50ms 后阻塞 200ms      | 验证 Worker 时钟是否继续推进      |
| Transport continuity  | 三档各执行 500ms Canvas2D 绘制，中间阻塞主线程 200ms | 验证自动选择、实际 paint 和帧序列 |
| Canvas2D throughput   | 主线程与 Worker 各执行 250ms fill、250ms scroll-copy | 形成相同实现的粗粒度对照          |
| Rust/WASM cold start  | no-store fetch、instantiate、首次导出调用            | 跟踪最小基线和预算余量            |
| Canvas IME            | EditContext；不可用时使用唯一的隐藏 textarea proxy   | 验证 caret/selection/IME 基础路径 |

SAB 延迟必须将各全局上下文的 `performance.timeOrigin + performance.now()`
统一后再比较；直接相减两个上下文的 `performance.now()` 会得到无效结果。

## 报告语义

- `samples` 保存原始值，`summary` 保存 count、min、max、mean、P50、P95、P99。
- 单项能力不可用或运行失败时，其他探针继续执行；状态显示
  `Complete with gaps`，具体原因写入 `errors`。
- 页面只展示时序样本的汇总，完整时序与结构化编辑事件以导出的 JSON 为准。
- continuity 同时检查阻塞窗口帧数、最大帧隙、paint 次数和最终像素；timer tick
  本身不算绘制证据。
- 本地桌面结果只用于校验探针自身，不能替代低端 Android、iOS 与目标 PC
  的重复采样。

## 当前已验证范围

2026-08-14 在本地 Chrome 开发环境完成探针自检：Worker rAF、SAB、
OffscreenCanvas、EditContext、输入代理和 Rust/WASM streaming instantiate 均可运行，
Canvas 编辑能收到 `textupdate` 并执行 grapheme 级光标移动。隔离环境自动选择 SAB；
无隔离环境自动选择 postMessage。两种 Worker 模式在 200ms 主线程阻塞窗口内均持续
实际 Canvas 绘制，主线程对照出现约 200ms 帧空洞。数据见
[`adr/0001-m0-transport-fallback.md`](adr/0001-m0-transport-fallback.md)，不进入产品性能基线。

尚未验证且阻止 M0 关闭的项目包括：

- 目标真机矩阵与重复采样；
- 使用审计工具并结合真实登录态浏览器验证形成的 COOP/COEP 业务影响结论；
- 中文、日文、韩文与复杂 composition 的录制回放；
- 候选窗 bounds、软键盘和 textarea proxy 的跨浏览器/OS 验证；
- 数据上传与趋势展示。

## 失败与回滚

探针不写入业务数据。关闭开发服务器即可停止；导出的 JSON 是唯一持久产物。
若 COOP/COEP 使目标页面不可运行，应保留失败报告并切换到无隔离部署验证
postMessage 路径，而不是伪造 SAB 可用性。
