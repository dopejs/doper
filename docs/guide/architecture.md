# 架构概览

## 两侧所有权

```
TSX / hooks          →  Mutation Stream  →   Scene / Layout / Paint
（TypeScript Shell）      二进制、批量        （Rust Core，wasm）
                                                    ↓
Canvas2D 回放器      ←   DisplayList      ←    Picture
```

**Shell 拥有组件树，Core 拥有 Scene。两者不共享可变对象。**
所有跨界通信都是版本化的二进制流：小端、四字节对齐、指令化，接收方在访问内存前完成
opcode、长度、对齐、ID 与算术校验，畸形输入被原子拒绝而不是部分应用。

这条边界不是性能优化，而是正确性边界：即使字节通常来自本项目自己的编码器，解码器也按不可信
输入对待，并有 fuzz 覆盖。

## 双时钟

UI 时钟（主线程）与渲染时钟（Worker）相互独立：

- 主线程采集输入、跑组件树、提交 Mutation 帧。
- Worker 驱动滚动物理、动画、布局与合成。

**滚动稳态不调用 Shell。** 缺失的数据用占位符渲染，在后续帧补建。因此主线程被业务代码
阻塞 200ms 时，滚动与动画仍然连续——这个场景有自动故障注入测试守护。

## 降级链

能力探测按顺序选择传输路径，三档功能等价：

1. **SharedArrayBuffer** —— 需要跨源隔离（COOP/COEP）
2. **postMessage** —— 无 SAB 时
3. **主线程 Canvas2D** —— 无 Worker / OffscreenCanvas 时

```ts
const root = await createHostedCanvasRoot(canvas, {
  transport: { preference: "sab" }, // 可选偏好，不满足时仍会降级
});
console.log(root.mode); // "sab" | "post-message" | "main-thread"
```

本站的 [Playground](/playground) 就是活例子：GitHub Pages 无法下发 COOP/COEP 响应头，
所以线上运行在 postMessage 路径，页面顶部的 transport 标记会如实显示。

## 失效模型

**prop 语义决定失效域**，调用方不手动标脏，也没有 `forceUpdate` 逃生口。

每个属性在单源 schema 中声明它影响布局、绘制、命中还是语义。改一个 `opacity` 不会触发重排；
改 `width` 会。脏位图按域维护，`onFrame` 会把各域的脏节点数暴露出来。

这个选择是"激进最窄失效 + 属性测试兜底"：增量渲染结果必须与全量渲染逐像素一致，
差分测试会把反例收敛到最小失败用例。

## Scene 表示

Core 内的 Scene 是 SoA（结构体数组转数组的结构体）：

- 节点 ID 含**代际**，槽位复用不会让过期 ID 重新生效。
- commit 后保持**拓扑有序**：父节点永远排在子节点前。
- 结构编辑每次 commit 紧凑化一次，而不是每次 mutation 一次。
- 布局结果用双缓冲 SoA 批量比较，热路径上没有每节点闭包或监听器分配。

## 后端可插拔

Core 输出扁平的二进制 DisplayList，后端只是回放器。Canvas2D 后端是一个吝啬分配的
typed-array 循环——**每次绘制都调一次 wasm→JS 不是可接受的渲染路径**。

同一份 DisplayList 也喂给隔离的 wgpu 原型，两者输出做像素差分。
是否采用 WebGPU 是数据决策，见 [ADR-0006](/adr/0006-webgpu-backend-decision)。

## 确定性

时间、随机源与输入流都可注入或可回放，Core 输出不依赖线程调度顺序。
`DOPR` 归档按原序录制 Mutation 与 Input 流，可脱离浏览器在 headless 环境确定性重放——
线上问题因此能在本地复现，敏感编辑流显式跳过录制。

## 深入

完整的算法、数据结构与验收口径见[技术设计文档](/design)。
