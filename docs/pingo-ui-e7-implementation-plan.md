# E7 context（Provider + useContext）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** 为 pingo 增加 React-context 同构能力：`createContext` / `Provider` / `useContext`，
使 pingo-ui 复合组件（Tabs/Accordion/RadioGroup，后续 Select/Menu）能用 shadcn 组合式 API。

**Architecture:** context 核心（品牌、类型、createContext、useContext）放
`@dopejs/pingo-runtime`（hook 与 ComponentScope 所在）；jsx 只做 `ElementType` 类型拓宽
（新增对 runtime 的 workspace 依赖）；reconciler 负责 Provider 登记、沿 `instance.parent`
链查找、值更新分发。值用 signal 承载——消费者订阅由现有 `observer.track` 免费获得，
且 signal 重渲染路径天然穿透 memo（E6 已证正交）。

**已验证的代码事实（实现依据）：**

- `ComponentScope`（runtime/hooks.ts）：构造函数 `constructor(invalidate: () => void)`；
  模块级 `activeScope`；`requireScope()` 取当前 scope；hooks 测试直接
  `new ComponentScope(() => undefined)` 构造——context 单测不需要 reconciler。
- 组件实例创建（reconciler.ts `mountInstanceInner`）：scope 以闭包引用 instance 创建
  （`new ComponentScope(() => this.enqueueComponent(instance))`）——lookup 桥同样以
  闭包接线。
- Owner 链：`instance.parent` 为 `ComponentInstance | RootOwner`（RootOwner
  `{ kind: "root", children: [] }`）。
- `compatible()`：`instance.type === descriptor.type`——Provider wrapper 是
  `createContext` 返回的单例对象引用，天然兼容。
- E6 memo 先例（a923e61/38625e8）：品牌用 `Symbol.for`；wrapper 解包在
  `renderComponent`；`ElementType` 与 `AnyPingoElement` 擦除字段都需拓宽。
- 依赖方向：runtime 无依赖；jsx 当前不依赖 runtime（本任务新增）；reconciler 依赖
  jsx + runtime。
- Provider 不做 props bailout：每次更新都走 renderComponent（children 透传需
  reconcile）；值变化经 signal 细粒度分发，非消费者子树由 descriptor identity
  bailout 兜住。

**语义约定（写进 API 注释）：**

- `useContext` 从消费组件的 parent 链向上找最近 Provider；找不到返回 `defaultValue`。
- Provider `value` 变化：仅 `Object.is` 不等时 set signal → 仅订阅的消费者重渲染
  （不穿 memo——E6 正交性）；非消费者兄弟组件不重渲染（优于 React）。
- Provider 卸载：消费者回落到默认值（链查找自然落空）。
- 嵌套同名 Provider：最近者胜。

---

### Task E7-1: runtime context 核心

**Files:**
- Create: `packages/runtime/src/context.ts`
- Test: `packages/runtime/src/context.test.ts`
- Modify: `packages/runtime/src/hooks.ts`（ComponentScope 增加 context lookup 桥）
- Modify: `packages/runtime/src/index.ts`（导出）

- [ ] **Step 1: 失败测试 `packages/runtime/src/context.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import {
  PINGO_PROVIDER_TYPE,
  createContext,
  isContextProvider,
  useContext,
} from "./context";
import { ComponentScope } from "./hooks";
import { signal } from "./signal";

describe("createContext", () => {
  it("creates a branded context with a singleton Provider", () => {
    const context = createContext("fallback");
    expect(context.defaultValue).toBe("fallback");
    expect(isContextProvider(context.Provider)).toBe(true);
    expect(context.Provider.context).toBe(context);
    expect(isContextProvider({})).toBe(false);
    expect(isContextProvider(null)).toBe(false);
  });
});

describe("useContext", () => {
  it("returns the default value when no provider is on the chain", () => {
    const context = createContext("fallback");
    const scope = new ComponentScope(() => undefined, () => undefined);
    const value = scope.render(() => useContext(context));
    expect(value).toBe("fallback");
  });

  it("reads the nearest provider signal through the scope lookup bridge", () => {
    const context = createContext("fallback");
    const provided = signal("from-provider");
    const scope = new ComponentScope(
      () => undefined,
      (candidate) => (candidate === context ? provided : undefined),
    );
    expect(scope.render(() => useContext(context))).toBe("from-provider");
  });

  it("subscribes the rendering component to the provider signal", () => {
    const context = createContext("fallback");
    const provided = signal("a");
    let invalidations = 0;
    const scope = new ComponentScope(
      () => {
        invalidations += 1;
      },
      (candidate) => (candidate === context ? provided : undefined),
    );
    let observed = scope.render(() => useContext(context));
    expect(observed).toBe("a");
    provided.set("b");
    expect(invalidations).toBe(1);
    observed = scope.render(() => useContext(context));
    expect(observed).toBe("b");
  });
});
```

注意：ComponentScope 构造签名本任务从 `(invalidate)` 扩为 `(invalidate, lookupContext?)`；
runtime 既有测试（hooks.test.ts 的 `new ComponentScope(() => undefined)`）必须保持可编译。
signal 的订阅语义：`get()` 订阅、`set()` 通知——以 packages/runtime/src/signal.ts 实际
API 为准（`provided.set(...)` / `.get()`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/runtime/src/context.test.ts`
Expected: FAIL（module 不存在 / 构造签名不符）

- [ ] **Step 3: 实现**

`packages/runtime/src/context.ts`：

```ts
import type { Signal } from "./signal";

/** Stable context brand shared across package copies and realms. */
export const PINGO_CONTEXT_TYPE: symbol = Symbol.for("dopejs.pingo.context");
/** Stable provider brand shared across package copies and realms. */
export const PINGO_PROVIDER_TYPE: symbol = Symbol.for("dopejs.pingo.context.provider");

/** A context object created by `createContext`. */
export interface PingoContext<T> {
  readonly $$typeof: typeof PINGO_CONTEXT_TYPE;
  readonly defaultValue: T;
  readonly Provider: ContextProvider<T>;
}

/** Element type wrapper: `<context.Provider value={...}>children</...>`. */
export interface ContextProvider<T> {
  readonly $$typeof: typeof PINGO_PROVIDER_TYPE;
  readonly context: PingoContext<T>;
}

/** Props accepted by a context Provider element. */
export interface ContextProviderProps<T> {
  readonly value: T;
  readonly children?: unknown;
}

export function createContext<T>(defaultValue: T): PingoContext<T> {
  const context: PingoContext<T> = {
    $$typeof: PINGO_CONTEXT_TYPE,
    defaultValue,
    Provider: undefined as unknown as ContextProvider<T>,
  };
  const provider: ContextProvider<T> = { $$typeof: PINGO_PROVIDER_TYPE, context };
  (context as { Provider: ContextProvider<T> }).Provider = provider;
  return context;
}

export function isContextProvider(value: unknown): value is ContextProvider<never> {
  return (
    typeof value === "object" &&
    value !== null &&
    "$$typeof" in value &&
    value.$$typeof === PINGO_PROVIDER_TYPE
  );
}

/** Lookup bridge result: the nearest provider's signal for one context. */
export type ContextLookup = (context: PingoContext<never>) => Signal<never> | undefined;
```

hooks.ts 变更：

1. ComponentScope 构造函数扩为
   `constructor(invalidate: () => void, lookupContext?: ContextLookup)`，存私有字段；
   公开方法 `public lookupContext(context: PingoContext<never>): Signal<never> | undefined`
   返回 `this.#lookupContext?.(context)`。
2. 新增 hook（放 hooks.ts 尾部或 context.ts 内 import requireScope——以循环依赖最小为准；
   requireScope 未导出则在 hooks.ts 内实现 useContext 并从 index 导出）：

```ts
/**
 * Reads the nearest provider's value for `context`, subscribing the rendering
 * component to it. Without a provider on the chain, returns the default.
 */
export function useContext<T>(context: PingoContext<T>): T {
  const scope = requireScope();
  const provided = scope.lookupContext(context as PingoContext<never>);
  if (provided === undefined) return context.defaultValue;
  return provided.get() as T;
}
```

3. index.ts 导出：createContext、isContextProvider、useContext、PINGO_CONTEXT_TYPE、
   PINGO_PROVIDER_TYPE，类型 PingoContext/ContextProvider/ContextProviderProps/ContextLookup。

- [ ] **Step 4: 跑测试确认通过 + 既有 runtime 测试无回归**

Run: `npx vitest run packages/runtime && pnpm --filter @dopejs/pingo-runtime build`
Expected: 全绿；build 成功

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/context.ts packages/runtime/src/context.test.ts packages/runtime/src/hooks.ts packages/runtime/src/index.ts
git commit -m "feat(runtime): add createContext/useContext with scope lookup bridge"
```

---

### Task E7-2: jsx 类型拓宽

**Files:**
- Modify: `packages/jsx/package.json`（+ `@dopejs/pingo-runtime` 依赖）
- Modify: `packages/jsx/src/types.ts`（ElementType / AnyPingoElement 擦除字段加 ContextProvider）
- Modify: `packages/jsx/src/index.ts`（如 jsx 需要 re-export context 类型则追加，否则不动）

- [ ] **Step 1: 拓宽类型**

types.ts：`import type { ContextProvider } from "@dopejs/pingo-runtime";`，
`ElementType<Props>` 联合与 `AnyPingoElement["type"]` 擦除字段加入 `ContextProvider<...>`
（参照 a923e61 对 MemoComponent 的处理方式）。

- [ ] **Step 2: 验证**

Run: `pnpm install && pnpm --filter @dopejs/pingo-jsx build && npx vitest run packages/jsx`
Expected: 全绿。lockfile 变更一并提交。

- [ ] **Step 3: Commit**

```bash
git add packages/jsx pnpm-lock.yaml
git commit -m "feat(jsx): accept context providers as element types"
```

---

### Task E7-3: reconciler 接线

**Files:**
- Modify: `packages/reconciler/src/reconciler.ts`
- Test: `packages/reconciler/src/reconciler.test.ts`（追加 describe("context")）

- [ ] **Step 1: 失败测试**

```ts
describe("context", () => {
  it("delivers provider value to nested consumers", () => {
    // theme context: Provider("dark") → 中间层（不消费）→ 消费者文本节点
    // 断言 sink 最后批次中消费者文本 value 为 "dark"
  });

  it("returns the default without a provider", () => { /* 消费者无 Provider → "fallback" */ });

  it("nearest provider wins", () => { /* Provider("outer") > Provider("inner") > consumer → "inner" */ });

  it("re-renders only subscribed consumers on value change", () => {
    // Provider value "a"→"b"；consumer A（读 context）重渲染；consumer B（不读）renders 不变；
    // 用渲染计数器断言
  });

  it("memo-wrapped consumers still re-render on context change", () => {
    // memo(Consumer) + Provider value 变化 → 重渲染（signal 路径穿透 memo）
  });

  it("provider children structure still reconciles on update", () => {
    // Provider children 中 host 文本变化 → sink 出现对应 setText mutation（ Provider 不做 bailout）
  });

  it("falls back to default after the provider unmounts", () => {
    // 第一次渲染有 Provider，第二次移除 → 消费者文本回到 default
  });
});
```

实现时从 sink 批次解码 mutation 断言文本值，参照文件内既有断言工具
（resourceForProp / decodeMutationBatch 模式）。渲染计数器模式参照 memo 测试。
`createElement(ThemeContext.Provider, { value: "dark", children: ... })`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/reconciler -t context`
Expected: FAIL

- [ ] **Step 3: 实现 reconciler 变更**

1. import：`createContext` 不需要；需要 `isContextProvider`、类型 `PingoContext`，
   以及 `signal`（runtime 既有 import 块并入）。
2. `ComponentInstance` 增加字段：
   `contextValue: { context: PingoContext<never>; signal: Signal<never> } | undefined`。
3. scope 创建处（mountInstanceInner 组件路径）：
   `new ComponentScope(() => this.enqueueComponent(instance), (context) => this.lookupContext(instance, context))`。
4. 新增私有方法：

```ts
private lookupContext(
  instance: ComponentInstance,
  context: PingoContext<never>,
): Signal<never> | undefined {
  let owner = instance.parent;
  while (owner.kind === "component") {
    if (owner.contextValue !== undefined && owner.contextValue.context === context) {
      return owner.contextValue.signal;
    }
    owner = owner.parent;
  }
  return undefined;
}
```

（`owner.parent` 的类型按实际 Owner 联合调整；RootOwner 无 parent，循环在 root 终止。）

5. mountInstanceInner 组件路径：descriptor.type 为 provider wrapper 时——
   `instance.contextValue = { context: type.context, signal: signal(props.value) }`；
   组件函数解包为 `(props) => props.children`。
6. renderComponent 解包顺序：先 memo、后 provider（或统一一个 resolveComponent
   辅助——以可读性为准）：

```ts
const type = instance.type;
const component = isMemoComponent(type)
  ? type.component
  : isContextProvider(type)
    ? (props: { readonly children?: PingoNode }) => props.children ?? null
    : (type as FunctionComponent<Record<string, unknown>>);
```

7. updateInstance 组件路径：provider 时先更新 signal——
   `const next = (descriptor.props as { value?: unknown }).value;`
   `if (!Object.is(instance.contextValue.signal.peek(), next)) instance.contextValue.signal.set(next);`
   ——然后照常走 renderComponent（Provider 无 memo bailout；若 provider 被 memo 包裹
   属未支持组合，文档不承诺）。
8. disposeInstance：contextValue 随实例销毁，无需额外清理（消费者订阅随其 scope
   dispose 由既有逻辑回收——验证 disposal 路径确实退订，若没有则记录为 concern）。

- [ ] **Step 4: 跑测试确认通过 + 全量无回归**

Run: `npx vitest run packages/reconciler`
Expected: 全绿（新 7 + 既有）

- [ ] **Step 5: Commit**

```bash
git add packages/reconciler/src/reconciler.ts packages/reconciler/src/reconciler.test.ts
git commit -m "feat(reconciler): wire context providers through the owner chain"
```

---

### Task E7-4: facade 导出 + 门禁

**Files:**
- Modify: `packages/facade/src/index.ts`
- Modify: `benchmarks/api/facade.v1.d.ts`（按 docs/api/index.md 程序更新快照）

- [ ] **Step 1: facade 导出** createContext/useContext/isContextProvider + 类型
  （PingoContext/ContextProvider/ContextProviderProps），放既有 runtime re-export 块。
- [ ] **Step 2: 门禁** `pnpm --filter @dopejs/pingo build`、`pnpm api:check`（快照按
  程序更新）、`pnpm test:run` 全绿。
- [ ] **Step 3: Commit** `feat(facade): export context API`

---

## 自审记录

- 覆盖：context 核心（T1）、类型拓宽（T2）、reconciler 接线（T3）、facade+门禁（T4）。
- 语义风险已标注：Provider 无 bailout（children 结构更新必须走 reconcile）、
  memo×Provider 组合不承诺、dispose 退订需验证。
- 类型体操集中点（PingoContext<never> 擦除）给了参照先例（memo 的 MemoComponent<never>）。
