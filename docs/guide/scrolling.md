# 虚拟滚动

## 为什么在引擎里做

DOM 虚拟列表的长尾问题来自：滚动事件要回到主线程 → 触发 setState → diff → 重排。
主线程一忙，帧就掉。

doper 把窗口计算放进 Core：滚动稳态**完全不调用 Shell**。Shell 只负责按 Core 规划的
预热窗口物化可见区间；数据没准备好时先画占位，后续帧补建。

## 用法

```ts
createElement("virtualList", {
  width: 480,
  height: 640,
  itemCount: 1_000_000,
  estimatedItemHeight: 32,
  renderItem: (index: number) =>
    createElement("container", {
      width: 480,
      height: 32,
      children: createElement("text", { value: `第 ${index} 行` }),
    }),
});
```

`estimatedItemHeight` 只是初始估计。真实高度测量出来后，Core 通过前缀和树（Fenwick）
纠正锚点位置，滚动条不会跳。

## 可调项

| prop                     | 作用                                    |
| ------------------------ | --------------------------------------- |
| `baseOverscanViewports`  | 对称预热范围（视口倍数）                |
| `velocityHorizonSeconds` | 速度投影时长，用于方向预测              |
| `maximumAheadViewports`  | 单方向预热上限                          |
| `scrollX` / `scrollY`    | 程序化滚动位置（变化时才发出 ScrollTo） |

方向预测会在快速 fling 时优先预热运动方向，而不是对称浪费两侧预算。

## 程序化滚动

```ts
// 通过 prop 变化触发一次 ScrollTo mutation
root.render(createElement("virtualList", { scrollY: 500_000 * 32 /* ... */ }));
```

或用 root 上的直接操纵 API（用于自定义手势）：

```ts
root.beginScroll(handle);
root.scrollBy(handle, 0, deltaY, elapsedMs);
root.endScroll(handle); // 交给 Core 估算 fling 速度
```

`handle` 来自元素的 `ref` 回调（`NodeHandle`）。

## 嵌套与编辑

指针拖动落在可编辑文本上时，文本选择优先于滚动拖拽；滚轮仍然滚动最近的滚动祖先。
这个优先级由命中路径深度决定，不需要业务干预。

## 性能口径

固定 fixture（百万行、20,000 帧）的自动 benchmark 是合并门禁的一部分。
当前 P95/P99 为亚微秒级重放，30 分钟连续滚动无不可控内存增长。

真机 P95/P99 与输入延迟属于平台资格采集，不作为工程出口条件——这条界线是刻意的，
避免用无法复现的设备数据阻塞工程进度，也避免用工程数据冒充设备承诺。

在 [Playground 的滚动演示](/playground/#/scroll)里可以看到实时帧指标。
