# doper 渲染引擎 · 技术设计

> 状态：草案 v0.2
> 定位：面向高性能交互、虚拟滚动与原生编辑的 Web canvas 渲染引擎
> 技术栈：Rust → WASM core / TypeScript shell / Canvas2D 优先可插拔后端

---

## 1. 目标与非目标

### 目标

1. **彻底解决滚动过程中的 FPS 下降**，尤其是移动端 P95/P99 长尾。
2. 维持 TSX 编写方式，且支持 **function component + hooks/state**。
3. 将虚拟滚动与多级缓存下沉为引擎原生能力，并满足百万行场景指标。
4. PC 与移动端均以绝对帧时间、掉帧率、输入延迟和内存指标作为性能门禁。
5. 后端可插拔，为 WebGPU 留出演进路径。
6. 提供引擎原生的光标、选择与文本编辑能力，不要求业务通过 EmbedDOM 创建
   HTML 输入控件。

### 非目标（本期明确不做）

- 不做 SSR / 首屏 HTML 输出。
- 不做通用 CSS 兼容（不实现 CSS 盒模型、层叠、选择器）。
- 不做小程序 / 原生端适配（架构上不阻断，但本期不投入）。
- 不内置业务级富文本文档模型、协同编辑、公式或 Markdown 语义；引擎负责
  可编辑文本基础设施，上层编辑器产品能力仍属于业务层。

---

## 2. 关键指标（验收基线）

这些指标是产品与平台支持目标。工程里程碑只使用可在仓库/CI 自动运行的同口径
测试；物理设备结果属于平台资格认证，不阻止工程完成。具备设备时采集并展示有效
FPS，但资格判断以帧时间分位数与掉帧率为主，避免平均 FPS 掩盖长尾卡顿；不使用
外部引擎数据作为通过条件。

| 指标                                        | 目标                                      |
| ------------------------------------------- | ----------------------------------------- |
| 滚动帧时间 P95（低端安卓，骁龙 6 系或同级） | ≤ 16.7ms                                  |
| 滚动帧时间 P99                              | ≤ 33ms                                    |
| 连续滚动 10s 掉帧率                         | < 1%                                      |
| 输入延迟（touchmove → 呈现）                | ≤ 2 帧                                    |
| 编辑延迟（文本输入 → glyph/caret 呈现）     | ≤ 2 帧                                    |
| 主线程人为阻塞 200ms 期间滚动               | 不掉帧、不停顿                            |
| PC 端连续交互帧时间（60Hz 参考设备）        | P95 ≤ 16.7ms，P99 ≤ 25ms                  |
| PC 端连续交互 10s 掉帧率                    | < 0.5%                                    |
| WASM 体积（gzip）                           | < 400KB                                   |
| WASM 冷启对首帧的额外延迟                   | < 50ms（streaming compile + JS 降级兜底） |

同设备、同构建口径下的 doper 历史数据用于发现趋势和定位回归，不单独决定
Pass/Fail。只要正确性成立且绝对指标全部达标，就不要求与目标分支或任何外部引擎
比较后才能通过；历史回退一旦使绝对指标失守，则按绝对门禁失败。

---

## 3. 总体架构

```
┌── Shell (TypeScript, 主线程) ─────────────────────────────┐
│  TSX runtime · Function Component · Hooks · Signals       │
│  Reconciler → Mutation Stream（扁平二进制 patch）          │
│  DOM 事件监听 · EditContext/IME bridge → 只写输入流       │
│  a11y 影子 DOM 树                                          │
└──────── ring buffer over SharedArrayBuffer ───────────────┘
                    ↓ 单向 · 批量 · 无对象代理
┌── Core (Rust → WASM, Worker) ─────────────────────────────┐
│  Scene(SoA) · Layout · Text · Edit · HitTest(BVH)         │
│  Scroller · Animator · Picture Cache · Compositor         │
│  产出：DisplayList（扁平二进制）                           │
└───────────────────────────────────────────────────────────┘
                    ↓ DisplayList
┌── Backend ────────────────────────────────────────────────┐
│  M1: Canvas2D Replayer (TS, Worker, OffscreenCanvas)      │
│  M3+: wgpu / WebGPU (Rust 内直出)                          │
│  兜底: 主线程 Canvas2D（无 Worker/SAB 环境）               │
└───────────────────────────────────────────────────────────┘
```

### 3.1 为什么后端要经过 DisplayList

Rust core 若通过 `web-sys` 直接调用 Canvas2D，每个 draw call 都是一次 WASM→JS 边界穿越，且字符串、渐变对象等参数需要 marshalling。在万级 draw call 的表格场景下这是不可接受的。

因此 core 的输出是一段**扁平二进制 DisplayList**（见 §7），由 Worker 内一个薄 TS 回放器执行。回放器是单态化的 typed array 循环，V8 能很好优化；资源（字体、颜色、图片、渐变）预先 intern 成整型 id，回放时查表，避免任何逐帧字符串处理。

WebGPU 后端则由 Rust 内的 `wgpu` 直接消费 DisplayList，不经过 JS。**同一份 DisplayList 喂两个后端**，这也是后端可插拔的实现基础。

---

## 4. 模块划分

### Rust workspace（`core/`）

| crate          | 职责                                                             |
| -------------- | ---------------------------------------------------------------- |
| `doper-scene`  | SoA scene 数据结构、拓扑维护、脏标记位图                         |
| `doper-layout` | 约束布局求解（BoxConstraints 单趟）、布局缓存                    |
| `doper-text`   | 文本布局、shaping（web 字体路径）、测量缓存、glyph atlas         |
| `doper-edit`   | 编辑会话、selection/caret、IME composition、编辑事务与 undo/redo |
| `doper-hit`    | BVH 空间索引、命中测试、事件路径构建                             |
| `doper-scroll` | 滚动物理、前缀和树、可见区间求解、预热调度                       |
| `doper-paint`  | DisplayList 构建、Picture cache、tile 划分与失效                 |
| `doper-anim`   | 时间轴、插值、animation driver                                   |
| `doper-abi`    | Mutation/Input/Recording/DisplayList 编解码与版本协商            |
| `doper-core`   | 顶层编排、帧循环、commit 协议、wasm-bindgen 入口                 |
| `doper-gpu`    | （M3+）wgpu 后端                                                 |

### TypeScript packages（`packages/`）

仓库内目录使用去掉公共前缀后的职责名，例如 `packages/reconciler`、
`packages/backend-canvas2d` 和 `packages/facade`。`packages/` 已提供仓库级命名空间，
目录不重复 `doper-`；下表的完整名称仅用于 npm 发布与包间导入。

| package                          | 职责                                                         |
| -------------------------------- | ------------------------------------------------------------ |
| `@dopejs/doper`                  | **门面包**。业务唯一直接依赖项，re-export 下列各包的公开 API |
| `@dopejs/doper-runtime`          | signals、hooks、function component、生命周期                 |
| `@dopejs/doper-jsx`              | JSX runtime、编译期优化（静态提升、props 常量折叠）          |
| `@dopejs/doper-reconciler`       | 组件树 → Mutation Stream 编码                                |
| `@dopejs/doper-host`             | Worker 生命周期、SAB 通道、能力探测与降级                    |
| `@dopejs/doper-editing`          | EditContext/IME/剪贴板桥接、editing controller 与编辑事件    |
| `@dopejs/doper-backend-canvas2d` | DisplayList 回放器                                           |
| `@dopejs/doper-widgets`          | 内置组件（Flex/Stack/Text/Image/VirtualList/Table…）         |
| `@dopejs/doper-a11y`             | 语义树 → DOM 影子树                                          |
| `@dopejs/doper-devtools`         | 帧瀑布、cache 命中率、tile 可视化、scene 检查器              |

#### 门面包 `@dopejs/doper`

业务侧只依赖这一个包，内部子包对业务不可见，便于后续重构而不破坏调用方。

```jsonc
// 业务 tsconfig.json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@dopejs/doper",
  },
}
```

```tsx
import { createRoot } from "@dopejs/doper";

root.render(
  <virtualList
    itemCount={1_000_000}
    estimatedItemHeight={32}
    renderItem={(index) => <text value={`row ${index}`} />}
  />,
);
```

约束：

- 门面包必须提供 `@dopejs/doper/jsx-runtime` 与 `@dopejs/doper/jsx-dev-runtime` 两个子路径导出，转发到 `@dopejs/doper-jsx`，否则 `jsxImportSource` 无法工作。
- **只做 re-export，不含任何实现逻辑**，避免成为绕不开的耦合点。
- 后端与 devtools 通过子路径按需引入（`@dopejs/doper/devtools`、`@dopejs/doper/backend-webgpu`），不进主入口，保证 tree-shaking 后不带入生产包。
- 门面包的导出面即公开 API 契约，纳入 api-extractor 卡点；子包之间的相互依赖不受此约束。

---

## 5. Scene 数据结构（SoA）

```rust
pub struct Scene {
    // 拓扑：节点按拓扑序（父永远在子之前）紧凑存放
    parent:       Vec<NodeId>,
    first_child:  Vec<NodeId>,
    next_sibling: Vec<NodeId>,
    depth:        Vec<u16>,

    // 几何
    transform: Vec<Affine>,     // 局部变换
    size:      Vec<Size>,
    offset:    Vec<Point>,      // 相对父的位置（布局产出）
    world_aabb: Vec<Rect>,      // 缓存的世界包围盒，供剔除与 BVH

    // 外观
    paint: Vec<PaintRef>,       // 指向 paint arena
    flags: Vec<NodeFlags>,      // clip / opacity / layer / static / hittable

    // 脏标记（位图，扫描即可）
    dirty_layout: BitSet,
    dirty_paint:  BitSet,

    // 空洞回收
    free_list: Vec<NodeId>,
    generation: Vec<u32>,       // NodeId = (index, generation)，防悬垂
}
```

设计要点：

- **拓扑序存放**：父先于子。布局、剔除、绘制都退化为顺序扫描，无指针追逐，稳态帧不重复排序脏节点。
- **脏节点遍历 = 位图扫描**：`dirty_layout.iter_ones()`，天然按拓扑序，天然去重。
- **NodeId 带 generation**：节点回收后 id 复用不会造成悬垂引用，跨线程传递安全。
- **拓扑序维护**：结构变更（插入/移动）可能破坏拓扑序。策略是**延迟重排**——变更时只标记 `topology_dirty`，在 commit 阶段做一次紧凑化（compaction），把变更代价从 O(n) per mutation 摊平成 O(n) per frame，且只在结构真变时发生。稳态（只改 props）零开销。

---

## 5.1 增量渲染与失效模型

这是引擎性能的决定性设计，单列一节。

### 约束与问题定义

增量渲染必须同时避免三类系统性问题：

1. **失效域硬耦合**：纯事件或绘制属性变化不应无条件触发 build、layout、paint 全链路。
2. **正确性依赖业务补丁**：业务不应通过静态标注或 `forceUpdate` 猜测引擎内部依赖。
3. **热路径动态分配**：布局变化检测不得为每个节点分配闭包或监听器。

因此 doper 从自身 Scene、约束布局与 DisplayList 不变式推导失效模型，并用全量参考
路径做差分验证；不以任何存量引擎的内部规则或抽象作为实现来源。

### doper 的五层模型

**L1 · 依赖自动捕获，业务零标注**

signal 读取时自动记录 `(signal → 组件)` 依赖边，写入时精确标脏对应组件。业务不写任何 `markNeedsX`。

**不提供 `forceUpdate`。** 若业务需要它，说明依赖追踪漏了——那是引擎 bug，应修引擎而非发放逃生舱。外部数据源变更用显式 signal（`useSelector` 订阅外部 store）表达。

**L2 · 失效域由 prop 的静态元数据决定（核心）**

Mutation Stream 是失效的唯一来源。reconciler 只为真正变化的 prop 发送指令；Core 收到后查编译期生成的元数据表决定标哪些域：

```rust
// 由 schema 单源生成，Rust / TS 两侧共享
Prop::Width     => LAYOUT | PAINT,
Prop::Color     => PAINT,
Prop::Opacity   => PAINT_SELF,   // 不波及子树布局
Prop::Transform => PAINT | HIT,  // 不影响布局
Prop::OnTap     => NONE,         // 纯回调，什么都不脏
```

失效域由 prop 的语义决定，而不是由调用者决定。改颜色不触发 layout，改回调不触发任何重绘。

##### 默认策略：激进最窄 + 属性测试兜底

元数据表由人工维护，写错的后果不对称：标多了只是慢，**标少了是不刷新的显示 bug，且极难排查**。两种默认值策略：

| 策略             | 未标注 prop 的默认值 | 权衡                                               |
| ---------------- | -------------------- | -------------------------------------------------- |
| 保守             | `LAYOUT \| PAINT`    | 安全，但会扩大重算范围，性能收益需逐个 prop 释放   |
| **激进（采用）** | 最窄（`NONE`）       | 收益立刻拿到，但漏标即 bug，**强依赖属性测试兜底** |

**采用激进默认**。前提是配套的属性测试必须在 M1 就位，不可推后。

##### 失效正确性属性测试

核心不变式：

> 对任意 scene 与任意 prop 变更序列，**增量渲染的产出必须与全量重绘的产出逐像素一致**。

实现：

```
1. 随机生成 scene（组件类型、嵌套深度、布局组合）
2. 随机生成 N 步 prop 变更序列
3. 路径 A：逐步施加变更，走增量失效管线 → 最终帧
   路径 B：每步后强制全量重建 scene 并重绘 → 最终帧
4. 逐像素比对 A 与 B；不一致即判定失效标注有漏
5. 失败时对变更序列做 shrink，缩到最小复现用例并输出漏标的 prop
```

工程要点：

- 用 `proptest`（Rust 侧）驱动，headless 后端渲染到内存 buffer，不依赖浏览器，可在 CI 每次提交跑。
- **每新增一个 prop 必须同时进入元数据表和测试的 prop 生成器**，由 schema 生成器强制校验两者一致，缺一即编译失败。这是防漏标的第一道闸门。
- shrink 能力是刚需——没有最小复现，漏标问题的排查成本会高到让人放弃这套机制。
- 该测试与 L5 的过度失效率统计共用同一套 headless 渲染与 picture hash 基建，**一次投入两处收益**，这也是它值得在 M1 就做的原因。

残余风险：属性测试只能覆盖生成器能构造出的 scene 空间，无法证明完备。因此保留一个**全局开关**，可在运行时把所有 prop 强制降级为 `LAYOUT | PAINT`——线上若出现疑似漏标的显示 bug，先开开关止血（退化为保守全失效路径，功能正确），再定位修复。

**L3 · 布局变化检测改为双缓冲批量对比**

布局产出写入 SoA 的 `offset` / `size` 数组；commit 阶段与上一帧数组做一次顺序扫描对比，批量得出位置/尺寸变化的节点集合。热路径零闭包、零监听器。

**L4 · repaint boundary 自动提升**

Core 按启发式自动决定哪些子树独立成 layer：滚动容器内容、带 transform 动画的节点、被频繁标脏但 picture hash 稳定的子树。业务不标注。

配合 `DrawPicture`：子树内容未变时，父节点只需重组一条引用指令，不重建子指令流。

**L5 · 过度失效必须可观测**

devtools 逐帧统计「被标脏但 picture hash 与上一帧一致」的节点数，该比率即**过度失效率**，纳入 CI 卡点与线上监控。

**没有度量就没有优化**：过度失效率必须与帧时间一起进入绝对门禁和趋势诊断。

---

## 6. Mutation Stream（Shell → Core ABI）

单向、批量、二进制。写入 SAB ring buffer，Core 每帧开始时一次性消费。

### 编码

小端序，4 字节对齐。流以固定 16 字节 header 开始：

`[u32 magic][u16 abi_version][u16 header_bytes][u32 stream_bytes][u32 instruction_count]`

Mutation Stream 的 magic 为 `DOPM`。每条指令为
`[u8 opcode][u8 flags][u16 reserved][payload...]`；ABI v1 的 flags、reserved 和所有
对齐填充必须为零。完整字段布局、opcode、prop、失效元数据与大小上限以
[`../schemas/protocol.v1.json`](../schemas/protocol.v1.json) 为单一来源并生成 Rust/TS
定义。解码器先验证整批数据和末尾唯一 `Commit`，成功后才能把 mutation 交给 Scene，
畸形输入不得产生部分状态变更。

输入使用同一封套的独立 Input Stream（magic `DOPI`）。编辑指令携带目标
`node_id` 与 `base_revision: u64`；滚动指令携带 generation-bearing `node_id`、逻辑
delta 与采样间隔。字符串以 UTF-8 编码，selection offset 保持浏览器边界的 UTF-16
语义。整批输入只在末尾唯一 `Commit(frame_seq)` 后生效，任一指令的 revision、
offset、composition、滚动采样或路由校验失败都回滚整个批次。

| opcode | 指令                   | payload                                                     |
| ------ | ---------------------- | ----------------------------------------------------------- |
| `0x01` | `CreateNode`           | `node_id: u32, kind: u16, parent: u32, before_sibling: u32` |
| `0x02` | `RemoveNode`           | `node_id: u32`                                              |
| `0x03` | `Reparent`             | `node_id: u32, new_parent: u32, before_sibling: u32`        |
| `0x10` | `SetF32`               | `node_id: u32, prop: u16, value: f32`                       |
| `0x11` | `SetVec4`              | `node_id: u32, prop: u16, v: [f32;4]`                       |
| `0x12` | `SetRef`               | `node_id: u32, prop: u16, resource_id: u32`                 |
| `0x13` | `SetFlags`             | `node_id: u32, set: u32, clear: u32`                        |
| `0x20` | `SetTextRun`           | `node_id: u32, str_id: u32, style_id: u32`                  |
| `0x30` | `DefineResource`       | `resource_id: u32, kind: u16, len: u32, bytes[]`            |
| `0x40` | `ScrollTo`             | `node_id: u32, x: f32, y: f32, behavior: u16`               |
| `0x41` | `ConfigureVirtualList` | `node_id: u32, item_count: u32, estimate/policy: [f32;4]`   |
| `0x42` | `SetVirtualItem`       | `node_id: u32, item_index: u32`                             |
| `0xF0` | `Commit`               | `frame_seq: u32`                                            |

### 约定

- `node_id` 由 Shell 侧分配（单调递增 + free list 复用），Core 不回传 id，**通道保持严格单向**。
- 字符串与图片等资源通过 `DefineResource` 一次性传入并 intern，之后只传 `resource_id`。字符串按内容 hash 去重——表格场景下大量重复文本因此零成本。
- `prop` 是编译期生成的常量表，Rust 与 TS 两侧由同一份 schema 文件生成，杜绝漂移。
- ABI 版本号在 Worker 握手时协商，不匹配直接拒绝启动并降级到兜底路径。

### 录制回放与帧诊断

Mutation/Input 的线上复现使用版本化 Replay Recording（magic `DOPR`）。记录封套沿用
16 字节 header；每条记录为
`[kind:u8, flags:u8, reserved:u16, payload_bytes:u32, payload...]`，payload 必须是完整且
可独立验证的 `DOPM` 或 `DOPI` 流。解码器在返回第一条记录前递归验证全部记录，保证
headless 回放不会消费半份损坏归档。录制入口必须显式声明数据为 `recordable` 或
`sensitive`；密码与其他敏感流直接跳过，不能依赖日志侧事后脱敏。

成功帧另有 schema 生成的 versioned `u32` 诊断布局，包含各脏域节点数、Scene 节点数、
布局 changed/visited 数、DisplayList command 数、是否重建 Picture 与 64 位 picture
hash，以及 Picture 整体/子树 build、cache hit 和过度失效计数。Host 只在存在
`onFrame` 观察者或缓存需要 picture key 时从 WASM 复制该数组；版本或 `frame_seq`
不一致视为 Core/Host 契约错误。Worker transport 另提供可拉取的有界队列快照，包含
当前深度、字节数、高水位、ACK、合并、拒绝、超时和最新序列；运行时降级后仍保留
故障前最后一份快照，供 devtools 和线上诊断使用。

### 为什么不用 SharedArrayBuffer 直接共享 Scene

共享可变状态需要跨线程锁，且 JS 侧无法安全地维护 Rust 的不变式。单向 patch 流是更强的隔离：Core 完全拥有 Scene，Shell 完全拥有组件树，两者不共享任何可变对象。这也让 Core 能在 Shell 卡死时继续独立跑帧。

---

## 7. DisplayList（Core → Backend ABI）

同样是扁平二进制。每帧产出，或从 Picture Cache 拼接。

DisplayList 使用同一 16 字节 stream header，magic 为 `DOPD`。ABI v1 要求图形状态
`Save`/`Restore` 严格平衡，未知 opcode、未定义 flags、非有限浮点、错误长度、非零
reserved/padding 或越界资源一律在回放前失败关闭。详细决策见
[`adr/0005-versioned-binary-stream-envelope.md`](adr/0005-versioned-binary-stream-envelope.md)。

| opcode                                            | 指令                              |
| ------------------------------------------------- | --------------------------------- |
| `Save` / `Restore`                                | 状态栈                            |
| `Transform(Affine)`                               | 变换                              |
| `ClipRect(Rect)` / `ClipPath(path_id)`            | 裁剪                              |
| `Alpha(f32)`                                      | 透明度                            |
| `FillRect(Rect, paint_id)`                        | 矩形                              |
| `FillRRect(RRect, paint_id)`                      | 圆角矩形                          |
| `FillPath(path_id, paint_id)`                     | 路径                              |
| `DrawGlyphRun(font_id, size, origin, glyph_span)` | 字形序列（web 字体路径）          |
| `DrawTextFallback(str_id, font_desc_id, origin)`  | 系统字体路径，回放器调 `fillText` |
| `DrawImage(image_id, src, dst)`                   | 图片                              |
| `DrawPicture(picture_id, offset)`                 | 引用缓存的子指令流                |

`DrawPicture` 是缓存复用的关键：item 内容不变时，滚动只需改变 `DrawPicture` 的 offset，指令流本身零重建。

---

## 8. 帧循环与 commit 协议（双时钟）

### 两个时钟

- **UI 帧**（主线程）：由 signal 变更触发，无变更则不跑。产出 Mutation Stream。
- **渲染帧**（Worker）：稳定驱动，负责动画、滚动、布局、绘制、合成。

两者通过 SAB 上的 `frame_seq` 与双缓冲 ring buffer 同步。渲染帧读取"当前已 commit 的最新一批 mutation"，Shell 写入下一批。**Shell 慢或卡住时，渲染帧继续用上一批 scene 跑**——这正是滚动不受主线程影响的机制。

Mutation 与低延迟 Input 使用两个独立、有界、定长 slot 的 SAB ring。Input ring 的
小帧只发送 wake 消息；超过 slot 或 ring 暂满时，Host 先发送 wake 以排空已发布 slot，
再按 FIFO 发送一次有界 copied fallback。两条 ring 都校验 header `frame_seq` 与流内
Commit 序列一致，并分别暴露发布、消费、fallback、拒绝和高水位指标。没有 SAB 时
Input 与 Mutation 分别退到 `postMessage`；没有 Worker 时两者直接进入主线程 Core，
三条路径共享同一 ABI 和行为测试。

### 有界背压与事务合并

Shell 产生的 transaction 使用连续 `frame_seq`。transport 已发布或等待 ACK 的
transaction 不可改写；队列触达帧数或字节预算时，只允许把“最新一个尚未发布的
完整 transaction”和新 transaction 解码后按 mutation 原序合并，再以新
transaction 的 `frame_seq` 重新编码。Core/receiver 因此要求序列**严格变新**，但不
要求 transport 输出连续序列；中间序列缺口明确表示事务已无损合并，不表示 mutation
被丢弃。ACK 仍逐个对应实际发布的 transaction。

若合并结果超过 Mutation Stream、SAB slot 或队列字节硬预算，HostedRoot 将该容量
耗尽识别为可恢复 transport 故障：停止 Worker，保留 Shell 的完整 Scene 快照，在新
主线程 Core 中以一个 full-state transaction 重建。协议错误、非法序列与畸形 payload
仍然 fail-fast，不能借降级隐藏实现缺陷。该策略的回滚开关是全局/设备/页面 Worker
policy；关闭 Worker 后直接使用 M1 主线程路径。

### Worker 帧驱动（M0 自动故障注入，平台资格补充实测）

`DedicatedWorkerGlobalScope` 上的 `requestAnimationFrame` 并非各平台稳定可用，这是本方案最大的能力不确定性。候选方案按优先级：

1. **Worker rAF**（若目标平台可用）——最优，相位天然对齐 vsync。
2. **主线程 rAF 打时间戳到 SAB**，Worker 用短周期 `setTimeout`/`MessageChannel` 轮询读取。缺点：主线程完全阻塞时 rAF 不触发，时间戳会停。
3. **Worker 内自驱**：`setTimeout(0)` + `performance.now()` 相位锁，配合方案 2 的时间戳做漂移校正；主线程阻塞时降级为自驱，恢复后重新锁相。

**必须实现 2+3 的组合**，否则“主线程阻塞 200ms 滚动不掉帧”无法成立。M0 用自动
故障注入验证时钟、阻塞窗口和降级不变式；真机只补充平台资格数据，不阻塞 M0。

### 无 SAB / 无 Worker 的兜底

`SharedArrayBuffer` 需要 COOP/COEP 跨源隔离响应头，这是**业务侧的外部依赖，可能一票否决**。降级链：

1. SAB 不可用 → `postMessage` 传 mutation（多一次拷贝，延迟略增，仍在 Worker 内合成）。
2. Worker/OffscreenCanvas 不可用 → 全部退回主线程单线程模式，功能不缺失，性能按 doper 自身的主线程基线独立记录。

降级在 `@dopejs/doper-host` 的能力探测中自动完成，业务无感知。

---

## 9. 滚动子系统

滚动是 Core 的一等公民，不是组件。

### 组成

- **物理**：`doper-scroll` 内实现惯性、回弹、边界，与平台手感对齐（iOS/Android 参数分离）。
- **区间求解**：不定高 item 用前缀和树（Fenwick / 分段平衡树），`offset → index` 与 `index → offset` 均 O(log n)，支持百万级 item。
- **测量修正**：item 实际高度与估算不符时，增量修正前缀和树并触发一次局部布局，不引发全量重排。
- **预热**：按滚动方向与速度预测落点，在空闲时预构建/预光栅化 buffer 区。目标是把 cache miss 率压到接近 0。

### `<virtualList>` 与补建事务

`<virtualList>` 是公开 JSX intrinsic，Shell 只提交 item 总数、估高、预热策略和
`renderItem(index)`，不会在首次 render 构造全部 item。Core 的 `HeightIndex` 持有
百万级逻辑高度、可见区和预热窗；Shell 只把当前完整预热窗物化为带
`SetVirtualItem(index)` 的直接子容器。窗口重叠部分按 index/key 复用，离窗节点被
回收，Scene 节点数因此与预热窗而非数据总量成正比。

Core 在 frame 完成后通过 schema 生成的 versioned `u32` Virtual Refill Batch 返回
完整物化窗：header 为 `[version, request_count]`，record 为
`[node_id, start, end]`。Host 严格验证版本、长度、generation-bearing node id 和
半开区间，再在微任务中调用 reconciler；Core 的滚动/绘制调用栈不会同步进入 Shell。
同一 node 尚未被 Host 取走的窗口只保留最新值。应用若在微任务前缩小 `itemCount`，
Shell 的最新 durable value 获胜：部分重叠请求裁到新边界，完全越界的旧请求忽略，
不得让旧窗口使 root fatal。

实际 item 高度进入 HeightIndex 后保持首个可见 item 的视觉锚点，并在同一 commit 内
从 virtual list 的固定尺寸 relayout boundary 做一次纠偏；非固定尺寸 list 才向上
扩到最近安全边界。回滚时可关闭 Worker/SAB 而不改变 `<virtualList>` 语义；若必须
隔离整个虚拟化能力，业务可在 feature rollout 层切回普通 `<scroll>` 的有界分页
数据，新增 opcode 仍由 ABI 版本校验失败关闭，不降级解释为其他指令。

### 滚动帧的闭环

```
读 SAB 输入 delta → 物理积分 → 求可见区间 →
  命中 cache: 平移 tile + 拼接 DrawPicture
  未命中:    Core 内布局+构建 picture（不回 Shell）
  Shell 侧缺数据: 发请求，本帧用占位，下帧补
→ 提交 DisplayList → 后端光栅化
```

**滚动帧内不产生任何 Shell 调用**。只有当某个 item 的组件从未构建过（真 cache miss）时才需要 Shell 补建，这条路径被预热机制覆盖到极低频。

---

## 10. 缓存体系

| 级别                   | 内容                                     | 失效条件                         | 位置    |
| ---------------------- | ---------------------------------------- | -------------------------------- | ------- |
| **Layout Cache**       | 节点在给定约束下的 size                  | 约束变化或自身 dirty_layout      | Core    |
| **Picture Cache**      | 子树的 DisplayList 片段（不可变）        | 子树 dirty_paint                 | Core    |
| **Raster Cache**       | tile / picture 的位图                    | picture 变更、DPR 变更、内存压力 | Backend |
| **Text Shape Cache**   | (str, font, size) → advance + glyph 序列 | 字体加载完成                     | Core    |
| **Text Metrics Cache** | 系统字体 `measureText` 结果              | 字体或 DPR 变更                  | Backend |

内存治理：Raster Cache 按 LRU + 总预算（默认按屏幕面积的 N 倍）淘汰；移动端预算更紧。所有 cache 暴露命中率指标给 devtools 与线上监控。

---

## 11. 文本子系统

### 硬约束（必须提前认清）

浏览器不暴露系统字体的字形数据，**无法自行 shape 系统字体**。因此文本必须双轨：

| 路径             | 条件                                   | 能力                                                    | 后端指令           |
| ---------------- | -------------------------------------- | ------------------------------------------------------- | ------------------ |
| **自研 shaping** | 业务显式声明并加载的 web 字体（woff2） | 完整排版控制、glyph atlas、GPU 友好、可精确缓存         | `DrawGlyphRun`     |
| **宿主回退**     | 系统字体 / 未声明字体                  | 只能 `measureText` + `fillText`，无字距控制，缓存粒度粗 | `DrawTextFallback` |

**这条约束反向影响 API 设计**：字体必须显式声明。越早定越好，后期改代价极大。

### 组成

- shaping：`swash`
- 首期 outline glyph 栅格：`fontdue`；彩色字体与未声明系统字体走宿主 fallback
- 段落布局：`parley`（或按需自研简化版）
- 换行：UAX #14 line breaking；CJK 需要额外的标点避头尾规则
- bidi：`unicode-bidi`
- glyph atlas：Core 维护，Canvas2D 后端以 `ImageBitmap` 贴图，WebGPU 后端直接采样纹理

实现状态（2026-08-16）：`doper-text` 已建立独立的无 unsafe Core 基础，使用
`swash` 完成显式 SFNT 字体的 LTR shaping，使用 UAX #14 数据完成基础换行，并输出
UTF-8/UTF-16、grapheme、cluster、glyph、line 与 caret 映射；Text Shape Cache 和
灰度 outline glyph atlas 均使用可观测的字节预算 LRU。公开字体 ABI、glyph 资源
回传和 Canvas2D 贴图仍未接入，因此这仍属于 M3-B 内部基础，不能视为公开文本路径
完成。当前 Core 输入只接受解码后的 TTF/OTF/TTC SFNT；WOFF/WOFF2 解码放在显式
字体加载器边界，接入时必须与失败回退、格式能力矩阵和体积门禁一起交付。

栅格器选择以 WASM 体积门禁为准：同一 Rust 1.96.0、`opt-z`、LTO 探针中，
`swash` 同时承担 shaping 与 raster 时为 308,835 bytes gzip，超过代表性文本包络的
300 KiB 门禁；`rustybuzz` shaping 加 `swash` raster 为 433,477 bytes gzip，超过
产品 400 KiB 总预算。`swash` shaping 加 `fontdue` raster 的本机基线为 148,459
bytes gzip，因此首期采用后者。能力影响是 atlas 只承诺 TTF/OTF/TTC 中的单色
outline glyph，不把 COLR/CBDT/SVG、系统字体或浏览器合成字体伪装成受支持；这些输入
必须走 `fillText` fallback。该决定可通过文本后端 feature flag 回滚；若未来栅格器、
工具链或按需裁剪在同一门禁下证明彩色字体可行，可替换 atlas 实现而不改变 shaping
和 DisplayList 契约。

### 风险

文本是本项目工程量与风险最大的单一模块，也是最容易低估的。建议 M1 只做「web 字体 + LTR + 简单换行」，把 bidi、复杂脚本、避头尾放到 M3。

---

## 11.1 编辑子系统

编辑是 Core 的一等能力，不再通过业务侧 EmbedDOM 临时覆盖一个 HTML 输入框。
引擎负责的是**编辑基础设施**，不是完整的富文本产品：

- 单行与多行可编辑文本。
- caret、范围选择、拖选、双击选词、键盘与指针导航。
- IME composition、候选窗口定位、软键盘与语言输入法。
- 插入、替换、按 grapheme/word 删除、换行、剪切、复制、粘贴。
- undo/redo 事务、只读、密码、最大长度与输入过滤钩子。
- selection/caret 绘制、自动滚动到可见区、无障碍 textbox 语义。

表格公式、富文本 schema、协同冲突解决、Markdown 命令和业务校验属于上层，
但它们必须能建立在同一套编辑事务与 selection API 上。

### 输入桥接与降级

主线程负责连接浏览器/操作系统文本输入服务，按优先级使用：

1. **EditContext**：绑定 canvas，接收文本、selection、composition 与字符边界
   查询，向输入法提供 control/selection/character bounds。
2. **引擎托管输入代理**：EditContext 不可用时，由 `@dopejs/doper-editing`
   维护一个全局、不可见的 `textarea`/`input` 代理，统一处理
   `beforeinput`、composition、软键盘和剪贴板。

第二条是平台降级实现，不是 EmbedDOM 组件模型：业务不创建、不定位、不同步
HTML 输入控件，Scene 中也不存在与每个编辑节点一一对应的 DOM。能力探测必须
逐浏览器和输入法验证，不能把 EditContext 的存在当作完整可用的充分条件。

### 状态所有权与双时钟

- Shell 拥有业务数据模型；Core 拥有当前激活编辑会话的瞬时文本、selection、
  composition 和 caret 状态，双方不共享可变对象。
- 主线程输入桥把编辑意图写入独立的低延迟 Input Stream，不要求先触发组件
  render 或 reconciler diff。
- Core 校验 `base_revision` 后立即应用编辑事务、重新布局受影响段落并绘制，
  再通过反向通道向 Shell 发出版本化 `EditTransaction`。
- Shell 可确认事务或发送带新 revision 的校正值；过期事务不得覆盖新状态。
- composition 更新是临时状态，commit 后合并为一个 undo 单元；失焦、取消、
  Worker 重启和外部 value 更新都必须有明确的 composition 终止规则。

这样避免把每次按键变成一次完整 TSX build，同时保留受控数据和业务校验能力。

### 文本位置模型

Web 输入 API 使用 UTF-16 offset，而 Rust 字符串、Unicode grapheme、shaping
cluster 和视觉 glyph 的边界并不相同。编辑子系统必须维护显式映射：

```
UTF-16 offset ↔ Unicode scalar ↔ grapheme ↔ shaping cluster ↔ glyph/line
```

协议边界使用 UTF-16 offset 以对齐 EditContext/InputEvent；Core 内部可以使用
UTF-8，但转换表必须随文本 revision 缓存。删除、移动和 selection 不得拆开
grapheme、combining sequence、emoji ZWJ 或 shaping cluster。Bidi 文本还需要
保存 logical/visual position、caret affinity 与垂直导航的 desired-x。

### 渲染与坐标反馈

- caret 闪烁由 Worker 渲染时钟驱动，不依赖 Shell setState。
- selection、composition underline 和 caret 由 Core 生成 DisplayList 指令，
  与文本使用同一坐标和裁剪体系。
- Core 将最新 control bounds、selection bounds 和按需 character bounds 回传
  主线程；滚动、缩放、DPR 或布局变化时更新，供 IME 候选窗口定位。
- active editor 必须能请求祖先滚动容器最小幅度 scroll-into-view，不能通过
  DOM `scrollIntoView()` 绕过 Core 的滚动模型。

### API 草案

```tsx
const editor = useTextEditingController({ value: cell.value });

<EditableText
  controller={editor}
  multiline={false}
  inputMode="text"
  onTransaction={(tx) => cell.apply(tx)}
  onSubmit={() => moveToNextCell()}
/>;
```

`EditableText` 是无装饰的引擎原语；`TextField` / `TextArea` 由 widgets 在其上
组合边框、placeholder、错误状态和交互样式。公开 API 同时提供本地 controller
模式和外部受控同步，但不得要求业务逐按键重建 host node。

### 安全与隐私

- 密码文本不得进入录制回放、日志、devtools 明文或 a11y value。
- 粘贴与拖放数据经过大小和类型限制；富内容默认转纯文本。
- 字符数限制按 grapheme 定义，内存预算按实际字节和布局产物定义。
- 输入过滤不得破坏正在进行的 composition；校验失败必须通过版本化校正事务
  处理，不能静默丢弃输入法中间态。

---

## 12. 事件与命中测试

- **采集**：主线程 `{passive: true}` 监听 pointer/wheel/touch/key。滚动相关事件只把 delta 与时间戳写入 SAB，**不做命中测试、不触发 setState**。
- **编辑输入**：文本意图、composition、selection 与 clipboard 走专用编辑输入
  协议，不伪装成普通 key event；快捷键和 `beforeinput` 的优先级由编辑会话决定。
- **命中测试**：Core 内用 BVH（基于 `world_aabb`，随 scene 增量维护）。找到目标后构建事件路径。
- **事件模型**：对齐 DOM，支持 capture / target / bubble 三阶段。
- **回传**：命中结果与事件路径通过反向 ring buffer 回传 Shell，由 Shell 执行业务回调。
- **`preventDefault` 的时序问题**：passive 监听器不能 `preventDefault`。需要阻止默认行为的区域（如内部可滚动区）由 Core 预先计算并把「非 passive 区域矩形」同步回主线程，主线程据此对这些区域使用非 passive 监听。这是必须显式处理的正确性点。

---

## 13. 反应式层（TypeScript）

### 选型：signals，不用 VDOM diff

```tsx
function Cell({ row, col }: CellProps) {
  const [editing, setEditing] = useState(false);
  const value = useSelector(() => sheet.get(row, col)); // 细粒度订阅
  return <Text value={value} bold={editing} onTap={() => setEditing(true)} />;
}
```

理由：signal 更新精确定位到单个组件，不需要从根 diff，也不要求业务标注静态/动态节点；百万 cell 场景下仍可保持更新范围可控。

### 编译期优化（`@dopejs/doper-jsx`）

- 静态子树提升：结构不变的子树只发一次 `CreateNode`，之后完全跳过。
- props 常量折叠：编译期能确定的值直接编入初始 mutation。
- 事件回调稳定化：避免每次渲染都产生新 `SetRef`。

### Hooks 范围

本期提供：`useState` `useMemo` `useCallback` `useRef` `useEffect`（在 commit 后执行）`useSelector` `useSignal`。
**不提供** `useLayoutEffect` 的同步语义——布局在 Worker 里，同步读布局结果会破坏双时钟。改为 `useLayoutValue(nodeRef, selector)`，异步一帧返回。这是与 React 的一个明确差异，需在文档中显著说明。

---

## 14. 无障碍与可测试性

从第一天进架构，不后补。

- Core 维护语义树（role / label / value / bounds / focusable）。
- `@dopejs/doper-a11y` 把语义树映射为 canvas 旁的绝对定位 DOM 影子树，供屏幕阅读器与自动化工具消费。
- E2E 因此可以按语义选择元素，像素录制回放只作为补充证据。
- 保留像素回归测试作为渲染正确性的补充手段（`@napi-rs/canvas` 或 headless 真实浏览器）。

---

## 15. 测试策略

渲染引擎的测试有一个特殊难点：**正确性没有唯一 oracle**。「这一帧画得对不对」没有标准答案可比对，只能靠差分测试构造 oracle。本章的组织即围绕这一点展开。

### 15.0 前置架构约束：确定性

**引擎必须支持确定性回放，否则本章大部分测试都会退化为 flaky 源头。** 这是架构约束，M1 必须满足，不可后补：

- **时间可注入**：帧循环不直接读 `performance.now()`，时间源作为依赖注入。测试中可逐帧步进。
- **随机数可注入**：引擎内部任何随机（如 cache 淘汰的抽样、预热调度的抖动）走可播种的 RNG。
- **输入可录制回放**：Mutation Stream 与输入事件流按原始顺序封装为 `DOPR` 二进制，
  两侧递归验证后可脱离浏览器在 headless 环境逐帧重放；敏感流不得写入归档。
- **无隐式并发**：Core 内部的并行（若引入）必须是确定性调度或结果不依赖调度顺序。

录制回放同时是**线上问题的排查手段**：用户复现一次异常，导出 mutation + 输入流，开发在本地精确重放；语义断言与像素结果一并保存。

### 15.1 测试分层

| 层          | 对象                                             | 手段                                   | 运行时机                           |
| ----------- | ------------------------------------------------ | -------------------------------------- | ---------------------------------- |
| L1 单元     | 各 crate / package 内部逻辑                      | `cargo test` / vitest                  | 每次提交                           |
| L2 属性     | 不变式（见 §15.2）                               | `proptest` + shrink                    | 每次提交                           |
| L3 契约     | Mutation Stream / Input Stream / DisplayList ABI | golden 二进制 fixture + 双侧 roundtrip | 每次提交                           |
| L4 差分     | 渲染正确性（见 §15.3）                           | 多 oracle 交叉比对                     | 每次提交（快集）/ 每晚（全集）     |
| L5 并发     | SAB ring buffer、双时钟同步                      | `loom` 模型检查 + 压力测试             | 每晚                               |
| L6 模糊     | ABI 解码器                                       | `cargo-fuzz`                           | 每晚 + 发布前                      |
| L7 集成/E2E | 完整应用行为                                     | 语义树驱动 + 真实浏览器                | 每次提交（核心用例）/ 每晚（全量） |
| L8 性能     | 帧时间、过度失效率、内存                         | 自动 benchmark；真机仅平台资格         | 每次提交 / 可选资格采集            |
| L9 耐久     | 长时间运行稳定性                                 | soak test（连续滚动 30 分钟）          | 每晚                               |

### 15.2 属性测试（不变式清单）

除 §5.1 的失效正确性外，以下不变式必须被属性测试覆盖：

| 模块           | 不变式                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `doper-scene`  | 任意 mutation 序列后，拓扑序成立（父 index < 子 index）；无悬垂 NodeId；free list 与 generation 自洽                                 |
| `doper-layout` | 布局结果满足传入约束；相同约束 + 相同输入 → 相同输出（幂等）；relayoutBoundary 内的变更不影响边界外的布局结果                        |
| `doper-scroll` | 前缀和树：`offset(index(o)) ≤ o < offset(index(o)+1)`；任意增删改后与朴素线性实现结果一致                                            |
| `doper-hit`    | BVH 命中结果与朴素逐节点遍历一致（**这是典型的差分 oracle**）                                                                        |
| `doper-abi`    | 任意指令流 `encode(decode(x)) == x`；截断/损坏输入不 panic、不越界                                                                   |
| `doper-text`   | 换行结果不超出给定宽度；相同输入 → 相同 glyph 序列                                                                                   |
| `doper-edit`   | 任意编辑序列不产生非法 offset 或拆分 grapheme；undo/redo 可逆；过期 revision 不覆盖新状态；composition commit 等价于一个原子 replace |

原则：**凡是有"朴素但显然正确"的参考实现的模块，都必须做差分测试**。朴素实现作为测试专用代码保留在仓库中，不参与生产构建。

### 15.3 差分测试（构造 oracle）

四组交叉比对，每组都在制造一个独立的正确性 oracle：

| #   | 比对双方                                                            | 捕获的缺陷类型                          |
| --- | ------------------------------------------------------------------- | --------------------------------------- |
| D1  | 增量渲染 ↔ 全量重绘                                                 | 失效标注漏标（§5.1 L2 的核心保障）      |
| D2  | Canvas2D 后端 ↔ WebGPU 后端                                         | 后端实现分歧、DisplayList 语义歧义      |
| D3  | 优化路径 ↔ 朴素路径（BVH↔线性、前缀和树↔线性、picture cache 开↔关） | 优化引入的正确性回归                    |
| D4  | wasm 构建 ↔ native 构建                                             | 目标相关缺陷（浮点、对齐、size_t 宽度） |

D2 有个前置决策：**两个后端的输出不可能逐像素完全一致**（抗锯齿与栅格化算法不同）。因此 D2 采用**感知阈值比对**（如 SSIM 或有界的逐像素差），阈值随场景类型分级并记录在案；D1/D3/D4 则要求**逐像素严格一致**，任何差异都是 bug。

### 15.4 契约测试（ABI）

ABI 是本架构中最危险的耦合面——Rust 与 TS 两侧独立实现编解码，一旦漂移就是内存级错误而非逻辑错误。

- `prop` 常量表、opcode 表、结构体布局**全部由单一 schema 文件生成**，两侧代码不可手写。
- 保留 **golden 二进制 fixture**：固定输入 → 固定字节序列。ABI 变更导致 fixture 失配时必须显式更新并同步 bump ABI 版本号，防止无意破坏兼容。
- 双向 roundtrip：TS 编码 → Rust 解码 → Rust 重编码 → 与原字节比对。
- 解码器必须对**任意字节输入**保持内存安全（由 L6 fuzz 保证），不得依赖"输入总是自家产生的"这一假设。

### 15.5 并发测试

双时钟 + SAB ring buffer 是本架构最容易出现难复现缺陷的地方。

- 用 `loom` 对 ring buffer 的读写协议做穷举式模型检查（生产者/消费者交错的全部可能）。
- 压力测试：Shell 侧以远高于渲染帧率的速度写入，验证背压、丢帧合并、`frame_seq` 单调性。
- 故障注入：模拟 Shell 卡死 / Worker 卡死 / 消息乱序，验证降级链正确触发且不产生视觉错误。

### 15.6 性能测试与门禁

- **PC benchmark 每次提交卡点**：检查 §2 的绝对指标；任一绝对指标失守即拦截
  合入。目标分支与历史趋势同时记录用于发现退化和定位原因，但不构成独立
  Pass/Fail 条件。
- **平台资格采集**：设备或自动设备云可用时覆盖低端安卓与主流 iOS，数据入库并做
  趋势告警；外部设备不可用不阻塞工程合入或里程碑完成。
- **过度失效率**（§5.1 L5）作为一等指标进卡点，与帧时间同等对待。
- **WASM 体积**进卡点（§2 目标 < 400KB gzip）。
- 内存：Raster Cache 预算遵守、长时间运行无泄漏（L9 soak）。

### 15.7 覆盖率与门禁策略

- Rust core 行覆盖率 ≥ 85%，`doper-abi` / `doper-scene` / `doper-scroll` 等核心 crate ≥ 95%。
- TS 侧 ≥ 80%。
- **覆盖率是下限而非目标**：不允许通过无断言测试刷指标，评审时关注不变式覆盖而非行覆盖。
- 合入门禁 = L1 + L2 + L3 + L4(快集) + L7(核心) + L8(PC benchmark) 全绿。
- 工程里程碑门禁只包含可在 CI 自动复现的层级。发布到某个受支持平台时，该平台还
  必须完成资格认证与 soak；缺少资格时应标记为 `unqualified`，不能把模拟值当真机值。

### 15.8 测试基建投入说明

本章的 headless 渲染、录制回放、差分框架、真机采集链路是**共享基建**，服务于 §5.1 的失效正确性、§15.3 的差分测试、§15.6 的过度失效率统计三处。因此必须在 M1 一次性建成，不可分散到各里程碑逐步补齐——分散建设的结果通常是永远建不完整。

---

## 16. 里程碑

| 里程碑                    | 内容                                                                                                                                                                                                                                                           | 出口标准                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **M0 探针**               | Worker 帧驱动三方案与故障注入；SAB/COOP-COEP capability；OffscreenCanvas 2D 基线；EditContext/输入代理契约；wasm 体积与冷启；建立可选平台资格采集与 benchmark 基础设施                                                                                         | 自动化探针、降级链、编辑回放和证据契约通过 `pnpm m0:check`                                          |
| **M1 单线程内核**         | Scene(SoA)、约束布局、Mutation/Input Stream、DisplayList、Canvas2D 回放器、signals + hooks + TSX；建立 editing revision、selection 与 offset 映射模型。先跑主线程，不引入 Worker。**含失效正确性属性测试 + headless 渲染基建**（§5.1 L2 的前置条件，不可推后） | 静态页面与参考渲染器/golden 对齐；编辑事务可确定性回放；PC 绝对指标通过且趋势可诊断；属性测试零失败 |
| **M2 双时钟 + 缓存**      | Worker 化、SAB 通道、Picture/Raster Cache、tile 合成、降级链                                                                                                                                                                                                   | 自动故障注入中主线程阻塞 200ms，Worker 连续呈现                                                     |
| **M3 滚动 + 文本**        | 原生虚拟滚动、前缀和树、预热；web 字体 shaping、glyph atlas；输出 grapheme/cluster/glyph/line 映射与 caret geometry                                                                                                                                            | 百万行固定 fixture 通过自动 benchmark；文本稳定驱动 selection/caret                                 |
| **M4 编辑、事件与无障碍** | EditContext 与输入代理、IME、caret/selection、剪贴板、undo/redo、自动滚动；BVH 命中测试、三阶段事件、非 passive 区域协议、语义树与影子 DOM                                                                                                                     | canvas 原生编辑、composition replay 与语义树 E2E 自动通过                                           |
| **M5 迁移与 WebGPU 验证** | 存量兼容 shim、devtools、迁移文档；wgpu 后端并行验证；平台资格数据仅决定该平台是否默认启用                                                                                                                                                                     | 迁移 fixture、灰度/回退演练和后端差分自动通过                                                       |

关键排序原则：**M2 之前不碰 WebGPU，M3 之前不碰复杂文本**。收益主要来自双时钟与 Core 内闭环滚动，先把这条主线拿下。

---

## 17. 风险与应对

| 风险                                       | 影响                             | 应对                                                                                       |
| ------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------ |
| **COOP/COEP 无法在业务页面启用**           | SAB 不可用，双时钟降级           | capability 自动降级到 postMessage；业务资格记录最终选中路径                                |
| **Worker 帧驱动在部分平台不稳**            | "主线程阻塞不掉帧"无法成立       | 自动故障注入 + 自驱锁相；平台资格失败时按平台 override 到安全路径                          |
| **文本模块被低估**                         | 进度失控                         | M1 只做最小子集；bidi/复杂脚本明确推迟到 M3；预留专人                                      |
| **EditContext 支持不完整或输入法行为分裂** | canvas 无法稳定输入、候选窗错位  | M0 建立浏览器/OS/输入法矩阵；引擎托管输入代理兜底；所有 composition 流可录制回放           |
| **编辑状态跨线程失序**                     | 丢字、回滚新输入、selection 跳动 | revisioned transaction、单一 active composition、过期更新拒绝、故障注入与确定性重放        |
| **WASM 体积与冷启**                        | 移动端弱网首屏劣化               | streaming compile；核心路径保留 JS 兜底实现，wasm 就绪后热切换；体积进 CI 卡点             |
| **Rust/WASM 工具链复杂度**                 | 构建、调试或升级阻塞核心迭代     | 固定工具链与 ABI；crate 边界隔离；保留 native/headless 路径并让 CI 同时验证                |
| **跨 Worker + WASM 调试困难**              | 排障成本高，长期拖慢迭代         | devtools 在 M1 就作为一等公民；Core 支持 headless 回放（录制 mutation 流，脱离浏览器复现） |
| **低端安卓上 WebGPU 反而更慢**             | 后端选型判断错误                 | 后端可插拔；没有对应平台资格数据时不在该平台默认开启 WebGPU                                |

### 回滚路径

每个里程碑都保持「可退回上一状态且业务可用」：

- M2 的 Worker 化通过 feature flag 控制，线上可一键切回主线程模式。
- M5 的 WebGPU 后端默认关闭，按机型灰度。
- 存量兼容 shim 保证业务可以按页面粒度回退到原有渲染路径。

---

## 18. M0 探针清单（可立即执行）

1. `DedicatedWorkerGlobalScope.requestAnimationFrame` 在目标机型矩阵上的可用性与相位稳定性。
2. 主线程 rAF → SAB 时间戳 → Worker 轮询的端到端延迟分布。
3. Worker 自驱 `setTimeout` + 相位锁的漂移量，以及主线程完全阻塞下的表现。
4. OffscreenCanvas 2D 在 Worker 中的光栅化吞吐 vs 主线程 Canvas2D。
5. `drawImage` 自拷贝（scroll-copy）在低端安卓上的真实成本——这决定 tile 平移策略。
6. 一个最小 Rust wasm 模块的体积、streaming compile 耗时、首次调用延迟。
7. COOP/COEP 在目标业务页面启用的可行性（含第三方资源影响面盘点）。
8. 真机 P95 采集链路搭建（Long Animation Frame API / `requestAnimationFrame` 打点 + 上报）。
9. EditContext 在目标浏览器/OS/输入法矩阵上的 text/selection/composition/bounds
   行为，以及引擎托管输入代理的等价性。

M0 工程出口运行 `pnpm m0:check`，只包含仓库与 CI 能无人值守复现的检查。物理设备、
真实 IME、业务 COOP/COEP 和外部存储属于平台资格认证：资格证据把 `deviceId` 与
`roleId` 分开，逐角色保存两组 5 次预热 + 15 次样本、真实 IME 录制和原始报告，并由
`m0-evidence-manifest-v1` 与 `pnpm platform:qualify` 复算。没有这些证据只会保持该
平台 `unqualified`，不改变 M0 工程完成状态。

采集器以不可覆盖的原子提交保存报告和 IME JSON，并为每个文件生成 SHA-256
sidecar；资格门禁先验证归档完整性，再从原始样本复算派生指标。业务审计、存储恢复
与最终决策使用版本化 JSON 契约，决策必须引用已验收业务与存储证据的 digest。
不支持 hard-link/`fsync` 的挂载不得直接作为采集 staging；应使用本地可靠文件系统
完成提交，再复制到外部不可变存储。该约束的回滚是回到上一份未通过的 M0 证据，
而不是放宽为可覆盖归档。

探针 1-3 是本方案成立的前提，**优先级最高**。
