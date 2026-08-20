# 快速开始

## 安装

```sh
pnpm add @dopejs/pingo
```

业务只依赖 `@dopejs/pingo` 这一个包。`@dopejs/pingo-host`、`@dopejs/pingo-jsx` 等是内部实现包，
不属于公开契约——[迁移扫描器](/migration)会拒绝直接 import 它们。

## 挂载第一个画布

```ts
import { createElement, createHostedCanvasRoot } from "@dopejs/pingo";

const canvas = document.querySelector<HTMLCanvasElement>("#app")!;
canvas.width = 800;
canvas.height = 600;

const root = await createHostedCanvasRoot(canvas);

root.render(
  createElement("container", {
    width: 800,
    height: 600,
    backgroundColor: "#ffffffff",
    padding: 24,
    children: createElement("text", {
      value: "Hello pingo",
      fontSize: 24,
      lineHeight: 32,
      color: "#1f2329ff",
    }),
  }),
);
```

`createHostedCanvasRoot` 会自动探测浏览器能力，在 SharedArrayBuffer、postMessage 与主线程
Canvas2D 之间选择传输路径，你不需要为降级写分支。`root.mode` 返回实际选中的路径。

## 使用 TSX

配置 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@dopejs/pingo"
  }
}
```

之后就能写：

```tsx
function OrderRow({ index }: { index: number }) {
  return (
    <container width={480} height={32} padding={[6, 12, 6, 12]}>
      <text value={`订单 #${index}`} fontSize={13} lineHeight={20} />
    </container>
  );
}

root.render(<OrderRow index={1} />);
```

## 主机元素

引擎只有五个内建元素，它们直接对应 Scene 节点，不存在 CSS 层叠或选择器：

| 元素           | 用途                                           |
| -------------- | ---------------------------------------------- |
| `container`    | 通用分组、背景、内边距、变换                   |
| `text`         | 文本运行（shaping、换行、caret 几何来自 Core） |
| `scroll`       | Core 拥有的可滚动容器                          |
| `virtualList`  | Core 规划窗口的虚拟列表                        |
| `editableText` | 可编辑文本原语                                 |

`TextField` 与 `TextArea` 是在 `editableText` 之上组合出的 widget（边框、错误态），
它们不引入新的输入路径。

## 状态与副作用

```ts
import { signal, useEffect, useSignal, useState } from "@dopejs/pingo";

function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setCount((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return createElement("text", { value: `已过 ${count} 秒` });
}
```

可用的响应式原语：`signal`、`computed`、`effect`、`batch`、`untracked`，
以及 hooks `useState`、`useSignal`、`useMemo`、`useCallback`、`useRef`、`useEffect`。

::: warning 没有同步布局读取
`useLayoutEffect` 式的同步 Worker 布局读取不被支持——布局发生在另一个时钟上。
需要布局结果时使用异步契约，不要试图在渲染中同步读取几何。
:::

## 观测运行状况

```ts
const root = await createHostedCanvasRoot(canvas, {
  onFrame: (report) => {
    console.log(report.commands, report.displayListBytes, report.core?.sceneNodes);
  },
  onHostError: (error) => report(error),
});
```

`onFrame` 每帧给出命令数、DisplayList 字节数以及 Core 侧的脏域计数、布局工作量与 picture hash，
是性能排查的第一手数据。更多见[诊断](/diagnostics)。

## 下一步

- [架构概览](/guide/architecture)：Shell 与 Core 如何分工
- [虚拟滚动](/guide/scrolling)、[文本与编辑](/guide/editing)
- [Playground](/playground)：可交互的实时演示
