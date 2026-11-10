# Windows 原生官方接入（v0.3.52-win.1 预览版）

范围：复用现有 Electron / React 界面，沿用 Windows 原生 Claude Code 的认证、配置和会话目录。首版重点为 Claude 官方账号或已有官方 API 认证；没有加入供应商切换和 WSL。

## 使用

- 接入状态放在「设置 → 账号与接入」，主页不显示认证提示条。状态读取不会发送模型消息。
- 自动查找 PATH 和 `%USERPROFILE%\.local\bin\claude.exe`，也可手动选择已安装的原生 `.exe`。Windows 构建随本机 CLI 使用同一版本，找不到时提示安装。
- 「打开官方登录终端」执行所选引擎的 `auth login`，用户在官方浏览器页面完成授权，返回后点击「重新检测」。该操作更新 CLI 共用认证；桌面应用不保存另一份密钥。
- 认证状态正常不等于网络或模型调用已通过。其他供应商配置不会被覆盖，也不会被标成官方接入。
- 共享同一用户环境和 `CLAUDE_CONFIG_DIR`。仅在某个终端临时设置的变量，需要从该终端启动应用才能继承。应用不执行 PowerShell 配置文件来搜集凭据。
- CLI 完成当前一轮后，回到桌面端的同一项目和会话即可自动读取新增历史。空闲的桌面引擎发现 CLI 新增的一轮后会重新读取，下次发送沿用同一会话。请按轮次在两端交替使用，同一会话的跨进程写入没有互斥锁。
- Windows 顶部与左侧使用统一外框，主工作区为圆角容器；顶部不显示产品名称，保留原生窗口按钮。侧栏展开时左上角仅显示侧栏开关，新对话位于导航；收起时左上角显示侧栏与新对话。

## 开发与验证

建议 Node 24.15.0 或更高的 24.x。Windows 安装依赖时验证 node-pty 自带的 N-API 二进制；Mac 保留原生模块重建。

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run dev
npm run pack:win
```

`dist/win-unpacked/Claude Code.exe` 是未签名的目录构建，必须与整个目录一起使用；可通过 `npm run release:win` 制作完整便携 ZIP；尚未制作安装器或自动更新。

```powershell
# 只读认证、SDK 初始化及原生 PowerShell PTY 检查，无模型请求
node scripts/probe-windows.mjs
# 额外发送一条固定 Haiku 短消息，不调用工具、不保存会话，预算上限 $0.05
node scripts/probe-windows.mjs --model-check
# Electron 界面、文件预览、SDK 和 PTY 集成检查，无模型请求
node scripts/launch.cjs electron scripts/smoke-windows.cjs
# 真实模型、默认权限确认、文件读写和 CLI→桌面→CLI→桌面接续
# 显式 --live；创建独立临时项目和真实测试会话，使用 Haiku，产生模型费用
node scripts/launch.cjs electron scripts/e2e-windows-cli.cjs --live
```

原生检查默认使用 `%USERPROFILE%\.local\bin\claude.exe`，可通过 `CLAUDE_PROBE_EXECUTABLE` 指向其他原生 CLI。

## 本轮实测与限制

- 本机官方认证、SDK 初始化成功（CLI 2.1.299），原生 PowerShell PTY 已返回预期内容并正常退出。
- 固定模型检查成功返回 `WINDOWS_OK`，报告费用约 $0.000978；未访问项目文件或写入会话历史。
- 类型检查与构建通过；99 个测试文件通过，615 项测试通过，1 项 POSIX 文件权限测试在 Windows 跳过。
- 真实 Electron 会话全流程通过：原生 CLI 创建历史，桌面输入框发送消息，Read/Write 操作中文和空格路径内的合成文件，默认模式弹出写入确认；切回 CLI 能复述桌面写入内容，再从桌面继续仍保留 CLI 新增上下文。使用本机已有官方登录，没有模拟模型响应或替换聊天 IPC。
- Electron 44.7.2 的真实界面检查通过：官方认证、SDK 初始化、中文及空格路径文件预览、PowerShell 终端输出与关闭。目录构建的 exe 也已成功启动并截图。
- 本次自动化执行环境从工作区中的 Electron 目录启动会提前退出；同版本缓存目录运行时可以正常启动。两处文件相同而 ACL 不同，权限是可能原因，尚未做底层归因。验证通过 `ELECTRON_OVERRIDE_DIST_PATH` 使用同版本缓存运行时，没有修改 ACL、关闭 sandbox 或更改原有 Electron 版本。
- 已实际打开新版 exe，确认标题栏原生按钮、统一色调、官方认证状态及原有项目历史列表正常显示。
- 后续修复：`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 会拦截官方 `/api/oauth/usage`，实验性接口却只返回空额度。额度查询现在使用独立的临时 CLI 进程，只在该进程清空此开关，仍关闭遥测、错误上报、自动更新、工具、MCP 和钩子；聊天进程及用户配置文件不变。真实 SDK 与页面已验证 5 小时和本周窗口，并逐字节确认 CLI 设置文件未变。
- 首次浏览器 OAuth、Mac 回归、第三方模型与 WSL 尚未验收。本轮验证的是已有官方登录的接入；没有替用户重新登录或更换账号。测试只涵盖合成项目和按轮次接续，并不代表所有 CLI 指令已经逐项验收。

参考：[Claude Code 认证](https://code.claude.com/docs/en/authentication)、[CLI reference](https://code.claude.com/docs/en/cli-reference)、[Windows 安装](https://code.claude.com/docs/en/setup)。


## Mac 保留与已知限制

- `main` 分支保留原有 Mac 发布；`win` 分支为 Windows 预览版，也保留 Mac 的窗口配置、原生模块重建与 `npm run pack:mac` 构建入口。此次未在 Mac 机器上执行打包或运行验收。
- Mac 接入页提供可复制的官方登录命令，Windows 提供 PowerShell 登录窗口；安装说明使用通用官方入口。
- 在终端中接续时，请使用同一个项目目录和会话 ID，并等待桌面端的回复、授权及后台任务结束。

图标生成：`node scripts/launch.cjs electron scripts/windows-icon.cjs` 从 Mac 原图裁去透明留白，生成 Windows 小尺寸 ICO。
