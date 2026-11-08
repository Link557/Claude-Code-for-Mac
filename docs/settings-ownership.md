# 会话回收与设置归属核查

核查日期：2026-11-08。范围为当前 Windows 分支代码与 Anthropic 官方资料；每个供应商的具体能力仍需实际验证。

## 桌面端进程与会话

现有 `src/main/live/SessionManager.ts` 默认保留数量为 4、闲置阈值为 15 分钟，现可通过桌面设置调整，并每 60 秒检查一次。只有活动进程数量（含即将建立的预留名额）超出保留数量，才从满足闲置阈值的候选者中按最近活动时间最早者开始回收；不足以回收时允许暂时超限。15 分钟并非固定准时关闭，定期检查及新会话创建会触发回收。`src/main/live/LiveSession.ts` 的 `lastActive` 在消息等活动时更新，不能等同于最后一次点击时间；候选过滤还要遵循 registry 的安全保护。

关闭的是桌面端管理的 CLI 会话进程，而非主动删除 CLI 历史。`LiveSession.start` 使用 SDK `resume` 接续已有 session；具体是否成功依赖原有历史可读取、CLI/服务可用以及配置兼容。不要宣传为任何情况下点击必定恢复。SDK 会话接口及选项参见 [Agent SDK TypeScript 参考](https://code.claude.com/docs/en/agent-sdk/typescript) 和 [会话文档](https://code.claude.com/docs/en/agent-sdk/sessions)。

保留数量和闲置阈值属于本桌面应用本机进程管理偏好，并非官方 Claude 账号套餐字段或 CLI 设置，也不依赖供应商。运行中、权限等待、后台任务等不可安全回收条件以当前实现为准；界面文案应明确这是软保留数量、超限且满足闲置条件才回收，避免称为硬并发上限或无条件定时关闭。

## 配置与生效范围

| 来源 | 示例 | 影响与边界 |
| --- | --- | --- |
| 桌面应用本地偏好 | 主题、显示名称、通知、会话进程保留策略 | 当前设备和本应用；不改写 CLI 用户配置或账号。见 `src/main/store.ts`、`src/shared/types.ts`。 |
| Claude Code 配置 | 模型、权限、语言、hooks、环境变量 | 用户、项目、项目本地和组织策略等范围；设置可能影响同一 CLI 配置的其他客户端，须显示项目和来源。见 [设置文件与优先级](https://code.claude.com/docs/en/settings)。 |
| SDK 会话选项 | `model`、`permissionMode`、`effort`、`settings`、`promptSuggestions`、`resume` | 宿主发起单个 `query` 时设置；不意味着修改账号配置。当前 `src/main/live/LiveSession.ts` 显式传入这些选项；结果仍可能受策略、CLI 版本和供应商能力制约。见 [SDK 选项与优先级](https://code.claude.com/docs/en/agent-sdk/typescript#settings-precedence)。 |
| 账号和供应商服务 | 官方订阅、认证、额度；第三方供应商路由、配额与模型 | 服务端能力和权限由对应服务提供方决定；官方订阅额度不能直接代表第三方用量。当前 `src/main/usage.ts` 基于 provider 和生效环境判断是否查询官方额度，但这是应用的路由判断，并非对所有代理实现或项目配置的完整识别保证。 |

官方 SDK 当前参考文档说明：`settingSources` 省略时，`query()` 读取 user、project、local 配置；显式 `[]` 关闭这三类文件来源。当前 `LiveSession.start` 未显式指定该字段，与默认读取方式一致；同一次调用明确传入的 SDK `settings` 等选项覆盖一般用户/项目文件，同键的组织托管策略通常优先，但存在官方文档列出的例外。实际生效结果需按具体 CLI/SDK 版本和配置核验，不能只凭文件文本推断。参考 [SDK SettingSource](https://code.claude.com/docs/en/agent-sdk/typescript#settingsource)。

本项目 `src/main/claudeConfigProtocol.ts` 对 SDK 0.3.301 的非公开 `get_settings` 控制协议做适配，读取 effective/sources；它是版本敏感的实现细节，不应视为长期稳定的公开 API。桌面会话选择的模型可能经 CLI 别名映射至其他 ID，识别到映射不证明网关实际后端或调用权限。

第三方服务是否支持输入建议、模型别名、思考程度、用量或对应 API，应根据 CLI 返回、供应商协议和实际请求结果判定；不要只按有无官方套餐判定，也不要因第三方接入一律关闭桌面本地功能。官方文档记录了 [第三方部署和网关](https://code.claude.com/docs/en/third-party-integrations) 与 [输入建议触发限制](https://code.claude.com/docs/en/interactive-mode#prompt-suggestions)。
