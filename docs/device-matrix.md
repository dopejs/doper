# 平台资格设备矩阵

本矩阵用于产品支持声明，不是 P0/M0 工程出口。没有设备或证据时，对应平台保持
`unqualified`；这会阻止宣称该平台已达到性能/输入法目标，但不阻止工程里程碑完成。

设备矩阵采用“固定资产 + 角色”管理。正式报告中的 `deviceId` 必须指向不可歧义的
物理设备；只写“低端安卓”或 User-Agent 不构成证据。

`deviceId` 标识物理资产，`roleId` 标识该次采集承担的矩阵角色，两者不得混用。同一
台物理 Mac 可以分别承担 `desktop-chromium`、`desktop-safari` 和
`desktop-firefox`；报告与 IME 录制必须保留各自 `roleId`，汇总按
role/device/build 分组，不能跨浏览器比较 batch。

## 资格角色

| 角色 ID            | 用途                                      | 最低覆盖                             | 当前资产     | 状态        |
| ------------------ | ----------------------------------------- | ------------------------------------ | ------------ | ----------- |
| `android-low`      | 移动滚动 P95/P99、scroll-copy、阻塞连续性 | 一台目标业务仍支持的低端物理 Android | 待分配       | unqualified |
| `android-mid`      | 默认 Android 能力与 IME                   | 一台主流中端物理 Android             | 待分配       | unqualified |
| `ios-baseline`     | iOS Safari、输入代理、软键盘              | 一台最低受支持 iOS 物理设备          | 待分配       | unqualified |
| `ios-current`      | 当前 iOS Safari / EditContext 能力        | 一台当前主力 iPhone                  | 待分配       | unqualified |
| `desktop-chromium` | PC 性能门禁与 SAB 参考                    | 固定 macOS/Windows 资产              | `dev-mac-01` | 已登记      |
| `desktop-safari`   | 无 Chromium 假设验证                      | 固定 macOS 资产                      | 待分配       | unqualified |
| `desktop-firefox`  | postMessage/主线程降级验证                | 固定 macOS/Windows/Linux 资产        | 待分配       | unqualified |

## 资产登记字段

每台设备在正式采集前固定以下信息：

- `deviceId`、负责人、厂商与型号；
- SoC、RAM、存储余量、屏幕刷新率；
- OS build、浏览器完整版本、WebView/Safari Technology Preview 等渠道；
- 电源模式、是否充电、初始电量与允许的温度区间；
- viewport、DPR、系统字体缩放、显示缩放；
- 可用输入法及版本；
- cross-origin isolation、双端 SharedArrayBuffer、Worker OffscreenCanvas、Worker rAF、
  EditContext 能力快照。

设备或浏览器升级会产生新的矩阵版本，不能覆盖旧报告中的环境信息。

## 已登记资产

### `dev-mac-01`

- MacBook Pro `Mac16,8`，Apple M4 Pro（10P + 4E），48GB RAM；
- macOS 26.6.1 build 25G76；
- Google Chrome 151.0.7922.138；
- 探针 viewport 1920×929，DPR 2，14 logical CPUs；
- 本地隔离与无隔离报告均已验证；
- 角色仅为 desktop Chromium 参考，不能替代低端 Android 或 iOS。

## 输入法覆盖

每个目标平台至少记录：

- 中文拼音：composition 更新、候选确认、候选翻页、撤销；
- 日文：假名组合、汉字转换、候选确认；
- 韩文：Jamo 组合与退格；
- 一条复杂序列：组合中移动 selection、替换范围或外部 value 更新；
- emoji、ZWJ、combining mark 和 surrogate pair 的移动与删除；
- EditContext 路径以及强制 textarea proxy 路径。

每个组合都必须从全新页面会话导出符合 `ime-recording-v2` schema 的文件，填写真实
输入法名称和版本，并以默认正式模式通过 `pnpm ime:replay -- <recording.json>`。
移动端证据必须包含 `softKeyboardObserved: true`；EditContext 证据必须包含实际的
`characterboundsupdate`。fixture、自动化键盘、事件溢出或本地占位 build/device id
均不能替代正式矩阵证据。

矩阵中任何“待分配”资产只会让相应平台保持 `unqualified`。机器可读资格登记写入
`m0-evidence-manifest-v1`，并由 `pnpm platform:qualify` 验证；除角色和资产 ID 外，
还必须固定上述硬件、环境、输入法、能力快照以及两组正式 batch ID。
