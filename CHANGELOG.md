# Changelog

版本口径见 `docs/release.md`：11 个包同版本原子发布，npm semver 与二进制
ABI 版本独立管理。

## Unreleased

- 项目许可证从下一次 npm 发布起由 MIT 切换为 Apache-2.0；v0.2.1 及以前
  的已发布版本仍保持 MIT。
- ABI 17 新增事务化 Picture 资源流；Core 可复用 immutable 子树，Canvas2D 后端原子安装、
  引用和释放资源，并保留 `incrementalPicturesEnabled` 内联回退开关。
- M9 增加 rich-scroll 性能/复杂度门禁、optimized/inline 像素差分、native/WASM 生命周期
  差分、组合 soak、WASM 384 KiB 余量门禁和两次 clean build 可复现检查。
- 平台资格升级为会过期、从原始证据复算且失败关闭的 v2 审计；当前七个角色均未获得
  真机资格，因此没有新增平台支持声明。
- 候选发布检查会验证包、WASM、资格状态、回滚开关和副作用，但不会创建 tag、发布 npm、
  创建 GitHub Release 或修改线上配置；六类 M10 候选能力均继续 Defer。

## 0.2.0

品牌更名与文本编辑正确性。0.x 阶段 minor 允许 breaking：本版同时改了公开
API 与二进制 ABI。

### Breaking

- 包名 `@dopejs/doper*` → `@dopejs/pingo*`（公开入口 `@dopejs/pingo`）。旧
  包停留在 0.1.0，不再更新；无别名包。
- 公开类型去掉 `Doper` 前缀：`PingoNode`、`PingoEvent`、`PingoEventHandler`、
  `PingoEventPhase`、`PingoElement`、`PingoRoot`、`PingoFont`（及其 options/
  error 类型）、`PingoImage`、`PingoImageOptions`。
- JSX 元素品牌符号 `dopejs.doper.element` → `dopejs.pingo.element`：跨版本
  混用元素描述符会被拒绝。
- 无障碍镜像属性 `data-doper-*` → `data-pingo-*`；compat 边界的激活判别值
  `"doper" | "legacy"` → `"pingo" | "legacy"`。
- ABI 4 → 10。系统字体度量流新增逐码点推进、位置型推进与收缩表；输入流
  新增 `SetWordBoundaries`。所有 golden 字节夹具随之显式重基。
- 输入帧对过期 `base_revision` 的命令不再整帧拒绝：位置型编辑单独丢弃并
  回一条空操作事务对齐输入面，undo/redo 以会话当前 revision 重试。

### 文本与编辑

- caret 与命中测试改用浏览器实测推进，不再用 `font_size * 0.6` 估算；IME
  预编辑文本与密码遮罩字形一并测量。
- 相邻全角标点的上下文收缩：位置型推进按字体实际压缩的那一半归属，caret
  可以落在两个标点之间。
- 回退文本路径支持软换行；单行框改为框内水平滚动并保持 caret 可见；
  可编辑节点裁剪到自身盒子。
- 双击分词使用平台 `Intl.Segmenter` 词典（中日文不再逐字选中）；未聚焦时
  的首次双击会等聚焦建立后补发。
- EditContext 模式补齐剪贴板与撤销快捷键；会话结束时解除 EditContext，使
  画布内外失焦行为一致（移动端软键盘随之收起）。
- 编辑期不再改变文本框尺寸；撤销后重新绘制。
- Worker 崩溃恢复保留可编辑配置，密码框不会在恢复帧里显示明文。

### 渲染与性能

- 通用字体族关键字不再被加引号，此前整站实际画的是默认衬线体。
- 栅格 tile 缓存不再逐帧改变文本栅格化结果。
- 滚动帧不再整场景标脏；时钟帧在无变化时不再重画；滚动中不再对不可复用
  的图片分块。
- Android 惯性改用 spline 模型，iOS 系数修正；画布尺寸变化、移动端触摸与
  横向滚动的多处阻断修复。

### 站点与工具

- 文档站点、十语言本地化、Playground 与 Storybook 合并到统一站点；新品牌
  标识。

## 0.1.0

首个可发布版本。P0–M5 全部工程里程碑完成，`pnpm m5:check`（M0→M5 全链
自动门禁）全绿。

- 确定性 Rust/WASM Core + TypeScript Shell：单源 schema、版本化二进制
  Mutation/Input/DisplayList/反向流，畸形输入原子拒绝。
- 双时钟渲染：SAB → postMessage → 主线程 Canvas2D 降级链，主线程阻塞
  200ms 时 Worker 连续呈现。
- 原生虚拟滚动（百万行 P95/P99 亚微秒级重放）与文本子系统（显式字体
  shaping、glyph atlas、系统字体 fallback）。
- canvas 原生编辑：EditContext/输入代理双路径、IME composition、指针与
  键盘 caret 导航、剪贴板、undo/redo、密码遮罩、caret scroll-into-view。
- 命中测试（增量 BVH + 朴素 oracle 属性测试）与 capture/target/bubble
  三阶段事件、non-passive 区域同步 `preventDefault` 协议。
- 无障碍：语义树导出、DOM 影子树镜像、`getByRole` 语义 E2E 选择器、
  键盘聚焦转发。
- 迁移与生产化：`@dopejs/pingo-compat` 按页面灰度/回退、迁移扫描器、
  发布包与 WASM SHA-256 完整性验证、诊断与运行手册。
- WebGPU 隔离原型与 headless oracle 零失配差分（ADR-0006：
  Continue Experiment，默认关闭）。

显式延后：bidi 视觉导航、widgets placeholder、WebGPU 默认启用。
平台资格（真机性能、真实 IME、屏幕阅读器）另行跟踪，不随包版本承诺。
