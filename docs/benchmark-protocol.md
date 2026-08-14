# Benchmark 复现协议

本协议适用于 P0 之后所有性能结论。场景定义以
[`../benchmarks/suite.v1.json`](../benchmarks/suite.v1.json) 为唯一来源，报告必须符合
[`schemas/benchmark-run.schema.json`](schemas/benchmark-run.schema.json)。

## 构建与环境

- 仅使用 release/production 构建；禁止用开发构建形成基线。
- 每份报告必须记录 engine、完整 commit/build id、浏览器与 OS 版本、设备资产 ID、
  viewport、DPR 和 cross-origin isolation 状态。
- 同一回归组使用相同设备、浏览器版本、电源模式、温度起点、viewport、网络资源
  和字体。运行期间关闭 DevTools、录屏及无关前台应用。
- 真机使用物理设备，不以桌面 CPU 降速模拟替代低端 Android 或 iOS 证据。
- 图片和字体必须来自固定的本地 fixture；正式基线禁止依赖实时网络资源。

## 采样

1. 重启浏览器并打开干净 profile；等待设备进入稳定温度与电源状态。
2. 每个场景运行 5 次预热，预热结果不进入统计。
3. 每个场景运行 15 次正式样本；场景要求 10 秒时不得缩短。
4. 保存每一帧/每一操作的原始样本，再从完整样本计算 count、min、max、mean、
   P50、P95、P99。
5. 百分位使用线性插值：`index = (n - 1) * q`。算法与平台探针
   `metrics.ts` 一致。
6. 不自动删除 outlier。设备过热、页面失焦、进程崩溃等无效运行必须保留失败记录，
   重新采集时使用新的 run id 并说明原因。

## 复现判定

同一 build 在同一设备上进行两组独立采集。满足以下条件才称为可复现：

- 两组 frame-time P95 的相对差异不超过 10%；
- 两组吞吐量中位数的相对差异不超过 5%；
- 正确性 hash、能力选择和降级模式完全一致；
- 两组均无未解释的错误、后台化或热降频记录。

超出误差时不能选择较好的一组作为基线，必须查明温度、调度、资源、构建或采集
差异后重新运行。

## 绝对门禁与趋势诊断

- 每个 build 先独立检查 `design.md` §2 的绝对 FPS、帧时间、掉帧率、输入延迟、
  内存和 WASM 指标；没有外部引擎对照也必须能得出 Pass/Fail。
- doper 目标分支或历史 build 的同口径数据只用于趋势诊断，不是独立通过条件，也
  不要求提供任何外部引擎的对照数据。
- 需要调查趋势时，两侧必须使用相同 suite、输入序列、资源、viewport、构建优化
  等级和采样顺序，并交替运行，避免温度或浏览器长期状态只影响后运行的一侧。
- 趋势报告比较 P50/P95/P99、吞吐和内存；P95 或吞吐变化超过 5% 时标记调查，
  不能用平均值掩盖长尾变化。只有绝对指标失守时，性能门禁才判定失败。
- 原始 JSON、失败记录和汇总一起归档。没有原始样本的表格或截图不构成基线。

## 编辑与 IME

`benchmarks/ime/synthetic-composition.v1.json` 只用于 runner 和 revision 状态机开发，
其 `provenance` 明确为 synthetic，不能作为输入法兼容证据。正式 M0 证据必须由目标
OS/浏览器/输入法录制，包含原始事件、selection、composition、character bounds、
软键盘状态和最终文本。
