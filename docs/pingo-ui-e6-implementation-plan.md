# E6 组件级 memo 实现计划

> **状态：已全部执行完成（2026-08-21，`a923e61…abc3d8d`）。** 进度权威记录见 `pingo-ui-implementation-plan.md` 进度总览。实施偏差：isMemoComponent 用 in-narrowing（repo lint 规则）；AnyPingoElement 擦除字段一并拓宽；组件 props interface 改 type alias（memo 泛型约束）；facade API 快照按 docs/api/index.md 程序更新。

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** 为 pingo 增加 React.memo 同构的组件级 props bailout，挡住"父渲染但 props 未变"的级联重渲染，使 pingo-ui 的 slot/闭包契约（§6.2.1）真正生效。

**Architecture:** `memo()` 定义在 `@dopejs/pingo-jsx`（组件模型类型所在），产出带 realm 安全品牌的 wrapper 对象作为 element `type`；reconciler 在组件更新路径做 props 浅比较 bailout；signal 驱动的重渲染走 `flushDirtyComponents → renderComponent` 直连路径，天然绕过 memo（正交）。

**已验证的代码事实（实现依据）：**

- Element：`{ $$typeof: PINGO_ELEMENT_TYPE, type, key, props }`（`packages/jsx/src/element.ts`，品牌用 `Symbol.for`）。
- `FunctionComponent<Props> = (props: Props) => PingoNode`（`packages/jsx/src/types.ts:334`）；`ElementType<Props> = HostType | FunctionComponent<Props> | typeof Fragment`（types.ts:341 附近）。
- `compatible()`（reconciler.ts:2380）：组件路径比较 `instance.type === descriptor.type`——memo wrapper 是单例对象引用，天然兼容。
- 组件更新路径（reconciler.ts `updateInstance`，约 1120 行）：`instance.props = descriptor.props; this.renderComponent(instance, coreParent);`——bailout 插入点。
- `renderComponent`（约 1176 行）：`instance.type as FunctionComponent` 后调用——memo 需解包。
- signal 重渲染路径：`enqueueComponent → #dirtyComponents → flushDirtyComponents → renderComponent`（约 1810 行），不经过 `updateInstance`，memo 不拦截 ✓。
- facade（`@dopejs/pingo`）从 jsx 等包 re-export 公共 API；memo 需要加入 facade 导出。

**语义约定（写进 API 文档注释）：**

- 默认浅比较：`Object.is` 逐值 + 键数相等；函数 prop 按引用比较（inline handler 使 memo 不命中，与 React 一致）。
- bailout 时 `instance.props` 更新为新 props（供下次比较），子树不动——子树上次渲染的 handler 闭包保留（React 同语义）。
- memo 不影响 signal 订阅重渲染。
- key/类型变化在 `compatible()` 层处理，优先于 memo。

---

### Task E6-1: memo wrapper 与类型（jsx 包）

**Files:**

- Create: `packages/jsx/src/memo.ts`
- Test: `packages/jsx/src/memo.test.ts`
- Modify: `packages/jsx/src/types.ts`（ElementType 联合加 MemoComponent）
- Modify: `packages/jsx/src/index.ts`（导出）

- [ ] **Step 1: 失败测试 `packages/jsx/src/memo.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { createElement } from "./element";
import { isMemoComponent, memo, shallowEqual } from "./memo";

const Component = (props: { readonly label: string }): string => props.label;

describe("memo", () => {
  it("wraps a component with a realm-safe brand", () => {
    const wrapped = memo(Component);
    expect(isMemoComponent(wrapped)).toBe(true);
    expect(wrapped.component).toBe(Component);
    expect(isMemoComponent(Component)).toBe(false);
    expect(isMemoComponent(null)).toBe(false);
  });

  it("keeps a custom compare function", () => {
    const compare = (): boolean => true;
    expect(memo(Component, compare).compare).toBe(compare);
  });

  it("is accepted as an element type", () => {
    const element = createElement(memo(Component), { label: "x" });
    expect(isMemoComponent(element.type)).toBe(true);
  });
});

describe("shallowEqual", () => {
  it("compares values with Object.is and key sets", () => {
    expect(shallowEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(shallowEqual({}, {})).toBe(true);
  });

  it("compares function props by reference", () => {
    const handler = (): void => {};
    expect(shallowEqual({ f: handler }, { f: handler })).toBe(true);
    expect(shallowEqual({ f: () => {} }, { f: () => {} })).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/jsx/src/memo.test.ts`
Expected: FAIL（Cannot find module './memo'）

- [ ] **Step 3: 实现 `packages/jsx/src/memo.ts`**

```ts
import type { FunctionComponent } from "./types";

/** Stable memo brand shared across package copies and realms. */
export const PINGO_MEMO_TYPE: symbol = Symbol.for("dopejs.pingo.memo");

export type PropsAreEqual<Props> = (previous: Readonly<Props>, next: Readonly<Props>) => boolean;

/**
 * Component wrapper produced by `memo`. The wrapper is a singleton object:
 * element identity (`instance.type === descriptor.type`) is preserved, so the
 * reconciler's compatibility check works unchanged.
 */
export interface MemoComponent<Props = Record<string, never>> {
  readonly $$typeof: typeof PINGO_MEMO_TYPE;
  readonly component: FunctionComponent<Props>;
  readonly compare: PropsAreEqual<Props> | undefined;
}

/**
 * Skips re-rendering a component when its props are shallowly equal to the
 * last render's props. Function props compare by reference — inline handlers
 * defeat memo, exactly as in React. Signal-driven re-renders bypass memo:
 * a component subscribed to a signal always re-renders when it writes.
 */
export function memo<Props extends Record<string, unknown>>(
  component: FunctionComponent<Props>,
  compare?: PropsAreEqual<Props>,
): MemoComponent<Props> {
  return { $$typeof: PINGO_MEMO_TYPE, component, compare };
}

export function isMemoComponent(value: unknown): value is MemoComponent<never> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly $$typeof?: unknown }).$$typeof === PINGO_MEMO_TYPE
  );
}

/** Default memo comparison: Object.is per value plus key-count equality. */
export function shallowEqual(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.is(left[key], right[key])) return false;
  }
  return true;
}
```

types.ts：在 `ElementType` 联合中加入 `MemoComponent<Props>`（import from ./memo — 注意循环依赖：memo.ts 从 types.ts import FunctionComponent（type-only， erased），types.ts 从 memo.ts import MemoComponent（type-only）——TS type-only 循环安全；若 lint/构建报警，改为把 MemoComponent 接口定义放 types.ts、memo() 函数留 memo.ts，以构建结果为准）。

index.ts 追加导出：`export { PINGO_MEMO_TYPE, isMemoComponent, memo, shallowEqual } from "./memo";` + 类型导出。

- [ ] **Step 4: 跑测试确认通过 + 包构建**

Run: `npx vitest run packages/jsx/src/memo.test.ts && pnpm --filter @dopejs/pingo-jsx build`
Expected: 3+2 passed；build 成功

- [ ] **Step 5: Commit**

```bash
git add packages/jsx/src/memo.ts packages/jsx/src/memo.test.ts packages/jsx/src/types.ts packages/jsx/src/index.ts
git commit -m "feat(jsx): add memo component wrapper and shallowEqual"
```

---

### Task E6-2: reconciler bailout 接入

**Files:**

- Modify: `packages/reconciler/src/reconciler.ts`（updateInstance 组件路径 + renderComponent 解包 + ComponentInstance.type 类型放宽）
- Test: `packages/reconciler/src/reconciler.test.ts`（追加 describe 块；RecordingSink 已在文件中）

- [ ] **Step 1: 失败测试（追加到 reconciler.test.ts）**

```ts
describe("memo", () => {
  it("skips re-render when props are shallowly equal", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    let renders = 0;
    const Leaf = (props: { readonly label: string }): PingoNode => {
      renders += 1;
      return createElement("text", { value: props.label });
    };
    const MemoLeaf = memo(Leaf);
    const tree = (label: string): PingoNode =>
      createElement("container", { children: createElement(MemoLeaf, { label }) });
    root.render(tree("a"));
    const afterFirst = renders;
    root.render(tree("a")); // same props → bailout
    root.flushSync?.(); // if flushSync exists; otherwise assert after scheduler flush
    expect(renders).toBe(afterFirst);
  });

  it("re-renders when a prop changes", () => {
    /* same harness; second render tree("b") → renders increments */
  });

  it("re-renders on inline handler identity change (function props compare by reference)", () => {
    /* pass onTap: () => {} inline both renders → renders increments */
  });

  it("honors a custom compare", () => {
    /* memo(Leaf, () => true) with changed props → no re-render */
  });

  it("remounts when key changes even under memo", () => {
    /* same props, different key → renders increments */
  });
});
```

注意：reconciler 重渲染走调度器（`#schedule`），测试里第二次 render 后如何等待 flush——参考 reconciler.test.ts 既有用例的 flush 方式（可能有 `flushSync` 或测试直接同步触发；以文件内既有模式为准）。`PingoNode`/`createElement`/`memo` 的 import 追加到文件头部既有 import。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/reconciler/src/reconciler.test.ts -t memo`
Expected: FAIL（memo 未定义或行为未接入）

- [ ] **Step 3: 实现 reconciler 接入**

reconciler.ts 中（行号为参考，以实际为准）：

1. import：`import { isMemoComponent, shallowEqual, type MemoComponent } from "@dopejs/pingo-jsx";`（确认 reconciler 对 jsx 的既有 import 形式，并入）。
2. `ComponentInstance.type` 类型放宽为 `HostType | FunctionComponent<...> | MemoComponent<...>` 层级中组件侧实际使用的类型。
3. `updateInstance` 组件路径改为：

```ts
if (instance.kind === "component") {
  if (typeof descriptor === "string" || !isPingoElement(descriptor)) {
    throw new Error("component descriptor changed unexpectedly");
  }
  const compare = isMemoComponent(instance.type)
    ? (instance.type.compare ?? shallowEqual)
    : undefined;
  if (compare !== undefined && compare(instance.props, descriptor.props)) {
    // Props equal: keep the previous subtree and its closures; store the
    // fresh props for the next comparison (React memo semantics).
    instance.props = descriptor.props;
    return instance;
  }
  instance.props = descriptor.props;
  this.renderComponent(instance, coreParent);
  return instance;
}
```

4. `renderComponent` 解包：

```ts
const output = instance.scope.render(() => {
  const type = instance.type;
  const component = (isMemoComponent(type) ? type.component : type) as FunctionComponent<
    Record<string, unknown>
  >;
  return component(instance.props);
});
```

- [ ] **Step 4: 跑测试确认通过 + reconciler 全量**

Run: `npx vitest run packages/reconciler`
Expected: 全部通过（memo 5 条新 + 既有无回归）

- [ ] **Step 5: Commit**

```bash
git add packages/reconciler/src/reconciler.ts packages/reconciler/src/reconciler.test.ts
git commit -m "feat(reconciler): add memo props bailout for component updates"
```

---

### Task E6-3: signal 正交性测试

**Files:**

- Test: `packages/reconciler/src/reconciler.test.ts`（追加）

- [ ] **Step 1: 写测试**

```ts
it("memo never blocks signal-driven re-renders", () => {
  const sink = new RecordingSink();
  const root = createRoot(sink);
  const count = signal(0);
  let renders = 0;
  const Leaf = (): PingoNode => {
    renders += 1;
    return createElement("text", { value: String(count.get()) });
  };
  const MemoLeaf = memo(Leaf);
  root.render(createElement("container", { children: createElement(MemoLeaf, {}) }));
  const afterMount = renders;
  count.set(1); // signal write must re-render despite unchanged props
  // flush per the file's existing pattern
  expect(renders).toBeGreaterThan(afterMount);
});
```

`signal` import 自 `@dopejs/pingo-runtime`（确认 reconciler 测试对 runtime 的既有 import 形式；reconciler 依赖 runtime —— ComponentScope 即来自 runtime，测试文件应已有 import 路径先例）。

- [ ] **Step 2: 跑通 + Commit**

Run: `npx vitest run packages/reconciler -t memo`
Expected: 通过。Commit: `test(reconciler): prove memo is orthogonal to signal re-renders`

---

### Task E6-4: facade 导出 + pingo-ui 组件接入 + 门禁

**Files:**

- Modify: `packages/facade/src/index.ts`（re-export memo/isMemoComponent/shallowEqual 或按 facade 既有 jsx re-export 形式追加）
- Modify: `packages/ui/src/components/{button,badge,card,label}.ts`（memo 包装）
- Test: `packages/ui/src/components/memo.test.ts`（新增：memo 包装后 descriptor 行为不变 + wrapper 语义）
- 注意 Input 暂不包装（内部含 hooks 且 props 携带 controller/handler，memo 收益低；留待 A1 评估）

- [ ] **Step 1: facade 导出**

facade 现状：从各包 re-export（参考既有 `PingoStyleSheet` 等类型导出行）。追加 memo 相关导出后：

Run: `pnpm --filter @dopejs/pingo build`
Expected: 成功。若 facade 有 public API 检查（`scripts/check-public-api.mjs`），运行 `pnpm --filter @dopejs/pingo exec true` 不适用——改为根脚本中对应的 API 检查命令（查 package.json scripts 里的 public-api 相关项并运行）。

- [ ] **Step 2: pingo-ui 组件包装**

模式（以 Button 为例，其余同）：实现函数改名加 `Impl` 后缀或内部函数 + 导出 memo 包装：

```ts
import { memo } from "@dopejs/pingo-jsx";

function ButtonImpl(props: ButtonProps): PingoNode {
  /* 原实现不变 */
}

/** shadcn-style button. Memoized: re-renders only when props change. */
export const Button = memo(ButtonImpl);
```

Card 族每个导出（Card/CardHeader/...）分别 memo 包装。类型：memo 后导出类型从函数变为 MemoComponent——pingo-ui 的 index.ts 无需改（`export { Button }` 对 const 同样有效）；组件测试现状是直接调用 `Button(props)`——memo 后 Button 是对象不可调用！**因此组件测试改为**：

- 直接调用测试目标改为 `ButtonImpl`？不导出 Impl。改为从组件模块导出被包装前的函数为内部名（如 `buttonView`），测试调它；或对 memo wrapper 用 `Button.component(props)` 调用。选后者：测试改为 `Button.component(props)`（不新增导出面）。每个组件测试文件相应调整调用点。

- [ ] **Step 3: 新增 `packages/ui/src/components/memo.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { isMemoComponent } from "@dopejs/pingo-jsx";

import { Badge } from "./badge";
import { Button } from "./button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";
import { Label } from "./label";

describe("memoized components", () => {
  it("all presentational components are memo-wrapped", () => {
    for (const component of [
      Button,
      Badge,
      Card,
      CardHeader,
      CardTitle,
      CardDescription,
      CardContent,
      CardFooter,
      Label,
    ]) {
      expect(isMemoComponent(component)).toBe(true);
    }
  });

  it("wrapped components keep their descriptor behavior", () => {
    const node = Button.component({ children: "保存" }) as { props: Record<string, unknown> };
    expect(node.props.className).toBe("pui-button pui-button--default");
  });
});
```

既有组件测试文件中的直接调用点（`Button(props)` 等）全部改为 `Button.component(props)` 形式。

- [ ] **Step 4: 门禁**

Run: `npx vitest run packages/ui && pnpm --filter @dopejs/pingo-ui build && pnpm test:run`
Expected: ui 全绿；全仓回归全绿（含 storybook typecheck 链路——storybook 中 Button(...) 直接调用必须改为 createElement(Button, ...) 或 Button.component(...)！检查 apps/storybook/src/PingoUi.stories.ts：memo 后所有组件都是对象，全部调用点改用 createElement。row() 帮助函数签名相应调整。）

- [ ] **Step 5: Commit**

```bash
git add packages/facade packages/ui apps/storybook
git commit -m "feat(ui): memo-wrap presentational components and export memo from facade"
```

---

## 自审记录

- 覆盖：memo wrapper（T1）、reconciler bailout（T2）、signal 正交（T3）、facade+组件接入+门禁（T4），对应总计划 E6 的 4 任务。
- 关键实现陷阱已标注：type-only 循环依赖处理、测试 flush 模式以既有用例为准、memo 后组件不可直接调用（storybook/测试调用点全改）。
- Input 不包装的决策已记录（hooks + controller/handler props 使浅比较恒失败，无收益）。
