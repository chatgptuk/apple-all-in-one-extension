<p align="right">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

> **v1.2.6.1：** 修复 Apple 密码自动连接流程中的 TypeScript 类型问题。弹窗状态变量现在显式使用完整的 `PasswordState` 联合类型，因此原生辅助程序返回有效的 `unlocked` 状态时，不再导致类型检查或构建失败。

> **v1.2.6：** 工具栏启动逻辑被隔离到一个轻量引导脚本中，用于修复全局及单标签页的操作状态；打开弹窗时也可以自动开始 Apple 密码访问码流程。

# Apple All-In-One v1.2.13

**Apple All-In-One** 是一个独立的 Chromium 扩展，将多项 Apple 账户相关功能整合在同一个入口中：Apple 密码、通行密钥、验证码，以及 iCloud+ 隐藏邮件地址。

本项目融合了经过用户验证的 **Open Passwords** 代码库和重新设计的 **隐藏邮件地址** 代码库，同时继续保持原生密码访问与 iCloud Web 服务之间彼此独立的安全边界。

> 这是一个独立的开源项目，未经 Apple Inc. 认可、赞助，也与 Apple Inc. 没有关联。Apple、iCloud、iCloud+ 及相关产品名称均为 Apple Inc. 的商标。

**项目仓库：** https://github.com/chatgptuk/apple-all-in-one-extension

## 项目来源 / 上游项目

Apple All-In-One 主要基于以下两个开源项目：

1. **Open Passwords** — https://github.com/ManiForoughi2/open-passwords  
   提供 Apple 密码集成层，包括 macOS 原生消息通信、SRP/AES-GCM 会话处理、密码查询与保存流程、通行密钥相关组件、OTP 输入框排除逻辑，以及安全的行内凭据选择器。Apple All-In-One 自行实现了已保存验证码的发现、按需读取、建议展示和带来源校验的填充；这些 OTP/验证码管理功能并非由 Open Passwords 提供。本项目保留了相关 Apache-2.0 声明和上游署名。

2. **iCloud Hide My Email Browser Extension** — https://github.com/dedoussis/icloud-hide-my-email-browser-extension  
   提供原始浏览器扩展基础和 iCloud 隐藏邮件地址私有 API 集成。Apple All-In-One 在此基础上增加了重新设计的地址管理器、明确的创建/使用流程、网站身份与图标显示、最近 iCloud 邮件活动、直接删除和批量管理。原项目的 MIT 许可证和版权声明均予以保留。

许可证详情请参阅 `LICENSES/`、`THIRD_PARTY_NOTICES.md` 和 `OPEN_PASSWORDS_NOTICE`。

## 已包含功能

- 通过 macOS `com.apple.passwordmanager` 原生辅助程序访问 Apple 密码。
- 建立 SRP 会话并加密读写凭据。
- 密码填充，以及密码保存/更新流程。
- 由 Apple All-In-One 实现的 Apple 密码验证码发现、按需读取、选择器/弹窗建议和安全填充。
- 从 Open Passwords 保留的 OTP 输入框排除、通行密钥桥接和可选的条件式通行密钥抑制功能。
- 生成、预留和填充 iCloud+ 隐藏邮件地址。
- 搜索和管理隐藏邮件地址。
- 直接删除仍处于启用状态的地址（自动执行 `停用 → 删除`）。
- 多选批量停用和批量删除，并按顺序执行操作。
- 为隐藏邮件地址识别网站/域名并显示网站图标。
- 最近 iCloud 邮件活动（`上次收到……`），带 24 小时自动缓存和有界收件箱扫描；手动刷新仍会立即强制扫描。
- 一个安全的行内选择器，统一展示已保存凭据、验证码和可选的隐藏邮件地址创建入口。
- Apple 风格的弹窗、设置、使用指南，以及通过代码绘制的云朵/钥匙孔应用图标。
- 英文和简体中文界面。默认跟随浏览器语言，也可在设置中手动切换中文或英文。
- 延迟启动：安装扩展或启动浏览器时不会验证 iCloud，也不会连接 Apple 密码原生辅助程序；仅在真正使用相应功能时初始化服务。
- 弹窗后台消息带短时重试，以应对 Manifest V3 Service Worker 唤醒竞争。

## 启动行为

Apple All-In-One 有意保持轻量的安装和浏览器启动过程：

- `onInstalled` 不会验证 iCloud Web 会话。
- `onInstalled` / `onStartup` 不会建立 Apple 密码原生连接。
- 工具栏操作保持全局启用，不依赖每个标签页的 `setPopup` 或启用/停用状态。
- 只有在请求密码功能时，Apple 密码才会连接 `com.apple.passwordmanager`。
- 只有在打开隐藏邮件地址或明确执行相关操作时，扩展才会验证/发现 iCloud 会话。
- **自动重新连接隐藏邮件地址** 默认开启。打开隐藏邮件地址或检测到缓存会话过期时，扩展会对浏览器已有的可信 iCloud Web 会话执行一次有界重新检查。如果 Apple 要求重新认证，扩展会停止操作并显示前往 iCloud.com 登录的入口；此行为可在设置中关闭。
- 当 Chromium 仍在唤醒 Manifest V3 Service Worker 时，弹窗消息会进行短暂重试。

这样可以避免安装后出现工具栏图标似乎只能在扩展页面中正常响应的情况。

## 语言

扩展内置英文和简体中文界面。

- 默认：**跟随浏览器**（`chrome.i18n.getUILanguage()`）。
- 手动选择：设置 → 通用 → 语言中的 **中文** 或 **English**。
- 弹窗、设置、安装指南、安全行内选择器、隐藏邮件地址右键菜单文案和通知均使用所选语言。
- Manifest 同时包含 Chrome `_locales` 元数据，因此扩展描述也会跟随浏览器语言。

## 重要交互行为

聚焦邮件输入框时，扩展**不会自动生成隐藏邮件地址**。

流程有意设计为明确的用户操作：

1. 聚焦符合条件的邮箱/登录输入框。
2. 选择**创建隐藏邮件地址**。
3. 扩展请求一个候选隐藏邮件地址。
4. 选择**使用**，预留该地址并填入输入框。

这样可以防止页面仅仅包含邮件输入框时就创建未被使用的地址。

## 从 Open Passwords 安装 / 升级

Apple All-In-One 有意保留 Open Passwords Manifest 中的 `key`，使 Chromium 生成现有原生策略辅助程序所期待的同一个扩展 ID。

1. 安装依赖并构建项目。
2. 打开 `chrome://extensions`。
3. 移除或停用先前以未打包方式加载的 Open Passwords；Chromium 无法同时加载两个采用相同固定 ID 的未打包扩展。
4. 加载生成的 `build/` 目录。
5. 如果 Open Passwords 之前已在此浏览器中正常工作，现有原生辅助程序配置应继续匹配保留的扩展 ID。
6. 如果从未安装辅助程序，请运行 `native/install.sh`，完全退出 Chrome 后重新打开。
7. 确认整合扩展正常工作后，停用或移除旧的独立隐藏邮件地址扩展。

## 构建

需要 Node.js 20 或更高版本。

```bash
npm install
npm run typecheck
npm run build
```

然后在 `chrome://extensions` 中将 `build/` 作为未打包扩展加载。

开发监听模式：

```bash
npm run watch
```

依赖集合有意避开 `webpack-dev-server`、`sockjs` 和已弃用的 `uuid@8` 依赖链，以避免此前出现的 npm 审计警告。

## Apple 密码安全模型

密码子系统保留 Open Passwords 的架构：

- 原生连接：`com.apple.passwordmanager`
- 使用 macOS 六位数质询码进行 SRP 握手
- 通过 AES-GCM 保护原生查询通道
- 解密后的密码缓存仅保存在 Service Worker 内存中，并在会话锁定或状态丢失时清除
- 对弹窗/后台特权消息进行验证
- 对凭据填充执行 frame/来源检查

之所以保留固定扩展身份，是因为 macOS 原生辅助程序/策略授权依赖该身份。

## 隐藏邮件地址安全模型

隐藏邮件地址功能**不会**获得 Apple 密码的原生会话密钥或解密后的密码值。

它使用浏览器中已经登录的 iCloud.com 会话来调用私有 iCloud Web 服务。扩展不会要求用户在扩展内输入 Apple 账户密码。

Apple All-In-One 不会尝试从钥匙串读取 Apple 账户密码，再静默重建 iCloud Web 登录。Apple 密码的原生访问只提供凭据操作，并不提供受支持、可恢复的 iCloud Web 认证会话；iCloud 登录还可能需要 Apple 认证、双重认证或设备信任状态。

邮件活动仅扫描最近的 `INBOX` 会话，不扫描垃圾邮件、废纸篓或已删除邮件。即使之前匹配的邮件后来被移动或删除，缓存的历史“上次收到”时间仍会保留。

只有当隐藏邮件地址转发到 iCloud 邮箱（`@icloud.com`、`@me.com` 或 `@mac.com`）时，才能读取最近邮件活动。

## 隐藏邮件地址管理

地址管理器支持：

- 按标签、地址、备注或检测到的网站搜索。
- 复制地址。
- 启用/停用。
- 通过自动执行 `停用 → 删除` 直接删除启用中的地址。
- 多选模式。
- 批量停用。
- 批量删除。
- 部分失败处理：操作失败的地址会保持选中，方便重试。
- 在 Chrome 能解析时显示网站图标，并提供安全的降级显示。
- 缓存最近邮件活动。

## 浏览器说明

Apple 密码原生辅助程序集成面向 macOS 上的 Chromium 浏览器。隐藏邮件地址部分也可以为 Firefox 构建，但 Apple 密码原生辅助程序仅适用于 Chromium/macOS。

## 许可证

此仓库中的代码采用不止一种许可证。

- Open Passwords 及相关移植组件：保留 Apache License 2.0 声明。
- 原始 Hide My Email 浏览器扩展：保留 MIT License 和原始版权声明。

参阅：

- `LICENSES/Open-Passwords-APACHE-2.0.txt`
- `LICENSES/Hide-My-Email-MIT.txt`
- `OPEN_PASSWORDS_NOTICE`
- `THIRD_PARTY_NOTICES.md`

### v1.2.8 交互优化

在工具栏弹窗的 Apple 密码访问码输入框中输入或粘贴六位数字后，会自动执行验证，因此正常解锁流程不再需要点击**解锁**。

### v1.2.9 确定性网站图标降级

- 不再把 `2025.6.30` 等日期式/全数字隐藏邮件地址标签识别为网站域名。
- 立即渲染字母图标，并将它保留在已验证网站图标的下方，因此异步加载不会产生空白方块。
- 移除 Chrome `_favicon` 作为最终降级解析方式，因为 Chrome 在网站没有图标时可能返回一个有效的通用地球图标。
- 增加常见的 `favicon.png` 和 `favicon.svg` 候选路径。
- 无法解析的网站图标在列表和详情视图中均保持确定性的字母显示。

### v1.2.13 可靠性修复

- 取代上方 v1.2.9 的直接图标候选探测策略；v1.2.9 条目仅作为版本历史保留。
- 使用 Chromium Manifest V3 `_favicon` API，不再下载网站 HTML 或猜测远程 `/favicon.*` 路径。
- 通过 Chromium 图标存储支持 CDN 或哈希资源地址中声明的网站图标。
- 过滤 Chromium 返回的通用地球图标，使无法解析的网站继续显示确定性的字母图标。
- 避免第三方 CSS/字体预加载警告被归因到 `popup.html`。
- 串行化右键菜单初始化并读取 `runtime.lastError`，避免扩展重载/安装竞态产生重复 ID 错误。
