// 对话相关的数据结构：主进程把 SDK 消息整理成这些类型后推给界面。
import type { SessionSummaryData } from './sessionSummary'
import type { EffortLevel, PermissionMode } from './types'

export type UiBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      input: Record<string, unknown>
      result?: { text: string; isError: boolean }
    }
  /** 本地斜杠命令（/context、/model…）的输出；output 为 null 表示会话记录里没保存输出 */
  | { kind: 'command'; name: string; args: string; output: string | null }

/** 一次模型请求的 token 用量 */
export interface TokenUsage {
  /** 未命中缓存的输入 */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** 这次请求写入的缓存档位；没写入缓存时缺省 */
  cacheTtl?: '5m' | '1h'
}

export type CommandBlock = Extract<UiBlock, { kind: 'command' }>

export interface UiMessage {
  id: string
  /** notice：系统提示（如「已中断」），以灰色小字显示 */
  role: 'user' | 'assistant' | 'notice'
  /** 内容来源与界面角色分开；unknown 保留原文，不冒充已确认的真人输入。 */
  source?: 'human' | 'unknown' | 'internal' | 'external'
  /** 内部来源的显示用途；缺失时保守地保留可见通知。 */
  internalKind?: 'technical' | 'compact' | 'command' | 'notification'
  originKind?: string
  /** 明确的界面分组边界。旧快照缺少此字段时才回退到 role。 */
  startsTurn?: boolean
  blocks: UiBlock[]
  /** 子代理内部的消息，挂在对应工具调用下 */
  parentToolUseId: string | null
  /** 助手消息的 token 用量 */
  usage?: TokenUsage
  /** 消息时间（毫秒时间戳） */
  time?: number
  /** 助手消息在会话链上的位置（最后一条组成它的 SDK 消息的 uuid） */
  uuid?: string
  /** 用户消息：编辑时从哪条链条目之后分叉；null 表示这是第一条消息 */
  forkFrom?: string | null
}

/** 仅用于当前运行状态，不写入历史摘要。revision 在主进程生命周期内递增。 */
export interface ChatActivity {
  revision: number
  phase: 'idle' | 'working' | 'thinking' | 'responding' | 'tool' | 'stopping'
  messageId?: string
  blockIndex?: number
  toolName?: string
  toolId?: string
}

export type ChatState = 'idle' | 'running' | 'awaiting' | 'error'

/** Ephemeral CLI prediction; never a submitted user message. */
export interface PromptSuggestion { id: string; text: string }

export interface SessionOptions {
  model: string | null
  mode: PermissionMode
  effort: EffortLevel | null
  ultracode?: boolean
  workflows?: boolean
  fastMode?: boolean
}
export interface RuntimeSettings {
  model?: string
  permissionMode?: PermissionMode | 'dontAsk'
  effort?: EffortLevel | null
  ultracode?: boolean
  fastMode?: string
  fastModeReason?: string
  ultracodeRequested?: boolean
  workflowAction?: boolean
  ultraReason?: string
  ultracodeAvailable?: boolean
  error?: string
  effortSource?: string
}

export interface QueuedMessage {
  editing?: boolean
  attachments?: string[]
  id: string
  text: string
  options: SessionOptions
  status: 'queued' | 'submitting' | 'submitted' | 'received' | 'unknown' | 'failed'
  error?: string
}
export interface SessionQueue { items: QueuedMessage[]; paused: boolean }
export type QueueAction = { type: 'move'; id: string; targetId: string; position: 'before' | 'after' } | { type: 'edit'; id: string; text: string; attachments?: string[] } | { type: 'insert' | 'delete' | 'forget' | 'beginEdit' | 'cancelEdit'; id: string } | { type: 'pause' | 'resume' | 'clear' }

export interface ApprovalRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  /** 是否可以「始终允许」 */
  grants?: string[]
  canAlwaysAllow: boolean
  reason?: string
}

export type Decision =
  | { type: 'allow' }
  | { type: 'allowAlways' }
  | { type: 'deny'; message?: string }
  | { type: 'answers'; answers: Record<string, string> }
  | { type: 'planApprove'; mode: PermissionMode }
  | { type: 'planRevise'; feedback: string }

export type ChatEvent = (
  | { kind: 'promptSuggestion'; suggestion: PromptSuggestion | null }
  | { kind: 'options'; options: SessionOptions; optionsSaved?: boolean; optionsSaveError?: string | null }
  | { kind: 'runtime'; runtime: RuntimeSettings }
  | { kind: 'queue'; queue: SessionQueue }
  | { kind: 'activity'; activity: ChatActivity }
  | { kind: 'summary'; summary: SessionSummaryData }
  | { kind: 'tasks'; tasks: BackgroundTask[] }
  | { kind: 'upsert'; messages: UiMessage[] }
  | { kind: 'replaceHistory'; snapshot: ChatSnapshot }
  | { kind: 'state'; state: ChatState }
  | { kind: 'approval'; request: ApprovalRequest }
  | { kind: 'approvalDone'; requestId: string }
  | { kind: 'result'; resultId?: string; replyPreview?: string; durationMs: number; error: string | null; diagnostic?: { subtype: string; errors: string[]; terminalReason?: string; userMessageIds: string[]; userStopped: boolean } }
  | { kind: 'notice'; text: string }
) & { revision?: number }

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'ended'
/** 后台任务（后台命令、子 Agent、监控、工作流）在界面上需要的字段 */
export interface BackgroundTask {
  id: string
  runId?: string
  /** local_bash、local_agent、local_monitor、local_workflow 等 */
  type?: string
  description: string
  status: BackgroundTaskStatus
  startedAt: number
  endedAt?: number
  tokens?: number
  toolUses?: number
  lastTool?: string
  summary?: string
  agents: { id: string; label?: string; state?: string; tokens?: number }[]
}

/** 当前上下文窗口的占用情况 */
export interface ContextUsage {
  used: number
  /** SDK 的有效统计窗口，可能小于模型硬上限。 */
  max: number
  percent: number
  autoCompactEnabled?: boolean
  autoCompactThreshold?: number
  free?: number
  buffer?: number
  /** 按类别拆分（系统提示词、工具、对话消息……），只含占用窗口的部分 */
  parts: { name: string; tokens: number }[]
}

export interface ChatSnapshot {
  promptSuggestion?: PromptSuggestion | null
  runtime?: RuntimeSettings
  /** 与实时事件共享的会话版本，用于拒绝过期快照。 */
  revision?: number
  optionsSaved?: boolean
  optionsSaveError?: string | null
  options?: SessionOptions
  queue?: SessionQueue
  activity?: ChatActivity
  summary?: SessionSummaryData
  /** 当前进程里的后台任务；会话进程结束后为空 */
  tasks?: BackgroundTask[]
  messages: UiMessage[]
  state: ChatState
  approvals: ApprovalRequest[]
  live: boolean
}

/** MCP 服务器状态（/mcp） */
export interface McpStatus {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  error?: string
  scope?: string
  tools: number
}

/** /btw 顺便问一下：一问一答，不写入主对话 */
export interface BtwTurn {
  question: string
  response: string
}
