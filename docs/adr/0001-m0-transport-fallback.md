# ADR-0001：M0 transport 降级链（提议）

- 状态：Proposed
- 日期：2026-08-14
- 决策者：待 M0 Go / Pivot / Stop 评审确认
- 关联设计：`docs/design.md` §8

## Context

doper 需要在主线程阻塞时继续滚动与绘制。SharedArrayBuffer 需要业务部署
COOP/COEP；部分平台可能缺少 SAB、Worker 或 OffscreenCanvas。必须在 M0 用相同
绘制行为证明三档路径，而不能只检查 API 是否存在。

## Decision

当前提议维持以下自动选择顺序：

1. cross-origin isolated 且主线程/Worker 均支持 SAB：`sab`。
2. Worker 支持 OffscreenCanvas 但 SAB 不可用：`post-message`。
3. Worker OffscreenCanvas 不可用：`main-thread`。

Worker 路径采用“主线程 rAF clock anchor + Worker 自驱”的组合。anchor 新鲜时每帧
最多校正 2ms；主线程阻塞导致 anchor 过期后保持 Worker 单调时钟自驱，恢复后重新
锁相。三档路径执行相同的 Canvas2D paint workload，结果保存帧时间、阻塞窗口帧数、
paint 次数、最终像素和 anchor 延迟。

## Alternatives

- **只使用 Worker rAF**：实现简单，但目标平台覆盖与稳定性尚未得到真机证明。
- **只有主线程 rAF → Worker**：主线程阻塞时 anchor 停止，不能满足目标。
- **始终主线程 Canvas2D**：功能可用，但本地故障注入已稳定出现约 200ms 绘制空洞。
- **没有 SAB 就回主线程**：丢失 postMessage Worker 仍能独立绘制的大部分收益。

## Evidence

2026-08-14 本地 Chrome 探针自检，均为单次开发机数据，不是产品性能基线：

| 环境                 | 自动选择    | 阻塞 200ms 时结果                                              |
| -------------------- | ----------- | -------------------------------------------------------------- |
| COOP/COEP 开启       | SAB         | SAB 12 帧，最大帧隙 20.9ms；postMessage 13 帧，最大帧隙 21.5ms |
| COOP/COEP 关闭       | postMessage | postMessage 12 帧，最大帧隙 20.8ms；SAB 正确报告 unsupported   |
| 两种环境的主线程对照 | main-thread | 约 204–216ms 最大帧隙，连续性判定失败                          |

每个成功结果的 `paintOperations == renderedFrames`，并读取最终像素；因此证据覆盖
实际 Canvas2D 操作，而不只是 Worker timer。两份运行时报告均通过
`platform-probe-report.schema.json`，控制台无 error/warning。

同一 Chrome 环境新增 bounded SAB ring 压力自检：容量 32，生产 4096 项，其中
1032 项进入 ring、3064 项在满载时显式拒绝；Worker 严格递增消费全部 accepted，
high-watermark 为 32，最终 read/write cursor 均为 1032。服务端从原始 sequence
重新计算记账、顺序与排空不变式。

同一 Chrome 环境的 bounded postMessage 自检采用容量 32 的发送 credit 和逐项 ACK：
生产 4096 项，接受并消费 1024 项、满载时显式拒绝 3072 项，high-watermark 为 32，
最终 in-flight 为 0；1024 个 ACK 与 Worker 消费序列逐项相等，最后
accepted/consumed/acknowledged sequence 均为 4072。服务端从原始消费和 ACK 序列
重新计算全部不变式。该结果证明应用层可限制 in-flight 并可靠排空，不代表浏览器
内部消息队列天然有界，也没有覆盖不同 payload 大小的复制成本。

仍需目标低端 Android、iOS、Safari、Firefox 与业务 COOP/COEP 结论后才能把本 ADR
改为 Accepted。

## Consequences

- Host 必须维护三档能力探测和行为等价测试。
- postMessage 是正式降级路径，不是临时调试代码；采用有界 in-flight/ack 背压，
  并继续记录不同 payload 大小的复制成本。
- main-thread 保证功能，不承诺主线程阻塞时继续呈现，遥测必须区分该模式。
- frame/anchor 原始样本、选择原因与错误必须进入报告，便于线上解释降级比例。

## Rollback

M0 真机若证明 Worker 自驱不稳定，将本 ADR 标记 Rejected，保留 main-thread 原型与
测量基建，重新评审平台范围、性能目标或 compositor 路线。实现尚未进入业务包，
回滚只需移除探针选择，不涉及持久状态迁移。
