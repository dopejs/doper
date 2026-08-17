# 事件与命中测试

## 采集与命中分离

主线程用 `{ passive: true }` 监听 pointer/wheel/touch。滚动相关事件**只把 delta 与时间戳
写入共享通道，不做命中测试、不触发 setState**。

命中测试发生在 Core：基于世界 AABB 的 BVH 随 Scene 增量维护（拓扑变化则重建，几何变化只 refit），
命中后构建 root→target 路径，通过反向流回传 Shell。

BVH 与朴素线性实现有属性测试保证结果一致——优化路径始终有可差分的 oracle。

## 三阶段传播

事件模型对齐 DOM：capture → target → bubble。

```tsx
<container onClickCapture={(event) => log("outer capture", event.eventPhase)}>
  <container
    onPointerDown={(event) => {
      event.preventDefault();
      event.stopPropagation();
    }}
  />
</container>
```

可用 handler：`onPointerDown`、`onPointerUp`、`onPointerMove`、`onPointerCancel`、
`onClick`、`onWheel`，每个都有对应的 `*Capture` 版本。

`DoperEvent` 提供 `target`、`currentTarget`、`eventPhase`、画布局部逻辑坐标 `x`/`y`、
`deltaX`/`deltaY`、`buttons`、修饰键、`preventDefault()`、`stopPropagation()`、
`stopImmediatePropagation()`。

## preventDefault 的时序问题

passive 监听器不能调用 `preventDefault()`。这是必须显式处理的正确性点，而不是可以糊弄过去的细节。

解法：需要阻止默认行为的区域（例如内部可滚动区）由 **Core 预先计算**并把「非 passive 区域矩形」
同步回主线程；主线程据此对这些区域改用非 passive 监听，并在命中区域时**同步**调用
`preventDefault()`。因此不存在依赖异步回传的竞态。

## 命中语义边界

当前语义是刻意收窄的，避免隐式行为：

- **重叠命中**取「最后绘制者」为 target；暂不提供 z-order、`pointer-events` 关闭命中
  或不可见节点跳过语义。引入其中任何一项都需要显式的设计决策。
- **按帧快照命中**：同一事件批内的所有事件针对上一提交帧的几何做命中。
  批内滚动改变几何要到下一帧才影响命中——这保证了事件批的原子回滚语义与确定性回放。
- 键盘输入走[编辑输入协议](/guide/editing)，不伪装成命中事件。

在 [Playground 的事件演示](/playground#/events)里可以看到实时的三阶段传播日志。
