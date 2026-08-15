# ADR-0005：二进制流使用版本化事务封套

- 状态：Accepted
- 日期：2026-08-15
- 决策者：doper maintainers
- 关联设计：`docs/design.md` §6、§7、§15.4

## Context

Mutation Stream、Input Stream、Replay Recording 与 DisplayList 都跨越进程内信任边界。只有 opcode 和隐式 payload
长度时，接收方无法在分配或解释指令前可靠校验版本、总长度和指令数量，也无法区分
截断、协议漂移与正常的未知指令。Mutation Stream 还必须保证畸形批次不会部分修改
Scene，DisplayList 必须避免在发现尾部损坏前已经画出半帧。

Rust 与 TypeScript 若分别手写 opcode、prop、失效域或布局常量，协议漂移会变成
内存级或静默渲染错误。因此这些信息必须来自同一个机器可读 schema。

## Decision

- 所有流都使用固定 16 字节、小端、四字节对齐的 header：
  `[magic:u32, abi_version:u16, header_bytes:u16, stream_bytes:u32,
instruction_count:u32]`。
- Mutation Stream magic 为 `DOPM`，Input Stream 为 `DOPI`，Replay Recording 为
  `DOPR`，DisplayList 为 `DOPD`；ABI v1 只接受精确
  版本匹配。协商失败由 Host 选择兼容 Core 或安全降级路径，不能猜测解析。
- 指令 header 为 `[opcode:u8, flags:u8, reserved:u16]`。ABI v1 尚未定义 flags，
  因此 flags、reserved 和 padding 必须为零；新增语义需要版本化，而不是静默忽略。
- `schemas/protocol.v1.json` 是 header、opcode、字段布局、node/resource kind、prop、
  失效元数据和大小限制的单一来源。生成器同时产出 Rust 与 TypeScript 表示，
  `pnpm protocol:check` 在生成物陈旧时失败。
- Mutation/Input 解码是事务性的：完整校验长度、计数、字段、资源上限和末尾唯一
  Commit 后才返回 batch。Recording 在暴露任何记录前递归验证其中每个 Mutation/Input
  payload。DisplayList 在回放前完整校验，并要求 Save/Restore 平衡。
- ABI v1 限制 Mutation Stream 为 16 MiB/262,144 条指令、DisplayList 为
  32 MiB/1,048,576 条指令、Input Stream 为 16 MiB/262,144 条指令、Recording 为
  64 MiB/1,048,576 条记录、单资源为 8 MiB；所有容量和长度计算必须在分配前检查
  溢出、显式上限与输入可实现的最大指令/记录数。
- 成功帧诊断使用 schema 生成的 14 个 `u32` word v1 布局，Core/Host 同时校验布局
  版本和 `frame_seq`；picture hash 按低/高 word 传输，避免单独维护跨语言 offset。

## Compatibility impact

这是 doper 的首个正式 ABI，没有需要迁移的既有发布版本。未来任何不兼容布局变化都
必须提升 ABI 版本、生成新 golden，并在 Host 握手中保留可诊断的降级行为。目录名不
属于 ABI；TypeScript 包目录保持简洁，npm 包名仍使用 `@dopejs/doper-*` 命名空间。

## Verification

- Rust/TypeScript 分别验证 canonical round-trip、截断、未知 opcode/record kind、错误
  prop wire type、非有限浮点、恶意计数、未定义 flags、Commit、嵌套流和图形状态栈
  不变式。
- `pnpm protocol:check` 用正式 golden 执行 TypeScript 编码 → Rust 解码/重编码，
  并让两侧共同接受同一 DisplayList golden。
- Rust 属性测试对任意字节输入验证解码不 panic；`core/doper-abi/fuzz` 为 Mutation、
  Input、Recording 与 DisplayList 提供四个 `cargo-fuzz` target，供 nightly 和发布前
  持续运行。

## Failure modes and rollback

解码失败必须保留上一份已提交 Scene/帧，并输出结构化错误；不得跳过未知指令或尝试
部分恢复。若新 ABI 在发布前暴露问题，回滚生成 schema、两侧 codec 与 golden 为同一
提交；若发布后存在多版本，Host 回退到兼容 Core 或上一条后端路径，而不是放宽校验。
