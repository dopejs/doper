# P0 / M0 出口审计

> 审计日期：2026-08-14
>
> 基准提交：`9813e32f85287564f30fac027312d92aed28a9da`
>
> 规则：只有可复现的当前证据才能标记完成；实现存在但未在要求的平台验证，仍为未完成。

## 状态定义

- **完成**：交付物和出口条件均有可复现证据。
- **进行中**：已有实现或部分证据，但不足以通过出口。
- **未开始**：没有实现或可信证据。
- **外部待验证**：仓库内准备已完成，但需要目标设备、业务系统或输入法环境。

## P0

| 要求                                                 | 状态       | 当前证据                                                                 | 缺口                                     |
| ---------------------------------------------------- | ---------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| Rust workspace、TS monorepo、格式/lint/test/build/CI | 完成       | 本地 `pnpm check`；GitHub CI run `31796925527` 在基准提交通过            | 新变更推送后仍须保持绿色                 |
| ADR、benchmark fixture 规范、性能数据格式            | 完成       | `docs/adr/`、versioned suite/schemas、`pnpm contracts:check`             | 后续契约变更必须版本化                   |
| 六类代表性场景                                       | 完成       | `benchmarks/suite.v1.json` 固定场景、seed、viewport、workload 与 metrics | runner 随可执行引擎纵向切片实现          |
| 固定设备矩阵与采样口径                               | 进行中     | `docs/device-matrix.md`、`docs/benchmark-protocol.md`                    | 为必需角色分配具体物理资产               |
| 外部依赖、试点业务与 M0 输入                         | 外部待验证 | 风险与决策项已列入计划                                                   | 业务 owner、COOP/COEP 影响盘点、试点场景 |
| 同设备可复现                                         | 进行中     | 两次本地探针 Worker rAF/SAB P95 差异约 4%                                | 正式 suite 仍需两组各 15 次采集          |
| 报告包含环境、build id、原始样本                     | 完成       | 报告 schema、JSON 导出、CI schema/fixture 校验与真实报告验证             | 正式基线禁止 `local-uncommitted`         |

## M0

| 要求                               | 状态       | 当前证据                                                          | 缺口                                      |
| ---------------------------------- | ---------- | ----------------------------------------------------------------- | ----------------------------------------- |
| Worker rAF 可用性与稳定性          | 进行中     | 桌面 Chrome 60 帧原始样本                                         | 目标设备矩阵、重复采样与相位漂移          |
| 主线程 rAF → SAB → Worker 延迟     | 进行中     | 修复跨 global 时间原点后，本地采样有效                            | 真机分布与长期样本                        |
| Worker 自驱与相位锁，含 200ms 阻塞 | 进行中     | 本地 Chrome 的 SAB/postMessage 在阻塞窗口持续实际 paint；ADR-0001 | 目标低端设备重复采样                      |
| Worker/主线程 Canvas2D 对照        | 进行中     | 桌面 fill、scroll-copy 与 128/256/512/1024 tile 扫描              | 低端 Android 成本                         |
| 最小 Rust/WASM 预算                | 进行中     | 196B raw / 180B gzip，streaming instantiate 与首次调用可采集      | 代表性代码规模投影和真机数据              |
| SAB/postMessage/主线程三档原型     | 进行中     | 隔离/无隔离自动选择；三档同 paint；报告通过 schema                | Worker/OffscreenCanvas 缺失真机验证、背压 |
| COOP/COEP 业务可行性               | 外部待验证 | 本地 Vite 隔离头可用                                              | 第三方资源、iframe、跳转、监控与业务结论  |
| EditContext/输入代理能力矩阵       | 进行中     | 桌面 Chrome `textupdate`、grapheme 光标及强制 proxy 输入成功      | 软键盘、候选窗、多 OS/IME 与录制回放      |
| 真机采集、上传与趋势               | 未开始     | 本地 JSON 导出                                                    | 设备采集、持久存储、趋势对比              |
| Go / Pivot / Stop ADR              | 未开始     | ADR 模板                                                          | 上述证据齐备后的正式决策                  |

## 当前结论

P0 和 M0 均未通过出口门禁。最近关键路径是：

1. 为 Android、iOS、Safari、Firefox 角色分配物理设备并重复采集。
2. 在目标业务页面完成 COOP/COEP 与第三方资源影响盘点。
3. 录制中文、日文、韩文和复杂 composition，验证 EditContext 与输入代理。
4. 建立真机报告上传/趋势链路，并完成代表性 WASM 规模投影。

P0/M0 的性能完成条件只看 doper 自身绝对指标和目标分支回归，不依赖任何外部
引擎的性能数据。
