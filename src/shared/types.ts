
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'
export type Theme = 'system' | 'light' | 'dark'
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface Project {
  id: string
  path: string
  name: string
  addedAt: number
  collapsed: boolean
}

export interface SessionSummary {
  id: string
  title: string
  cwd: string
  lastModified: number
  archived: boolean
}

export interface DetectedFolder {
  path: string
  sessionCount: number
}

export interface ModelOption {
  value: string
  label: string
  /** 该模型支持的思考程度，空数组表示不支持调节 */
  resolvedModel?: string
  efforts: EffortLevel[]
}

export interface Settings {
  /** Local display preference, independent of CLI authentication and provider. */
  displayName?: string | null
  /** Desktop process retention only; never written to Claude Code settings. */
  retainedSessions?: number
  sessionIdleMinutes?: number
  /** Whether new desktop CLI sessions request next-prompt suggestions. CLI policy still applies. */
  promptSuggestions?: boolean
  theme: Theme
  defaultModel: string
  defaultPermissionMode: PermissionMode
  /** null 表示使用模型默认的思考程度 */
  defaultEffort: EffortLevel | null
  claudePath: string | null
  allowBypass: boolean
  autoScroll?: boolean
  reduceMotion?: boolean
  /** Desktop execution copy only; does not change CLI or model language. */
  executionLanguage?: 'zh' | 'en'
  notifyCompletion?: boolean
  notifyApproval?: boolean
  notificationSound?: boolean
}

export type { CommandInfo } from './commandCatalog'

/** 右栏文件预览的内容 */
export type FilePreview =
  | { kind: 'text'; size: number; content: string; truncated?: boolean }
  | { kind: 'image'; size: number; dataUrl: string }
  /** 音视频不读进内存，由 desk-media:// 协议按需流式读取 */
  | { kind: 'media'; size: number; media: 'video' | 'audio'; url: string }
  | { kind: 'pdf' | 'docx' | 'spreadsheet'; size: number; base64: string }
  | { kind: 'binary'; size: number }
  | { kind: 'too-large'; size: number; limit?: number }
  | { kind: 'missing' | 'dir' }

export interface FileInfo {
  path: string
  name: string
  extension: string
  bytes: number
}

export interface ProjectEntry {
  path: string
  name: string
  kind: 'file' | 'dir'
}

export interface MetaInfo {
  email?: string | null
  organization?: string | null
  models: ModelOption[]
  modelCatalogError?: string
  subscriptionType: string | null
  claudeVersion: string | null
}

/** 套餐用量的一个限额窗口（如 5 小时内、本周） */
export interface UsageWindow {
  kind: 'five_hour' | 'seven_day' | 'model_week'
  label: string
  /** 已用百分比，0–100 */
  percent: number
  resetsAt: string | null
}

export interface PlanUsage {
  subscriptionType: string | null
  /** false：不受套餐限额约束（如使用 API Key） */
  available: boolean
  windows: UsageWindow[]
}

/** 开发截图用：指定启动时的界面状态 */
export interface DemoState {
  route?: 'new' | 'settings'
  dialog?: 'add-project' | 'import'
  dialogPath?: string
  openMenu?: 'project' | 'model' | 'effort' | 'permission' | 'project-picker'
  /** 打开第一个项目里的第 N 个会话 */
  openSession?: number
  /** 启动后自动用这个模型发送这条消息 */
  prompt?: string
  model?: string
}

export interface AppState {
  /** Local login name, only for UI greetings. */
  username?: string | null
  seededFromHistory: boolean
  demo: DemoState | null
  home: string
}

export type { DeskApi } from './ipc/contract'
