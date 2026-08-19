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

| opcode | 指令                   | payload                                                       |
| ------ | ---------------------- | ------------------------------------------------------------- |
| `0x01` | `CreateNode`           | `node_id: u32, kind: u16, parent: u32, before_sibling: u32`   |
| `0x02` | `RemoveNode`           | `node_id: u32`                                                |
| `0x03` | `Reparent`             | `node_id: u32, new_parent: u32, before_sibling: u32`          |
| `0x10` | `SetF32`               | `node_id: u32, prop: u16, value: f32`                         |
| `0x11` | `SetVec4`              | `node_id: u32, prop: u16, v: [f32;4]`                         |
| `0x12` | `SetRef`               | `node_id: u32, prop: u16, resource_id: u32`                   |
| `0x13` | `SetFlags`             | `node_id: u32, set: u32, clear: u32`                          |
| `0x20` | `SetTextRun`           | `node_id: u32, str_id: u32, style_id: u32`                    |
| `0x30` | `DefineResource`       | `resource_id: u32, kind: u16, len: u32, bytes[]`              |
| `0x40` | `ScrollTo`             | `node_id: u32, x: f32, y: f32, behavior: u16`                 |
| `0x41` | `ConfigureVirtualList` | `node_id: u32, item_count: u32, estimate/policy: [f32;4]`     |
| `0x42` | `SetVirtualItem`       | `node_id: u32, item_index: u32`                               |
| `0x50` | `ConfigureEditable`    | `node_id: u32, revision: u64, flags: u32, max_graphemes: u32` |
| `0xF0` | `Commit`               | `frame_seq: u32`                                              |

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

| opcode                                               | 指令                              |
| ---------------------------------------------------- | --------------------------------- |
| `Save` / `Restore`                                   | 状态栈                            |
| `Transform(Affine)`                                  | 变换                              |
| `ClipRect(Rect)` / `ClipPath(path_id)`               | 裁剪                              |
| `Alpha(f32)`                                         | 透明度                            |
| `FillRect(Rect, paint_id)`                           | 矩形                              |
| `FillRRect(RRect, paint_id)`                         | 圆角矩形                          |
| `FillPath(path_id, paint_id)`                        | 路径                              |
| `DrawGlyphRun(font_id, size, origin, glyph_span)`    | 字形序列（web 字体路径）          |
| `DrawTextFallback(str_id, font_desc_id, origin)`     | 系统字体路径，回放器调 `fillText` |
| `DrawTextInlineFallback(font_desc_id, origin, utf8)` | Core 编辑覆盖层的系统字体即时文本 |
| `DrawImage(image_id, src, dst)`                      | 图片                              |
| `DrawPicture(picture_id, offset)`                    | 引用缓存的子指令流                |

`DrawPicture` 是缓存复用的关键：item 内容不变时，滚动只需改变 `DrawPicture` 的 offset，指令流本身零重建。

`DrawTextInlineFallback` 只用于 Core 持有、尚未回写为 Shell intern 资源的活动编辑值。
它沿用同一条 DisplayList trust boundary，UTF-8 长度受流预算约束，Canvas2D 回放器在
preflight 阶段完成解码，不能在绘制中访问未验证字节。显式 web 字体仍由 Core 对活动
值重新 shaping 后走 `DrawGlyphRun`；无法 shaping 时整段退到 inline fallback。该指令
避免把每次按键同步改写 Scene resource，也避免等待一次 Shell render 才显示输入。

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

### 滚轮传递曲线（M5 决策，2026-08-17）

浏览器原生滚动的 **位移** 和 wheel 事件的 `deltaY` 是一一对应的，但 **传递曲线**
不是：桌面浏览器把一格离散滚轮动画滚过去（约 100–300ms 缓出，连续格并入同一段
动画），只有高精度设备（触摸板）的 delta 才即时应用——因为那份 delta 本身已经由
操作系统平滑过、并且已经带上了惯性阶段的采样。

早期实现对两者一律即时 1:1 应用。位移正确，但离散滚轮变成瞬跳，主观上"太快、
不像原生"；同时 `apply_wheel` 每个事件都 `begin()/end(false)`，引擎侧完全没有滚轮
速度模型。

现在按输入源分流：

- **高精度（触摸板）**：即时 1:1，惯性仍由操作系统的事件流提供，引擎不叠加自己的
  fling，避免双重惯性。
- **离散格**：累加到一个动画目标，由 `ScrollPhysics` 在 `advance()` 里以**有界时长**
  的三次缓出推进（120ms 走完）。连续格在动画中途到达时以当前位置为新起点重新计时，
  所以快速拨轮不会越拖越远；目标硬夹到内容边界，不产生 overscroll，与浏览器一致。
  直接拖拽、高精度 delta 和程序化 `jump_to` 都会立即取消未完成的动画。

  这里**必须是有界时长而不是指数逼近**。第一版用的是时间常数 45ms 的指数逼近 +
  停止阈值，线上实测一格滚轮要 280ms 才停下来，最后三分之一的时间只走几个像素：
  总位移正确，但手感是明显的拖沓。浏览器的滚轮平滑滚动是约 100–150ms 的有界缓动，
  完成时间本身就是手感的一部分，因此属性测试断言的是**完成时间**而不只是落点。

分类只能在 Host 完成，因为只有它看得到 DOM 事件。判定是**按手势**而非按事件：
经典滚轮的 legacy `wheelDeltaY` 是 120 的整数倍且事件间隔远大于一帧，触摸板则以
显示器刷新率连续下发。手势内一旦出现触摸板特征就保持高精度直到手势结束
（200ms 静默）；拿不到 legacy 字段的平台默认高精度，即保持与原始 delta 一致的
位移，不会有意外的动画。

**兼容性**：Input Stream 的 `DispatchEvent` 把原先必须为零的 2 字节 padding 变成
`flags`（bit0 = 高精度滚轮，其余位保留且必须为零）。布局、大小、对齐都不变，但
旧解码器会拒绝带标志位的帧，因此 `abiVersion` 从 1 提升到 2，由既有的版本协商在
握手期给出明确的不兼容结果，而不是等到第一次触摸板滚动才失败。

**验证**：`doper-scroll` 的动画累加、有界完成时间、边界夹取、取消路径与"小于停止
距离立即应用"各有单测；`doper-core` 有一条引擎级测试断言同一份 delta 在两种标志下分别是即时
到位和先动画后精确落点；ABI 侧有编解码 round trip 与保留位 fail-closed 覆盖；
Host 侧有分类的单测矩阵。

**回滚**：Host 端把 `classifyWheel` 恒定返回 `EVENT_FLAG_PRECISE_WHEEL`，即可在不
改 Core、不改 ABI 的前提下恢复全即时 1:1 行为。

### 窗口移动的增量布局（2026-08-18）

虚拟滚动每帧都在移动窗口，而 `doper-layout` 的增量路径以「拓扑未变」为前提——窗口移动
必然增删子节点，于是每帧都退回全量布局。代价随窗口大小增长而非随变化量增长，滚动手感
和预热策略因此互相牵制：窗口开大能减少占位骨架但每帧布局更贵，开小则反之。

虚拟项的偏移来自 `VirtualLayoutProvider::item_offset` 而非兄弟累加（`compute_subtree`
中虚拟项分支不推进 `parent.content_y`），所以窗口移动时**留下来的节点不可能移动**。现在
当结构变化全部发生在虚拟项内部时，按 NodeId 重映射上一帧快照、复用所有存活几何，只布局
新增项。

两个必须做对的细节，第一次尝试都错了并已记录在此以免重犯：

- **子约束要由父容器推导**，即 `make_frame(parent, tight(parent_prior_size))` 的
  `child_constraints`，其中包含 padding 扣减与 Scroll 类型放宽 max 为 INFINITY 的分支。
  直接用 `tight(parent_size)` 会把子项强制成父容器尺寸。
- **新增项的偏移必须显式写入**。`compute_subtree` 只在栈中存在父帧时赋 offset，从该项
  自身开始时那段分支不执行，偏移会停在零。

这两个错误都会被紧随其后的测量修正遍静默改回，画面上看不出来，只在 `layout_visited`
计数上露破绽。因此回归测试除了断言访问节点数，还**把增量结果与从零全量布局的结果逐项
比对要求完全相等**。

判定条件是「新增/移除的节点是虚拟项**或位于虚拟项内部**」。只判断"是虚拟项"是不够的：
一个 item 通常是包装容器加一棵应用子树，窗口移动增删的是整棵子树。用单节点 fixture 写的
测试会因此给出虚假绿灯。

实测（百万行 playground，40 格快速 fling）：窗口移动时 `layout_visited` 从 372（整个
Scene）降到 60，稳定后 39。

绘制侧此前有对称的问题：`rebuild_subtrees` 在拓扑变化时把所有节点标记重建，并且
`self.subtrees = updates` 丢弃整个子树缓存。子树缓存按 NodeId 索引，存活节点的缓存本来
完全有效，所以现在按「自身脏、几何变化、无缓存、或子节点列表变化」精确判定，缓存改为合并
后按当前 Scene 保留。

**判定必须比对子节点 id 序列，不能比数量**：窗口移动是前删一项、后加一项，父容器的子节点
数量不变。只比数量会把这种情况判成未变，父容器的指令就会残留旧内容——一个不会报错、只会
画错的坑。为此 `CachedSubtree` 记录 `child_ids`。

实测合计效果（同一 fling）：`layout_visited` 372 → 0，`dirtyPaintNodes` 372 → 1。

**剩余瓶颈已转移到 Shell 物化往返**：Core 每帧代价接近零之后，占位恢复仍需约 700ms，时间
花在「请求窗口 → 微任务 → reconciler 为整窗调用 `renderItem` 并 diff → 编码 mutation →
传输 → Core 应用」这条链路上。下一步是先服务可见区间再补预热窗口，以及窗口移动时只增删
差量行而不是重建整窗元素。

### 已知限制（历史记录）

（下述内容记录修复前的状态与第一次撤回的尝试。）

虚拟滚动此前**每移动一次窗口就要对整个 Scene 重新布局一次**。

`doper-layout` 的增量布局以「拓扑未变」为前提：它按下标复用上一帧的双缓冲几何，
`front.ids != scene.ids()` 就退回 `prepare_full`，从根节点重算。而虚拟列表每次窗口
移动都会增删子节点，拓扑必变——**增量布局在最需要它的场景里从不生效**。

实测（`shifting_a_virtual_window_costs_the_change_not_the_whole_scene`，当前标记为
`#[ignore]`）：一个 41 节点的窗口移动 1 项（增删各 1 个节点），`layout_visited` 是
42/42，即整个 Scene。代价随窗口大小增长，而不是随变化量。

这条直接决定了滚动手感，并且和预热策略互相牵制：窗口开大能减少占位骨架，但每帧布局
更贵；开小布局便宜，但骨架更多。两端都被同一个 O(Scene) 代价卡住，只能在两种难受之间
挪动。滚轮缓动会把这个代价乘以动画帧数——按钮式的程序化跳转只有一次窗口变化，所以明显
更快，这也是这个限制最容易观察到的地方。

**第一次修复尝试已撤回。** 思路是对的：虚拟项的偏移来自 `VirtualLayoutProvider::item_offset`
而非兄弟累加（见 `compute_subtree` 中虚拟项分支不推进 `parent.content_y`），所以窗口移动
理论上可以只布局新增项、复用其余几何。但实现时给新增项传了 `BoxConstraints::tight(parent_size)`，
把子项强制成了父容器尺寸；几何算错后又被紧随其后的测量修正遍掩盖，只在 `visited` 计数上
露出破绽。**正确实现需要按父容器给子节点的约束来构造，而不是父容器自身的尺寸**，并且要同时
处理测量修正遍（`engine.rs` 中 `mark_virtual_measurements_changed` 触发的第二遍布局，其
边界是整个列表）。在把这两点都做对之前不应合入——布局是不变式最密集的子系统，错误会被
后续修正遍静默吞掉。

### 滚动帧的闭环

```
读 SAB 输入 delta → 物理积分 → 求可见区间 →
  命中 cache: 平移 tile + 拼接 DrawPicture
  未命中:    Core 内布局+构建 picture（不回 Shell）
  Shell 侧缺数据: 发请求，本帧用占位，下帧补
→ 提交 DisplayList → 后端光栅化
```

**滚动帧内不产生任何 Shell 调用**。只有当某个 item 的组件从未构建过（真 cache miss）时才需要 Shell 补建，这条路径被预热机制覆盖到极低频。

### 占位与预热（M5 缺陷修复，2026-08-17）

线上 Playground 暴露了三个互相叠加的缺陷，症状是快速滚动时视口下方大面积**白屏**：

1. **占位从未被绘制**。`plan_frame` 只把可见但未物化的 item 记进 `placeholders`
   计数器，没有任何代码为它生成 Scene 节点或 DisplayList 指令，所以缺数据的区域
   什么都不画。文档此前描述的"先画占位、下帧补"在实现里并不存在，而门禁全绿，
   因为没有任何测试断言"缺数据时画了什么"。现在 Core 为每个可见且未物化的 item
   发出 `FillPlaceholder`（DisplayList 新指令，携带内联 RGBA，不需要 Scene 资源），
   在滚动内容坐标系中、子节点之前绘制，物化后的真实行自然覆盖它。
2. **滚轮/触摸板没有前瞻**。预热窗口的方向投影读的是 `physics.velocity()`，而滚轮
   路径从不保留 fling 速度（`begin/end(false)` 或动画目标），于是投影恒为 0，窗口
   永远是对称的 ±1 视口，快速手势每帧都落到窗口之外。改为按**落点**预热：动画中
   直接用动画目标，其余用一条独立衰减的 `preheat_velocity`——它只参与缓存规划，
   不参与 `advance` 的惯性积分，因此触摸板不会在抬手后自己滑动。
3. **补建请求会永久失效**。`requested` 置位后只有在该 item 被物化或显式失效时才
   复位；若窗口在 Shell 应答前移走，该位永远为真，之后再次可见时不会重新请求，
   变成永久空白。现在离开预热窗口的未应答项会被重新标记为可请求。

**验证**：`doper-core` 有一条断言"每个计数到的 placeholder 都必须真的被画出来、
且矩形非空、颜色不透明"；`doper-scroll` 有滚轮前瞻与未应答重试的回归测试。

### 补建往返：消费端合并（M5 缺陷修复，2026-08-18）

上一轮把 Core 每帧代价降到接近零之后，快速甩动停手仍要约 950ms 才能褪去骨架。诊断
显示主线程在这段时间内**没有任何 long task**——不是算不完，是在排队。根因是三处
"生产者按帧产出、消费者逐条处理"的结构，它们各自把一次手势放大成十几次全量工作：

1. **输入逐条触发整画布回放**。post-message 路径下每条 input 消息立即调用一次
   `sink.input()`，而每次都要出一帧并做整画布回放（约 15–20ms）；指针设备每次刷新
   产生一个事件（约 8ms 一个），积压只增不减，抬手后偏移还要追赶数百毫秒。渲染时钟
   现在每帧调用 `inputBatch()` 一次性排干队列：Core 状态仍逐条推进、反向流照常排空，
   只跳过中间那些还没被看见就已被取代的画面。为不破坏顺序，commit 前也会先排干。
2. **补建请求逐条触发整窗重建**。Core 每个渲染帧发一个窗口，每个窗口各自一条消息、
   各自一个微任务，于是 Shell 为每条消息都把整窗重建一遍。实测一次手势里 6ms 内做了
   4 次 123 项的整窗重建，每次只比上一次前进 25 项，且提交串行排队——Core 因此一直
   在收到偏移早已离开的窗口。窗口是**绝对区间**而非增量，后者完全取代前者，所以现在
   按帧合并、每个列表只渲染最新窗口，最多多付一帧延迟。
3. **饥饿钳制造成窗口双稳态**。预热窗口原本在视口缺内容时收窄、补齐后放宽。但饥饿是
   这次规划的**输出**而非输入：窄窗被应答 → 视口短暂补齐 → 下一次规划改要宽窗 →
   物化宽窗时又把窄窗持有的行删掉。Core 于是在两种形状间交替发请求，Shell 每次重建
   不同窗口，视口永不收敛。现在窗口只由偏移与落点决定，重建规模由
   `maximum_ahead_viewports` 约束。

**实测**（本地 dist-pages，40 格快速甩动后观察骨架消失时刻）：约 950ms → 225/283/292/317ms。
剩余部分可分解为约 200ms 的滚轮惯性动画本身与约 80ms 的流水线排空（请求 → 渲染 →
传输 → 提交，各一跳），后者与 `mat` 落后 `vis` 约 100 项的观测一致。

**新增可观测量**：`frameDiagnostics` v4 增加 `virtualVisibleStart/End` 与
`virtualMaterializedStart/End`。此前只有 `visiblePlaceholders`，"Shell 慢"和"Shell 在
补一个 Core 早已不要的窗口"看起来完全一样——正是缺了这两个区间，前六个假设全部猜错。
定位靠的就是"可见区在 [491,510]、已物化区却停在 [374,496]"这一条对照。

**回滚**：三处改动彼此独立。输入批处理回退为 `doper:input` 消息内直接调用 `sink.input()`；
补建合并回退为 `queueMicrotask`；窗口形状回退为按 `starved` 收窄。任一处回退都不改变
ABI，只会让骨架时间回到修复前的量级。

### 手感回归：同步抑制与非滚动轴（2026-08-18）

上面的按帧合并带来两个手感缺陷，都在同一次线上试用中暴露：

1. **画布滚动与页面滚动同时发生**。滚轮的 `preventDefault` 原本在
   `dispatchCanvasEvent` 里，而合并把这次调用推迟到了下一帧——那时浏览器已经滚过页面，
   `preventDefault` 不再被采纳。抑制判定因此拆出来在监听器内同步执行
   （`suppressWheelDefault`），合并只负责推迟**派发**，不推迟**抑制**。
   `dispatchCanvasEvent` 对 wheel 不再重复抑制。
2. **不可横向滚动的列表出现横向回弹**。`overscroll_limit()` 只看视口尺寸，不看该轴
   是否真的有可滚动余量。虚拟列表内容宽度等于视口宽度、`maximum_position` 为 0，
   横向仍能橡皮筋到 ±0.5 视口；而触摸板在纵向手势中始终带一个小的横向分量，于是整段
   滚动都在左右晃。现在没有可滚动余量的轴不回弹，与浏览器对内层滚动容器的行为一致
   （可滚动轴在边缘的回弹不受影响）。

**验证**：`doper-scroll` 有"无可滚动余量的轴不移动也不回弹、可滚动轴仍在边缘回弹"的
单测；host 既有的"只在 Core 发布的区域内同步抑制滚轮默认行为"用例覆盖第 1 点，并且
正是它抓到了抑制被调用两次。浏览器实测：25/25 滚轮事件 `defaultPrevented`，页面
`scrollY` 不动。

### 横向布局与 image 图元（M5，2026-08-18）

此前 playground 的列表每行只有一个 text 节点。真实业务单元格有缩略图、标签、多行文本、
按钮和 checkbox，而引擎缺两样东西使它根本写不出来：

1. **只有垂直流布局**。`compute_subtree` 把每个子节点固定放在
   `(padding.left, content_y)` 然后 `content_y += size.height`，没有任何横向排列手段。
   现在 `Prop::Direction`（`0` 列 / `1` 行）与 `Prop::Gap` 让容器沿主轴排列子节点，
   容器自然尺寸 = 主轴累加 + 交叉轴最大值，gap 只出现在相邻子节点之间。
   Mutation Stream 没有整数 prop 值类型，所以方向以精确的 f32 传递。
   虚拟列表恒为列流：它的 item 偏移来自 Core 的高度索引，不参与兄弟累加。
2. **image 图元没有打通**。`NodeKind::Image`、`DrawImage` 指令、Canvas2D 后端的
   `drawImage` 回放都在，但 `doper-paint` 从未为 Image 节点发出指令，也没有公开的
   `image` intrinsic 或 Shell 侧上传路径。现在 `Prop::Image` 指向一个
   `ImageBitmap` 资源，绘制时整图铺进节点矩形；未显式指定宽高时取图片自身像素尺寸。

**tradeoff：资源携带原始 RGBA 像素，而非编码字节。** 资源事务在提交边界上**同步**原子
应用，而任何编码格式（PNG/JPEG）都需要异步解码，无法参与这个事务模型。交出解码后的
像素让 Core 保持确定性，也让 worker 传输不需要额外的暂存协议，代价是传输
`width × height × 4` 字节。对列表缩略图（44×44 ≈ 7.7KB）这是划算的；大图需要一条
带异步暂存的编码字节通路，那是另一个决策。资源池按内容哈希 intern，所以共享调色板的
缩略图每张只占一份资源。

**信任边界**：`validate_image_resource` 在 Scene 提交时核对声明的宽高与像素长度是否
自洽——不核对的话，一个与后续字节不符的宽高会让解码方越界读取。

**验证**：`doper-layout` 有 row/gap/padding/负 gap 拒绝的单测；
`packages/facade/src/m5-rich-cell.browser.ts` 对**真实像素**断言横向排列与图片绘制
（含自然尺寸路径与四象限颜色，翻转或 stride 错误会直接失败）；golden 字节夹具随
abiVersion 2→3 显式重基。

### ABI 从"绊线"变成"契约"（2026-08-18）

此前 ABI 版本号只是一根绊线：每条流都做严格相等否则失败，没有协商、没有降级；唯一的
回退路径（worker → 主线程）用的是同一份 WASM，所以真正的版本不匹配没有任何恢复出路。
更根本的是**前向兼容在结构上做不到**——指令头是 `opcode u8 + flags u8 + reserved u16`，
没有长度字段，解码器遇到不认识的 opcode 无法知道该跳过多少字节，只能硬失败。

**指令自描述帧（abiVersion 4）**。`reserved` 变成 `words`：指令总字数（含 4 字节头）。
`u16` 覆盖 256 KiB，而单个资源上限是 8 MB，所以 `words == 0xFFFF` 是转义，其后紧跟一个
u32 字节长度。长度字必须紧跟在头之后而不是放在指令末尾——跳过型读者要先拿到长度才能
找到末尾，放在末尾是循环依赖（第一版就写错在这里，被"超长指令"测试逮住）。

写入端由 `Writer` 自己追踪未闭合指令并在下一条指令开始或流收尾时回填，40 个编码调用点
一处都不用改，也不可能写出一条没有长度的指令。

**跳过必须由生产方声明**。`flags` 的 bit0 是 `OPTIONAL`。这是安全性的关键：静默跳过一条
不认识的 `CreateNode` 会让之后每一条 mutation 都指向不存在的节点；而丢一条不认识的绘制
指令只损失一个视觉细节。所以未知 opcode 若未标记 OPTIONAL 仍然是硬错误。加性的绘制
指令、加性的 prop 才应该标记。

**版本策略**：接受 `>= MINIMUM_READABLE_ABI_VERSION`（即 4，引入自描述帧的版本），拒绝更旧
的流——它们没有长度字段，无法安全跳过，解析下去只会得到垃圾。更新的流一律接受，靠逐条
跳过兜底。**这是一次性的破坏**：v3 及更早的解码器读不了 v4 流；换来的是从 v4 起所有后续
版本互相可读。现在没有外部消费者，是代价最低的时机。

**收尾校验**：每条已知指令解码后必须满足"实际消耗字节数 == 头部声明长度"。没有这一条，
一个流可以声明一个长度、携带另一个，让跳过型读者和解码型读者对"下一条指令从哪开始"产生
分歧——这正是恶意流用来让解码器失步的手法。这一条是被 glyph 流的敌意输入测试逼出来的。

**可观测性**：`decode_with_report` / `decodeMutationBatchWithReport` 返回
`DecodeReport { skipped_instructions, producer_abi_version }`。降级如果没人看得见，就和
"解码器丢了数据"无法区分。跳过的指令仍计入声明总数，否则计数校验会拒绝每一次降级。

**验证**：`doper-abi` 57 个单测（含转义往返、跳过契约的两面、越界/倒退 seek、长度与载荷
不符）；跨语言 `pnpm contracts:check` 通过；6 个 golden 字节夹具与所有手写指令夹具随
abiVersion 3→4 显式重基；`doper-abi` 行覆盖 95.04%（门槛 95%）。

**降级是可见的**（frameDiagnostics v5）。Core 在 commit 与 input 两条路径上都用
`decode_with_report`，把跳过计数与观测到的最高生产方版本累加进 `CoreMetrics`，再经
`skippedInstructions` / `producerAbiVersion` 两个诊断字段浮到宿主与 playground HUD——
HUD 只在非零时显示这一行。此前这两个值在 8 条流里都是产出后即丢弃，等于没有降级可观测性；
`doper-core` 有一条端到端断言"被跳过的指令必须计数并出现在诊断字长里，而同一条指令未标记
时仍然致命"。

**worker 握手也放宽了**。它原本对 `abiVersion` 做严格相等，即使流层已经能读——那会让一次
混合版本部署在握手阶段硬失败，而流层本可以承载。现在同样按 `>= MINIMUM_READABLE_ABI_VERSION`
判定。

**回滚**：schema 的 `instructionHeader` 恢复 `reserved`、`read_header` 与 worker 握手恢复
严格相等即可，但那会同时回到"没有前向兼容、降级不可见"的状态。

### 滚动帧的绘制失效（M5 缺陷修复，2026-08-18）

反馈"PC 端滚动卡顿感明显"。先换量具：此前测的都是"甩动后骨架多久消失"，那是恢复指标；
卡顿要看引擎**实际交付帧**的间隔，而 requestAnimationFrame 采样测到的是显示器节拍，与
引擎产帧无关。playground 现在记录每帧交付时刻（`__doperFrameLog`），主线程回放耗时也
进了帧报告（`replayMs`）——没有它，一帧慢下来无法区分是 Core 出列表慢还是后端画得慢。

**实测**（1280×800，富单元格 demo，180 次连续滚轮）：引擎只交付 46 帧，帧间隔
P50 31.7ms / P95 40.4ms / P99 51.1ms，45 个间隔里 20 个超过 32ms；主线程 0 个长任务。
每帧 `dirtyPaintNodes` **恰好等于 `sceneNodes`**（377/377、769/769、489/489…），而
`layoutVisitedNodes` 只有 0–112。

**根因**：`Scene` 在拓扑紧凑化后无条件 `dirty_*.fill()`，即把所有节点在所有域标脏。
虚拟列表每次窗口移动都改拓扑，于是每个滚动帧整个 Scene 都是绘制脏。绘制引擎里那句
"只有新节点和子列表变化的父节点需要重建"的精确逻辑因此被完全架空。

**修复**：绘制域改为按 id 跨紧凑化承接——存活节点保持原有洁净状态，新建节点为脏，本批次
点名的节点为脏（属性变更落在 plan 上而非旧 Scene，不显式处理会丢失失效）。其余三个域
维持保守全填：紧凑化会重排索引，而布局/命中/语义各自依赖不同的重排语义，没有证据支持
一并放宽。结构性重建仍归绘制引擎自己判断（比对缓存子树的子节点 id 序列并向上传播）。

**效果与诚实的边界**：`dirtyPaintNodes` 从"等于全部节点"降到约 45，但**帧节奏基本没变**
（P50 31.7 → 30.0–31.6ms）。因为每帧的主导成本与脏节点数无关：显示列表仍然整份重建、
重编码、传输并全量回放约 2550 条指令，`replayMs` 呈双峰（P50≈0，P95≈29ms）。所以这是
一次正确的缺陷修复，不是卡顿的解药。

**下一步**：`DrawPicture`（按 id 引用不可变子树 Picture + 偏移）在 ABI 与后端都已具备，
但 `build_display_list` 目前把一切内联展开。纯滚动帧应当复用子树 Picture 并只改外层
变换，而不是重建整份列表——这才是帧率问题的正面攻击方向，尚未实施。

### 栅格 tile 缓存是卡顿本身（M5 缺陷修复，2026-08-18）

上一条修完绘制失效后帧率没动，于是把耗时拆开：帧报告新增 `coreMs` 与 `replayMs`——
没有这个拆分，一帧慢下来无法区分是 Core 出列表还是后端画。

**实测**（180 次连续滚轮）：Core 总计 61ms（P95 3.7ms），**回放总计 497ms（P95 30.6ms）**，
回放是 Core 的八倍。再看缓存：每帧 `rasterFrame` 都是 `hits=0, misses=8`。

**根因**：tile 的键包含图片哈希（`pictureKey:dpr:x:y:w:h`），所以**任何两张不同的画面之间
没有任何可复用的 tile**。而 miss 的处理是对每个 tile 调一次 `paint()`——即把整份约 2550 条
指令的显示列表**按 tile 重放 8 遍**再合成。滚动时画面每帧都变，于是每帧必然 8 次全量重放。
这不是"缓存开销"，是八倍的绘制工作量。

**对照实验**：关闭栅格缓存后，交付帧数 48 → 142，帧间隔 P50 30.0 → 12.1ms，
P95 42.6 → 16.7ms，超过 32ms 的帧 17 → 0，回放总耗时 504 → 72ms。

**修复**：只有当画面键与上一帧相同时才动用 tile。第一次见到一张画面直接画到目标画布，
重复出现才值得栅格化。这正是 tile 唯一可能命中的条件，其余情况下分块必然亏本。
实测 P50 30.0 → 8.4ms，回放总耗时 504 → 85ms，滚动期间分块帧数为 0。

**残留**：P95 仍有约 40ms 的长尾（对照组只有 16.7ms）。此时 Core 约 3ms、回放约 3ms，
所以这 40ms 是**在等而不是在算**——属于输入→worker→Core→传输→主线程回放这条流水线的
调度问题，尚未定位。

`?rasterCache=off` 作为 playground 的查询参数保留，便于在部署环境上直接做同样的对照。

### 时钟帧在无变化时重画整块画布（M5 缺陷修复，2026-08-18）

栅格缓存修完后仍有 P95 ≈ 40ms 的长尾，而 Core 与回放各约 3ms，所以那 40ms 是在等。

**先修量具，两次**。worker 每 60 帧才推送一次时钟指标，所以用 `frames` 差值除以时间得到的
频率恒为 60 的倍数——我据此得出的"时钟 39.8Hz"是量化假象。改为按两次推送之间的间隔计算
（每次相隔恰好 60 帧）后，真实值是 **21.8Hz、120 帧里 66 次 overrun**：方向对，程度被低估了。
`RenderClockMetrics` 因此增加 `lastRequestedDelayMs` / `maximumTimerLatenessMs` /
`maximumCallbackMs`——没有它们无法区分"定时器晚到"与"回调太慢"。回调最大 43.7ms，是后者。

**根因**：`CanvasFrameSink.advance` 在 `core.advance()` 没有产出新 DisplayList 时，仍然调用
`replayLastFrame()`，即把上一帧整份指令重画一遍。画布内容在帧之间本来就保留着，这次重画
不改变任何一个像素。按时钟阶段计时：`advance` 合计 1981ms / 120 帧（最大 35.7ms），是
`input` 阶段（471ms）的四倍，也是整个 worker 帧预算里最大的一项。

**修复**：无新画面时直接返回，不重放。需要重绘画布的场景（尺寸变化、DPR 变化、传输恢复）
本来就走各自的完整帧路径，`replayLastFrame()` 保留给它们。

**实测**：时钟 21.8 → 66 Hz，overrun 68 → 0，回调最大 43.7 → 10.7ms，
`advance` 合计 1981 → 53.8ms；交付帧数 89 → 140，帧间隔 P95 39.1 → 17.2ms，
P99 47.4 → 17.9ms，**超过 32ms 的帧 16 → 0**。

### 移动端两处阻断（M5 缺陷修复，2026-08-18）

真机打开 playground 报 `RangeError: canvas width must be positive`，且手指拖动滚的是网页
而不是列表。两条都在桌面上永远不会触发。

**1. 小数 device pixel ratio 被当作非法尺寸。** `positiveDimension` 要求整数，而逻辑尺寸是
后备存储除以 DPR。手机的 DPR 常是 2.75 / 3.5 / 2.625，这个商几乎不可能是整数——
393 × 2.75 = 1080.75 → 取整 1081 → 1081 / 2.75 = 393.09，于是每台这样的设备都在启动时被
拒绝，而错误信息还说"必须为正"，值明明是正的。桌面 DPR 通常是 1 或 2，所以从未暴露。
改为接受任意正有限值。不取整是有意的：取整会让 Core 布局用的视口与后备存储差出亚像素，
回放缩放随之漂移。

**2. `touch-action` 缺失。** 触摸屏上非被动监听器加 `preventDefault` 拦不住页面滚动：
浏览器在 pointerdown 就决定是否由合成器接管平移，而这个决定**只看 CSS `touch-action`**，
一旦接管，后续事件不再可取消。宿主在 Core 发布了触摸非被动区域时把画布设为
`touch-action: none`，与监听器 passivity 是同一个决定的两种平台表达；关闭时一并释放，
否则一块引擎已不再驱动的画布会继续压制页面自身的手势。

**验证**：移动端模拟（393×852、DPR 2.75、hasTouch）下正常启动并渲染 395 个节点，拖拽使
可见区从 0 移到 6 而 `window.scrollY` 保持为 0；host 单测覆盖小数 DPR 启动与
`touch-action` 的设置/释放。

### 惯性几乎没有：系数不对，平台还写死了（M5 缺陷修复，2026-08-18）

真机反馈"手指滑动的惯性跟 iOS 原生差别很大，没什么惯性"。两个叠加的原因：

**1. 平台是硬编码的。** `ScrollController::default()` 无条件用 `ScrollPlatform::Android`，
没有任何设置入口，所以**包括 iPhone 在内的所有设备拿到的都是 Android 档**（衰减 11.5）。

**2. iOS 档的系数也不对。** 本积分器 `v /= 1 + d·dt` 趋近于 `v₀·e^(−d·t)`，一次甩动的
滑行距离是 `v₀/d`。`UIScrollView` 的 normal `decelerationRate` 是每毫秒 0.998，即
`v₀·0.998^(1000t) = v₀·e^(−2.002t)`，所以 d 应为 **2.0**（0.99 的 "fast" 档对应 10.05）。
原值 7.5 让 2000 px/s 的释放只滑不到 300px，而 iOS 会滑约 1000px——**不到三分之一**。

**修复**：iOS 档改为 2.0 并写清推导；`CoreEngine::for_platform` 让宿主在构造时指定平台，
`WasmCore::new` 增加一个布尔参数，宿主按设备判定（iPhone/iPad/iPod，以及 iPadOS 会上报
桌面平台串因而需要"Mac + 多点触控"这条）。判定刻意保守：认不出是 Apple 的一律用较短的
Android 滑行——在读不出平台的设备上这是更安全的一侧。

**验证**：`doper-scroll` 断言 iOS 档下 2000 px/s 的释放滑行落在 900–1100px（即约 v₀/2.002）。

### Android 不是"另一个系数"，是另一个模型（2026-08-18）

上一条把 Android 的 11.5 留着没动，理由是"没有可靠换算依据"。真机反馈 Android 手感"诡异"
之后把它算清楚了，结论是：**换系数解决不了**。

AOSP `OverScroller.SplineOverScroller` 的闭式解（friction 0.015、INFLEXION 0.35、
`DECELERATION_RATE = ln0.78/ln0.9 = 2.3582`、`physicalCoeff = 9.80665×39.37×ppi×0.84`）给出
`distance ∝ v^1.74`，而指数衰减是 `distance ∝ v`。所以**单个系数只能在一个速度上对齐**：
按 2000 dp/s 校准后，500 dp/s 会滑过头 2.8 倍，8000 dp/s 又只有应有的 1/2.8——力度与响应
不成比例，这才是"诡异"的来源，不是量的大小。

**模型**：注意到 AOSP 的 INFLEXION 按定义就是"平均速度 / 释放速度"，因此
`D = INFLEXION · v₀ · T` 在所有速度上恒等成立。于是幂律 `v(t) = v₀(1−t/T)^1.857`
（`k = 1/INFLEXION − 1`）能**同时精确复现 AOSP 的距离与时长**，位置曲线
`1−(1−t/T)^2.857`，无需搬运 AOSP 的采样表。iOS 保持指数衰减——那本来就是它的真实模型。
`FlingModel` 因此成为平台配置的一部分，而不是一个系数。

**边界交接**：spline 拥有运动直到触边，越界时把当前速度交给既有的弹簧回弹，否则甩动会
直接穿过边缘。

**释放速度必须钳制**。速度估计是测量值，一个快样本就能推出手指不可能产生的速度：
浏览器测试里 400px/16.7ms 推出 24000 px/s，按 AOSP 公式那是一次 **32833px、4.9 秒**的滑行，
直接把测试的静默预算撑爆。真实工具包都会钳，AOSP 公布的是
`ViewConfiguration.getScaledMaximumFlingVelocity` = 8000。iOS 没有同类公开常量，那一侧的
8000 是防抖动估计的护栏而非平台值，已在代码里注明。

**验证**：`doper-scroll` 断言 Android 档在 500 / 2000 / 8000 px/s 三个速度上滑行距离与 AOSP
闭式解的误差均小于 2%（58.3 / 647.4 / 7186.4 px），并断言"四倍释放速度滑行超过八倍距离"
这一 spline 特有性质；另有触边交接与超速钳制两条。手感只有这些能自动化断言，所以锁住它们。

### 画布尺寸变化无人处理（M5 缺陷修复，2026-08-18）

把窗口从 1280 缩到 700：画布后备存储仍是 934×494，CSS 宽度变成 666，内容被横向压到
0.71×，而且**没有产生任何新帧**——引擎从头到尾不知道尺寸变了。手机旋转屏幕是同一条路径。

这不是回归，是一直缺失：`CoreEngine::set_viewport` 存在，但**宿主从未调用过它**，
worker 模式下还需要一条跨线程消息，而协议里没有。

**三处补齐**：

- `set_viewport` 从"只改约束"改为返回替换帧。只改约束什么都不会发生：画布继续显示按旧
  盒子测量的内容，在新盒子上被裁掉而不是重排。这与同文件 `set_device_pixel_ratio` 的
  既定模式一致。
- worker 协议增加 `doper:resize`（版本 7→8），worker 收到即刻应用而非入队——画布在屏幕上
  已经是新尺寸了，排队意味着这期间每一帧都是拉伸的。
- 宿主暴露 `resize(width, height)`，并**默认用 `ResizeObserver` 跟随画布自身的盒子**。
  每个 canvas 应用都会在窗口缩放或手机旋转时撞上这件事，而漏掉 resize 不会大声失败，
  只是把上一帧拉伸到新盒子。让默认行为正确，`resize` 保留给自己管布局的调用方。
  调整尺寸会清空画布，所以无需重排时也必须把已有帧放回去——不会有别的时机做这件事，
  因为"无变化的时钟帧不再绘制"。

**验证**：浏览器实测 1280→700 后后备存储与 CSS 宽度一致（666/666）、产出新帧、内容重排且
行背景铺满新宽度；host 单测覆盖两侧尺寸的同步与非法入参。

### 编辑崩溃与横向滚动失效（M5 缺陷修复，2026-08-18）

**1. 在多个输入框间来回点击会让 worker 崩溃。** 报错是
`render Worker failed: render clock callback failed`，看不出根因——时钟只在
`cause instanceof Error` 时保留原信息，而 wasm-bindgen 抛的是 `JsValue`，不是 `Error`
实例，于是真正的消息被包装文字盖掉了。补上非 Error 的描述后立刻可读：
`Core frame rejected: EditTransactionsNotDrained`。

根因在 `inputBatch`：循环里每批都调 `core.input()`，而 `core.input()` 要求反向流已排空；
`emitEventTransactions` 放在循环内，`emitEditTransactions` 却留在循环外。同一帧内第一批
产生编辑事务、第二批就会被拒。点击输入框会产生焦点/caret 事务，而宿主把多个指针事件
合并进同一帧——两者相遇即崩。改为每次 `core.input()` 之后即排空，循环外的那次因此变成
多余并删除。

**2. 内容比视口宽却无法横向滚动。** `extents` 只看滚动节点的**直接子节点**，取
`offset + size`。而 item 的 size 已被显式 `width` 钳过：一行声明 359 宽，内部的
checkbox/缩略图/正文/金额/按钮累加约 598，金额列和按钮整个被切掉，横向拖动却毫无反应。
改为遍历子树，按 `scrollWidth` 的语义取内容触及范围的并集。

**为什么不存进布局快照**：先尝试给 `LayoutSnapshot` 加一条 content-size 通道，被
"增量与全量布局必须一致"的属性测试当场否决——增量布局在**固定尺寸祖先处停止向上传播**，
而内容触及范围恰恰是必须穿过该边界的量。两者本质冲突，所以放在滚动侧按需计算：只有滚动
节点需要它，且只覆盖已物化的子树。

**验证**：`doper-core` 断言"每个子节点单独放得下、但累加偏移超出行盒"这一真实形状下横向
可滚（单个超宽子节点会被父约束钳住，复现不出问题）；host 单测断言一批多条事务时反向流
逐条排空。移动端模拟实测横向拖动可以把金额列和按钮滑出来。

### caret 位置与双击分词都错（M5 缺陷修复，abiVersion 4→5，2026-08-18）

反馈"编辑 demo 的 caret 渲染位置有问题，双击分词选择有问题"。先量：用 caret 闪烁做像素
差分（按 `Home` 强制光标到 0，260ms 采样 6 帧取每列 max−min），文字墨迹从画布 x=50 开始，
caret 画在 x=58——**与命中测试无关的常量偏移**，说明错的是停靠点本身。

**根因**：`approximate_caret_stops` 对每个字符一律用 `font_size * 0.6`。14px 下是 8.4px，
而中日韩全角字形推进 14px，误差随下标累积。**两个 bug 同源**：`place_caret` 用
`nearest_caret_offset(&carets, local)` 把指针映射成文本偏移，用的是同一套停靠点——所以
双击落在错误的偏移上，`word_range_utf16` 再据此选错词。

**修法**：宿主把浏览器真实测量的逐码点推进送进 Core。`systemTextMetrics` 流的
`UpsertSystemTextMetric` 增加 `advanceCount: u32` + 变长 `advances`，该指令从定长变为变长
（`fixedBytes: null`，`minimumBytes: 24`）。表项在 abiVersion 5 是位置型的 `f32[]`，在
abiVersion 6 改为 `(codePoint: u32, advance: f32)[]`——原因见下一条。

**只测可编辑的文本**。逐码点测量是每个**不同**码点一次 `measureText`；对列表 demo 那样
每帧几百行文本全量测量会毁掉刚优化完的滚动热路径。宿主因此在 `preflightResources` 里跟踪
`ConfigureEditable` 点名过的节点（reconciler 不会取消可编辑，条目随节点一起消失），只为
这些节点用到的 string/style 对请求推进；一个节点**变成**可编辑时，即使资源对没变也强制
重测一次，否则 Core 拿到的永远是上一次省略了推进的度量。

**Core 侧按码点建表，不按位置查表**。推进是位置型的、对着 Scene 字符串测的；但 caret 要
对着**实时编辑值**放置，而实时值在 Shell 往返之前一直领先于 Scene 字符串——位置型查表会
在每一次按键上错位。所以 Core 把 (Scene 字符串, 推进数组) 归约成 `char -> advance` 表。
代价是丢掉字距调整（fallback 路径本来就没有整形器），换来的是刚敲进去、还没被测量的码点
只有那一两帧退回估算，其余全部正确。

**验证**：`doper-core` 断言同一个点击位置在"有测量推进"下解析到偏移 3、在"无测量推进"下
解析到 4（四个全角字 16px vs 估算 9.6px，第四个停靠点已差出一个字形）；host 单测断言
普通文本对不带推进、节点变可编辑后强制重测、已带推进的后续帧不再重测；backend 单测断言
每个不同码点只测一次且换行推进为 0；`doper-abi` 断言超限与超出载荷的 advance 计数都被
拒绝；6 个 golden 字节夹具随 abiVersion 4→5 显式重基（其中 replay-recording 内嵌了度量流，
因此同时增长了推进载荷）。

**残留风险**：整形路径（有真实字体资源时）不走这条 fallback，不受影响；未被测量的码点
仍用 `font_size * 0.6`，在 Shell 往返延迟很大的场景下可见一帧抖动。回滚是把
`advances` 字段留在线上但让宿主一律传空数组，Core 自动退回估算。

### IME 预编辑从来没被测量过（abiVersion 5→6，2026-08-19）

上一条落地后，反馈"编辑的 IME 状态也需要处理"。查下来是同一个洞的另一半，而且更严重。

**三处症状一个根因**。合成期间的预编辑文本只存在于 Core 的编辑会话里（`edit_overrides`），
它**永远不会成为 Scene 字符串**——Shell 只在 commit 时才拿到值。而上一条的推进表是按
(stringId, styleId) 对着 Scene 字符串测的，所以预编辑的那几个字一个都没被测量，全部退回
`0.6 × font_size`。受影响的不止 caret：

- 组词下划线（`EditorDecorationKind::Composition`）走 `append_range_decorations(&carets, ...)`；
- caret 走 `closest_caret(carets, ...)`；
- **IME 候选窗位置**走 `editor_character_rects(&carets, requested, geometry)`，也就是
  EditContext 的 `updateCharacterBounds`。

三者共用同一套停靠点。16px 的全角字实测宽 16，估算给 9.6——**候选窗宽度差 40%**，会直接
飘到字形外面。

**推进表改成按码点索引，不按位置索引**。位置型表达式上更精确（能带字距调整），但它把表
绑死在 Scene 字符串上，而 caret 要对着实时编辑值放置：按键往返期间两者差几个字符，合成
期间两者差整个预编辑串。所以 `advances` 从 `f32[]` 改为 `(codePoint, advance)[]`，按码点
升序且不重复（否则同一张表会有多种字节序列，golden 夹具和跨语言往返就锁不住）。Core 侧
因此**变简单了**：不再需要回查 Scene 字符串把数组和字符 zip 起来，直接 collect 成表。
代价是丢掉字距调整——fallback 路径本来就没有整形器，不构成回归。

**宿主在合成命令到达 Core 之前测量**。`CanvasFrameSink.input` / `inputBatch` 解码输入流，
取出 `updateComposition` / `commitComposition` 的文本，把新码点并进该资源对的
`extraCodePoints` 再重测。三条约束：

- **只在有可编辑节点时解码**（`#editableNodes.size > 0`）。滚动 demo 一个可编辑节点都没有，
  热路径完全不受影响。
- **只在预编辑引入了没见过的码点时**才重测并调 `set_system_text_metrics`，即最多每个新字
  一次，而不是每次按键一次。
- 每个资源对保留的预编辑码点有上限（4096）；溢出只是让极少数字退回估算，不会无限增长。

那次度量帧的显示列表**被正常接受而不是丢弃**：增量回放是对着上一份已接受的列表做差分的，
跳过一份会让回放器失步。紧随其后的输入帧会立刻覆盖这些像素。

**验证**：`doper-core` 用 `RequestCharacterBounds` 断言合成 U+5019（该码点不在 Scene 字符串
里）后候选窗矩形是 left=32 / width=16；把该码点从推进表里删掉后同一断言给出 width=9.6，
即这条测试确实能鉴别。host 单测断言预编辑触发一次重测、同一码点再来不重复通知 Core；
backend 单测断言 `extraCodePoints` 与字符串码点合并去重且按码点升序；`doper-abi` 断言代理对、
超范围码点、乱序与重复表项都被拒绝；6 个 golden 字节夹具随 abiVersion 5→6 显式重基。

**残留风险**：真机 IME 行为属于平台资格认证，仓库门禁只覆盖协议与几何。合成期间宿主会
多产一帧（仅在出现新码点时），在极低端设备上可能可见。回滚是宿主停止传 `extraCodePoints`，
线上退回"只测 Scene 字符串"，即上一条的行为。

### 聚焦即缩水 40%：测量没用上同一张表（2026-08-19）

反馈"编辑的时候字体老是跳来跳去"。

**根因**在 `measure_system_fallback` 的第一个条件：

```rust
if !self.edit_overrides.contains_key(&node)
    && let Some(metric) = self.system_metrics.get(&(run.string_id, run.style_id))
```

只要节点处于编辑会话中，浏览器实测的 `max_line_width` 就整段不用，退回
`approximate_fallback_measure`——而它按 `字符数 × font_size × 0.6` 算宽。全角文本因此在
**点进输入框的一瞬间**从实测宽度缩到 60%，失焦再弹回来。16px 的"中文"是 32 → 19.2。
这跟前两条是同一个洞的第三面：推进表建好了，caret 用了，命中测试用了，**布局测量没用**。

**修法**两条：

1. 编辑会话存在、但会话值**仍等于 Scene 字符串**时，继续用浏览器实测值。聚焦本身不改变
   任何东西，所以聚焦/失焦不再有任何跳变——这覆盖了"点进去还没打字"的全部时间。
2. 真正开始编辑后，`approximate_fallback_measure` 按同一张逐码点推进表求和，而不是
   `0.6em` 估算。未测量的码点仍退回估算。

字符串比较是每次测量 O(n)：可编辑节点很少、文本很短，不在滚动热路径上。

**残留的不连续**：实测值是 `measureText(整行)`（含字距调整），编辑期是逐码点求和（不含）。
两者在全角文本上差异为零，在长拉丁文本上是几像素级，远小于此前的 40%。要彻底消除需要
在编辑期也做整行测量，那会把每次按键变成一次 `measureText`，暂不做。

**验证**：`doper-core` 断言实测 32 → 聚焦后仍 32 → 插入一个全角字后 48。把测量路径改回
旧行为复跑，聚焦这一步就给出 19.2，即这条测试能鉴别。

### 通用族名被加了引号，整块画布画的是默认衬线体（2026-08-19）

反馈"focus 之后字体变了"，附了两张截图：一张整块画布是衬线体，一张是无衬线。

**实测**（Chromium，13px，`measureText("canvas")`）：

| font 串                      | Latin 宽度 |
| ---------------------------- | ---------- |
| `400 13px "sans-serif"`      | 35.369     |
| `400 13px "Inter"`（不存在） | 35.369     |
| `400 13px serif`             | 35.369     |
| `400 13px sans-serif`        | 41.190     |

**根因**：后端用 `JSON.stringify(family)` 拼 `font` 串。CSS 里通用关键字**不能加引号**——
加了就变成一个没有任何字体叫这个名字的族名，浏览器于是静默回退到默认字体（衬线）。JSX 层
在没给 `fontFamily` 时默认填 `"sans-serif"`，所以**整站 demo 的文本一直画的是衬线体**，而不是
它声明的无衬线。同样的写法还会把 `Inter, sans-serif` 这样的族列表整个引成一个不存在的名字。

**修法**：`cssFont(weight, fontSize, family)` 按逗号拆列表逐项输出：通用关键字裸出；已带引号
的保留；符合 CSS 标识符的裸出；其余才加引号。空列表回退到 `sans-serif`——因为**非法的
shorthand 在 Canvas2D 上是空操作**，会让上一次绘制的字体悄悄套用到这一次。

**验证**：`backend-canvas2d` 单测钉住字符串形态；另加一条**浏览器**回归测试，因为单测只能钉
字符串，真正坏掉的是浏览器怎么解析它——断言引号形态与"命名一个不存在的字体"测得完全一样
（这就是缺陷本身），而 `cssFont` 的输出与裸通用关键字一致。

**没有复现的部分**：我没能复现"聚焦触发切换"这个转变本身。排除了两个候选——`<canvas>` 元素
与 `OffscreenCanvas`（栅格 tile 走后者）对同一 font 串解析完全一致；元素的 CSS `font-family`
也不影响解析。修复后两种状态都会解析为真正的 `sans-serif`，所以"其中一态是衬线"这个现象
本身消失了，但如果仍能观察到聚焦前后字形变化，说明还有第二个原因未定位。

### 编辑器外点击不会失焦（2026-08-19）

反馈"在文本框外点击时没有 blur"。确实没有：会话只在点中另一个可编辑节点时才切换，点空白处、
点画布上别的内容、点页面上画布以外的地方，编辑会话都会一直留着——软键盘和 caret 也就一直在。

**为什么不能靠事件事务判断**：Core 只在命中到节点时才产出事件事务
（`let Some(hit) = hit else { continue }`），所以点在空白处根本没有事务回到宿主。

**修法**是两条同步规则，都在宿主侧：

1. 画布上的 `pointerdown`，若落在**当前编辑器的 control bounds 之外**就结束会话。边界本来就随
   editing geometry 回到宿主，判定是同步的，和原生 input 失焦的时机一致。几何还没到位时**不**
   失焦——凭猜测结束一个其实点在编辑器内的会话，比多留一帧更糟。
2. `document` 上的捕获阶段 `pointerdown`，落在画布之外就结束会话。用捕获是为了让页面上某个
   `stopPropagation` 的处理器无法把会话卡死。无障碍镜像容器和输入代理是引擎自己的表面，
   不算"外面"——代理挂在 `document.body` 上而不在画布里，因此 `NativeTextInputBridge`
   新增 `ownsNode` 供宿主排除。

**两条路径原本还不等价**（追加修复）。EditContext 模式下 `deactivate()` 只做了逻辑收尾，
从不把 `canvas.editContext` 解除；而 EditContext 挂在一个仍持有 DOM 焦点的元素上，OS 文本
服务就仍然处于工作状态——软键盘不收、IME 仍武装在一个用户已经点开的框上。点画布**外面**时
浏览器会自己把焦点移走，掩盖了这一点；点画布**里面**别的地方时不会。所以 `activate` 挂载、
`deactivate` 解除，两侧收敛到同一状态。DOM 焦点仍留在画布上，键盘导航与无障碍焦点不受影响。

**验证**：浏览器测试通过**输入代理的焦点**而不是引擎内部状态来断言——失焦必须真的传达到 OS
文本服务，只断言引擎状态会在"键盘还挂在用户已经点开的框上"时通过。覆盖：框内按下→代理获得
焦点；画布空白处按下（Core 无事务）→失去焦点；画布外的按钮按下→失去焦点；再点回框内→重新
获得焦点。另一条断言两侧结束会话后 `canvas.editContext` 都为 null。把三处改动分别去掉复跑，
对应断言都会失败。

### 栅格 tile 缓存会改变渲染结果（2026-08-19）

反馈"focus 之后文字明显不一样"。前几轮我在 headless 里怎么测都是逐像素相同，直到拿到一段
真机录屏，逐帧量化才定位。

**证据**：把录屏拆成 209 帧，量**纯文本标题**（永不进编辑态的 text 节点）的墨迹右边缘：

```
帧   1 -> 778      帧 128 -> 784      帧 152 -> 784
帧  88 -> 784      帧 129 -> 778      帧 156 -> 778
帧 127 -> 778      帧 130 -> 784      帧 161 -> 784
```

不是"聚焦前后两个状态"，而是**逐帧在两套栅格化之间来回跳**：整行宽度差 6px（775→781），
字重和字距同时变。放大对比可以看到同一串 `caret` 一套边缘更硬、一套更平滑。

**根因**：整条渲染链路里**逐帧分支只有一个**——栅格 tile 缓存的
`repeated ? 走 tile : bypass`。tile 是临时 `OffscreenCanvas`，浏览器对它的文本栅格化与对
正在合成的画布并不一致。于是"这一帧走不走缓存"这个纯缓存决策，改变了画出来的像素。
headless 复现不了，是因为两侧都是软件栅格化。

**这违反了缓存的基本约定**：缓存不得改变渲染结果。

**修法**：`rasterCache` 由默认开启改为**默认关闭**（选项保留，可显式打开）。这不只是回避
问题——它已经**没有收益可言**了：

- tile 按产生它的 picture 作键，两张不同的 picture 之间没有任何可复用的 tile；
- 而"picture 没变"的帧现在根本不会重绘（`advance()` 无变化直接返回 null），
  所以重复的 picture 压根到不了回放器。浏览器测试实测：显式打开缓存后，
  **没有任何一帧命中 tile**，全部 bypass。

**验证**：浏览器测试断言默认配置下任何一帧都不带 `rasterFrame`（即不经过缓存），以及显式
打开后链路仍然接通。断言的是**决策**而不是像素——headless 两侧都走软件栅格化，逐像素断言
在这里恒真，抓不住回归。要重新默认开启，必须先拿出"tile 路径与直绘路径逐像素相同"的证据。

### 密码框 caret 落在最后一个圆点右边（2026-08-19）

和 IME 预编辑是同一类：**Core 的显示值里有 Scene 字符串里不存在的码点**。

密码会话的显示值是 `"\u{2022}".repeat(grapheme_count)`（`editing.rs:235`），U+2022 不属于任何
字符串资源，宿主因此从未测量过它，caret 停靠点对每个圆点退回 `font_size * 0.6`。16px 下
估算 9.6px 而实测圆点推进更窄，7 个字符累积下来 caret 明显甩在最后一个圆点右侧。

**修法**复用为 IME 建的 `extraCodePoints` 通道：宿主在 `preflightResources` 里已经能看到
`ConfigureEditable` 的 flags，password 是 `1 << 2`；带该位的节点，其 string/style 对的额外
码点集合里加入 U+2022。重测触发条件同时扩了一条——"该对的额外码点集合发生变化"，否则
一个已经测过的对在变成密码框后不会重测。

预编辑码点是在两次提交之间到达的，所以 `measureComposition` 里把它们并进已提交的集合并
回写，避免下一次提交重复测量同一批码点。

**验证**：host 单测断言带 password 位时推进表含 `[0x2022, 10]`、去掉该位后表里不再有它。
把加入遮罩那一行改成恒假复跑，断言失败。

### 富单元格暴露的能力缺口

新 demo 每行约 18 个节点（此前 3 个），1280×800 视口下 20 行物化 = 357 个 Scene 节点。
它暴露出以下尚未解决的问题，按影响排序：

1. **滚动时整场景被标记重绘**。稳态慢速滚动实测 `dirtyPaintNodes` 每帧都等于
   `sceneNodes`（377/489/863/583/619/637/619），即使 `layoutVisitedNodes` 为 0。
   子树缓存命中在累积（454 → 1361），说明缓存有效，但脏标记仍是全量的。简单文本行
   时该值是 1。Core 拥有滚动，理应平移 Picture 而非重绘，这是下一个要查的性能问题。
2. **快速甩动后的骨架时间随每行节点数上升**：约 280ms（3 节点/行）→ 约 533ms
   （18 节点/行）。物化一个窗口的成本正比于窗口内节点数，往返因此变长。
3. **没有交叉轴对齐**。row 的子节点一律贴主轴起始边，40px 缩略图与两行文本无法居中对齐。
4. **没有内联富文本**。一个 text 节点只有一种样式，同一行内混排需要多个节点手工定位，
   而各 run 的宽度 Shell 拿不到（`useLayoutValue` 是异步的）。
5. **没有圆角与描边**。demo 里 checkbox 的"边框"是外层色块套内层白块做出来的，
   tag 与按钮都是直角矩形。
6. **row 的子节点按容器内容盒而非剩余空间约束**。中间文本列需要显式宽度，写不出
   "占满剩余空间"。

---

---

## 10. 缓存体系

| 级别                   | 内容                                     | 失效条件                         | 位置      |
| ---------------------- | ---------------------------------------- | -------------------------------- | --------- |
| **Layout Cache**       | 节点在给定约束下的 size                  | 约束变化或自身 dirty_layout      | Core      |
| **Picture Cache**      | 子树的 DisplayList 片段（不可变）        | 子树 dirty_paint                 | Core      |
| **Raster Cache**       | tile / picture 的位图                    | picture 变更、DPR 变更、内存压力 | Backend   |
| **Text Shape Cache**   | (str, font, size) → advance + glyph 序列 | 字体加载完成                     | Core      |
| **Text Metrics Cache** | 系统字体 `measureText` 结果              | 字体、DPR 或最后一个引用释放     | Core/Host |

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

Core 与 Backend 之间另有 schema 生成、版本化的 `DOPG` Glyph Resource Batch。它只
传输 `DrawGlyphRun` 所引用 span 的增量 define/release，包含受限灰度 bitmap、DPR、
placement 和 paint 引用；Host 必须完整校验并预检资源生命周期后原子安装，再回放
DisplayList。bitmap 面积、批次字节数和记录数均有 fail-closed 上限，不能把像素数据
塞进逐 draw 的 WASM→JS 调用。若 glyph batch 或显式字体路径失败，整段文本走宿主
fallback，不允许一半 atlas、一半 fallback 造成 caret/advance 分歧。

实现状态（2026-08-16）：`doper-text` 已建立独立的无 unsafe Core 基础，使用
`swash` 完成显式 SFNT 字体的 LTR shaping，使用 UAX #14 数据完成基础换行，并输出
UTF-8/UTF-16、grapheme、cluster、glyph、line 与 caret 映射；Text Shape Cache 和
灰度 outline glyph atlas 均使用可观测的字节预算 LRU。公开 `createFont` 会复制并冻结
解码后的 TTF/OTF/TTC SFNT 输入，`Text`/`EditableText` 通过独立 `Font` Scene 属性选择
显式路径，不改变既有 `TextStyle` ABI。Core 已在布局阶段生成真实 span 和
`DrawGlyphRun`，WASM 暴露 drain-only `take_glyph_resources`；Host 将同一帧的普通资源
与 `DOPG` 完整预检后原子安装，Canvas2D 在资源安装阶段把灰度 mask 着色到独立 surface
再回放。未 drain 的 DOPG 会阻止下一帧，DPR 变化会释放旧 span、清空 atlas 并生成新
资源。Core 侧字体解析、缺字、栅格或批次预算失败时整段走系统字体 fallback；Host
侧校验或 surface 准备失败则拒绝整个资源事务和该帧，不得保留半安装状态。

Core 输入仍只接受解码后的 SFNT；公开异步 `loadFont` 在宿主边界按 magic 处理
TTF/OTF/TTC、WOFF1 与 WOFF2。网络响应和解码结果受同一 8 MiB 资源上限约束，WOFF1
按照 W3C 容器目录进行完整范围/对齐/重叠检查并通过 `DecompressionStream` 有界解压，
WOFF2 在头部预检后才动态加载 decoder-only WASM，也允许受控宿主注入等价 decoder。
加载、解码、取消、格式与环境能力错误有稳定错误码；失败的 Promise 不会生成半有效
`DoperFont`。decoder-only 模块不进入默认同步入口，也不计入产品 Core WASM。

系统字体测量使用 schema 生成、版本化的 `DOPT` System Text Metrics Batch。Host
在 Mutation Stream 提交前，从事务后的 UTF-8 string/TextStyle 资源快照中按
`(string_id, style_id)` 去重，通过 Canvas `measureText` 测量每个 hard line 的最大
逻辑宽度；DOPT 与同一 Mutation Stream 一起进入 WASM，二者都完整解码和预检后才
允许 Scene 提交，Core 在 layout 前原子安装度量。Host 维护节点拓扑和 pair 引用计数，
只对首次出现的 pair 发送 upsert，最后一个引用消失时发送 release；Core 缓存有
262,144 项硬上限，畸形、重复、非有限或超限输入均 fail closed。字体集合
`loadingdone` 和 DPR 变化会重测所有 active pair，通过独立 metric-only 入口只重排
受影响文本节点。DOPT 也进入 `DOPR` 录制回放，时间或平台字体状态不会在回放时被
隐式重新采样。

系统 fallback 的绘制与测量保持同一 hard-line 模型：Canvas2D 按编码 line-height
逐行 `fillText`。首期不为系统字体实现引擎内 soft wrap；受约束的宽度会被布局 clamp，
但不会伪造浏览器未执行的换行。需要确定性 soft wrap、caret cluster 或跨后端一致
排版时必须显式加载字体。

当前能力矩阵：

| 输入/能力  | 显式字体路径                                                                      | 系统字体 fallback                                   |
| ---------- | --------------------------------------------------------------------------------- | --------------------------------------------------- |
| 字体格式   | `loadFont` 解码后的 TTF/OTF/TTC（源可为 SFNT/WOFF1/WOFF2）                        | 浏览器可解析的 CSS family                           |
| 方向与脚本 | LTR；Latin、CJK 等以字体实际 glyph 覆盖为准；检测到 RTL/方向控制符即整段 fallback | 由浏览器 shaping/bidi 决定                          |
| 换行       | hard line + UAX #14 基础 soft wrap                                                | hard line；首期无 soft wrap                         |
| 栅格       | 单色 outline mask，DPR 重建                                                       | `fillText`；彩色/合成字体由浏览器决定               |
| 映射       | UTF-8/UTF-16、grapheme、cluster、glyph、line、caret                               | 只保证整段尺寸与 hard-line geometry                 |
| 确定性     | Core 输出确定，可录制输入                                                         | DOPT 记录测量结果后可回放；首次实测仍受平台字体影响 |

字体缺失、缺 glyph、RTL、彩色/非 outline glyph、解析/shape/raster 或 DOPG 预算失败
都必须整段 fallback，不能混合两条路径。完整 bidi、复杂脚本视觉导航和 CJK
避头尾不在首期显式路径的承诺内，进入后续独立范围。

真实 Chromium 门禁会加载真实 SFNT，通过公开 API 进入 WASM Core，禁用 `fillText`
后断言 DOPG glyph bitmap 经 Canvas `drawImage` 产生非透明像素；系统字体门禁覆盖真实
`measureText`、hard-line replay、字体/DPR 刷新、引用释放和 metric-only 增量重排。
接入后的产品 Core WASM 为 283,124 bytes gzip，低于 300 KiB 代表性文本包络和
400 KiB 产品上限。

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

`EditableText` 的 Shell→Core 状态同步由 `ConfigureEditable` mutation 显式携带
authoritative revision、只读/密码/多行 flags 与 grapheme 上限；文字本身仍由同帧的
`SetTextRun` 引用。首次创建建立会话，严格更新的 revision 才能校正活动值；相同
revision 的确认不清空 undo，较旧 revision 被忽略且不得覆盖新输入。配置、字符串
资源和 Scene 结构在同一个 mutation commit 后统一校验，派生失败按 Core poison 规则
关闭该实例，Host 回退并用完整快照恢复。

Core→Host 使用独立的有界、版本化 Edit Transaction Stream。记录携带 node id、
base/new revision、delta、selection、composition 与 transaction kind；Host 必须先完整
验证一批再交给 controller。Worker 在本地完成绘制后把该批转发主线程，主线程路径直接
消费同一编码。反向流拥塞时不得丢事务或只保留末尾 delta：先合并为每节点的完整状态
快照，仍超预算则触发可恢复 Worker 降级。密码事务可交给对应业务回调，但不得进入
Replay Recording、通用 frame report、devtools 或错误文本。

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

### 命中语义边界（M4-A 决策，2026-08-16）

- **重叠命中**：多个节点覆盖同一点时，按 Scene 拓扑顺序取「最后绘制者」为
  target。当前不提供 z-order、`pointer-events` 关闭命中或不可见节点跳过语义；
  引入其中任何一项都是显式的 design.md 范围决策，不允许在实现中隐式加入。
- **帧快照命中**：同一事件批内的全部事件针对上一提交帧的 `HitIndex` 几何做
  命中；批内滚动或几何变化在下一次 commit/derived-state 刷新后才影响命中。
  这是契约行为：它保持事件批的原子回滚语义与确定性回放，并与浏览器「事件
  针对已呈现帧」的直觉一致。需要批内即时几何的场景必须拆分事件批。
- **事件种类**：Core 事件流当前只承载 pointer/click/wheel。keyboard 走编辑
  输入协议（见 11.1），focus 语义随 M4-D 语义树引入；两者都不伪装成命中事件。

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
