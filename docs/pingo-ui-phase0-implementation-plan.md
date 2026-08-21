# pingo-ui 阶段 0 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `@dopejs/pingo-ui` 包骨架、cva-lite、theme signal、SCSS 皮肤管线（shadcn 默认 preset），交付 Button/Badge/Card/Input/Label 五个样板组件并在 storybook 走通明暗切换。

**Architecture:** 纯 TS 组件包，组合 `@dopejs/pingo-jsx` 原语与 `@dopejs/pingo-widgets` 的 Pressable；皮肤用 SCSS 经 `@dopejs/pingo-style-preprocess` 在包构建期 codegen 为 TS 模块；theme 是模块级 signal（reconciler 的 observer.track 自动订阅，无需 context API）。

**Tech Stack:** pnpm workspace、tsc 构建、vitest、dart-sass（经 style-preprocess）、Storybook html-vite。

**Spec:** [`docs/pingo-ui-capability-plan.md`](../pingo-ui-capability-plan.md)（§4 包结构、§5 主题模型、§6 API 契约、§8 第一批）。

## 已验证的引擎事实（实现约束）

- `ComponentScope.render` 用 `observer.track(render)` 包裹：组件 render 中读 signal 自动订阅，signal 写入自动重渲染。ThemeProvider 因此是模块级 signal，不做组件。
- `createHostedCanvasRoot(canvas, options)` 的 options 继承 `RootOptions`，含 `styleSheets?: readonly PingoStyleSheet[]`。
- 组件函数（`View`/`Pressable` 等）直接返回 host descriptor（`{ type: "container", props }` 形状），测试可无 root 直接调用并断言 `props.className`。
- schema 支持：margin/padding 四边、`borderRadius`、`fontWeight: number | "bold" | "normal"`、cursor、pointerEvents、`#hex8`（alpha）、`:hover/:active/:focus/:focus-visible`、同节点 compound class。
- schema **不支持**（皮肤禁用）：`gap`、`letterSpacing`、`outline`、`:focus-within`、`boxShadow`（E4）、`placeholder`（引擎无此能力）。颜色关键字不支持，SCSS 变量只写 hex。
- `TextEditingController`（`@dopejs/pingo-editing`）有 `value` getter 并内部应用 transaction delta。
- `resolveStyle({ nodeType, className, styleSheets, interactionState })` 可在 node 环境做皮肤断言；`STYLE_INTERACTION_STATES.hover` 从 `@dopejs/pingo-style` 导出。
- display 初始值 `flex`；皮肤中显式声明 `flex-direction` / `justify-content` / `align-items`。
- 已知视觉缺口（写进组件文档注释，不 hack）：Input 无 focus ring（需 `:focus-within` 或 E4）、Card 无 shadow（E4）、Input 无 placeholder。

## 文件结构

```
packages/ui/
  package.json                        # @dopejs/pingo-ui
  tsconfig.json / tsconfig.build.json # 镜像 packages/widgets
  LICENSE / NOTICE                    # 复制自 packages/widgets
  scripts/build-styles.mjs            # SCSS → codegen src/generated/styles.ts
  styles/tokens.scss                  # 语义 token 契约 + shadcn 默认值
  styles/presets/shadcn-default.scss  # 默认 preset（显式选择 tokens）
  styles/index.scss                   # 入口：preset + 全部组件皮肤
  styles/components/{button,badge,card,input,label}.scss
  src/cva.ts / src/cva.test.ts
  src/theme.ts / src/theme.test.ts
  src/generated/styles.ts             # codegen 产物，提交
  src/styles.test.ts                  # 皮肤解析断言
  src/components/{button,badge,card,input,label}.ts
  src/components/{button,badge,card,input,label}.test.ts
  src/index.ts
apps/storybook/
  package.json                        # 加 @dopejs/pingo-ui 依赖
  src/mount.ts                        # mountStory 增加 styleSheets 选项
  src/PingoUi.stories.ts              # 五个组件 + 明暗切换
```

---

### Task 1: 包骨架

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/tsconfig.build.json`
- Create: `packages/ui/src/index.ts`
- Bash: `cp packages/widgets/LICENSE packages/widgets/NOTICE packages/ui/`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@dopejs/pingo-ui",
  "version": "0.0.0",
  "description": "shadcn-style component library for the pingo canvas engine",
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/dopejs/pingo.git",
    "directory": "packages/ui"
  },
  "publishConfig": {
    "access": "public"
  },
  "type": "module",
  "sideEffects": false,
  "files": [
    "LICENSE",
    "NOTICE",
    "dist",
    "styles"
  ],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "node scripts/build-styles.mjs && tsc -p tsconfig.build.json",
    "typecheck": "node scripts/build-styles.mjs && tsc --noEmit"
  },
  "dependencies": {
    "@dopejs/pingo-editing": "workspace:*",
    "@dopejs/pingo-jsx": "workspace:*",
    "@dopejs/pingo-runtime": "workspace:*",
    "@dopejs/pingo-style": "workspace:*",
    "@dopejs/pingo-widgets": "workspace:*"
  },
  "devDependencies": {
    "@dopejs/pingo-style-preprocess": "workspace:*"
  }
}
```

- [ ] **Step 2: 创建 tsconfig（镜像 widgets）**

`packages/ui/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src" },
  "include": ["src/**/*.ts"]
}
```

`packages/ui/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "outDir": "dist",
    "sourceMap": true
  },
  "exclude": ["src/**/*.browser.ts", "src/**/*.test.ts"]
}
```

- [ ] **Step 3: 创建 src/index.ts 占位与 LICENSE/NOTICE**

```ts
// @dopejs/pingo-ui — public surface is assembled across tasks in this plan.
export {};
```

```bash
mkdir -p packages/ui/src packages/ui/scripts packages/ui/styles/presets packages/ui/styles/components
cp packages/widgets/LICENSE packages/widgets/NOTICE packages/ui/
```

- [ ] **Step 4: 安装依赖并验证骨架**

Run: `pnpm install && pnpm --filter @dopejs/pingo-ui typecheck`
Expected: typecheck 通过（`scripts/build-styles.mjs` 尚不存在会失败——先创建空脚本 `process.exit(0)` 占位，Task 4 替换；或直接跳过此步验证，在 Task 4 统一验证。选后者：本步只跑 `pnpm install` 确认 workspace 解析成功）。

- [ ] **Step 5: Commit**

```bash
git add packages/ui && git commit -m "feat(ui): scaffold @dopejs/pingo-ui package"
```

---

### Task 2: cva-lite

**Files:**
- Create: `packages/ui/src/cva.ts`
- Test: `packages/ui/src/cva.test.ts`

- [ ] **Step 1: 写失败测试**

`packages/ui/src/cva.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { cva } from "./cva";

const buttonClass = cva({
  base: "pui-button",
  variants: {
    variant: {
      default: "pui-button--default",
      secondary: "pui-button--secondary",
      ghost: "pui-button--ghost",
    },
    size: {
      default: "",
      sm: "pui-button--sm",
      lg: "pui-button--lg",
    },
    theme: {
      light: "",
      dark: "pui-dark",
    },
  },
  compoundVariants: [
    { when: { variant: "ghost", theme: "dark" }, className: "pui-button--ghost-dark" },
  ],
  defaultVariants: { variant: "default", size: "default", theme: "light" },
});

describe("cva", () => {
  it("composes base with default variants and skips empty classes", () => {
    expect(buttonClass()).toBe("pui-button pui-button--default");
  });

  it("applies explicit variants in config key order", () => {
    expect(buttonClass({ variant: "secondary", size: "sm" })).toBe(
      "pui-button pui-button--secondary pui-button--sm",
    );
  });

  it("emits dark marker and matching compound variants", () => {
    expect(buttonClass({ variant: "ghost", theme: "dark" })).toBe(
      "pui-button pui-button--ghost pui-dark pui-button--ghost-dark",
    );
  });

  it("explicit props override defaults; unknown values contribute nothing", () => {
    expect(buttonClass({ variant: "default", size: "lg" })).toBe(
      "pui-button pui-button--default pui-button--lg",
    );
  });

  it("is deterministic across calls", () => {
    expect(buttonClass({ variant: "ghost", theme: "dark" })).toBe(
      buttonClass({ theme: "dark", variant: "ghost" }),
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/ui/src/cva.test.ts`
Expected: FAIL（`Cannot find module './cva'`）

- [ ] **Step 3: 实现 cva.ts**

```ts
/**
 * cva-lite: class-variance-authority for pingo-ui.
 *
 * Class emission order is deterministic: base, then variant axes in config
 * key order, then compound variants in array order. Empty strings contribute
 * nothing. Cascade precedence comes from stylesheet source order, never from
 * class position in the className string.
 */

export type CvaProps = Readonly<Record<string, string | boolean | undefined>>;

export interface CvaCompound {
  readonly when: CvaProps;
  readonly className: string;
}

export interface CvaConfig {
  readonly base?: string;
  readonly variants?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly compoundVariants?: readonly CvaCompound[];
  readonly defaultVariants?: CvaProps;
}

export function cva(config: CvaConfig): (props?: CvaProps) => string {
  const variants = config.variants ?? {};
  const defaults = config.defaultVariants ?? {};
  const compounds = config.compoundVariants ?? [];
  return (props = {}) => {
    const classes: string[] = [];
    if (config.base !== undefined && config.base !== "") classes.push(config.base);
    const resolved: Record<string, string | boolean | undefined> = {};
    for (const axis of Object.keys(variants)) {
      const value = props[axis] ?? defaults[axis];
      resolved[axis] = value;
      if (value === undefined || value === false) continue;
      const className = variants[axis]?.[String(value)];
      if (className !== undefined && className !== "") classes.push(className);
    }
    for (const compound of compounds) {
      const matches = Object.entries(compound.when).every(([axis, expected]) => {
        const actual = resolved[axis] ?? props[axis] ?? defaults[axis];
        return String(actual) === String(expected);
      });
      if (matches && compound.className !== "") classes.push(compound.className);
    }
    return classes.join(" ");
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/ui/src/cva.test.ts`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/cva.ts packages/ui/src/cva.test.ts
git commit -m "feat(ui): add cva-lite class variance composer"
```

---

### Task 3: theme signal

**Files:**
- Create: `packages/ui/src/theme.ts`
- Test: `packages/ui/src/theme.test.ts`

设计依据：pingo 无 context API；`ComponentScope.render` 内 signal 读自动订阅（reconciler observer.track）。模块级 signal 即主题"context"。**注意：本模块 import 即创建 signal，包需保持 `sideEffects: false` 时 tree-shaking 不删除本模块——它通过 src/index.ts 显式导出，安全。**

- [ ] **Step 1: 写失败测试**

`packages/ui/src/theme.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";

import { getTheme, setTheme, useTheme, type PingoUiTheme } from "./theme";

afterEach(() => {
  setTheme("light");
});

describe("theme", () => {
  it("defaults to light", () => {
    expect(getTheme()).toBe("light");
  });

  it("setTheme switches the value read by useTheme", () => {
    setTheme("dark");
    expect(useTheme()).toBe("dark");
    expect(getTheme()).toBe("dark");
  });

  it("accepts only the two theme values at the type level", () => {
    const values: readonly PingoUiTheme[] = ["light", "dark"];
    expect(values).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/ui/src/theme.test.ts`
Expected: FAIL（`Cannot find module './theme'`）

- [ ] **Step 3: 实现 theme.ts**

```ts
import { signal } from "@dopejs/pingo-runtime";

export type PingoUiTheme = "light" | "dark";

/**
 * Module-level theme signal. pingo has no context API; components reading
 * `useTheme()` during render are auto-subscribed by the reconciler's
 * observer tracking, so `setTheme` re-renders every subscribed component.
 */
const themeSignal = signal<PingoUiTheme>("light");

/** Switches the active theme. Every subscribed component re-renders. */
export function setTheme(next: PingoUiTheme): void {
  themeSignal.value = next;
}

/** Reads the theme without subscribing (for non-render call sites). */
export function getTheme(): PingoUiTheme {
  return themeSignal.value;
}

/** Reads the theme inside component render; auto-subscribes the component. */
export function useTheme(): PingoUiTheme {
  return themeSignal.value;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/ui/src/theme.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/theme.ts packages/ui/src/theme.test.ts
git commit -m "feat(ui): add module-level theme signal"
```

---

### Task 4: SCSS 皮肤管线 + shadcn 默认 preset

**Files:**
- Create: `packages/ui/styles/tokens.scss`
- Create: `packages/ui/styles/presets/shadcn-default.scss`
- Create: `packages/ui/styles/index.scss`
- Create: `packages/ui/styles/components/{button,badge,card,input,label}.scss`
- Create: `packages/ui/scripts/build-styles.mjs`
- Create: `packages/ui/src/generated/styles.ts`（codegen 产物）
- Test: `packages/ui/src/styles.test.ts`

token 值 = shadcn 默认主题（zinc, new-york）。light/dark 双套变量；组件皮肤只引用变量（§5.1 硬约束，由 Task 4 Step 7 的检查脚本强制）。

- [ ] **Step 1: tokens.scss（语义契约 + shadcn 默认值）**

`packages/ui/styles/tokens.scss`:

```scss
// Semantic token contract for pingo-ui skins. Names follow shadcn semantics;
// defaults are the shadcn default theme (zinc). Presets override via
// `@use "../tokens" with (...)`. Values must be hex — color keywords and
// non-hex functions are rejected by compileStyleSheet.
//
// dark-* mirrors drive `.pui-dark` compound rules in component skins.

$background: #ffffff !default;
$foreground: #09090b !default;
$card: #ffffff !default;
$card-foreground: #09090b !default;
$primary: #18181b !default;
$primary-foreground: #fafafa !default;
$primary-hover: #18181be6 !default; // primary / 90%
$secondary: #f4f4f5 !default;
$secondary-foreground: #18181b !default;
$secondary-hover: #f4f4f5cc !default; // secondary / 80%
$muted-foreground: #71717a !default;
$accent: #f4f4f5 !default;
$accent-foreground: #18181b !default;
$destructive: #ef4444 !default;
$destructive-foreground: #fafafa !default;
$destructive-hover: #ef4444e6 !default;
$border: #e4e4e7 !default;
$input-border: #e4e4e7 !default;
$ring: #a1a1aa !default;

$radius-md: 6px !default;
$radius-lg: 8px !default;

$dark-background: #09090b !default;
$dark-foreground: #fafafa !default;
$dark-card: #09090b !default;
$dark-card-foreground: #fafafa !default;
$dark-primary: #fafafa !default;
$dark-primary-foreground: #18181b !default;
$dark-primary-hover: #fafafae6 !default;
$dark-secondary: #27272a !default;
$dark-secondary-foreground: #fafafa !default;
$dark-secondary-hover: #27272acc !default;
$dark-muted-foreground: #a1a1aa !default;
$dark-accent: #27272a !default;
$dark-accent-foreground: #fafafa !default;
$dark-destructive: #7f1d1d !default;
$dark-destructive-foreground: #fafafa !default;
$dark-destructive-hover: #7f1d1de6 !default;
$dark-border: #27272a !default;
$dark-input-border: #27272a !default;
$dark-ring: #52525b !default;
```

- [ ] **Step 2: preset 与入口**

`packages/ui/styles/presets/shadcn-default.scss`:

```scss
// Default preset: selects the shadcn default theme shipped as token
// defaults. A future in-house theme is a sibling file overriding tokens via
// `@use "../tokens" with (...)`; component skins never change.
@use "../tokens";
```

`packages/ui/styles/index.scss`:

```scss
@use "presets/shadcn-default";
@use "components/button";
@use "components/badge";
@use "components/card";
@use "components/input";
@use "components/label";
```

- [ ] **Step 3: 五个组件皮肤**

`packages/ui/styles/components/button.scss`:

```scss
@use "../tokens" as t;

// shadcn new-york Button. Text color/font inherit from the View skin class
// into the inner Text node (no descendant selectors in pingo).
// Rule order matters: light, light:hover, dark, dark:hover — later wins at
// equal specificity.

.pui-button {
  justify-content: center;
  align-items: center;
  height: 36px;
  padding-left: 16px;
  padding-right: 16px;
  border-radius: t.$radius-md;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}

.pui-button--sm {
  height: 32px;
  padding-left: 12px;
  padding-right: 12px;
  font-size: 12px;
}

.pui-button--lg {
  height: 40px;
  padding-left: 32px;
  padding-right: 32px;
}

.pui-button--icon {
  width: 36px;
  padding-left: 0;
  padding-right: 0;
}

.pui-button--disabled {
  cursor: default;
}

.pui-button--default {
  background-color: t.$primary;
  color: t.$primary-foreground;
  &:hover { background-color: t.$primary-hover; }
  &.pui-dark {
    background-color: t.$dark-primary;
    color: t.$dark-primary-foreground;
    &:hover { background-color: t.$dark-primary-hover; }
  }
}

.pui-button--secondary {
  background-color: t.$secondary;
  color: t.$secondary-foreground;
  &:hover { background-color: t.$secondary-hover; }
  &.pui-dark {
    background-color: t.$dark-secondary;
    color: t.$dark-secondary-foreground;
    &:hover { background-color: t.$dark-secondary-hover; }
  }
}

.pui-button--outline {
  background-color: t.$background;
  color: t.$foreground;
  border-width: 1px;
  border-style: solid;
  border-color: t.$border;
  &:hover { background-color: t.$accent; color: t.$accent-foreground; }
  &.pui-dark {
    background-color: t.$dark-background;
    color: t.$dark-foreground;
    border-color: t.$dark-border;
    &:hover { background-color: t.$dark-accent; color: t.$dark-accent-foreground; }
  }
}

.pui-button--ghost {
  color: t.$foreground;
  &:hover { background-color: t.$accent; color: t.$accent-foreground; }
  &.pui-dark {
    color: t.$dark-foreground;
    &:hover { background-color: t.$dark-accent; color: t.$dark-accent-foreground; }
  }
}

.pui-button--destructive {
  background-color: t.$destructive;
  color: t.$destructive-foreground;
  &:hover { background-color: t.$destructive-hover; }
  &.pui-dark {
    background-color: t.$dark-destructive;
    color: t.$dark-destructive-foreground;
    &:hover { background-color: t.$dark-destructive-hover; }
  }
}
```

`packages/ui/styles/components/badge.scss`:

```scss
@use "../tokens" as t;

.pui-badge {
  justify-content: center;
  align-items: center;
  padding-top: 2px;
  padding-bottom: 2px;
  padding-left: 10px;
  padding-right: 10px;
  border-radius: t.$radius-md;
  border-width: 1px;
  border-style: solid;
  border-color: transparent;
  font-size: 12px;
  font-weight: 600;
}

.pui-badge--default {
  background-color: t.$primary;
  color: t.$primary-foreground;
  &.pui-dark { background-color: t.$dark-primary; color: t.$dark-primary-foreground; }
}

.pui-badge--secondary {
  background-color: t.$secondary;
  color: t.$secondary-foreground;
  &.pui-dark { background-color: t.$dark-secondary; color: t.$dark-secondary-foreground; }
}

.pui-badge--destructive {
  background-color: t.$destructive;
  color: t.$destructive-foreground;
  &.pui-dark { background-color: t.$dark-destructive; color: t.$dark-destructive-foreground; }
}

.pui-badge--outline {
  background-color: t.$background;
  color: t.$foreground;
  border-color: t.$border;
  &.pui-dark {
    background-color: t.$dark-background;
    color: t.$dark-foreground;
    border-color: t.$dark-border;
  }
}
```

`packages/ui/styles/components/card.scss`:

```scss
@use "../tokens" as t;

// boxShadow intentionally absent until engine work package E4 lands.

.pui-card {
  flex-direction: column;
  background-color: t.$card;
  color: t.$card-foreground;
  border-width: 1px;
  border-style: solid;
  border-color: t.$border;
  border-radius: t.$radius-lg;
  &.pui-dark {
    background-color: t.$dark-card;
    color: t.$dark-card-foreground;
    border-color: t.$dark-border;
  }
}

.pui-card-header {
  flex-direction: column;
  padding-top: 24px;
  padding-left: 24px;
  padding-right: 24px;
}

.pui-card-title {
  font-size: 20px;
  font-weight: 600;
}

.pui-card-description {
  margin-top: 6px;
  font-size: 14px;
  color: t.$muted-foreground;
  &.pui-dark { color: t.$dark-muted-foreground; }
}

.pui-card-content {
  flex-direction: column;
  padding: 24px;
}

.pui-card-footer {
  align-items: center;
  padding-left: 24px;
  padding-right: 24px;
  padding-bottom: 24px;
}
```

`packages/ui/styles/components/input.scss`:

```scss
@use "../tokens" as t;

// Focus ring intentionally absent: pingo has no :focus-within and the border
// lives on the shell; tracked as a known gap until a selector or E4 shadow
// solution lands.

.pui-input {
  align-items: center;
  min-height: 36px;
  padding-left: 12px;
  padding-right: 12px;
  padding-top: 6px;
  padding-bottom: 6px;
  background-color: t.$background;
  border-width: 1px;
  border-style: solid;
  border-color: t.$input-border;
  border-radius: t.$radius-md;
  color: t.$foreground;
  &.pui-dark {
    background-color: t.$dark-background;
    border-color: t.$dark-input-border;
    color: t.$dark-foreground;
  }
}

.pui-input--disabled {
  opacity: 0.5;
  cursor: default;
}

.pui-input__field {
  font-size: 14px;
  line-height: 20px;
}
```

`packages/ui/styles/components/label.scss`:

```scss
@use "../tokens" as t;

.pui-label {
  font-size: 14px;
  font-weight: 500;
  color: t.$foreground;
  &.pui-dark { color: t.$dark-foreground; }
}
```

- [ ] **Step 4: build-styles.mjs（codegen）**

`packages/ui/scripts/build-styles.mjs`:

```js
// Generates src/generated/styles.ts from styles/index.scss.
// Fails the build when the compiled CSS violates the pingo CSS subset.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compilePingoStyleFile } from "@dopejs/pingo-style-preprocess";

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = path.join(packageDir, "styles", "index.scss");
const outFile = path.join(packageDir, "src", "generated", "styles.ts");

const result = await compilePingoStyleFile(entry, { sourceName: "@dopejs/pingo-ui" });
if (result.styleSheet === null) {
  for (const diagnostic of result.diagnostics) {
    console.error(`[pingo-ui] ${diagnostic.code}: ${diagnostic.message}`);
  }
  process.exit(1);
}

const module = `// GENERATED by scripts/build-styles.mjs — do not edit by hand.
import { createStyleSheet, type PingoStyleSheet } from "@dopejs/pingo-style";

/** Compiled pingo-ui skin (shadcn default preset, light + dark). */
export const pingoUiCssText = ${JSON.stringify(result.cssText)};

/** Creates a fresh immutable stylesheet for one pingo root. */
export function createPingoUiStyleSheet(): PingoStyleSheet {
  return createStyleSheet(pingoUiCssText, { sourceName: "@dopejs/pingo-ui" });
}
`;

await mkdir(path.dirname(outFile), { recursive: true });
await writeFile(outFile, module);
console.log(`[pingo-ui] generated ${path.relative(packageDir, outFile)}`);
```

**注意**：`compilePingoStyleFile` 的返回形状以 `packages/style-preprocess/src/file.ts` 实际导出为准；若字段名不是 `cssText/styleSheet/diagnostics`，以实际为准调整（Task 11 验收以生成物内容为准）。

- [ ] **Step 5: 生成并检查产物**

Run: `cd packages/ui && node scripts/build-styles.mjs`
Expected: 输出 `[pingo-ui] generated src/generated/styles.ts`；产物含 `.pui-button--default:hover` 与 `.pui-button--default.pui-dark` 等规则。

- [ ] **Step 6: 写皮肤解析测试**

`packages/ui/src/styles.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  STYLE_INTERACTION_STATES,
  resolveStyle,
} from "@dopejs/pingo-style";

import { createPingoUiStyleSheet, pingoUiCssText } from "./generated/styles";

const styleSheets = [createPingoUiStyleSheet()];

function resolve(className: string, interactionState = 0) {
  const result = resolveStyle({ nodeType: "view", className, styleSheets, interactionState });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.style;
}

describe("pingo-ui skin", () => {
  it("compiles without diagnostics", () => {
    expect(pingoUiCssText).toContain(".pui-button--default:hover");
    expect(pingoUiCssText).toContain(".pui-button--default.pui-dark");
  });

  it("resolves the default button in light theme", () => {
    const style = resolve("pui-button pui-button--default");
    expect(style.backgroundColor).toBe("#18181bff");
    expect(style.color).toBe("#fafafaff");
    expect(style.height).toBe(36);
  });

  it("resolves hover state from the precompiled interaction rules", () => {
    const style = resolve("pui-button pui-button--default", STYLE_INTERACTION_STATES.hover);
    expect(style.backgroundColor).toBe("#18181be6");
  });

  it("resolves the dark compound override", () => {
    const style = resolve("pui-button pui-button--default pui-dark");
    expect(style.backgroundColor).toBe("#fafafaff");
    expect(style.color).toBe("#18181bff");
  });

  it("dark hover wins over light hover by source order", () => {
    const style = resolve(
      "pui-button pui-button--default pui-dark",
      STYLE_INTERACTION_STATES.hover,
    );
    expect(style.backgroundColor).toBe("#fafafae6");
  });

  it("resolves muted description color in dark theme", () => {
    const style = resolve("pui-card-description pui-dark");
    expect(style.color).toBe("#a1a1aaff");
  });
});
```

- [ ] **Step 7: 跑测试并加 token-only 源码检查**

Run: `npx vitest run packages/ui/src/styles.test.ts`
Expected: 6 passed

token-only 硬约束检查（防止组件皮肤出现字面值），追加为 `packages/ui/scripts/build-styles.mjs` 中生成前的校验（插在编译之前）：

```js
// Token-only enforcement: component skins must reference variables, never
// literal colors or lengths. Reads each styles/components/*.scss file and
// rejects declaration values without a `t.$` token reference (pseudo-state
// blocks and class selectors are fine; only declaration values are checked).
import { readFile, readdir } from "node:fs/promises";

const componentsDir = path.join(packageDir, "styles", "components");
const declarationPattern = /^\s*[a-z-]+\s*:\s*([^;]+);/gmu;
for (const file of await readdir(componentsDir)) {
  if (!file.endsWith(".scss")) continue;
  const source = await readFile(path.join(componentsDir, file), "utf8");
  for (const match of source.matchAll(declarationPattern)) {
    const value = match[1] ?? "";
    if (!value.includes("t.$")) {
      console.error(`[pingo-ui] ${file}: literal value "${value.trim()}" — use a token from styles/tokens.scss`);
      process.exit(1);
    }
  }
}
```

注意：此检查要求皮肤里所有声明值都写 `t.$xxx`。上面 Step 3 的皮肤中 `height: 36px` 等尺寸是字面值——**调整方案：尺寸 token 化**。在 tokens.scss 追加：

```scss
// sizing scale (shadcn new-york)
$button-height: 36px !default;
$button-height-sm: 32px !default;
$button-height-lg: 40px !default;
$button-padding-x: 16px !default;
$button-padding-x-sm: 12px !default;
$button-padding-x-lg: 32px !default;
$badge-padding-x: 10px !default;
$badge-padding-y: 2px !default;
$card-padding: 24px !default;
$card-description-gap: 6px !default;
$input-height: 36px !default;
$input-padding-x: 12px !default;
$input-padding-y: 6px !default;
$font-size-xs: 12px !default;
$font-size-sm: 14px !default;
$font-size-xl: 20px !default;
$line-height-sm: 20px !default;
$font-weight-medium: 500 !default;
$font-weight-semibold: 600 !default;
```

并把 Step 3 皮肤中的字面值全部替换为对应 `t.$` 引用（`0` 可保留字面——检查脚本放行值为 `0` 的声明：在拒绝前加 `if (value.trim() === "0") continue;`）。

- [ ] **Step 8: Commit**

```bash
git add packages/ui/styles packages/ui/scripts packages/ui/src/generated packages/ui/src/styles.test.ts
git commit -m "feat(ui): add scss skin pipeline with shadcn default preset"
```

---

### Task 5: Button 组件

**Files:**
- Create: `packages/ui/src/components/button.ts`
- Test: `packages/ui/src/components/button.test.ts`

- [ ] **Step 1: 写失败测试**

`packages/ui/src/components/button.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { Button, type ButtonProps } from "./button";

afterEach(() => setTheme("light"));

function render(props: ButtonProps) {
  // Components evaluate to host descriptors without a root.
  return Button(props) as { type: unknown; props: Record<string, unknown> };
}

describe("Button", () => {
  it("composes default classes and button semantics", () => {
    const node = render({ children: "保存", onPress: () => {} });
    expect(node.props.className).toBe("pui-button pui-button--default");
    expect(node.props.semanticRole).toBe("button");
    expect(node.props.semanticLabel).toBe("保存");
  });

  it("applies variant and size", () => {
    const node = render({ children: "x", variant: "secondary", size: "sm" });
    expect(node.props.className).toBe("pui-button pui-button--secondary pui-button--sm");
  });

  it("appends the dark marker from the theme signal", () => {
    setTheme("dark");
    const node = render({ children: "x" });
    expect(node.props.className).toBe("pui-button pui-button--default pui-dark");
  });

  it("appends user className last and marks disabled", () => {
    const node = render({ children: "x", disabled: true, className: "mine" });
    expect(node.props.className).toBe(
      "pui-button pui-button--default pui-button--disabled mine",
    );
    expect(node.props.semanticValue).toBe("disabled");
    expect(node.props.onTap).toBeUndefined();
    expect(node.props.onClick).toBeUndefined();
  });

  it("wires press handlers when enabled", () => {
    const onPress = (): void => {};
    const node = render({ children: "x", onPress });
    expect(node.props.onTap).toBe(onPress);
    expect(typeof node.props.onPointerDown).toBe("function");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/ui/src/components/button.test.ts`
Expected: FAIL（`Cannot find module './button'`）

- [ ] **Step 3: 实现 button.ts**

`packages/ui/src/components/button.ts`:

```ts
import { Text, type PingoNode } from "@dopejs/pingo-jsx";
import { Pressable } from "@dopejs/pingo-widgets";

import { cva } from "../cva";
import { useTheme } from "../theme";

export type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
export type ButtonSize = "default" | "sm" | "lg" | "icon";

export interface ButtonProps {
  readonly children: string;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
  readonly className?: string;
  readonly semanticLabel?: string;
}

const buttonClass = cva({
  base: "pui-button",
  variants: {
    variant: {
      default: "pui-button--default",
      secondary: "pui-button--secondary",
      outline: "pui-button--outline",
      ghost: "pui-button--ghost",
      destructive: "pui-button--destructive",
    },
    size: {
      default: "",
      sm: "pui-button--sm",
      lg: "pui-button--lg",
      icon: "pui-button--icon",
    },
    theme: { light: "", dark: "pui-dark" },
    disabled: { true: "pui-button--disabled" },
  },
  defaultVariants: { variant: "default", size: "default" },
});

/**
 * shadcn-style button. Visuals come entirely from the skin classes; text
 * color and font inherit from the View into the inner Text node. The slot
 * contract (§6.2.1) does not apply here: no user JSX is passed through.
 */
export function Button(props: ButtonProps): PingoNode {
  const theme = useTheme();
  const disabled = props.disabled === true;
  const className = [
    buttonClass({ variant: props.variant, size: props.size, theme, disabled }),
    props.className,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return Pressable({
    className,
    disabled,
    onPress: props.onPress,
    semanticLabel: props.semanticLabel ?? props.children,
    children: Text({ value: props.children }),
  });
}
```

**实现注意**：`Pressable` 透传 `className` 并在 disabled 时省略 handler、设置 `semanticValue: "disabled"`、opacity 0.5——与测试断言一致。若测试 4 的 `onTap undefined` 断言因 Pressable 实现细节偏差失败，以 Pressable 实际行为为准修正断言（disabled 必须无 handler 是契约，不是实现细节）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/ui/src/components/button.test.ts`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/button.ts packages/ui/src/components/button.test.ts
git commit -m "feat(ui): add Button component"
```

---

### Task 6: Badge 组件

**Files:**
- Create: `packages/ui/src/components/badge.ts`
- Test: `packages/ui/src/components/badge.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { Badge } from "./badge";

afterEach(() => setTheme("light"));

describe("Badge", () => {
  it("composes default variant classes", () => {
    const node = Badge({ children: "Beta" }) as { props: Record<string, unknown> };
    expect(node.props.className).toBe("pui-badge pui-badge--default");
  });

  it("supports variants and dark theme", () => {
    setTheme("dark");
    const node = Badge({ children: "x", variant: "outline" }) as {
      props: Record<string, unknown>;
    };
    expect(node.props.className).toBe("pui-badge pui-badge--outline pui-dark");
  });

  it("appends user className last", () => {
    const node = Badge({ children: "x", className: "mine" }) as {
      props: Record<string, unknown>;
    };
    expect(node.props.className).toBe("pui-badge pui-badge--default mine");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/ui/src/components/badge.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 badge.ts**

```ts
import { Text, View, type PingoNode } from "@dopejs/pingo-jsx";

import { cva } from "../cva";
import { useTheme } from "../theme";

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

export interface BadgeProps {
  readonly children: string;
  readonly variant?: BadgeVariant;
  readonly className?: string;
  readonly semanticLabel?: string;
}

const badgeClass = cva({
  base: "pui-badge",
  variants: {
    variant: {
      default: "pui-badge--default",
      secondary: "pui-badge--secondary",
      destructive: "pui-badge--destructive",
      outline: "pui-badge--outline",
    },
    theme: { light: "", dark: "pui-dark" },
  },
  defaultVariants: { variant: "default" },
});

/** shadcn-style badge: non-interactive status label. */
export function Badge(props: BadgeProps): PingoNode {
  const theme = useTheme();
  const className = [badgeClass({ variant: props.variant, theme }), props.className]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return View({
    className,
    ...(props.semanticLabel === undefined ? {} : { semanticLabel: props.semanticLabel }),
    children: Text({ value: props.children }),
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/ui/src/components/badge.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/badge.ts packages/ui/src/components/badge.test.ts
git commit -m "feat(ui): add Badge component"
```

---

### Task 7: Card 组件族

**Files:**
- Create: `packages/ui/src/components/card.ts`
- Test: `packages/ui/src/components/card.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> };

describe("Card family", () => {
  it("composes card classes with dark marker", () => {
    setTheme("dark");
    expect((Card({ children: null }) as Host).props.className).toBe("pui-card pui-dark");
  });

  it("each section carries its own skin class", () => {
    expect((CardHeader({ children: null }) as Host).props.className).toBe("pui-card-header");
    expect((CardTitle({ children: "t" }) as Host).props.className).toBe("pui-card-title");
    expect((CardContent({ children: null }) as Host).props.className).toBe("pui-card-content");
    expect((CardFooter({ children: null }) as Host).props.className).toBe("pui-card-footer");
  });

  it("description picks up the dark marker and user className goes last", () => {
    setTheme("dark");
    const node = CardDescription({ children: "d", className: "mine" }) as Host;
    expect(node.props.className).toBe("pui-card-description pui-dark mine");
  });

  it("children pass through untouched (slot identity contract)", () => {
    const child = CardTitle({ children: "keep-me" });
    const node = CardHeader({ children: child }) as {
      props: { children: unknown };
    };
    expect(node.props.children).toBe(child);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/ui/src/components/card.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 card.ts**

```ts
import { Text, View, type PingoNode } from "@dopejs/pingo-jsx";

import { useTheme } from "../theme";

export interface CardSectionProps {
  readonly children: PingoNode;
  readonly className?: string;
}

export interface CardTextProps {
  readonly children: string;
  readonly className?: string;
}

function join(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part !== "").join(" ");
}

function section(base: string, props: CardSectionProps, themed: boolean): PingoNode {
  const theme = useTheme();
  return View({
    className: join(base, themed && theme === "dark" ? "pui-dark" : undefined, props.className),
    children: props.children,
  });
}

function text(base: string, props: CardTextProps, themed: boolean): PingoNode {
  const theme = useTheme();
  return Text({
    className: join(base, themed && theme === "dark" ? "pui-dark" : undefined, props.className),
    value: props.children,
  });
}

/** shadcn-style Card composition family. Slots pass through untouched. */
export function Card(props: CardSectionProps): PingoNode {
  return section("pui-card", props, true);
}

export function CardHeader(props: CardSectionProps): PingoNode {
  return section("pui-card-header", props, false);
}

export function CardTitle(props: CardTextProps): PingoNode {
  return text("pui-card-title", props, false);
}

export function CardDescription(props: CardTextProps): PingoNode {
  return text("pui-card-description", props, true);
}

export function CardContent(props: CardSectionProps): PingoNode {
  return section("pui-card-content", props, false);
}

export function CardFooter(props: CardSectionProps): PingoNode {
  return section("pui-card-footer", props, false);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/ui/src/components/card.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/card.ts packages/ui/src/components/card.test.ts
git commit -m "feat(ui): add Card composition family"
```

---

### Task 8: Input 组件（无 slot、无 placeholder）

**Files:**
- Create: `packages/ui/src/components/input.ts`
- Test: `packages/ui/src/components/input.test.ts`

已知缺口（写在组件注释）：无 placeholder（引擎不支持）；无 focus ring（需 `:focus-within` 或 E4）；prefix/suffix slot 等 E5/E6。

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { Input } from "./input";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> };

describe("Input", () => {
  it("renders the shell with skin classes and an editable field child", () => {
    const node = Input({ semanticLabel: "邮箱" }) as Host & {
      props: { children: { props: Record<string, unknown> } };
    };
    expect(node.props.className).toBe("pui-input");
    expect(node.props.children.props.className).toBe("pui-input__field");
  });

  it("marks disabled as readOnly with the disabled class", () => {
    const node = Input({ disabled: true }) as Host & {
      props: { children: { props: Record<string, unknown> } };
    };
    expect(node.props.className).toBe("pui-input pui-input--disabled");
    expect(node.props.children.props.readOnly).toBe(true);
  });

  it("appends the dark marker and user className", () => {
    setTheme("dark");
    const node = Input({ className: "mine" }) as Host;
    expect(node.props.className).toBe("pui-input pui-dark mine");
  });

  it("forwards onValueChange through the controller transaction path", () => {
    // Wiring detail: the component wraps onTransaction and reads the
    // controller's applied value. Verified structurally here.
    const node = Input({ onValueChange: () => {} }) as Host & {
      props: { children: { props: Record<string, unknown> } };
    };
    expect(typeof node.props.children.props.onTransaction).toBe("function");
    expect(node.props.children.props.controller).toBeDefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/ui/src/components/input.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 input.ts**

`packages/ui/src/components/input.ts`:

```ts
import { TextEditingController, type EditTransaction } from "@dopejs/pingo-editing";
import { Input as EngineInput, View, type PingoNode } from "@dopejs/pingo-jsx";
import { useMemo } from "@dopejs/pingo-runtime";

import { useTheme } from "../theme";

export interface InputProps {
  /** Initial value for uncontrolled usage; ignored when `controller` is set. */
  readonly value?: string;
  /** Called after each edit transaction with the controller-applied value. */
  readonly onValueChange?: (value: string) => void;
  /** Advanced escape hatch: caller-owned durable controller. */
  readonly controller?: TextEditingController;
  readonly onTransaction?: (transaction: EditTransaction) => void;
  readonly onSubmit?: () => void;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly password?: boolean;
  readonly inputMode?: "text" | "numeric" | "decimal" | "tel" | "email" | "url";
  readonly className?: string;
  readonly width?: number;
  readonly semanticLabel?: string;
}

function join(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part !== "").join(" ");
}

/**
 * shadcn-style decorated input. Known gaps (no hacks, tracked in the
 * capability plan): no placeholder (engine capability), no focus ring
 * (needs :focus-within or E4), no prefix/suffix slots (needs E5/E6).
 */
export function Input(props: InputProps): PingoNode {
  const theme = useTheme();
  const disabled = props.disabled === true;
  const controller = useMemo(
    () => props.controller ?? new TextEditingController({ value: props.value ?? "" }),
    [],
  );
  const readOnly = disabled || props.readOnly === true;
  return View({
    className: join(
      "pui-input",
      disabled ? "pui-input--disabled" : undefined,
      theme === "dark" ? "pui-dark" : undefined,
      props.className,
    ),
    ...(props.width === undefined ? {} : { width: props.width }),
    children: EngineInput({
      className: "pui-input__field",
      controller,
      readOnly,
      ...(props.password === undefined ? {} : { password: props.password }),
      ...(props.inputMode === undefined ? {} : { inputMode: props.inputMode }),
      ...(props.semanticLabel === undefined ? {} : { semanticLabel: props.semanticLabel }),
      onTransaction: (transaction) => {
        props.onValueChange?.(controller.value);
        props.onTransaction?.(transaction);
      },
      ...(props.onSubmit === undefined ? {} : { onSubmit: props.onSubmit }),
    }),
  });
}
```

**实现风险（实现时验证）**：`controller.value` 在 `onTransaction` 回调时点是否已应用该 transaction，取决于 reconciler 对 controller 的接线顺序。若 `controller.value` 读到的是旧值，改为在回调内先用 transaction delta 推导：`const applied = transaction.delta === undefined ? controller.value : controller.value.slice(0, transaction.delta.range.start) + transaction.delta.text + controller.value.slice(transaction.delta.range.end);`（仅当 controller 未自动应用时；以 `packages/editing/src/controller.ts` 实际语义为准，并补一条行为测试）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/ui/src/components/input.test.ts`
Expected: 4 passed（`useMemo` 在 root 外调用依赖 hook 上下文——若测试报 hook 错误，改用模块内惰性创建：`let fallback: TextEditingController | undefined;` 模式或直接在函数体 `const controller = props.controller ?? new TextEditingController(...)`（descriptor 直出场景每次调用重建可接受，因为 Input 作为组件由 reconciler 渲染时才有状态意义）。**以测试实际表现为准调整，并在代码注释记录选择。**）

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/input.ts packages/ui/src/components/input.test.ts
git commit -m "feat(ui): add decorated Input component"
```

---

### Task 9: Label 组件

**Files:**
- Create: `packages/ui/src/components/label.ts`
- Test: `packages/ui/src/components/label.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { Label } from "./label";

afterEach(() => setTheme("light"));

describe("Label", () => {
  it("renders label text with skin class", () => {
    const node = Label({ children: "用户名" }) as { props: Record<string, unknown> };
    expect(node.props.className).toBe("pui-label");
    expect(node.props.value).toBe("用户名");
  });

  it("appends dark marker and user className", () => {
    setTheme("dark");
    const node = Label({ children: "x", className: "mine" }) as {
      props: Record<string, unknown>;
    };
    expect(node.props.className).toBe("pui-label pui-dark mine");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/ui/src/components/label.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 label.ts**

```ts
import { Text, type PingoNode } from "@dopejs/pingo-jsx";

import { useTheme } from "../theme";

export interface LabelProps {
  readonly children: string;
  readonly className?: string;
  readonly semanticLabel?: string;
}

/** shadcn-style form label. No control association exists in pingo yet. */
export function Label(props: LabelProps): PingoNode {
  const theme = useTheme();
  const className = ["pui-label", theme === "dark" ? "pui-dark" : undefined, props.className]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return Text({
    className,
    value: props.children,
    ...(props.semanticLabel === undefined ? {} : { semanticLabel: props.semanticLabel }),
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/ui/src/components/label.test.ts`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/label.ts packages/ui/src/components/label.test.ts
git commit -m "feat(ui): add Label component"
```

---

### Task 10: 公开导出 + storybook 走通

**Files:**
- Modify: `packages/ui/src/index.ts`
- Modify: `apps/storybook/package.json`
- Modify: `apps/storybook/src/mount.ts`
- Create: `apps/storybook/src/PingoUi.stories.ts`

- [ ] **Step 1: packages/ui/src/index.ts**

```ts
export { cva } from "./cva";
export type { CvaCompound, CvaConfig, CvaProps } from "./cva";
export { getTheme, setTheme, useTheme } from "./theme";
export type { PingoUiTheme } from "./theme";
export { createPingoUiStyleSheet, pingoUiCssText } from "./generated/styles";
export { Badge } from "./components/badge";
export type { BadgeProps, BadgeVariant } from "./components/badge";
export { Button } from "./components/button";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./components/button";
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/card";
export type { CardSectionProps, CardTextProps } from "./components/card";
export { Input } from "./components/input";
export type { InputProps } from "./components/input";
export { Label } from "./components/label";
export type { LabelProps } from "./components/label";
```

- [ ] **Step 2: storybook 增加依赖与 mount styleSheets 支持**

`apps/storybook/package.json` dependencies 改为：

```json
  "dependencies": {
    "@dopejs/pingo": "workspace:*",
    "@dopejs/pingo-ui": "workspace:*"
  },
```

`apps/storybook/src/mount.ts`：函数签名与 root 创建处改为：

```ts
import { createHostedCanvasRoot, type PingoNode, type HostedCanvasRoot } from "@dopejs/pingo";
import type { PingoStyleSheet } from "@dopejs/pingo";

export function mountStory(
  render: () => PingoNode,
  options: {
    width?: number;
    height?: number;
    styleSheets?: readonly PingoStyleSheet[];
  } = {},
): HTMLElement {
```

`createHostedCanvasRoot(canvas, { ... })` 的 options 对象中追加：

```ts
    ...(options.styleSheets === undefined ? {} : { styleSheets: options.styleSheets }),
```

`PingoStyleSheet` 类型需确认 facade 已导出（`packages/facade/src/index.ts` 有 `type PingoStyleSheet` 导出——已验证存在）。Run: `pnpm install && pnpm --filter @dopejs/storybook typecheck`
Expected: 通过

- [ ] **Step 3: PingoUi.stories.ts**

```ts
import { createElement } from "@dopejs/pingo";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
  createPingoUiStyleSheet,
  setTheme,
  type PingoUiTheme,
} from "@dopejs/pingo-ui";
import type { Meta, StoryObj } from "@storybook/html-vite";

import { mountStory } from "./mount";

interface ShowcaseArgs {
  theme: PingoUiTheme;
}

const meta: Meta<ShowcaseArgs> = {
  title: "pingo-ui/Showcase",
  render: (args) => {
    setTheme(args.theme);
    return mountStory(
      () =>
        createElement("container", {
          width: 460,
          padding: 24,
          backgroundColor: args.theme === "dark" ? "#09090bff" : "#ffffffff",
          children: [
            createElement("container", {
              children: [
                Button({ children: "Default", onPress: () => {} }),
                Button({ children: "Secondary", variant: "secondary", onPress: () => {} }),
                Button({ children: "Outline", variant: "outline", onPress: () => {} }),
                Button({ children: "Ghost", variant: "ghost", onPress: () => {} }),
                Button({ children: "Destructive", variant: "destructive", onPress: () => {} }),
                Button({ children: "Disabled", disabled: true }),
              ].flatMap((node, index) =>
                index === 0 ? [node] : [createElement("container", { width: 8 }), node],
              ),
            }),
            createElement("container", { height: 16 }),
            createElement("container", {
              children: [
                Badge({ children: "Default" }),
                Badge({ children: "Secondary", variant: "secondary" }),
                Badge({ children: "Destructive", variant: "destructive" }),
                Badge({ children: "Outline", variant: "outline" }),
              ].flatMap((node, index) =>
                index === 0 ? [node] : [createElement("container", { width: 8 }), node],
              ),
            }),
            createElement("container", { height: 16 }),
            Card({
              className: undefined,
              children: createElement("container", {
                children: [
                  CardHeader({
                    children: createElement("container", {
                      children: [
                        CardTitle({ children: "账户设置" }),
                        CardDescription({ children: "管理你的账户偏好与通知。" }),
                      ],
                    }),
                  }),
                  CardContent({
                    children: createElement("container", {
                      children: [
                        Label({ children: "邮箱" }),
                        createElement("container", { height: 8 }),
                        Input({ semanticLabel: "邮箱", width: 360 }),
                      ],
                    }),
                  }),
                  CardFooter({
                    children: createElement("container", {
                      children: [
                        Button({ children: "保存", onPress: () => {} }),
                        createElement("container", { width: 8 }),
                        Button({ children: "取消", variant: "outline", onPress: () => {} }),
                      ],
                    }),
                  }),
                ],
              }),
            }),
          ],
        }),
      { width: 480, height: 560, styleSheets: [createPingoUiStyleSheet()] },
    );
  },
  args: { theme: "light" },
  argTypes: {
    theme: { control: "radio", options: ["light", "dark"] },
  },
};

export default meta;
type Story = StoryObj<ShowcaseArgs>;

export const Light: Story = { args: { theme: "light" } };
export const Dark: Story = { args: { theme: "dark" } };
```

**注意**：`Card` 的 props 类型是 `CardSectionProps`（`children: PingoNode`），上面调用中 `className: undefined` 应删除（精确可选属性类型下会报错）；实现时以 typecheck 为准清理。spacer 用定宽 `container` 是因为 schema 无 `gap`。

- [ ] **Step 4: 构建并人工验证 storybook**

Run: `pnpm packages:build && pnpm storybook:build`
Expected: 构建成功。然后 `pnpm storybook:dev`，浏览器打开 `http://localhost:6006/?path=/story/pingo-ui-showcase--light` 与 `--dark`：
- 五个 Button variant 视觉区分正确；hover 变色；
- dark 下全套组件切换暗色；
- Input 可聚焦输入。

**验证方式**：用 browser 工具打开两个 story 各截一张图确认渲染无异常（无空白画布、无报错 overlay）。

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/index.ts apps/storybook
git commit -m "feat(ui): export public surface and wire storybook showcase"
```

---

### Task 11: 全量门禁 + 收尾

- [ ] **Step 1: 包测试全绿**

Run: `npx vitest run packages/ui`
Expected: 全部通过（cva 5 + theme 3 + styles 6 + button 5 + badge 3 + card 4 + input 4 + label 2 = 32）

- [ ] **Step 2: 构建与类型检查**

Run: `pnpm --filter @dopejs/pingo-ui build && pnpm --filter @dopejs/pingo-ui typecheck && pnpm --filter @dopejs/storybook typecheck`
Expected: 全部通过

- [ ] **Step 3: 仓库级回归（确保新包不破坏既有门禁）**

Run: `pnpm test:run`
Expected: 全仓测试通过（含 style-preprocess 边界检查）

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test(ui): phase-0 gates green"
```

---

## 自审记录（计划作者已核对）

- **Spec 覆盖**：§4 包结构 → Task 1/4/10；§5 主题模型 → Task 3/4（compound class + signal context，ThemeProvider 以 `setTheme/useTheme` 实现，无 context API 的诚实替代）；§5.1 preset 配置化 → Task 4（tokens.scss 契约 + preset 文件 + token-only 检查）；§6.1 API 对齐 → 组件 props 形状；§6.2 slot 契约 → Card slot 透传测试（Task 7）；§8 第一批样板五组件 → Task 5–9。E1–E6 属阶段 2，不在本计划。
- **Placeholder 扫描**：三处"以实际为准"均为已标注的外部 API 形状风险（`compilePingoStyleFile` 返回字段、controller 应用时点、useMemo 在 descriptor 直出场景），各有明确 fallback，非占位。
- **类型一致性**：`PingoUiTheme`、`ButtonVariant/Size`、`BadgeVariant`、`CardSectionProps/CardTextProps`、`InputProps` 在测试、实现、index 导出间一致；cva `when`/`className` 字段名 Task 2 定义与 Task 5 使用一致。
