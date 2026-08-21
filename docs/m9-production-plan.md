# M9 生产资格、增量合成与发布硬化计划

> 状态：**实施中（2026-08-21）：M9-A/B/C 主链路已落地，完整出口门禁尚未完成**
>
> 前置：M8 工程门禁已完成；开始实现前必须保持 `pnpm m8:check` 全绿
>
> 总计划：[`plan.md`](plan.md)
>
> 技术依据：[`design.md`](design.md)
>
> 资格矩阵：[`device-matrix.md`](device-matrix.md)

## 1. 为什么需要 M9

M0–M8 已经建立完整的渲染、滚动、编辑、事件、无障碍、样式、动画和媒体纵向切片，
但“功能存在”不等于“可以安全扩大生产使用”。当前最重要的剩余风险是：

1. `DrawPicture` ABI 与后端能力已经存在，Core 的 `build_display_list` 仍把子树内联展开；
   纯滚动帧会重复构建、编码和传输未变化的子指令流。
2. M8 出口基线（commit `b564140`、固定 `release-opt-z-lto` 口径）的产品 Core WASM 为
   409,197 gzip bytes，虽然通过 `< 400 KiB` 硬门禁，但只剩 403 bytes 余量，无法承受
   正常维护变化。
3. 自动化工程门禁已经成熟，真机性能、真实 IME、屏幕阅读器、媒体功耗和业务
   COOP/COEP 仍缺少完整资格证据；没有证据时必须保持 `unqualified`。
4. 发布包、灰度和回滚基建已经存在，但还需要一个不会打 tag、不会发布 npm 的候选发布
   总门禁，把性能、资格状态、产物和回滚证据组合起来。

M9 的产品承诺是：**让已有能力具备可度量、可回退、可审计的生产准入路径**，而不是用
新的 API 或 CSS 面继续扩大范围。

## 2. 目标与非目标

### 2.1 目标

- 让稳定子树成为版本化、受预算约束的 immutable Picture 资源；纯滚动帧只重组引用和
  外层变换，不重复传输未变化的子指令。
- 保留内联全量 DisplayList 参考路径，并用逐像素差分证明优化路径正确。
- 在不删除已交付能力、不降低正确性门禁的前提下，把产品 Core WASM gzip 恢复到
  `≤ 384 KiB`，为 400 KiB 产品硬上限保留至少 16 KiB 工程余量。
- 把平台资格扩展为版本化、可过期、可复算、失败关闭的支持矩阵；资格状态只来自原始
  真机证据，不来自开发机模拟或手工汇总值。
- 提供不产生 tag、不上传 npm、不修改线上状态的候选发布检查，自动验证包、WASM、
  支持矩阵、soak 和回滚演练。
- 基于试点证据为 M10 候选能力作出 Adopt / Defer / Reject 决策，避免隐式扩张范围。

### 2.2 非目标

- M9 不默认启用 WebGPU，不新增通用 CSS/CSSOM 兼容层。
- M9 不交付 bidi/复杂脚本、完整 CJK 避头尾、二维虚拟化、virtual header/footer/sticky、
  overlay/absolute positioning 或 widgets placeholder。
- M9 不改变 SSR、mini-program/native adapter 和业务级富文本语义的非目标边界。
- M9 工程完成不等于任何移动设备、浏览器、输入法、屏幕阅读器或受版权媒体已经获得
  支持资格；缺少有效证据时相应平台仍为 `unqualified`。
- M9 不执行 npm publish、Git tag、GitHub Release、生产灰度或外部消息发送；这些都是
  需要维护者明确授权的外部状态变更。

## 3. 不可破坏的边界

- Picture 优化不得让滚动帧调用 Shell，不得改变 Scene 所有权或引入共享可变对象。
- Picture 发布、引用和释放必须服从 commit 边界；解码失败不能产生部分资源状态。
- 资源 ID 必须带 generation 或具备等价的陈旧引用拒绝机制；复用槽位不能让旧引用复活。
- DisplayList 仍是平坦、版本化、四字节对齐的信任边界；不得回到逐 draw WASM→JS 调用。
- 优化路径与内联参考路径必须在要求严格一致的场景逐像素相同；不能通过放宽容差、更新
  golden 或关闭断言让失败通过。
- 资格证据与工程门禁分离：仓库验证“审计器会正确判定”，真实设备决定“平台是否合格”。
- 400 KiB 仍是产品兼容硬上限；384 KiB 是 M9 新增的工程余量门禁，不替代或放宽硬上限。

## 4. 分阶段交付

### M9-A：度量冻结与 Picture 资源 ADR

目标：先固定可证伪假设和量具，再修改热路径。

交付：

- 建立包含复杂行、嵌套裁剪、文本、图片、动画层和 Video poster 的 deterministic
  rich-scroll fixture；固定随机种子、视口、DPR、可见窗口和输入录制。
- 同帧记录 `displayListBytes`、command 数、Picture publish/reuse/rebuild/release、
  资源驻留字节、Core/编码/传输/replay 时间和过度失效率。
- 保留 inline reference builder，并定义 `incrementalPicturesEnabled` 优化级回滚开关。
- ADR 冻结 Picture ID/generation、publish-before-reference、release acknowledgement、
  跨 Worker 传输、内存预算、重启恢复和 ABI 兼容方案。
- 建立复杂度门禁：预热后把不可变子树内部 draw command 数扩大四倍，不得让纯滚动帧
  的子树 payload 随之扩大；每帧只允许出现有界的 composition 引用和真实变更资源。

出口：基线可重复，指标 schema 有敌意输入测试，reference/optimized 开关可独立选择，
ADR 包含失败模式与回滚；此阶段不以“看起来更快”作为完成证据。

### M9-B：增量 Picture 合成

目标：让纯滚动、transform/opacity 动画和未变化虚拟 item 复用 immutable Picture。

交付：

- Core 按稳定内容 hash 和 generation 管理 Picture arena；结构或 paint 变化只重建受影响
  子树，layout-only offset 变化只重组 `DrawPicture`。
- Picture resource 与引用同一 committed frame 原子发布；release 在最后引用之后发生，
  Worker 重启或 transport 切换从完整快照重建。
- Backend 以固定字节和资源数预算保存 Picture；压力下按可解释策略驱逐，命中失败回到
  同帧内联/重建路径，不允许空白、旧画面或 use-after-close。
- hit、semantics、editing geometry 和 media resource 生命周期保持由 Scene 派生，不能因
  Picture 复用而冻结交互状态。
- main-thread、postMessage、SAB 三 transport 以及 native/WASM 使用同一资源时序语义。

自动验证：

- optimized ↔ inline reference 逐像素严格差分；native ↔ WASM 输出严格一致。
- 任意 publish/reference/release/evict/restart 序列的模型或属性测试；截断、乱序、重复、
  超预算和陈旧 generation 均失败关闭且不部分提交。
- 纯滚动稳态 `layoutVisitedNodes == 0`、Shell mutation 为零、未变化子树 rebuild 为零；
  idle 帧不产生 DisplayList、资源消息或回放。
- rich-scroll 自动 benchmark 继续满足 PC P95 ≤ 16.7ms、P99 ≤ 25ms、掉帧率 < 0.5%；
  200ms 主线程阻塞时 Worker 连续推进。
- 30 分钟逻辑时间/加速 soak 后资源驻留回到预算内，无 generation 泄漏或单调增长。

回滚：关闭 `incrementalPicturesEnabled` 后使用现有内联 DisplayList；关闭优化不改变公开
API、Scene、Mutation Stream 或业务 durable state。

### M9-C：WASM 预算恢复与归因

目标：把“刚好没超限”变成可以持续维护的预算。

交付：

- 固定 Rust/wasm-pack/wasm-opt 工具链，输出 crate/能力维度的 size attribution 和
  release artifact gzip 报告。
- 产品 Core 同时执行 `< 400 KiB` 产品硬门禁和 `≤ 384 KiB` M9 工程余量门禁；冷启动
  额外延迟继续 `< 50ms`。
- 优先移除重复生成代码、未使用泛型实例、重复错误文本和同步入口不需要的可选能力；
  适合延迟加载的 decoder/tooling 必须拆成独立产物并保持完整性 manifest。
- size 优化必须通过 native/WASM 差分、ABI fixture、fuzz、覆盖率和浏览器纵向切片；不得
  通过删除 fallback、调低优化正确性或改变压缩口径达标。

出口：同一工具链连续两次 clean build 均 `≤ 384 KiB`，报告能解释主要体积来源；任何
单项变化超过 4 KiB 必须在 CI 输出归因并要求显式审阅。

回滚：每个 size change 可独立 revert；若拆分模块加载失败，保留原有功能等价路径或将该
可选能力标为 unavailable，不能让 Core 半初始化。

### M9-D：平台资格与支持矩阵 v2

目标：让“支持某平台”成为可验证、会过期的事实，而不是文档中的口头承诺。

工程交付：

- 版本化 evidence manifest 记录 device/role/build、OS/浏览器/输入法、transport、capability、
  原始帧样本、内存、掉帧、IME replay、无障碍检查和媒体事件/复制/回收数据的摘要与 digest。
- `platform:qualify` 从原始样本复算 P95/P99/掉帧率/冷启/内存，不信任提交的汇总值；
  缺文件、串组、重复 batch、环境漂移、过期、digest 不符或伪造派生值均失败关闭。
- 支持矩阵输出 `qualified | unqualified | expired`，并列出选中的 transport、EditContext/
  proxy、Video 路径、已验证浏览器版本和不能声明的能力。
- OS、浏览器主版本、设备角色或引擎 build 改变时旧证据不能静默继承；过期策略写入 schema
  并由时钟注入测试。
- 真机采集覆盖低端/中端 Android、最低/当前 iOS、desktop Chromium/Safari/Firefox；
  IME 覆盖中/日/韩与代理路径，无障碍覆盖 VoiceOver/NVDA/TalkBack，媒体覆盖后台切换、
  seek/loop/error、功耗记录与资源回收。不能可靠证明硬件解码或 DRM 时不得声称支持。

工程出口只要求审计器、schema、fixture 和失败路径自动通过。真实资产分配与有效报告会改变
支持矩阵状态，但缺失时只保持 `unqualified`，不阻止 M9 工程完成。

回滚：发现证据错误或平台回归时立即把对应 role/build 标为 `expired` 或 `unqualified`，
通过 capability override 退到安全 transport/输入/媒体路径；不修改历史原始证据。

### M9-E：候选发布、soak 与回滚演练

目标：证明某个 commit 可以进入发布评审，而不在门禁中执行实际发布。

交付：

- 新增 `pnpm m9:check`，串联 `m8:check`、Picture 契约/差分/性能、WASM 余量、资格审计器、
  deterministic soak、API/ABI 快照与 release tarball 验证。
- 新增只读候选发布报告：commit、版本、ABI/Worker protocol、WASM digest、11 个包 digest、
  测试结果、资格矩阵、已知限制、回滚开关和未满足支持项。
- 把 GitHub release workflow 的全量门禁从历史 `m5:check` 升级为 `m9:check`；升级前对
  当前 `main` fail closed，禁止创建 post-M8 tag 或发布 npm。
- 每次提交运行加速 soak；定期运行真实 30 分钟 scroll/animation/edit/media 组合 soak，
  对 frame/resource/node/listener 数量设置硬预算和结束态回收断言。
- 自动演练页面级 kill switch、Picture 优化关闭、Video 关闭、SAB→postMessage→main-thread
  降级和 Worker 重启；回滚后 durable application state 与编辑 revision 不倒退。
- 更新 runbook：资格撤销、WASM/CDN digest 不一致、Picture poison、媒体泄漏和 rollback
  失败均有操作步骤、诊断字段和停止放量条件。

出口：候选发布命令在 clean checkout 可重复生成同语义报告并全绿；命令不得创建 tag、
GitHub Release、npm 发布或修改线上配置。实际发布仍按 [`release.md`](release.md) 由维护者
单独授权。

### M9-F：下一阶段范围决策

M9 不实现延后能力，只为每个候选项记录需求证据、性能/包体预算、API/ABI 影响、oracle、
平台资格和回滚方案，并给出 Adopt / Defer / Reject：

- bidi/复杂脚本与视觉导航；
- overlay/absolute positioning 与 widgets placeholder；
- 二维虚拟化和 virtual header/footer/sticky；
- `calc()`/custom properties/更复杂 selector/离散 transition；
- WebGPU 默认启用；
- 独立 DevTools UI。

没有真实业务 fixture 或无法写出自动出口门禁时默认 Defer。M9 完成不要求必须产生 M10；
“没有足够证据，继续延后”是有效决策。

## 5. 总出口门禁

M9 只有在以下自动、可重复条件全部满足时才能声明工程完成：

1. `pnpm m9:check` 在 clean checkout 全绿并完整包含 `pnpm m8:check`。
2. Picture optimized/reference、main/postMessage/SAB、native/WASM 的正确性和资源时序门禁通过。
3. rich-scroll 的绝对性能、复杂度不变量、200ms stall 和资源预算通过。
4. 产品 Core WASM clean build `≤ 384 KiB` gzip且冷启动 `< 50ms`。
5. 资格 v2 审计器对有效 fixture 通过，对缺失、篡改、串组、过期和伪造数据失败关闭。
6. 加速 soak、定期 30 分钟 soak、候选 tarball、digest 和全部回滚演练通过。
7. API/ABI/协议变更有版本、golden、roundtrip、malformed-input 和 fuzz 覆盖；公开文档、
   diagnostics、runbook、changelog 同步。
8. Rust workspace ≥ 85%、核心 crates ≥ 95%、TypeScript ≥ 80%，且新增失败路径有实质断言。

真机报告不是上述工程完成条件，但任何发布支持声明必须额外满足对应 role 的有效资格证据。

## 6. 依赖与执行顺序

```text
M8 complete
  → M9-A 度量/ADR
      ├─→ M9-B Picture 合成 ─┐
      ├─→ M9-C WASM 余量 ────┼─→ M9-E 候选发布/回滚
      └─→ M9-D 资格 v2 ──────┘
                                  → M9-F 下一阶段决策
```

- M9-B 和 M9-C 可并行，但每次合流都必须运行同一产品 WASM 与 rich-scroll 门禁。
- M9-D 的 schema/审计器可与 Core 工作并行；真实设备采集必须绑定候选 commit 和 build digest。
- M9-E 依赖 B/C/D 的工程出口，不依赖所有平台变成 qualified。
- 任何需要新 Core node kind、公开 API 或 ABI 的候选能力都不进入 M9，应转为独立后续里程碑。

## 7. 关键失败模式与停止条件

| 失败模式                             | 最小停止条件                   | 处置与回滚                                     |
| ------------------------------------ | ------------------------------ | ---------------------------------------------- |
| Picture 引用早于资源发布             | 任一空白帧、未知 ID 或部分提交 | 停止合入；修复事务顺序；关闭 Picture 优化      |
| 槽位复用让旧 generation 复活         | 属性/故障注入出现陈旧命中      | 停止合入；禁止复用直到 generation 不变式恢复   |
| 优化后像素或交互语义变化             | D1/D3、hit、semantics 任一差异 | 回到 inline reference；不得更新 tolerance 掩盖 |
| Picture 驻留或消息无界增长           | soak 超预算或结束态不回落      | 停止 soak/放量；清空优化缓存并回退 inline      |
| WASM 无法恢复 16 KiB 余量            | clean build > 384 KiB          | 暂停新增 Rust 能力；做归因、拆分或裁剪重复实现 |
| 资格证据无法复算或已过期             | audit 不通过                   | 平台标为 unqualified/expired；禁止支持声明     |
| 回滚造成 durable state/revision 倒退 | 演练出现数据或输入丢失         | 停止候选发布；修复适配边界，不以重新发布代替   |
| 候选命令产生外部状态                 | 出现 tag/publish/线上写入      | 视为门禁缺陷；拆除副作用并审计凭证/产物        |

## 8. 完成后的状态表达

M9 工程完成后可以声明：

- Picture 增量合成、WASM 余量、资格审计和候选发布流程已通过自动化门禁；
- 某个平台只有在支持矩阵显示 `qualified` 时，才可以附带具体 build/browser/transport/
  输入/媒体范围作支持声明；
- npm 或生产发布只有在维护者明确执行发布流程后才算发生。

禁止把“M9 工程完成”“某平台 qualified”和“某版本已经发布”三个状态合并表述。
