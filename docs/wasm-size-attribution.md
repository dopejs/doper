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

## 2026-08-22：有序容器回收

M9 之后只剩 3,372 bytes 余量，E5（flex 主轴）与 E1（keyboard）落地后余量降到
**42 bytes**，触发本文"gzip 超过 384 KiB：停止新增 Rust 能力，先按 section 和依赖树
归因"这一条。归因结果与处理如下。

### 归因方法

`scripts/attribute-wasm-code.mjs` 把 code section 的每个函数体按 name section 归给
函数与 crate。它是**诊断脚本，不是门禁**——门禁仍由 `measure-wasm-budget.mjs`
按 section 总量把关。产品构建被 strip，所以要单独构建一个保留 name section 的模块
（命令写在脚本头部注释里）；该构建不过 wasm-opt，绝对值比产品模块高约 12%，
本节只用它的**相对权重**。

### 归因结论

回收前 code bodies 共 972,953 bytes / 4,281 个函数。最大单项不是任何渲染代码：

| 归属                        |   bytes |  占比 |
| --------------------------- | ------: | ----: |
| `alloc::collections::btree` | 216,100 | 22.2% |
| `core`（fmt/slice/num 等）  | 110,090 | 11.3% |
| pingo-core                  |  95,991 |  9.9% |
| swash（shaping）            |  83,823 |  8.6% |
| hashbrown                   |  50,025 |  5.1% |

`BTreeMap`/`BTreeSet` 按 (K, V) 单态化，每一对都会生成完整的节点平衡、分裂、
合并与导航代码。Core 里有约 20 个不同的 (K, V) 组合，平均每个约 10.8 KB。

### 处理

新增 `core/pingo-collections`：`OrderedMap` / `OrderedSet`，用**有序 Vec + 二分查找**
提供同样的有序迭代与 `O(log n)` 查找，插入/删除改为移动元素而非重平衡节点。
每个单态化约几百字节而非 10.8 KB。

**只替换小的或批量重建的映射**，插入密集的大映射（`BTreeMap<NodeId, PlanNode>`、
`BTreeMap<u32, Resource>`）仍是 `BTreeMap`——有序 Vec 在那里会把提交变成 `O(n²)`。
已替换：interaction 的 pointer/capture/mask、scroll 的 state/materialized、
animation 的 durable/transition/keyframe、editing 的 session、
scene 的 `Prop` 通道与 interaction state。

`OrderedMap::from_iter` 一开始逐条 `insert`，对乱序输入是 `O(n²)`；这在 m1 上表现为
p95 +3.6%。改为一次排序后，m1 回到基线的 ±1% 内（噪声范围）。

### 结果

| 指标               |               回收前 |      回收后 |
| ------------------ | -------------------: | ----------: |
| gzip               |              393,174 | **362,853** |
| 384 KiB 余量       |                   42 |  **30,363** |
| code section       |              869,844 |     727,730 |
| 函数数（带名构建） |                4,281 |       3,586 |
| m1 p95             | 3.026 ms（基线均值） |    3.057 ms |
| m3 p95             |              0.79 µs |     0.75 µs |

即使把 E5+E1 新增的能力算进去，产品模块也比 M9 基线（389,844）小 26,991 bytes。

### 下一批候选（尚未动手）

- `core float formatting`（flt2dec，约 16 KB）：错误类型的 `Display` 用 `{self:?}`
  打印带 `f32` 字段的结构，拉进了完整的最短浮点表示算法。
- `hashbrown`（约 50 KB）：paint 的 `HashMap<NodeId, Arc<CachedSubtree>>` 等；
  改有序容器还能顺带去掉一处哈希序依赖，但 n 较大，需要先测。
- 剩余 `alloc::btree`（约 63 KB）：即上面刻意保留的大映射，要换需要先解决
  批量插入的复杂度。

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

## 2026-08-22：E8 布局回读通路

| 阶段                                                | gzip bytes | 增量   |
| --------------------------------------------------- | ---------- | ------ |
| E8 之前                                             | 369,999    | —      |
| E8-1/E8-2 `ObserveGeometry` + `layoutGeometryBatch` | 371,101    | +1,102 |
| E8-3…E8-7 Core 导出、观察集、诊断字段               | 371,133    | +32    |

**合计 +1,134 bytes**，工程预算 393,216 仍余 22,083。远低于立项时 5–15 KB 的预估，
原因是新增的 Rust 代码几乎全是编解码与集合操作，没有引入新依赖，也没有新的
monomorphisation 面——观察集用的是既有的 `pingo-collections::OrderedSet`，几何重算
复用 `pingo-hit` 已有的仿射与裁剪折叠，`WorldGeometry` 一个字节都没加宽。

因此**没有动用**工程预算到产品预算之间那 16,384 的余量。子计划 E8-8 允许动用它，
但这次不需要，这条记录是为了让"允许"不被读成"已经用了"。

## 失败模式与回滚

- 任一 clean build 不同：拒绝候选，保留两个产物和工具版本做差分，不更新基线掩盖差异；
- gzip 超过 384 KiB：停止新增 Rust 能力，先按 section 和依赖树归因
  （`scripts/attribute-wasm-code.mjs` 给出按函数/crate 的明细）；400 KiB 产品上限
  不得作为日常余量使用；
- Binaryen 优化改变输出语义：撤销对应 pass，并以 native/WASM 字节差分、ABI golden、
  browser vertical slice 和 inline Picture oracle 定位；
- 冷启动超过 50ms：拒绝候选并回滚最近的构建或初始化路径变化。

生成 manifest 是构建产物，不作为手工基线提交；候选报告读取其 digest、section 归因和
`reproducibleCleanBuilds: 2`，但不会 tag、发布 npm 或修改线上配置。
