# ADR-0007：CSS 子集、原生事件与基础组件模型

- 状态：Accepted
- 日期：2026-08-20
- 决策者：pingo maintainers
- 关联设计：`docs/design.md` §12.1、`docs/css-events-plan.md`

## Context

pingo v0.2.1 已有直接 props、`container/text/image/scroll/virtualList/editableText`
intrinsic、Core 命中测试和部分 pointer/click/wheel 事件。继续增加组件和交互时，直接 props
会重复 CSS 已有概念，独立 scroll/virtualList 类型也阻碍横向与后续二维虚拟化；缺少
className、hover、active、focus 和 Core 动画会迫使业务在主线程用 setState 模拟视觉状态。

项目此前排除“通用 CSS”。这不能被解释为永远拒绝 CSS 语义；需要明确一个不会把完整 CSS
解析、选择器与 CSSOM 渗入 Core，同时能持续扩展属性和值语法的子集架构。

## Decision

1. 公开基础组件演进为 View、Text、Image、Video、Input、TextArea；Fragment 不产生节点。
2. overflow 是 View 的滚动能力；虚拟化是带 itemCount/estimate/renderItem 的显式 scroll
   behavior，不由 overflow 或已物化 children 推断。
3. Shell 负责 CSS tokenize/parse、className selector、cascade、inheritance 与 computed
   style；Core 只执行 canonical typed property/value。
4. 新增单一 style schema，生成 TS/Rust 类型、ABI、失效/继承/动画元数据、文档和测试生成器。
5. CSS 语法扩展若归一到已有 computed value，不改变 ABI；新 Core property 语义才版本化 ABI。
6. Core 持有 hit、hover/active/focus/capture 状态与 presentation animation；Shell 预编译
   state-conditioned declarations，Core 不匹配 selector。
7. 首期简单 selector 只作用当前节点；不支持 combinator、结构伪类、伪元素或通用 CSSOM。
8. transition/keyframes 先支持 opacity/transform；layout animation 必须单独通过性能与正确性门禁。
9. 旧 intrinsic 和 direct props 走边缘兼容层，不复制进 Core，不在无迁移工具时删除。

## Alternatives

- **Core 解析 CSS/className**：需要同步 stylesheet、selector/cascade 与环境状态，扩大字符串、
  动态分配和祖先失效，不符合 Scene/ABI 热路径边界。
- **只保留直接 props**：API 随能力线性膨胀，class/伪类/transition 无统一语义，业务重复实现。
- **overflow 自动虚拟化 children**：Shell 构造 children 的成本已经发生，且缺少总数、估算与数据
  补建契约，无法保证有界物化。
- **伪类通过业务事件 setState**：视觉反馈依赖主线程和 Shell render，增加延迟并破坏 Core 闭环。
- **第一期完整 CSS/DOM**：范围、WASM 体积和兼容测试不可控，与 canvas 引擎目标不匹配。

## Evidence

- 当前 schema prop 已有静态 invalidation metadata，证明 canonical property 是 Core 最窄接口。
- 当前 scroll/virtualList 都映射到同一 `NodeKind::Scroll`，虚拟窗口实质是滚动轴的附加能力。
- 现有事件已经由 Core 基于已呈现帧命中并回传三阶段路径，适合继续承载交互状态。
- 现有 Worker animation clock 和滚动物理证明 Core 可在无 Shell mutation 时持续推进时钟帧；通用
  Animator 尚未实现，因此本 ADR 只冻结边界，不声称功能已交付。

## Consequences

- 新 CSS 属性必须声明 initial/inherited/grammar/invalidation/animation/feature metadata，并加入
  parser、computed-style、增量/全量差分和文档门禁。
- style parser/cascade 应位于独立可测试的 TS package；facade 只 re-export。
- pointerType、enter/leave、capture 与 interaction state 需要版本化 Input/derived-state 协议。
- display、overflow、pointer-events 会同时影响 layout/paint/hit/semantics/scroll，需要原子派生。
- Video 是 Host 媒体管线和 Core 帧资源的独立里程碑，不伪装成会动的 Image。
- CSS 子集版本独立于 npm engine version 和二进制 ABI，并提供 capability/diagnostic API。

## Rollback

CSS resolver、新组件 facade、interaction styles、Core animation 和 Video 分别受 rollout flag 控制。
关闭任一新能力时，旧 intrinsic、direct props、现有事件和 virtualList 路径保持工作；不兼容
stylesheet 在 commit 前拒绝，页面可经 compat 边界回退。二进制协议不对未知 style/animation
opcode 做降级解释。
