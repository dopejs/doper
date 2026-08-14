# doper 总体实施计划

> 状态：草案 v0.2  
> 依据：[`design.md`](design.md)  
> 规划口径：按依赖顺序、交付物和出口门禁管理，不含人力与工期估算

---

## 1. 计划目标

本计划用于把技术设计转成可执行的研发项目。最终交付是一套从第一性原理
设计的 Web Canvas 渲染引擎：

- 提供 TSX 开发体验、引擎原生虚拟滚动、多级缓存和稳定的 PC/移动端性能。
- 用新的 Rust/WASM Core、TypeScript Shell、双时钟和二进制 ABI 解决移动端
  滚动长尾问题。
- 从第一天建立确定性、差分测试、性能门禁、可观测性和降级能力。
- 提供 canvas 内原生 caret、selection、IME 和文本编辑，业务不再为输入能力
  创建 EmbedDOM 控件。
- 用外围兼容层支持存量迁移，不让存量引擎的内部模型限制 doper Core。

存量实现只作为迁移输入，不是性能对照组或架构模板。doper 的完成标准由自身
绝对指标、目标分支回归数据和正确性 oracle 决定。

## 2. 成功标准

项目成功需要同时满足以下四类结果，任何一类缺失都不能宣布完成。

### 2.1 性能

- 低端安卓滚动帧时间 P95 ≤ 16.7ms，P99 ≤ 33ms。
- 连续滚动 10 秒掉帧率 < 1%。
- `touchmove` 到呈现延迟 ≤ 2 帧。
- 主线程人为阻塞 200ms 时滚动不停顿。
- PC 连续交互帧时间 P95 ≤ 16.7ms、P99 ≤ 25ms，10 秒掉帧率 < 0.5%。
- 相对 doper 目标分支的 P95/吞吐回归超过 5% 时阻止合入并要求解释。
- WASM gzip < 400KB，冷启动额外延迟 < 50ms。

### 2.2 正确性

- 增量渲染与全量渲染在要求严格一致的场景逐像素相同。
- Mutation Stream 和 DisplayList 能版本协商、拒绝畸形输入并确定性回放。
- 优化路径能与朴素参考路径做差分验证。
- 降级模式功能等价，不因浏览器缺少 SAB、Worker 或 OffscreenCanvas 而缺功能。

### 2.3 开发体验

- 业务只依赖 `@dopejs/doper`，继续使用 TSX、function component、hooks 和
  signals。
- 公开 API 有明确契约、文档和兼容策略。
- 能通过语义树进行 E2E 测试，并能录制、导出和重放线上输入。
- `EditableText`、`TextField` 和 `TextArea` 在支持矩阵内完成输入法、键盘、
  指针、剪贴板、撤销重做与无障碍闭环。

### 2.4 迁移

- 存量页面可以按页面或场景灰度迁移。
- Worker、WebGPU 和 doper 整体均有可操作的回退开关。
- 存量兼容 shim 位于边界层，可独立删除，不污染 Core。

完整数值及测试口径以 `design.md` 为准。本文件不得降低设计中的验收线。

## 3. 规划假设与约束

### 3.1 外部依赖

以下依赖不由引擎仓库单方面控制，M0 必须得到明确结论：

- 目标业务能否部署 COOP/COEP，以及第三方资源受影响范围。
- 低端安卓、主流 iOS 和 PC 的真机/设备农场可用性。
- npm 包发布、WASM CDN/静态资源、灰度与线上指标平台。
- 试点业务场景及其准入条件。

### 3.2 范围管理原则

- M0 结束时根据平台能力、实测收益和文本方案复核后续范围与优先级。
- 未通过出口门禁时，不得通过压缩测试、降低指标或跳过降级路径进入下一阶段。
- 新需求必须说明所属里程碑、前置依赖及对当前关键路径的影响。
- 对核心目标无直接贡献的能力进入候选清单，不隐式扩张当前阶段范围。

## 4. 总体策略

### 4.1 先证明风险，再增加复杂度

项目的关键路径不是“先把所有组件写出来”，而是依次证明：

1. 浏览器平台允许 Worker 独立、稳定地驱动渲染。
2. 单线程 Core 的数据模型、ABI 和确定性测试基建正确。
3. 双时钟与缓存能在主线程阻塞时保持滚动。
4. 原生虚拟滚动和文本能在真实大数据场景达到指标。
5. 交互、无障碍和迁移能力能满足实际业务。

### 4.2 架构创新采用“假设—探针—决策”闭环

任何影响 Core 模型、ABI、调度、缓存或后端的重大创新都应包含：

1. 明确要改善的用户问题和可量化指标。
2. 至少一个可证伪的技术假设。
3. 最小探针或参考实现，而不是直接进入生产主路径。
4. 与朴素参考路径及 doper 目标分支基线的同口径数据。
5. 决策记录、失败模式、兼容影响和回滚路径。

架构决策记录放入 `docs/adr/`，格式至少包含 Context、Decision、Alternatives、
Evidence、Consequences 和 Rollback。设计尚未确认的部分不得通过代码事实被
悄悄固化。

### 4.3 保持一条可运行的纵向切片

从 M1 开始，主分支始终保留一条最小端到端路径：

```
TSX/fixture → Mutation Stream → Scene/Layout → DisplayList → Canvas2D → frame
```

每个阶段扩展这条路径，禁止长期存在只能单独运行、无法组合验证的模块堆积。

## 5. 工作流划分

项目分为七条长期工作流。里程碑是集成与验收边界，工作流用于安排并行执行。

| 工作流              | 范围                                                   | 主要产物                                           |
| ------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| W1 架构与度量       | ADR、能力探针、benchmark、真机数据                     | 决策记录、性能看板、基线报告                       |
| W2 Rust Core        | Scene、Layout、ABI、Scroll、Paint、Anim、Hit、Text     | crates、native/wasm 构建、参考实现                 |
| W3 TypeScript Shell | signals/hooks、JSX、reconciler、facade                 | packages、公开 API、类型与契约                     |
| W4 Host 与 Backend  | Worker、SAB/postMessage、Canvas2D、资源管理            | 帧驱动、回放器、降级链                             |
| W5 质量与可观测性   | headless、属性/差分/fuzz/E2E、devtools                 | CI 门禁、录制回放、诊断指标                        |
| W6 迁移与交付       | shim、试点应用、发布、灰度、回滚                       | 迁移指南、发布包、运行手册                         |
| W7 编辑基础设施     | edit model、IME、caret/selection、clipboard、undo/redo | `EditableText`、Input Stream、输入桥与编辑测试矩阵 |

W5 不是收尾工作。每个功能必须把对应测试和观测能力作为同一个交付项完成。

## 6. 里程碑与出口门禁

### P0：项目引导与基线定义

> 当前状态：进行中。Rust/TypeScript workspace、基础 CI、versioned benchmark
> suite/schema、复现协议和 M0 浏览器探针已建立；具体物理设备资产与试点业务输入
> 尚未完成。

目标：让 M0 的结果可重复、可比较，并建立最小工程治理。

主要交付：

- 初始化 Rust workspace、TypeScript monorepo、格式化、lint 和基础 CI。
- 建立 `docs/adr/`、benchmark fixture 规范和性能数据格式。
- 固定代表性场景：静态表格、连续滚动、动态高度列表、图片列表、高频局部
  更新，以及单元格编辑/IME composition。
- 固定设备矩阵、构建模式、采样时长、预热次数和 P50/P95/P99 算法。
- 建立 doper 自身的绝对性能基线和目标分支回归基线。
- 明确外部依赖、试点业务与 M0 决策输入。

出口门禁：

- 任意工程师可以按文档在同一设备复现基线，误差范围有记录。
- CI 能运行空工程的格式、lint、单元测试和构建检查。
- benchmark 数据包含环境、commit/build 标识和原始样本，不只保留汇总值。

### M0：平台能力与架构探针

> 当前状态：进行中。桌面 Chrome 已验证隔离/无隔离自动选择、三档 transport、
> 实际 Canvas 绘制连续性、tile 扫描、EditContext/输入代理和 WASM streaming；
> 真机矩阵、业务 COOP/COEP 结论与多输入法录制回放尚未完成。

目标：验证双时钟方案是否成立，确定平台能力矩阵和降级策略。

主要交付：

- Worker rAF 可用性与相位稳定性探针。
- 主线程 rAF 时间戳经 SAB 到 Worker 的延迟分布。
- Worker `setTimeout` 自驱与相位锁探针，包括主线程阻塞 200ms。
- Worker/主线程 OffscreenCanvas 2D 吞吐对照。
- `drawImage` scroll-copy、tile 大小和低端安卓成本数据。
- 最小 Rust WASM 的 gzip 体积、streaming compile 和首次调用数据。
- COOP/COEP 影响盘点以及 SAB、postMessage、主线程三档原型。
- EditContext、软键盘、主流 IME、候选窗 bounds 与引擎托管输入代理探针。
- 真机帧时间采集、原始数据上传和趋势展示。

出口门禁：

- 目标设备矩阵上能解释采用哪种帧驱动以及每个平台的降级方式。
- 在至少一个低端目标设备上证明主线程阻塞时 Worker 原型仍能连续呈现；
  若无法证明，必须形成替代架构决策，不能直接进入 M1。
- COOP/COEP 有业务侧结论，不能以“以后再确认”关闭 M0。
- 每个目标平台都确定 EditContext 或输入代理路径，并完成中文、日文、韩文及
  至少一种复杂 composition 流的录制回放。
- WASM 体积和启动预算存在可信的剩余空间评估。
- 召开 Go / Pivot / Stop 评审并留下 ADR。

回滚/转向：若 Worker 独立驱动不可行，保留单线程 Canvas2D 原型与测量基建，
重新评估“主线程阻塞不掉帧”目标、平台范围或原生 compositor 路线。

### M1：确定性单线程内核

目标：建立正确、可测试的端到端渲染内核，不提前引入并发复杂度。

主要交付：

- 单源 schema 与 Rust/TS 代码生成。
- `doper-abi`：Mutation Stream、DisplayList、版本协商和畸形输入处理。
- `doper-scene`：SoA、generation NodeId、脏位图、commit 时拓扑紧凑化。
- `doper-layout`：约束布局、relayout boundary、双缓冲结果比较。
- `doper-edit` 最小数据模型：revision、selection/affinity、composition、原子
  edit transaction，以及 UTF-16/UTF-8/grapheme offset 映射。
- 最小 Paint/Canvas2D 回放路径以及 Picture 的不可变表示。
- signals、基础 hooks、JSX runtime、reconciler 和 facade 的最小公开 API。
- 可注入时间/RNG、二进制录制回放、headless 渲染。
- 增量/全量差分、属性测试、ABI golden/roundtrip、基础 fuzz。
- 编辑事务属性测试：grapheme 不可拆分、revision 单调、undo/redo 可逆、
  composition commit 原子化及确定性回放。
- 最小语义字段进入 Scene/协议，为 M4 保留正确架构位置。
- devtools 最小帧阶段、脏节点和 picture hash 诊断。

范围澄清：M1 文本使用足以验证端到端架构的最小路径或宿主 fallback；完整
web 字体 shaping、复杂排版和 glyph atlas 属于 M3。M1 的“像素对齐”验收只
覆盖双方能力交集且 fixture 已固定的场景。

出口门禁：

- 纵向切片可在 native/headless 和浏览器中确定性运行。
- 相同输入、时间和随机种子得到相同指令流及要求严格一致的像素输出。
- Scene、Layout、ABI 的属性与差分测试进入每次提交 CI。
- 新 prop 缺少 invalidation 元数据或生成器覆盖时构建失败。
- PC 快集 benchmark 相对已冻结基线不回归。
- 公开 API 快照和二进制 golden 的变更必须显式评审。
- 最小编辑 Input Stream 可录制回放，过期 revision 不覆盖新编辑状态。

回滚：各优化路径保留朴素参考实现；出现正确性问题时可全局强制所有 prop
使用 `LAYOUT | PAINT`，以性能退化换取功能正确。

### M2：双时钟、Worker 与缓存

目标：把已验证的单线程内核迁入 Worker，并证明主线程阻塞时滚动持续。

主要交付：

- SAB 双缓冲 ring buffer、frame sequence、背压和提交协议。
- postMessage 与主线程 Canvas2D 行为等价的降级实现。
- M0 确定的 Worker 帧驱动和恢复锁相逻辑。
- Picture Cache、Raster Cache、tile 合成、预算与内存压力淘汰。
- Worker 生命周期、崩溃恢复、资源重建和 feature flag。
- ring buffer 的模型检查、压力测试、乱序/卡死故障注入。
- cache 命中率、过度失效率、队列深度、丢弃/合并帧和内存指标。

出口门禁：

- 主线程人为阻塞 200ms 时，目标设备上的滚动连续性达到设计要求。
- SAB、postMessage、主线程三种路径通过同一行为测试套件。
- Worker 崩溃或初始化失败能自动回落，不留下半提交 Scene 或黑屏。
- Cache 开/关的输出严格一致，预算在长时间压力测试中有效。
- Worker 模式可按全局、设备或页面关闭并回到 M1 路径。

### M3：原生虚拟滚动与文本

目标：在代表性百万行场景中达到移动端滚动指标，并完成首个可用文本体系。

该阶段包含两个高风险子项目，应独立推进并定期集成验证：

#### M3-A Scroll

- 惯性、回弹和 iOS/Android 参数体系。
- 前缀和树、不定高 item、可见区间求解和测量修正。
- 方向/速度预测、预热调度、占位与补建协议。
- 百万行 fixture、快速 fling、反向滚动和高度突变压力测试。

#### M3-B Text

- 显式 web 字体加载、LTR、基础换行和 Text Shape Cache。
- 系统字体 `measureText`/`fillText` fallback 及缓存失效。
- glyph atlas 与 Canvas2D 贴图路径。
- 字体加载失败、DPR 变化、长文本和 CJK 基础场景。
- 输出 logical offset、grapheme、shaping cluster、glyph、line 与 caret geometry
  的稳定映射，供编辑命中和视觉导航使用。

bidi、复杂脚本及完整 CJK 避头尾只有在核心指标稳定且通过独立范围决策后
才进入本阶段；否则作为明确的后续能力，不以降低核心质量强行塞入。

出口门禁：

- 百万行目标场景滚动 P95/P99、掉帧率和输入延迟达到设计指标。
- 滚动稳态不调用 Shell；真实 miss、占位和补建次数可观测。
- 前缀和树与朴素实现、cache 开关、wasm/native 路径差分一致。
- 已声明支持的文本脚本和 fallback 行为有明确能力矩阵。
- 30 分钟连续滚动无不可控内存增长。

### M4：编辑、事件、命中与无障碍

目标：使 doper 达到可用于真实输入和交互页面的完整性，业务不再依赖
EmbedDOM 呼起 HTML 输入控件。

主要交付：

- `EditableText` 原语、`TextField`/`TextArea` widgets 与 editing controller。
- EditContext canvas 绑定，以及 doper-host 统一托管的不可见输入代理降级。
- caret 闪烁、范围选择、拖选、双击选词、Bidi/跨行键盘导航与 scroll-into-view。
- IME composition、候选窗 bounds、软键盘、clipboard、undo/redo 和 submit。
- 版本化编辑事务、Shell 确认/校正、外部 value 更新和 Worker 重启恢复。
- 增量 BVH、朴素命中 oracle、capture/target/bubble 三阶段事件。
- passive 输入与非 passive 区域矩形协议。
- 焦点、编辑态 textbox 语义和语义树到 DOM 影子树映射。
- 基于 role/label/value 的 E2E 选择器和核心交互用例。
- 浏览器/OS/输入法/屏幕阅读器测试矩阵，以及编辑状态与语义树 devtools。

出口门禁：

- 单行、多行、中文/日文/韩文 IME、组合字符、emoji、RTL、剪贴板和撤销重做
  在支持矩阵内通过，无丢字、重复提交或 selection 跳动。
- EditContext 与输入代理路径通过同一编辑行为契约；业务代码不创建 EmbedDOM。
- 输入到 glyph/caret 呈现延迟满足设计指标，caret bounds 能随内部滚动正确更新。
- 密码内容不进入日志、录制回放、devtools 明文或 a11y value。
- BVH 与线性命中在属性测试中一致。
- 事件顺序、传播停止、坐标变换和滚动嵌套行为通过契约测试。
- 需要 `preventDefault` 的区域不存在依赖异步回传的竞态。
- 试点组件通过键盘与至少一个主流屏幕阅读器验证。
- 性能快集保持不回归。

### M5：迁移、生产化与 WebGPU 决策

目标：完成可回滚的业务迁移，并用数据决定 WebGPU 后端方向。

主要交付：

- 位于边界包的存量 compatibility shim、迁移指南和自动检查工具。
- facade API 文档、限制、错误诊断和版本策略。
- 试点页面 shadow/对照运行、灰度比例、自动回退和运行手册。
- 发布包、source map、WASM 资源完整性、版本兼容与事故诊断链路。
- wgpu/WebGPU 隔离原型，用同一 DisplayList 做 Canvas2D 差分和真机性能对照。

出口门禁：

- 至少一个包含真实编辑场景的代表性存量页面完成灰度，并达到正确性、性能
  和稳定性门禁。
- 可按页面退回原有渲染路径，可按能力退回主线程 Canvas2D。
- 发布门禁包含全部测试层、真机指标与 soak test。
- WebGPU 形成 Adopt / Continue Experiment / Reject 的数据决策；M5 完成不等于
  WebGPU 必须成为默认后端。
- shim 的依赖方向确保删除 shim 不需要修改 Core。

## 7. 关键依赖与并行关系

关键路径为：

```
P0 基线
  → M0 平台结论
  → M1 schema + 确定性 headless + 纵向切片
  → M2 双时钟 + 降级链
  → M3 原生滚动达到真机指标
  → M4 原生编辑与真实交互完整性
  → M5 试点迁移与发布
```

可并行但有集成边界的工作：

- M1 中 Rust Core 与 TS Runtime 可并行，但必须先冻结最小 schema，并每周做
  端到端集成。
- M2 中 ring buffer 与缓存可并行，但缓存只能基于 M1 的确定性 DisplayList。
- M3 的 Scroll 与 Text 可并行，但共享资源预算、DisplayList 和真机 benchmark，
  必须定期合流验证。
- M4 的语义 DOM 可并行开发，但语义字段和节点生命周期必须在 M1 定位。
- M4 的输入桥可以在 M0 后独立演进，但必须等待 M3 的 cluster/caret geometry
  契约稳定后才能完成端到端编辑验收。
- WebGPU 可以在 M5 做隔离探针，不得提前改变 Core 或阻塞 Canvas2D 主线。

## 8. 启动阶段执行顺序

### 步骤 1：基线与工程引导

- 明确各工作流的责任边界、接口和外部协作关系。
- 初始化 workspace、CI、ADR 模板、benchmark 数据格式。
- 冻结第一批 doper benchmark 场景、设备矩阵和采样协议。
- 建立风险台账并给 COOP/COEP、设备、试点业务指定 owner。

### 步骤 2：帧驱动与采集探针

- 完成 Worker rAF、主线程时间戳、Worker 自驱三个最小探针。
- 完成主线程阻塞注入器与真机原始样本采集。
- 验证数据包含构建、浏览器、OS、设备和温度/电源等环境信息。
- 建立 EditContext 与输入代理的最小 canvas 输入探针，录制 composition 事件序列。

### 步骤 3：Canvas、WASM 与隔离能力

- 测量 OffscreenCanvas、scroll-copy 和不同 tile 策略。
- 测量最小 WASM 体积、编译和首次调用。
- 在目标业务壳中验证 COOP/COEP 与第三方资源影响。

### 步骤 4：降级原型与重复测量

- 贯通 SAB、postMessage、主线程三条最小路径。
- 在完整设备矩阵重复测试，分析离群点而不是只看平均数。
- 对所有关键结论记录置信度、失败设备和未知项。

### 步骤 5：M0 决策与 M1 拆解

- 召开 Go / Pivot / Stop 评审并提交 ADR。
- 根据实测结果复核 M1–M5 范围，冻结 M1 纵向切片和最小公开 API。
- 确认 schema 所有者、生成策略和 ABI 版本规则。

### 步骤 6：M1 第一条纵向切片

- 建立 `CreateNode`、基础 prop、`Commit` 的最小 schema。
- 贯通 TS 编码、Rust 解码、最小 Scene、一个矩形 DisplayList 和 Canvas2D 回放。
- 同时提交 golden、roundtrip、畸形输入测试和确定性 fixture。

## 9. 研发治理

### 9.1 集成与检查

- 工作流持续同步阻塞项；发现性能异常时保留环境信息和原始数据。
- 持续运行端到端集成、风险/依赖检查和 benchmark 快集趋势检查。
- 保持可运行的纵向切片，用实物检查里程碑状态并复核架构假设。
- 里程碑出口执行门禁评审，不以完成任务数量代替结果验收。

### 9.2 变更规则

- Core 架构、公开 API、ABI、能力范围、指标或里程碑变化需要 ADR 和
  `design.md` 更新。
- 二进制契约变更必须在同一个变更中更新 schema、Rust/TS 生成物、golden、
  版本号及兼容测试。
- 优化必须附带相同口径的前后数据和正确性 oracle。
- 所有缓存、调度、降级和异步恢复路径必须同时增加指标与故障注入测试。
- benchmark baseline 与容差不可仅为让 CI 变绿而更新。

### 9.3 Definition of Done

一个交付项只有同时满足以下条件才算完成：

- 需求、能力范围和不支持行为有文档。
- 正常路径、边界和失败路径已有实现。
- 对应层级的测试已加入自动化，并在受影响平台通过。
- 性能敏感路径有基线和回归结果。
- 关键状态和失败能被观测、导出或重放。
- feature flag、兼容或回滚路径已验证。
- 没有隐藏的 lint、类型、测试或 benchmark 失败。

## 10. CI 与发布门禁建设顺序

| 阶段  | 每次提交                                        | 每晚/定期                       | 发布前                       |
| ----- | ----------------------------------------------- | ------------------------------- | ---------------------------- |
| P0–M0 | format、lint、unit、探针构建                    | 真机重复采样                    | M0 决策包复核                |
| M1    | L1 单元、L2 属性、L3 ABI、L4 快集、PC benchmark | fuzz、差分全集                  | native/wasm 一致性           |
| M2    | 加入降级契约、并发压力快集                      | loom、故障注入、内存压力        | 三路径回退演练               |
| M3    | 加入 scroll/text 核心用例                       | 真机 P95/P99、30 分钟 soak      | 设备矩阵与字体矩阵           |
| M4    | 加入编辑事务、IME 与语义 E2E                    | 浏览器/OS/输入法/屏幕阅读器矩阵 | 原生编辑与无障碍验收         |
| M5    | 完整合入门禁                                    | 灰度趋势、长稳、WebGPU 对照     | 全层级、真机、soak、回滚演练 |

覆盖率下限沿用设计：Rust Core ≥ 85%，核心 crates ≥ 95%，TypeScript ≥ 80%。
覆盖率只作为底线，不能替代不变式、差分和失败路径测试。

## 11. 风险台账

| 风险                       | 最早验证 | 预警信号                                       | 应对/回滚                                                    |
| -------------------------- | -------- | ---------------------------------------------- | ------------------------------------------------------------ |
| Worker 帧驱动不稳定        | M0       | 相位漂移、阻塞时停止呈现                       | 自驱锁相；失败则架构转向评审                                 |
| COOP/COEP 无法部署         | M0       | 第三方资源或业务壳不兼容                       | postMessage；量化性能损失并调整范围                          |
| WASM 启动/体积超标         | M0/M1    | 预算早期已耗尽                                 | 功能裁剪、延迟加载、JS fallback                              |
| ABI 漂移或内存错误         | M1       | 双侧常量手写、fixture 频繁无解释变化           | 单源生成、golden、roundtrip、fuzz                            |
| 激进 invalidation 漏标     | M1       | 增量/全量像素差异                              | schema 强校验；全局保守失效开关                              |
| 双时钟竞态难复现           | M2       | frame_seq 回退、半帧、偶发黑屏                 | 模型检查、录制回放、故障注入、回退单线程                     |
| Cache 内存失控             | M2/M3    | LRU 无效、长稳持续增长                         | 硬预算、压力回收、关闭 raster cache                          |
| 文本范围失控               | M1/M3    | 脚本/字体需求持续扩张                          | 明确能力矩阵；先 web font + LTR + fallback                   |
| EditContext 覆盖或行为不足 | M0/M4    | 浏览器无 API、候选窗错位、composition 事件差异 | 引擎托管输入代理；能力矩阵；录制回放                         |
| 编辑跨线程失序             | M1/M4    | 丢字、重复提交、selection 回跳                 | revisioned transaction、过期拒绝、单一 composition、故障注入 |
| 滚动 cache miss 过高       | M3       | fling 时占位和 Shell 请求激增                  | 方向预热、预算调优、场景降级                                 |
| 无障碍后补导致返工         | M1/M4    | Scene/ABI 无语义位置                           | M1 预留语义模型，M4 完成行为                                 |
| 存量兼容污染 Core          | 全程     | Core 出现特定旧引擎类型/分支                   | shim 边界隔离、依赖规则、删除性测试                          |
| 真机指标不可复现           | P0 起    | 只保存汇总值、环境变化大                       | 原始样本、环境元数据、固定设备与协议                         |

风险台账在里程碑检查时更新。没有明确缓解方案的红色风险必须升级为范围
或架构决策，不允许只记录状态而不处理。

## 12. 灰度与回滚策略

生产迁移采用逐级放量：内部 demo → 测试业务 → 影子对照 → 小比例用户 →
按设备扩大 → 默认开启。每一级都比较正确性、崩溃率、P95/P99、输入延迟、
内存和降级比例。

需要保留三个独立开关：

1. 页面级：doper → 原有渲染路径。
2. 引擎级：Worker/SAB → postMessage → 主线程 Canvas2D。
3. 优化级：激进 invalidation、Picture/Raster Cache、未来 WebGPU 可分别关闭。

回滚开关必须在试点前演练，并记录生效时间、状态迁移和资源清理行为。
不能把“重新发布旧版本”作为唯一回滚方案。

## 13. 近期决策清单

以下决策应在对应里程碑前关闭，而不是在实现中隐式选择：

| 决策                           | 截止点    | 所需证据                                         |
| ------------------------------ | --------- | ------------------------------------------------ |
| Worker 帧驱动组合              | M0 出口   | 设备矩阵相位和阻塞数据                           |
| COOP/COEP 与默认 transport     | M0 出口   | 业务影响盘点、性能差异                           |
| monorepo 工具与构建链          | P0 出口   | Rust/TS/WASM/CI 最小闭环                         |
| schema 格式与生成器            | M1 启动前 | 双侧生成、golden、版本演示                       |
| NodeId 位布局与 ABI 版本策略   | M1 前半   | 生命周期、容量、兼容分析                         |
| headless 像素后端              | M1 前半   | 确定性、CI 成本、浏览器差异                      |
| Raster Cache 预算模型          | M2 前半   | 设备内存与屏幕面积数据                           |
| 滚动物理参数来源               | M3 前半   | iOS/Android 手感和指标测试                       |
| 文本首期能力矩阵               | M1 出口前 | 试点业务字体/脚本需求                            |
| 编辑状态所有权与 revision 协议 | M1 前半   | 外部 value、composition、undo、Worker 重启状态机 |
| EditContext 与输入代理能力矩阵 | M0 出口   | 浏览器/OS/输入法探针和候选窗 bounds 数据         |
| WebGPU 是否继续                | M5 出口   | Canvas2D 对照、覆盖率、功耗和稳定性              |

## 14. 计划维护

- 本计划在每个里程碑出口更新状态、剩余范围与风险。
- `design.md` 回答“系统为什么这样设计”；本计划回答“按什么顺序交付并如何
  判断完成”。两者冲突时先修正设计决策，再更新计划。
- 任务级拆分应进入项目管理系统，不在本文维护逐条 issue 状态。
- 只有当前置里程碑出口门禁通过后，才进入下一阶段或启动大规模业务迁移。
