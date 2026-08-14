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

### 正式 IME 录制与回放

编辑区下方选择证据类别，并填写输入法名称及完整版本。每条正式场景从一次全新页面
加载开始，完成输入和 composition commit 后点击 **Export IME recording**。页面生成
独立的 v2 录制，而不是把整份平台报告当作输入法证据；契约位于
[`schemas/ime-recording.schema.json`](schemas/ime-recording.schema.json)。每条事件除文本、
UTF-16 selection 和 composition 状态外，还记录 control/selection bounds、
`visualViewport` 高度与偏移。EditContext 的 `characterboundsupdate` 同时记录请求范围和
首尾 character bounds，用于复核候选窗几何。

正式录制执行：

```bash
pnpm ime:replay -- doper-ime-<recording-id>.json
```

回放器会重新应用 EditContext `textupdate`，校验 textarea proxy 的状态快照，并拒绝
时间倒退、非法 composition 转移、越界 selection/range、拆分 surrogate pair 或
非 composition 状态下拆分 grapheme、错误最终文本/selection、软键盘或 character
bounds 标记不一致、事件溢出和未结束的 composition。默认也拒绝 fixture 与
`local-uncommitted` / `local-dev`，避免把开发自检误作正式设备证据。本地链路自检可
显式使用 `--allow-local`，仓库 fixture 还需同时使用 `--allow-fixture`。

每个目标 OS/浏览器/输入法组合必须单独导出，不得把自动化键盘输入描述为 IME
兼容证据。移动设备录制必须观察软键盘；EditContext 场景必须保留实际
`characterboundsupdate`。每次录制后先通过 replay，再与平台报告一起归档，且保持
`recordingId` 不可覆盖。

通过采集器打开页面时还会显示 **Archive IME recording**。它把同一份 v2 JSON 以
`POST /api/ime-recordings` 上传；服务端再次执行 schema、provenance/local placeholder
和确定性 replay 校验，通过后用 `wx` 语义写入
`ime/v2/<device>/<build>/<recordingId>.json`。接口沿用平台报告的 Bearer token，重复
recording id 返回 409，非法事件流返回 400。导出或归档任一成功后页面锁定该会话，
必须重新加载才能开始下一条，避免同一 recording id 指向变化中的事件流。

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

汇总格式带 `version: 2`，保留每次运行的完成状态和错误，并分别输出同设备趋势、
batch 完整性与同设备/同 build 的 batch 重复性判定。重复性只比较完整 sample batch：
合并原始 Worker frame samples 计算 P95，并使用每轮 Canvas 吞吐中位数；帧 P95
差异上限为 10%，吞吐差异上限为 5%，能力与 transport signature 必须一致。单次
运行不会被误标成正式重复性。正式汇总默认拒绝 `local-uncommitted` 和
`local-dev`；只做探针开发自检时可显式添加 `--allow-local`。使用
`--output new-summary.json` 可创建新文件；为防止误覆盖，目标已存在时命令失败。

### 真机采集服务

先把 commit 固化进 production build，再启动同源采集器：

```bash
VITE_DOPER_BUILD_ID=<full-commit> pnpm build
DOPER_PROBE_COLLECTOR_TOKEN=<at-least-24-random-characters> \
  pnpm probe:collect -- \
  --host 0.0.0.0 \
  --cert /secure/server.crt \
  --key /secure/server.key \
  --output /mounted/immutable-probe-artifacts
```

目标设备打开采集器输出的 URL，把 `<asset-id>` 替换为 `device-matrix.md` 中登记的
设备 ID；可追加 `&autorun=1` 自动开始。完成后在页面的 **Collector token** 输入框
输入令牌并点击 **Archive report**。令牌只通过 Authorization header 发送，不进入
URL、报告或归档文件。

正式重复采集使用页面的 **Run batch**：默认严格执行 5 次预热和 15 次正式样本。
成功预热不归档；正式样本各自使用新 runId 并带同一 batchId、序号和总数。预热若
失败会先保留失败报告再停止，正式样本无论探针是否有错误都归档，summary v2 只把
序号完整、没有错误且能力签名一致的 batch 标记为 complete。

平台报告接口会再次执行 v1 schema 与正式标识校验，并用 `wx` 语义写入
`v1/<device>/<build>/<runId>.json`；相同 run id 返回 409，不覆盖原始证据。
`/api/summary` 提供机器可读趋势，`/trends` 提供只读页面。启用令牌时趋势页使用
HTTP Basic 登录，用户名为 `doper`、密码为同一令牌。

IME 归档位于独立的 `ime/v2` namespace，不会被平台报告 summary 当作 v1 报告读取。
两个写接口与趋势接口使用同一鉴权和 10 MiB 请求上限。

默认只监听 `127.0.0.1`。绑定非 loopback 地址时，工具强制要求 TLS 证书/私钥和
至少 24 字符令牌；证书必须被目标设备信任，否则不能把 SAB/安全上下文结果作为
证据。输出目录仍应挂载到项目选定的持久化、备份或对象存储；本地文件系统的
“同 run 不覆盖”不等于运维层面的不可变保留策略。

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

| 探针                  | 当前口径                                              | 主要用途                          |
| --------------------- | ----------------------------------------------------- | --------------------------------- |
| Worker frame driver   | 60 个 Worker rAF 帧间隔                               | 检查可用性和帧间隔长尾            |
| SAB timestamp latency | 60 个主线程 rAF 发布时间到 Worker 观测时间            | 评估共享传输延迟                  |
| Bounded SAB ring      | 容量 32，生产 4096 项并故意预填充溢出                 | 验证背压、丢弃记账、顺序与排空    |
| Main-thread stall     | Worker 自驱 450ms，主线程延迟 50ms 后阻塞 200ms       | 验证 Worker 时钟是否继续推进      |
| Transport continuity  | 三档各执行 500ms Canvas2D 绘制，中间阻塞主线程 200ms  | 验证自动选择、实际 paint 和帧序列 |
| Canvas2D throughput   | 主线程与 Worker 各执行 250ms fill、250ms scroll-copy  | 形成相同实现的粗粒度对照          |
| Rust/WASM cold start  | 最小模块与代表性文本包络的 fetch/instantiate/首次调用 | 跟踪启动下界与可信预算余量        |
| Canvas IME            | EditContext；不可用时使用唯一的隐藏 textarea proxy    | 验证 caret/selection/IME 基础路径 |

SAB 延迟必须将各全局上下文的 `performance.timeOrigin + performance.now()`
统一后再比较；直接相减两个上下文的 `performance.now()` 会得到无效结果。

### WASM 预算包络

`pnpm wasm:budget` 使用固定 Rust 1.96.0 release 配置链接实际 grapheme 分段和字体
shaping 路径，并将结果与
[`evidence/wasm-budget.v1.json`](evidence/wasm-budget.v1.json) 精确比较。当前结果为
591,662B raw / 236,368B gzip，低于 300KB 内部包络门禁，距 400KB 产品预算剩余
173,232B。本地 Chrome `instantiateStreaming` 的一次链路自检总计 5.405ms。

该包络是保守的风险探针，不是最终 Core 大小，也不确认最终文本依赖；选择 shaping
方案或实现实际 Core 后必须重新测真实产物。桌面启动数据不能替代目标移动设备样本。
详见 [`adr/0002-m0-wasm-budget-envelope.md`](adr/0002-m0-wasm-budget-envelope.md)。

## 报告语义

- `samples` 保存原始值，`summary` 保存 count、min、max、mean、P50、P95、P99。
- 单项能力不可用或运行失败时，其他探针继续执行；状态显示
  `Complete with gaps`，具体原因写入 `errors`。
- 页面只展示时序样本的汇总，完整时序与结构化编辑事件以导出的 JSON 为准。
- continuity 同时检查阻塞窗口帧数、最大帧隙、paint 次数和最终像素；timer tick
  本身不算绘制证据。
- SAB backpressure 保存全部 accepted sequence；`accepted + dropped == produced`、
  high-watermark 不超过容量、严格递增消费、最终 cursor 相等且最后 accepted 已消费时才
  标记 `backpressureHandled`。服务端会重新计算这些不变式，不信任客户端布尔值。
- 本地桌面结果只用于校验探针自身，不能替代低端 Android、iOS 与目标 PC
  的重复采样。

## 当前已验证范围

2026-08-14 在本地 Chrome 开发环境完成探针自检：Worker rAF、SAB、
OffscreenCanvas、EditContext、输入代理和 Rust/WASM streaming instantiate 均可运行，
Canvas 编辑能收到 `textupdate` 并执行 grapheme 级光标移动。隔离环境自动选择 SAB；
无隔离环境自动选择 postMessage。两种 Worker 模式在 200ms 主线程阻塞窗口内均持续
实际 Canvas 绘制，主线程对照出现约 200ms 帧空洞。数据见
[`adr/0001-m0-transport-fallback.md`](adr/0001-m0-transport-fallback.md)，不进入产品性能基线。
同一 Chrome 环境的 bounded SAB ring 实测生产 4096 项、接受并消费 1032 项、显式
拒绝 3064 项，high-watermark 为容量 32；读写 cursor 最终均为 1032，完整 sequence
严格递增且最后 accepted sequence 已消费。完整页面报告通过 schema 和服务端不变式
回读。该“满时拒绝新项”仅为 M0 压力策略，不预先决定 M2 Mutation Stream 的合并或
背压语义。
production build 的同源采集器也已完成本地 E2E：服务端 schema 校验、201 写入、
重复 run 409、防匿名写入 401、汇总 API、趋势页以及双样本 batch 自动归档均可
工作。该结果证明采集链路，不替代物理目标设备数据或外部存储保留策略。
同一环境还通过页面实际走通了 EditContext 的 `pointerselection → textupdate` 与强制
textarea proxy 的 `pointerselection → beforeinput → input`；两份页面生成的 v2 录制
均通过 schema 和确定性 replay。输入来自浏览器自动化键盘，因此只证明录制/回放
链路，不证明任何真实输入法或软键盘兼容性。
production collector 页面也已完成本地 E2E：生成的 textarea proxy v2 录制经服务端
校验后写入独立 archive，回读文件再次 replay 通过，成功后页面锁定录制控件。

尚未验证且阻止 M0 关闭的项目包括：

- 目标真机矩阵与重复采样；
- 使用审计工具并结合真实登录态浏览器验证形成的 COOP/COEP 业务影响结论；
- 中文、日文、韩文与复杂 composition 的录制回放；
- 候选窗 bounds、软键盘和 textarea proxy 的跨浏览器/OS 验证；
- 采集归档的外部持久化、备份与保留策略。

## 失败与回滚

探针不写入业务数据。关闭开发服务器即可停止；导出的 JSON 或采集器 archive 是
唯一持久产物。
若 COOP/COEP 使目标页面不可运行，应保留失败报告并切换到无隔离部署验证
postMessage 路径，而不是伪造 SAB 可用性。
