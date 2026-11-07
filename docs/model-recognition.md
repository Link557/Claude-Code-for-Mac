# 模型识别接口

`window.desk.meta.get(projectPath)` 返回当前项目的 CLI 模型目录。桌面端不维护 Opus、Sonnet、Haiku 等固定白名单；目录来自所选原生 Claude Code 的 SDK 初始化结果，沿用 CLI 加载的用户、项目、本地设置和进程环境。

每个模型包含：

- `value`：传给 CLI 的原始选择值，可以是别名、`default` 或第三方模型 ID。选择后原样提交，不自行改写供应商路由。
- `label`：CLI 提供的显示名称。
- `resolvedModel`：CLI 报告的实际目标模型 ID；选择菜单在名称下展示它，便于核对别名映射。
- `efforts`：CLI 报告支持的思考档位；没有支持信息时为空，不凭模型名称推测。

例如 CLI 可返回 `value: sonnet`、`resolvedModel: deepseek-chat`。桌面显示两者并继续传入 `sonnet`，保留 CLI 原有映射语义。CLI 没有列出的供应商模型不会凭空加入，也不会扫描第三方服务的整个模型库。

模型缓存按项目、引擎、用户/项目/本地配置及接入环境隔离。配置只存摘要，不把密钥或完整设置写入缓存。现有配置变更事件会失效内存目录并刷新可见选择器。旧版固定名单缓存失效。

识别只代表 CLI 的配置结果，不证明网关实际后端、网络连通性或模型调用成功。只修改终端临时环境变量时，需要从该终端重新启动桌面应用才能继承新环境。

验证包含任意自定义 ID、别名映射、缓存隔离、不落盘密钥、选择值原样提交与配置变更刷新。另通过隔离的真实原生 CLI 初始化验证 `sonnet → deepseek-chat`，未发送模型消息，未修改用户配置。

配置语义参考：[Claude Code 模型配置](https://code.claude.com/docs/en/model-config)。

## Windows win.2 打包验收

2026-11-08：`0.3.52-win.2` 完整便携 ZIP 打包成功。使用打包后的 exe、隔离的应用数据和 CLI 配置，直接核对真实 `meta.get` 与模型菜单，确认 `sonnet → deepseek-chat` 和原固定名单之外的模型项可见。没有发送模型消息或修改用户配置。随后以用户正常配置启动新版，模型菜单显示 CLI 当前返回的 Default、Opus、Fable、Sonnet、Haiku 及实际 ID。29 项相关测试、类型检查与应用构建通过。
