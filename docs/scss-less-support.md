# SCSS / Less 支持设计

> 状态：已完成（2026-08-21）
> 所属规划：[`pingo-ui-capability-plan.md`](./pingo-ui-capability-plan.md)
> 关联文档：[`css-events-plan.md`](./css-events-plan.md)、[`design.md`](./design.md) §12.1
> 定位：构建期作者体验扩展；不改变 Shell/Core 边界、CSS subset、ABI 或 Core

---

## 1. 审查结论

原方案的总方向正确：SCSS/Less 必须先在 Node 构建期编译成 CSS，再交给现有
`compileStyleSheet` 校验；Sass、Less 不能进入 facade、浏览器 bundle 或 Core。

但原方案不能直接实施，主要缺口如下：

1. 示例生成模块从 `@dopejs/pingo-style` 导入，违反业务代码只依赖公开 facade 的边界。
2. 没有区分“DOM CSS 预处理”和“pingo stylesheet 预处理”，同一个 `.scss` 导入可能被
   误解为会生成 `PingoStyleSheet`。
3. 直接 transform `.scss`/`.less` 会与 Vite 自带 CSS pipeline 竞争，可能发生 CSS 注入、
   重复预处理或插件顺序差异。
4. Sass partial / Less import 的依赖图没有进入 bundler watch graph；修改 token 或 mixin
   可能不触发 HMR/重构建。
5. Sass 同步抛错、Less Promise rejection 与 pingo CSS diagnostics 没有统一成稳定契约。
6. 诊断只指向生成 CSS，不足以定位原始 SCSS/Less；source map 不应推迟到无法排障之后。
7. 未限制 Less JavaScript/plugin、远程导入和自定义 importer，构建工具的执行边界不明确。
8. 新 Node-only 包的发布集合、子路径导出、依赖闭包和 tarball 门禁没有设计。
9. 把 pingo-ui Button 样板列为预处理器完成条件，混入了组件产品范围；应使用独立 fixture
   验证，避免两项工作互相阻塞。

以下方案保留正确的分层，修正上述问题。

---

## 2. 目标与非目标

### 2.1 目标

- 在仓库的 Vite 应用中支持普通 `.scss` / `.less` DOM 样式导入。
- 提供显式的 `?pingo-style` 导入，将 SCSS/Less 编译并校验为 `PingoStyleSheet`。
- 提供 Node-only 编译 API，供 Vite、CLI、codegen 或非 Vite 构建系统复用。
- 预处理错误和 pingo CSS subset 错误都能定位到原始作者文件。
- partial/import 变化能稳定触发 watch、HMR 和生产重构建。
- 构建结果可复现，错误失败关闭，运行时不包含 Sass/Less。

### 2.2 非目标

- 不在浏览器、Shell runtime、facade、Worker、WASM 或 Core 中运行 Sass/Less。
- 不扩大 pingo CSS subset；后代选择器、`@media`、`@supports`、`@keyframes`、
  `var()`、`calc()`、`em/rem/vw/vh` 仍按现有诊断拒绝。
- 不把普通 DOM `.scss` / `.less` 自动解释成 pingo stylesheet。
- 不在本里程碑交付 pingo-ui 组件、主题系统或新的 Core style property。
- 不引入可执行 Less plugin、自定义 Sass function 或网络 importer。

---

## 3. 两种导入语义必须分开

### 3.1 普通 Vite DOM 样式

```ts
import "./site.scss";
import "./probe.less";
```

这条路径使用 Vite 自带预处理能力，输出 DOM CSS 并由 Vite 注入或抽取。仓库只需固定
兼容的 Sass/Less 编译器版本，不增加自定义插件。

它只适用于文档站、平台探针和 Storybook 外壳，不产生 `PingoStyleSheet`。

### 3.2 pingo stylesheet

```ts
import { createHostedCanvasRoot } from "@dopejs/pingo";
import buttonSheet from "./button.scss?pingo-style";
import themeSheet from "./theme.less?pingo-style";

const root = await createHostedCanvasRoot(canvas, {
  styleSheets: [buttonSheet, themeSheet],
});
```

`?pingo-style` 是显式类型边界：构建期先预处理和校验，生成的 JavaScript 模块默认导出
`PingoStyleSheet`，且不会向 DOM 注入 CSS。

为上述查询导入提供类型声明：

```ts
declare module "*.scss?pingo-style" {
  const sheet: import("@dopejs/pingo").PingoStyleSheet;
  export default sheet;
}

declare module "*.less?pingo-style" {
  const sheet: import("@dopejs/pingo").PingoStyleSheet;
  export default sheet;
}
```

---

## 4. 固定架构

```text
SCSS / Less entry + partials/imports
              │ Node-only compiler package
              │ source map + dependency graph
              ▼
CSS text（expanded、无 sourceMappingURL）
              │ build-time compileStyleSheet validation
              ▼
generated ESM module
              │ imports createStyleSheet from @dopejs/pingo
              ▼
PingoStyleSheet（browser 中仅执行现有轻量 CSS compiler）
              │ existing Shell resolver / ABI
              ▼
Core canonical typed values
```

关键约束：

- Node 编译器可在实现内部依赖 `@dopejs/pingo-style` 做构建期校验。
- 生成给业务应用的模块只能从 `@dopejs/pingo` 导入公开 API。
- 当前 `PingoStyleSheet` 的规则是带私有 symbol 的不可变对象，不能安全 JSON 序列化。
  因此首版把已验证的 CSS 文本写入生成模块，并在模块初始化时调用一次
  `createStyleSheet`。这不会携带 Sass/Less，也不会改变现有运行时语义。
- 若未来要消除这次轻量解析，必须先设计版本化、可校验的 stylesheet artifact 格式和
  public hydration API；不能读取或序列化当前内部字段。

---

## 5. Node-only 包

新增 `packages/style-preprocess`，发布名 `@dopejs/pingo-style-preprocess`。

### 5.1 包边界

- `type: module`，`engines.node` 与仓库 Node 下限一致。
- exports 包含 Node 工具入口 `.`、Vite 插件入口 `./vite`，以及只提供 TypeScript
  查询模块声明的 `./client`。
- 直接依赖固定版本的 `sass` 与 `less`；两种语法开箱即用，接受安装体积换取确定性。
- 依赖 `@dopejs/pingo-style` 仅用于 Node 构建期校验。
- 不被 facade、host、jsx、widgets 或任何浏览器运行时包依赖。
- 加入 npm publish set、版本一致性、依赖闭包、legal files、source map 和 tarball 检查。

仓库根同时把相同版本的 `sass` / `less` 声明为 devDependency，供 Vite 原生 DOM CSS
预处理解析；lockfile 只保留一套版本。

### 5.2 API 契约

Sass 的官方 API 是同步或异步返回，Less 的 `render` 是 Promise。公开契约不伪装二者相同：

```ts
interface StylePreprocessResult {
  readonly language: "scss" | "less";
  readonly cssText: string | null;
  readonly styleSheet: PingoStyleSheet | null;
  readonly diagnostics: readonly StylePreprocessDiagnostic[];
  readonly dependencies: readonly string[];
}

function compileScssString(source: string, options?: ScssPreprocessOptions): StylePreprocessResult;

function compileLessString(
  source: string,
  options?: LessPreprocessOptions,
): Promise<StylePreprocessResult>;

function compilePingoStyleFile(
  filename: string,
  options?: FilePreprocessOptions,
): Promise<StylePreprocessResult>;
```

- `compile*` 对作者输入错误不抛异常，而是返回 `styleSheet: null` 和稳定 diagnostics。
- 文件读取失败、无效调用参数、编译器加载失败等操作错误可以抛异常。
- `createStyleSheetFromScss` / `createStyleSheetFromLess` 是 throwing convenience API；
  作者错误统一抛 `StylePreprocessError`，并保留全部 diagnostics。
- SCSS 字符串 API 保持同步，因此只处理无 import 的源码；有 import 时返回
  `file-api-required`。Less 字符串 API 只有在提供绝对 `sourceName` 后才解析相对 import。
  Vite 统一使用异步文件 API，避免相对解析基准不明确，并完成 canonical dependency 校验。

### 5.3 统一诊断

```ts
interface StylePreprocessDiagnostic {
  readonly stage: "scss" | "less" | "pingo-css";
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly generatedLocation?: StyleSourceLocation;
  readonly sourceLocation?: StyleSourceLocation;
}
```

- Sass exception / Less rejection 转为 `stage: "scss" | "less"`。
- `compileStyleSheet` diagnostics 转为 `stage: "pingo-css"`。
- 两个编译器首版都开启 source map；pingo CSS 的生成位置必须尽力映射回原始文件。
- 无法映射时必须保留 `generatedLocation` 和 entry source name，不得伪造原始位置。
- diagnostics 按生成位置和 code 稳定排序，保证 CI 输出和 snapshot 可复现。

---

## 6. 编译器策略与安全边界

### 6.1 Sass

- 使用 Dart Sass modern JS API，输出 `style: "expanded"`、`charset: false`、
  `sourceMap: true`。
- entry 传 canonical file URL，确保相对 `@use` / `@import` 有稳定基准。
- 用 `loadedUrls` 形成完整依赖集合；只接受 `file:` URL。
- 不开放 custom importer、custom function 或 Node package importer。

### 6.2 Less

- 使用 `less.render`，传绝对 `filename`、显式 `paths` 和 source map options。
- 用返回值的 `imports` 形成完整依赖集合。
- 固定 `javascriptEnabled: false`，不传 plugins，并在预扫描中拒绝 `@plugin`。
- 不开启 `insecure`，不允许 HTTP(S) 或协议相对导入。

### 6.3 共同限制

- 默认 allow roots 为 entry 所在目录和显式配置的 load paths；所有依赖 canonicalize 后
  必须位于 allow roots 内。
- 拒绝 symlink 逃逸、非文件依赖、远程依赖和不在 allow roots 中的文件。
- 编译后 CSS 必须先通过现有 1,048,576 code-unit 上限，再进入 `compileStyleSheet`。
- 对 entry、依赖数量和依赖总字节设置显式预算；超限产生稳定构建错误。
- compiler 版本由 lockfile 固定，fixture 的 CSS、diagnostics 和 dependency list 做
  reproducibility snapshot；升级编译器必须显式审查差异。

这些限制只约束 pingo stylesheet 工具；普通 Vite DOM 样式仍遵循 Vite 自己的配置。

---

## 7. Vite 插件设计

入口：`@dopejs/pingo-style-preprocess/vite`。

### 7.1 模块处理

插件只匹配精确 query flag `pingo-style` 和 `.scss` / `.less` 扩展名。

1. `resolveId` 去掉 query 后调用 `this.resolve`，尊重 Vite alias 和正常文件解析。
2. 返回带插件 namespace 的内部 virtual id，隔离 Vite 原生 CSS pipeline，防止 DOM CSS
   注入或二次预处理。
3. `load` 调用 `compilePingoStyleFile`。
4. entry 与全部 dependencies 逐一调用 `this.addWatchFile`。
5. 任一 error diagnostic 使用插件上下文失败关闭构建；warning 保留源位置输出。
6. 生成普通 ESM，并绑定构建时 CSS subset 版本：

```ts
import { CSS_SUBSET_VERSION, createStyleSheet } from "@dopejs/pingo";

if (CSS_SUBSET_VERSION !== EXPECTED_CSS_SUBSET_VERSION) {
  throw new Error("pingo stylesheet was built for a different CSS subset");
}
export default createStyleSheet(COMPILED_CSS, { sourceName: ORIGINAL_SOURCE_NAME });
```

这项检查覆盖应用把 facade externalize 到不同版本的情况；版本不一致必须在注册 stylesheet
前失败，不能让构建期校验与运行时解释使用不同语义。

virtual id 会牺牲生成的微型 JS 模块到 SCSS 文件的常规 JS source map；作者诊断由预处理
source map 单独承担。这样可明确避开 Vite CSS pipeline，优先保证语义正确和无 DOM 注入。

### 7.2 Watch、HMR 与缓存

- Sass `loadedUrls`、Less `imports` 必须全部加入 watch graph。
- 任一 partial 变化必须使所属 `?pingo-style` 模块重新执行 `load` 并触发 HMR。
- 首版不维护独立编译缓存，复用 Vite 模块图缓存；这样不会因只看 entry mtime 而漏掉
  partial/import 变化。未来若 profiling 证明需要独立缓存，key 必须至少包含 language、
  entry 与所有依赖内容、规范化 options、Sass/Less version 和 `CSS_SUBSET_VERSION`。
- dev、production、SSR 三种 Vite environment 必须生成语义一致的 stylesheet。

### 7.3 不使用 Vite 私有 CSS API

Vite 存在实验性的 `preprocessCSS`，但本功能需要稳定的依赖图、诊断映射和无 CSS 注入
模块语义。首版直接调用固定版本 Sass/Less 公共 API，不依赖 Vite 实验接口。

---

## 8. pingo CSS 兼容扩展

预处理器常输出颜色函数。Shell-only 增加以下输入并统一归一到现有 `rgba8`：

- `rgb()` / `rgba()`：number 或百分比 channel，number 或百分比 alpha；
- `hsl()` / `hsla()`：标准 hue 单位与百分比 saturation/lightness；
- legacy comma 与现代 space/slash 形式；
- channel 和 alpha 按 CSS clamp 规则处理，8-bit 输出使用固定 rounding 规则。

每种函数必须与等价 `#rrggbbaa` 做 canonical 对比。不增加 ABI tag，不改 Core。

超出该集合的输出，例如 `color(display-p3 ...)`、CSS 自定义属性、`calc()`，继续由
`compileStyleSheet` 失败关闭。不能为“让 Sass/Less 用起来”而隐式扩大 CSS subset。

---

## 9. 测试与工程门禁

### 9.1 编译 API

- SCSS：变量、mixin、`@each`、算术、`&:hover`、`&.variant`、partial `@use`。
- Less：变量、mixin、guard/loop、算术、`&:hover`、import。
- 两种产物都必须通过 `compileStyleSheet`，并得到确定的 rule count/content hash。
- 语法错误、后代选择器、at-rule、`var()`、未支持单位、超限输入返回稳定 diagnostics。
- Less `@plugin` / JavaScript、远程 import、allow-root 逃逸必须失败。
- source map 用例断言 diagnostics 指回原始 entry 或 partial。

### 9.2 Vite 集成

- 真实 Vite fixture 同时导入 `.scss?pingo-style` 和 `.less?pingo-style`。
- production 与 SSR build 都成功，导出值可被 root 注册。
- 构建产物不包含 Sass/Less runtime module、compiler banner 或动态编译调用。
- 不生成对应 CSS asset，不向 DOM 注入 style。
- 修改 Sass partial / Less import 后，watch build 必须重跑并改变输出 hash。
- 普通 `.scss` / `.less` fixture 另行证明 Vite DOM 样式路径可用，避免混淆两种语义。

### 9.3 边界与发布

- `@dopejs/pingo` API snapshot 不因本功能变化。
- facade、style、host 等浏览器包的依赖图不出现 `sass`、`less` 或
  `style-preprocess`。
- Node-only 包的 `.` / `vite` / `client` types、ESM、实现模块 source maps、legal files
  和 tarball 均验证。纯 re-export 的 `dist/index.js` 没有可映射执行语句，构建器不会为它
  生成空 source map；实际编译器 chunk 与 Vite 入口都必须带 map。
- 两次 clean build 的生成模块、diagnostics、dependencies 和 content hash 完全一致。
- 完成后串联现有 style、API、npm release、browser 和 M9 工程门禁；WASM 大小应保持
  字节不变，若变化视为边界泄漏。

---

## 10. 交付顺序

1. **颜色函数**：Shell parser + canonical/property tests，不改 ABI。
2. **Node 编译核心**：统一结果/诊断、依赖图、source map、导入安全边界。
3. **Vite 插件**：query resolution、隔离 CSS pipeline、watch/HMR、SSR。
4. **仓库原生 DOM 支持**：固定 Sass/Less devDependencies，加入两种真实构建 fixture。
5. **发布与边界门禁**：Node-only tarball、依赖图、clean-build reproducibility。
6. **文档与样板**：API/作者指南；pingo-ui 样板作为后续消费者，不作为本功能 blocker。

---

## 11. 失败模式与回滚

| 失败模式                               | 处理                                                 |
| -------------------------------------- | ---------------------------------------------------- |
| 预处理语法错误                         | 构建失败，定位原始文件                               |
| 产物超出 pingo CSS subset              | 构建失败，同时保留生成位置和映射后的源位置           |
| partial/import 不可读或越过 allow root | 构建失败，不回退为普通 CSS                           |
| Sass/Less compiler 升级改变输出        | reproducibility/snapshot 门禁失败，显式审查后升级    |
| Vite 插件未配置                        | `?pingo-style` 无法解析，构建失败，不产生错误样式    |
| HMR 编译失败                           | 保留上一已提交模块，dev server 报错；生产 build 失败 |

回滚不需要 ABI、数据或 Core 迁移：移除 Vite 插件和 `?pingo-style` imports，恢复等价
CSS 文本/对象 stylesheet；Node-only 包和编译器依赖可以独立撤回。普通 DOM SCSS/Less
支持也可通过移除对应 import 和 devDependency 单独回滚。

---

## 12. 官方行为依据

- [Vite CSS preprocessors](https://vite.dev/guide/features#css-pre-processors)：Vite 原生支持
  Sass/Less，但要求安装对应 compiler。
- [Vite plugin API](https://vite.dev/guide/api-plugin)：custom file、virtual module、
  `resolveId` / `load` 约定。
- [Rolldown PluginContext](https://rolldown.rs/reference/Interface.PluginContext)：
  `addWatchFile` 的 rebuild 语义。
- [Dart Sass CompileResult](https://sass-lang.com/documentation/js-api/interfaces/compileresult/)：
  `loadedUrls` 与 source map。
- [Less programmatic usage](https://lesscss.org/usage/#programmatic-usage)：`less.render` 的
  Promise、`imports` 与 map。
