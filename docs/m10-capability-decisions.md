# M10 候选能力范围决策

> 日期：2026-08-21
>
> 结论：六类候选中五类为 **Defer**；overlay/absolute positioning 于 2026-08-21 转为
> **Adopt**（fixture 由 pingo-ui 弹层组件提供，见下行）。M9 不实现 Defer 能力；没有
> 真实业务 fixture 和可自动执行的出口 oracle 时，不用“可能有用”扩大 Core、ABI 或
> 产品支持面。

| 候选能力                                                 | 决策                    | 当前缺失的采用证据                                                                                                                                                                          | 采用前预算与 oracle                                                                 | API/ABI 与资格影响                                               | 回滚边界                                                  |
| -------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| bidi/复杂脚本与视觉导航                                  | Defer                   | 尚无绑定目标字体、语言分布和编辑行为的业务录制                                                                                                                                              | shaping/cache/WASM 增量预算；Unicode bidi + 浏览器 caret 录制差分；中/阿/希真实 IME | cluster/visual caret 模型会扩展 Core 编辑契约，可能新增 ABI 数据 | 按字体/脚本 capability 回到明确的 unsupported，不伪造 LTR |
| overlay/absolute positioning 与 widgets placeholder      | **Adopt**（2026-08-21） | 已满足：pingo-ui 第二批弹层组件（Dialog/Popover/Tooltip/DropdownMenu/Select/Command/Sheet/Toast）提供层叠、锚点、焦点与滚动容器 fixture，见 `pingo-ui-implementation-plan.md` Track B E2/E3 | layout/hit/clip/semantics 增量↔全量 oracle，帧时和节点预算（转为 E2/E3 出口条件）   | 新 positioning computed value 与失效语义；需要无障碍顺序资格     | feature bit 关闭后拒绝新值，现有 flow layout 保持         |
| 二维虚拟化和 virtual header/footer/sticky                | Defer                   | 没有二维数据规模、冻结区域和编辑单元格需求样本                                                                                                                                              | 二维 extent/anchor 朴素 oracle、快速双轴 fling、内存/补建预算                       | 扩展 virtual contract 和 refill ABI，三 transport 均需新门禁     | 保留 x/y 单轴，未知二维协议失败关闭                       |
| `calc()`/custom properties/复杂 selector/离散 transition | Defer                   | 没有可量化的迁移阻断清单                                                                                                                                                                    | parser/cascade WPT 子集、增量/全量 computed-style oracle、Shell CPU/包体预算        | 可归一到现值的语法不改 ABI；新语义逐项版本化                     | CSS capability/version 拒绝，direct props 仍可用          |
| WebGPU 默认启用                                          | Defer                   | ADR-0006 仍缺目标设备稳定收益与驱动资格                                                                                                                                                     | Canvas2D 像素差分、低中端设备 P95/P99/功耗/内存、设备丢失恢复                       | backend capability 不改 Scene；每个平台必须单独 qualified        | Canvas2D 始终是默认和回退，设备丢失立即切换               |
| 独立 DevTools UI                                         | Defer                   | 没有调试任务频率、使用者和分发方式证据                                                                                                                                                      | trace 大小/采样开销/敏感数据审计、真实事故任务可用性测试                            | 必须作为可选包，不能进入 facade 主入口或产品 WASM                | 不加载可选包；现有 diagnostics/录制接口保留               |

## 重新评审条件

任何候选转为 Adopt 前必须同时提供：真实业务 fixture、明确的性能与包体上限、公开 API/ABI
diff、optimized/reference oracle、所需平台资格角色、失败模式和单独 kill switch。只提供设计草图、
开发机 demo 或手工截图时继续 Defer。Reject 只用于证据证明能力与 pingo 架构目标冲突；当前没有
足够证据作永久拒绝。
