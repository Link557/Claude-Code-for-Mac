# 模型识别接口

`window.desk.meta.get(projectPath)` 返回当前项目的 CLI 模型目录。桌面端不维护 Opus、Sonnet、Haiku 等固定白名单；目录来自所选原生 Claude Code 的 SDK 初始化结果，沿用 CLI 加载的用户、项目、本地设置和进程环境。

每个模型包含：

- `value`：传给 CLI 的原始选择值，可以是别名、`default` 或第三方模型 ID。选择后原样提交，不自行改写供应商路由。
- `label`：CLI 提供的显示名称。
- `resolvedModel`：CLI 报告的实际目标模型 ID；选择菜单在名称下展示它，便于核对别名映射。
- `efforts`：CLI 报告支持的思考档位；没有支持信息时为空，不凭模型名称推测。

例如 CLI 可返回 `value: sonnet`、`resolvedModel: deepseek-chat`。桌面显示两者并继续传入 `sonnet`，保留 CLI 原有映射语义。不会扫描第三方服务的整个模型库。

Fable 始终保留入口。CLI 未返回该项且没有有效映射时，入口置灰，并说明当前未提供模型或映射；读取中与读取失败分别显示对应原因，不以套餐或第三方接入判断权限。如果 CLI 生效配置的 `ANTHROPIC_DEFAULT_FABLE_MODEL` 指定了目标，则显示为 Fable，并以该目标 ID 提交。此适配避免某些 CLI 版本仍在初始化结果中返回固定官方 Fable ID、绕过配置映射的问题。目标能力仅复用 CLI 已返回的目标模型信息，不继承官方 Fable 的思考能力。

配置映射使模型可选择，不表示已验证供应商调用权限；实际请求失败仍由现有会话错误界面展示。

模型缓存按项目、引擎、用户/项目/本地配置及接入环境隔离。配置只存摘要，不把密钥或完整设置写入缓存。现有配置变更事件会失效内存目录并刷新可见选择器。旧版固定名单缓存失效。

识别只代表 CLI 的配置结果，不证明网关实际后端、网络连通性或模型调用成功。只修改终端临时环境变量时，需要从该终端重新启动桌面应用才能继承新环境。

验证包含任意自定义 ID、别名映射、缓存隔离、不落盘密钥、选择值原样提交与配置变更刷新。另通过隔离的真实原生 CLI 初始化验证 `sonnet → deepseek-chat`，未发送模型消息，未修改用户配置。

配置语义参考：[Claude Code 模型配置](https://code.claude.com/docs/en/model-config)。

## Windows win.2 打包验收

2026-11-08：`0.3.52-win.2` 完整便携 ZIP 打包成功。使用打包后的 exe、隔离的应用数据和 CLI 配置，直接核对真实 `meta.get` 与模型菜单，确认 `sonnet → deepseek-chat` 和原固定名单之外的模型项可见。没有发送模型消息或修改用户配置。随后以用户正常配置启动新版，模型菜单显示 CLI 当前返回的 Default、Opus、Fable、Sonnet、Haiku 及实际 ID。29 项相关测试、类型检查与应用构建通过。

## Windows win.3 打包验收

2026-11-08：`0.3.52-win.3` 将 Fable 映射适配与本机显示名称编辑一起打包。100 项相关测试、类型检查、构建通过。打包后的 exe 在隔离配置中通过真实 CLI 读取 Fable → deepseek-chat，界面展示正确，设置页改名保存成功；未发送模型消息，不声称验证网关调用权限。无官方额度时的本机 Token 统计及名字同步另通过 Electron 界面检查。桌面快捷方式已更新并打开新版。

显示名称在设置和使用情况页共用本地偏好，不修改 CLI 登录账号；用于后续首页招呼语。Token 活动依赖本机历史记录中的 usage 字段，不等同供应商账单。

## Windows taskbar icon identity (win.5)

The earlier Start-menu shortcut retained the preview executable and `local.nature.claude-desk` identity even after the desktop link was updated. Taskbar captures reproduced the smaller icon with that identity. The Windows app now uses `local.nature.claude-desk.windows` consistently in its process, window and package metadata, and supplies an explicit shell icon resource. Use `node scripts/launch.cjs electron scripts/install-windows-shortcuts.cjs <packaged exe>` to update both desktop and Start-menu links together.

2026-11-08: verified the packaged win.5 taskbar icon beside WPS at 100% display scale. Its overall tile is larger; the ICO is byte-for-byte identical to win.3, preserving the internal logo proportions. Typecheck and build passed, ZIP completed, both shortcuts updated and the app opened. User data remains in the existing claude-desk directory.

## win.6: match the official desktop icon's outer tile

2026-11-08: the win.5 taskbar tile still had faint shadow padding. The icon converter now crops to the solid tile bounds (alpha >= 240) using a square crop, scaling the entire tile and mark uniformly. It does not enlarge the mark independently. The 24px ICO layer's solid bounds changed from 22×21 to 24×24. Captured the packaged app beside the running official Claude desktop app at 100% scale; the tile widths are visually aligned (antialiasing/color thresholds can differ by one pixel). Both shortcuts were updated, win.6 opened, build succeeded. Evidence: local taskbar capture `official-compare-win6.png`.
