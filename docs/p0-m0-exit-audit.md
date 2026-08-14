# P0 / M0 出口审计

> 审计日期：2026-08-14
>
> 审计范围：当前分支 HEAD；初始平台探针基准为
> `9813e32f85287564f30fac027312d92aed28a9da`。
>
> 规则：工程完成只由仓库和 CI 能自动复现的证据决定。真机、真实输入法和业务环境
> 属于平台资格认证；缺失时不能宣称该平台已认证，但不改变工程里程碑状态。

## 状态定义

- **完成**：交付物和自动化出口条件均有可复现证据。
- **进行中**：已有实现或部分证据，但不足以通过出口。
- **未开始**：没有实现或可信证据。
- **平台未认证**：需要目标设备、业务系统或输入法环境；不阻塞工程里程碑。

## P0

| 要求                                                 | 状态 | 当前证据                                                                 |
| ---------------------------------------------------- | ---- | ------------------------------------------------------------------------ |
| Rust workspace、TS monorepo、格式/lint/test/build/CI | 完成 | 本地 `pnpm m0:check`；当前 `main` 的远端 CI                              |
| ADR、benchmark fixture 规范、性能数据格式            | 完成 | `docs/adr/`、versioned suite/schemas、`pnpm contracts:check`             |
| 六类代表性场景                                       | 完成 | `benchmarks/suite.v1.json` 固定场景、seed、viewport、workload 与 metrics |
| 自动化复现与统计口径                                 | 完成 | 固定 fixture、原始样本、两组 5+15/10%/5% 算法的测试                      |
| 报告完整性与可追溯性                                 | 完成 | build/device/run id、原子归档、SHA-256 sidecar、派生指标重算             |

## M0

| 要求                               | 状态 | 当前证据                                                     |
| ---------------------------------- | ---- | ------------------------------------------------------------ |
| Worker rAF、SAB 延迟与跨时钟换算   | 完成 | 原始样本、跨 global timeOrigin 修复、单元测试                |
| Worker 自驱与相位锁，含 200ms 阻塞 | 完成 | SAB/postMessage 连续 paint、故障注入、Accepted ADR-0001      |
| Worker/主线程 Canvas2D 对照        | 完成 | fill、scroll-copy 与 128/256/512/1024 tile 自动探针          |
| Rust/WASM 体积与冷启动预算         | 完成 | 最小 180B；host 精确包络最大 236,368B gzip；`<50ms` 报告门禁 |
| SAB/postMessage/主线程三档原型     | 完成 | capability 自动选择、两种背压及 256B–1MiB payload 校验       |
| COOP/COEP capability 与审计工具    | 完成 | 隔离/无隔离构建、响应头/跨域资源审计及安全降级               |
| EditContext/输入代理契约           | 完成 | v2 schema、导出、确定性 replay、两条输入路径和负向测试       |
| 采集、上传、完整性与趋势           | 完成 | TLS/认证、原子归档+sidecar、summary v2、趋势页及失败关闭测试 |
| M0 架构决策                        | 完成 | ADR-0001 与 ADR-0004 Accepted                                |

## 当前结论

**P0 和 M0 工程出口已通过，可以进入 M1。**统一复现命令为 `pnpm m0:check`。

以下项目保留为非阻塞平台资格，当前没有证据的平台状态为 `unqualified`：

1. Android/iOS/Safari/Firefox 的物理设备性能与冷启动。
2. 真实业务登录态的 COOP/COEP 和第三方资源影响。
3. 中文、日文、韩文、复杂 composition、软键盘和候选窗。
4. 外部不可变存储与恢复演练。

资格命令为 `pnpm platform:qualify`。它仍严格要求七角色、两组 5+15、真实 IME 和
结构化证据；缺少证据时失败关闭，但该失败不等于 P0/M0 工程失败。

P0/M0 的性能完成条件只看 doper 自身绝对指标，不依赖目标分支或任何外部引擎
的性能数据。doper 历史趋势保留为诊断信息，不是独立出口门禁。
