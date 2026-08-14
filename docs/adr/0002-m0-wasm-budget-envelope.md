# ADR-0002：用代表性文本包络验证 WASM 体积余量

- 状态：Accepted（仅限 M0 预算探针）
- 日期：2026-08-14
- 决策者：doper maintainers
- 关联设计：`docs/design.md` §2、§15、§16

## Context

最小 cold-start 模块只有 180B gzip，只能验证浏览器加载链路，不能证明未来 Core 在
400KB gzip 产品预算内有可信余量。M0 需要在产品 Core 尚未实现时尽早暴露文本处理
依赖可能造成的体积风险，同时不能把探针依赖误当成最终架构选择。

## Decision

保留 180B 最小模块作为纯启动下界，并新增隔离的 `probes/wasm-budget` 包络探针：

- 实际链接 `unicode-segmentation 1.13.3` 与 `rustybuzz 0.20.1`，并导出可达的
  grapheme 与 shaping 路径，防止优化器移除代表性代码；
- JS 输入通过 Rust 自有、显式上限的缓冲区进入，不接受裸指针/长度对，畸形标量和
  非法 UTF-8 返回错误哨兵；
- 使用 Rust 1.96.0、`opt-level=z`、LTO、单 codegen unit 与 strip symbols；
- 产品预算保持 400KB gzip，包络探针设置 300KB gzip 内部门禁，从而至少保留
  100KB 给 Scene、Layout、ABI、Paint 和调度代码；
- 该 probe 不进入产品 Core，也不决定 M3 的最终 shaping 依赖。依赖选型变化时重新
  建立同口径包络并显式评审 evidence fixture。

## Alternatives

- 只测最小模块：无法发现真实依赖体积，拒绝。
- 在 M1/M3 完成后再测：发现预算超标时重构代价过高，拒绝。
- 直接把探针依赖加入 Core：会在架构验证前固化实现，拒绝。
- 用 crate 源码大小或下载包大小估算：与 LTO 后 WASM gzip 无直接对应关系，拒绝。

## Evidence

- 固定证据：[`../evidence/wasm-budget.v1.json`](../evidence/wasm-budget.v1.json)
- 复现命令：`pnpm wasm:budget`
- Rust 单元测试验证 grapheme、非法字节和无裸指针输入路径；`pnpm check` 对 evidence
  做精确回读，工具链或二进制大小漂移会失败。
- 2026-08-14 `dev-mac-01` Chrome 本地自检：591,662B raw / 236,368B gzip，距
  400KB 产品预算剩余 173,232B；`instantiateStreaming` 的 fetch、compile +
  instantiate、首次调用分别为 2.735ms、2.445ms、0.225ms，总计 5.405ms。
- 浏览器报告通过 `platform-probe-report-v1` schema，探针错误为空。该桌面单次数据
  只验证链路与数量级，不替代目标移动设备的重复冷启动样本。

## Consequences

- CI 增加一个约 236KB gzip 的代表性包络构建和精确 evidence 检查。
- 目前对产品预算有 173KB 的实测静态余量，但这不是最终 Core 体积保证；每个里程碑
  仍必须对真实产物执行 400KB 门禁。
- `rustybuzz`/`unicode-segmentation` 只存在于 disposable probe，Core 不得依赖它们
  来声称设计已定。
- 移动设备上的网络、编译与首次调用长尾仍是 M0 未关闭项。

## Rollback

删除 `probes/wasm-budget`、对应构建脚本入口和 report 字段即可回滚，不影响最小
cold-start 模块或运行时降级链。若包络超过 300KB，先记录失败证据，再评估 feature
裁剪、延迟加载或更换文本路径；不得仅提高门禁使 CI 变绿。
