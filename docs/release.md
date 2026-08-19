# doper npm 发布流程

> 状态：初版（2026-08-17）。发布集共 10 个包：公开入口 `@dopejs/pingo`、
> 迁移边界 `@dopejs/pingo-compat`，以及它们的依赖闭包（runtime/jsx/
> editing/reconciler/host/backend-canvas2d/widgets/a11y）。内部包的
> description 均标注 "internal"，公开契约只有 facade 与 compat 的导出面
> （迁移扫描器阻止业务 import 内部包）。

## 1. 版本策略

- 全部 10 个包**同版本**发布；`ENGINE_VERSION`（facade 导出）与包版本
  必须一致，`pnpm npm:release:verify` 强制校验。
- npm semver 与 ABI 版本独立：ABI（`ENGINE_ABI_VERSION`）只在二进制协议
  不兼容时递增，并伴随 golden fixture 显式更新；npm 版本按 semver 管理
  公开 API（`benchmarks/api/*.d.ts` 快照即公开面审阅记录）。
- 0.x 阶段 minor 允许 breaking，需在 CHANGELOG 与 API 快照 diff 中明示。
- 内部包（`@dopejs/pingo-*`，compat 除外）不承诺任何稳定性；pnpm 发布时
  facade 对它们的依赖被固定为精确版本，同版本原子发布避免内部漂移。

## 2. GitHub 发版（推荐路径）

推送 `v*` tag 即触发 `.github/workflows/release.yml`：

1. 校验 tag 与 `ENGINE_VERSION` 一致（不一致直接失败）。
2. 在发布提交上跑完整 `pnpm m5:check`（M0→M5 全链；CI 无 GPU 时后端差分
   如实输出 SKIPPED）。
3. `pnpm npm:release:verify` 校验全部 tarball。
4. 创建 GitHub Release：自动生成 release notes，附上 10 个包的 tarball 与
   `wasm-manifest.json`（事故时用于 CDN 资产 digest 对照）。
5. 配置了 `NPM_TOKEN` secret 时以 npm provenance 发布全部包；未配置则在
   Release 上注明跳过，可后续本地补发。

操作序列：

```sh
node scripts/set-release-version.mjs 0.2.0 && pnpm install
# 更新 CHANGELOG.md 的 Unreleased 段落
git commit -am "release: v0.2.0"
git tag v0.2.0 && git push origin main v0.2.0
```

## 3. 本地手动发布（备用路径）

```sh
# 1. 设定版本（同步 10 个包 + ENGINE_VERSION）
node scripts/set-release-version.mjs 0.2.0
pnpm install   # 刷新 lockfile 中的 workspace 版本

# 2. 全量工程门禁（M0→M5 全链）
pnpm m5:check

# 3. 发布产物验证（tarball 内容、依赖闭包、workspace 区间重写）
pnpm npm:release:verify

# 4. 提交版本与验证结果，打 tag
git commit -am "release: v0.2.0" && git tag v0.2.0

# 5. 发布（需要 npm 凭证；pnpm 按拓扑序发布全部非 private 包）
pnpm npm:release:publish
```

`npm:release:publish` 内部执行 `pnpm -r publish --access public`；
pnpm 在打包时自动把 `workspace:*` 重写为当前精确版本，
`npm:release:verify` 已对实际 tarball 校验过该重写。

## 4. 发布内容校验

`scripts/check-npm-release.mjs` 对**实际 tarball** 断言：

- `dist/` 产物、类型与 source map 齐备；host 包含 `wasm/doper_core_bg.wasm`
  与 SHA-256 `manifest.json`（与 `pnpm release:check` 的完整性口径一致）。
- 不泄漏 `src/`、`*.test.*`、`*.browser.*`。
- 无残留 `workspace:` 依赖区间；`@dopejs/*` 依赖闭包全部在发布集内。
- 版本与 `ENGINE_VERSION` 一致、`publishConfig.access` 为 public。

## 5. 回滚

- 发布后发现缺陷：优先发 patch 版本；`npm deprecate` 标注问题版本。
  不依赖 unpublish（72 小时窗口且破坏下游 lockfile）。
- 业务侧回滚与放量控制见 `docs/runbook.md`（灰度关断不依赖 npm 回滚）。
- WASM 资产完整性：事故时用 `manifest.json` digest 对照 CDN 内容
  （见 `docs/diagnostics.md`）。
