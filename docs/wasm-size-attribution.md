# M9 产品 Core WASM 体积归因

本报告固定 M9 候选门禁的构建口径和可回滚优化。产品硬上限仍为 `< 400 KiB` gzip；
M9 另设 `≤ 384 KiB` 工程门禁，以保留至少 16 KiB 的维护余量。

## 可复现口径

- Rust：`rustc 1.96.0 (ac68faa20 2026-05-25)`，由仓库 `rust-toolchain.toml` 固定；
- 打包：`wasm-pack 0.14.0`，target `web`，workspace release profile；
- Binaryen：`wasm-opt 117`，pass 列表写入生成的 `packages/host/wasm/manifest.json`；
- 冷环境：第一次 `wasm-pack build` 先原子填充它自带的 Binaryen cache，构建器随后验证
  cache 中的实际 `wasm-opt --version` 必须精确为 117；错误或缺失版本仍失败关闭；
- 命令：`pnpm core:wasm:repro` 在两个独立临时 target/output 目录 clean build，要求
  SHA-256、raw bytes 和 gzip bytes 三者完全一致；
- 冷启动：同一门禁实例化候选 WASM，并要求 `< 50ms`。

M8 基线 commit `b564140` 为 409,197 gzip bytes。M9 两次 clean build 均为
1,115,466 raw bytes、389,844 gzip bytes，SHA-256
`8ec99e23d010a33e725fe484fe83602391b5486505afd7c065b0872df61f6c78`。相对基线减少
19,353 gzip bytes；距离 384 KiB 工程上限仍有 3,372 bytes，距离 400 KiB 产品上限
有 19,756 bytes。

## 主要来源与优化

当前 raw section 归因由构建器直接解析 WASM v1 section，并断言总和等于文件大小：

| section          |   bytes | 说明                                        |
| ---------------- | ------: | ------------------------------------------- |
| code             | 862,006 | Core、布局、文本、协议和 Picture 指令实现   |
| data             | 247,479 | 静态表、字符串、字体/Unicode 相关数据       |
| function         |   3,915 | 函数索引表                                  |
| 其余全部 section |   2,066 | type/export/element/import/custom/header 等 |

体积恢复来自三项可独立回滚的构建/依赖调整：移除重复的直接 `ttf-parser` 依赖，使用稳定
WASM operator 编码避免额外兼容实现，以及在固定 Binaryen 版本上采用定点
duplicate-function-elimination、vacuum、DAE 和 instruction optimization。没有删除 ABI
解码校验、fallback、inline reference、编辑、无障碍或媒体能力，也没有放宽 fuzz、差分、
覆盖率或浏览器门禁。

同一依赖清理也让 `pingo-probe-wasm-budget` 的 aarch64 macOS 固定口径从
377,967/148,458 raw/gzip bytes 变为 377,807/148,428（分别减少 160/30 bytes）；
`docs/evidence/wasm-budget.v2.json` 已显式重审这一 host baseline，300 KiB 探针上限不变。

## 失败模式与回滚

- 任一 clean build 不同：拒绝候选，保留两个产物和工具版本做差分，不更新基线掩盖差异；
- gzip 超过 384 KiB：停止新增 Rust 能力，先按 section 和依赖树归因；400 KiB 产品上限
  不得作为日常余量使用；
- Binaryen 优化改变输出语义：撤销对应 pass，并以 native/WASM 字节差分、ABI golden、
  browser vertical slice 和 inline Picture oracle 定位；
- 冷启动超过 50ms：拒绝候选并回滚最近的构建或初始化路径变化。

生成 manifest 是构建产物，不作为手工基线提交；候选报告读取其 digest、section 归因和
`reproducibleCleanBuilds: 2`，但不会 tag、发布 npm 或修改线上配置。
