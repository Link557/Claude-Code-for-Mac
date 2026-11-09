// 渲染进程和主进程之间唯一的接口定义：preload 按它生成 window.desk，主进程按它注册和校验处理函数。
// 通道名一律是「命名空间:方法名」，不要在别处手写通道字符串。
import type { ClaudeConfigChange, ClaudeConfigSnapshot } from '../claudeConfig'
import type { ConnectionStatus } from '../connection'
import type { DiffSource, FileRewindResult, LiveSetting, PermissionRules, RuleChange, TaskOutput } from '../sessionControl'
import type { UsageAnalytics, UsageOverview, UsageProfile } from '../usageAnalytics'
import type { CommandCatalogSnapshot } from '../commandCatalog'
import type { BrowserState, ViewBounds } from '../workspace'
import type { ScheduledRunStarted, ScheduledTask, ScheduledTaskInput } from '../schedules'
import type { SkillCatalog } from '../skills'
import type { BtwTurn, ChatEvent, ChatSnapshot, ContextUsage, Decision, QueueAction, McpStatus, SessionOptions, UiMessage } from '../chat'
import type { AppState, DetectedFolder, EffortLevel, FileInfo, FilePreview, MetaInfo, ModelOption, PermissionMode, PlanUsage, Project, ProjectEntry, SessionSummary, Settings } from '../types'

/** 渲染进程调用、主进程返回结果 */
export interface Invoke<A extends unknown[], R> { readonly kind: 'invoke'; readonly __args?: A; readonly __result?: R }
/** 主进程推送给渲染进程；渲染进程侧是订阅函数，返回取消订阅 */
export interface Event<A extends unknown[]> { readonly kind: 'event'; readonly __args?: A }
/** 只在 preload 里执行，不经过 IPC */
export interface Local<F extends (...args: never[]) => unknown> { readonly kind: 'local'; readonly __fn?: F }

const invoke = <A extends unknown[], R = void>(): Invoke<A, R> => ({ kind: 'invoke' })
const event = <A extends unknown[]>(): Event<A> => ({ kind: 'event' })
const local = <F extends (...args: never[]) => unknown>(): Local<F> => ({ kind: 'local' })

export const contract = {
  connection: {
    status: invoke<[projectPath?: string], ConnectionStatus>(),
    pickExecutable: invoke<[], string | null>(),
    login: invoke<[]>(),
    installationHelp: invoke<[]>()
  },
  usage: {
    overview: invoke<[], UsageOverview>(),
    stats: invoke<[refresh?: boolean], UsageAnalytics>(),
    saveProfile: invoke<[accountKey: string, profile: UsageProfile], UsageProfile>()
  },
  workspace: {
    /** 明确关闭页面时销毁资源；组件卸载不等于关闭页面。 */
    closePage: invoke<[id: string]>(),
    onShortcut: event<[kind: 'files' | 'terminal' | 'browser']>()
  },
  terminal: {
    open: invoke<[id: string, cwd: string], { output: string; exited: boolean }>(),
    write: invoke<[id: string, data: string]>(),
    resize: invoke<[id: string, cols: number, rows: number]>(),
    close: invoke<[id: string]>(),
    onData: event<[id: string, data: string]>(),
    onExit: event<[id: string, code: number]>()
  },
  browser: {
    open: invoke<[id: string], BrowserState>(),
    navigate: invoke<[id: string, url: string]>(),
    bounds: invoke<[id: string, bounds: ViewBounds | null]>(),
    action: invoke<[id: string, action: 'back' | 'forward' | 'reload' | 'stop']>(),
    close: invoke<[id: string]>(),
    onState: event<[id: string, state: BrowserState]>()
  },
  window: {
    alwaysOnTop: invoke<[], boolean>(),
    toggleAlwaysOnTop: invoke<[], boolean>(),
    onAlwaysOnTopChanged: event<[enabled: boolean]>()
  },
  app: {
    splashFinished: invoke<[]>(),
    notify: invoke<[title: string, body: string, silent: boolean, sessionId?: string]>(),
    /** Dock 角标显示的未读会话数，0 时清除 */
    setDockBadge: invoke<[count: number]>(),
    openNotificationSettings: invoke<[]>(),
    onNotificationClick: event<[sessionId: string]>(),
    state: invoke<[], AppState>(),
    /** 把窗口带到最前面（点系统通知时） */
    focus: invoke<[]>()
  },
  projects: {
    list: invoke<[], Project[]>(),
    pickFolder: invoke<[], string | null>(),
    add: invoke<[path: string], Project[]>(),
    remove: invoke<[id: string], Project[]>(),
    setCollapsed: invoke<[id: string, collapsed: boolean], Project[]>(),
    detectFromHistory: invoke<[], DetectedFolder[]>(),
    markSeeded: invoke<[]>(),
    revealInFinder: invoke<[path: string]>()
  },
  sessions: {
    list: invoke<[projectPath: string], SessionSummary[]>(),
    rename: invoke<[id: string, title: string, projectPath: string]>(),
    setArchived: invoke<[id: string, archived: boolean]>()
  },
  settings: {
    get: invoke<[], Settings>(),
    set: invoke<[patch: Partial<Settings>], Settings>()
  },
  skills: {
    /** 扫描个人、项目、账号同步和插件提供的技能；projectPath 为空时只读用户级 */
    list: invoke<[projectPath: string | null], SkillCatalog>(),
    /** 技能正文（不含 frontmatter），仅限 list 返回过的路径 */
    read: invoke<[path: string], string>(),
    /** 写入用户级 settings.json 的 enabledPlugins */
    setPluginEnabled: invoke<[id: string, enabled: boolean]>()
  },
  schedules: {
    list: invoke<[], ScheduledTask[]>(),
    create: invoke<[input: ScheduledTaskInput], ScheduledTask[]>(),
    update: invoke<[id: string, input: ScheduledTaskInput], ScheduledTask[]>(),
    setEnabled: invoke<[id: string, enabled: boolean], ScheduledTask[]>(),
    remove: invoke<[id: string], ScheduledTask[]>(),
    /** 立即执行一次，不影响下一次计划时间 */
    runNow: invoke<[id: string], ScheduledTask[]>(),
    onChanged: event<[tasks: ScheduledTask[]]>(),
    onStarted: event<[run: ScheduledRunStarted]>()
  },
  meta: {
    get: invoke<[projectPath?: string], MetaInfo>(),
    cachedModels: invoke<[projectPath?: string], ModelOption[] | null>(),
    commands: invoke<[projectPath: string, force?: boolean], CommandCatalogSnapshot>(),
    onCommands: event<[snapshot: CommandCatalogSnapshot]>(),
    /** 套餐用量（和终端里 /usage 看到的一样），不消耗额度 */
    usage: invoke<[], PlanUsage>(),
    /** 执行 /config：不带参数返回设置清单，带 key=value 修改一项（临时会话，不写入任何对话） */
    config: invoke<[projectPath: string, setting?: string], string>(),
    configSnapshot: invoke<[projectPath: string], ClaudeConfigSnapshot>(),
    onConfigChanged: event<[change: ClaudeConfigChange]>()
  },
  files: {
    diff: invoke<[projectPath: string, source: DiffSource], string>(),
    /** Electron 44 不再在 File 对象上暴露 path，需要通过 webUtils 转换 */
    pathFor: local<(file: File) => string>(),
    saveImage: invoke<[bytes: Uint8Array, mime: string], string>(),
    /** 校验路径并返回普通文件信息；目录、缺失和不可读文件会被过滤 */
    describe: invoke<[paths: string[]], FileInfo[]>(),
    search: invoke<[projectPath: string, query: string], string[]>(),
    /** 读取项目内的一个目录；只接受项目根目录内的路径 */
    list: invoke<[projectPath: string, directory: string], ProjectEntry[]>(),
    /** 在项目内新建空文件或文件夹，返回绝对路径 */
    create: invoke<[projectPath: string, directory: string, kind: ProjectEntry['kind'], name: string], string>(),
    /** 用默认应用打开文件 */
    open: invoke<[path: string]>(),
    /** 文件链接的右键菜单（原生菜单）：默认应用打开、在 Finder 中显示、复制路径 */
    contextMenu: invoke<[path: string, kind: 'file' | 'dir']>(),
    /** 右栏预览：读取文件内容 */
    read: invoke<[path: string], FilePreview>(),
    /** 预览期间监听文件变化（成对调用 unwatch） */
    watch: invoke<[path: string]>(),
    unwatch: invoke<[path: string]>(),
    /** 监听中的文件有变化；返回取消订阅函数 */
    onChanged: event<[path: string]>(),
    /** 批量检查路径是文件、文件夹还是不存在 */
    stat: invoke<[paths: string[]], Record<string, 'file' | 'dir' | null>>()
  },
  chat: {
    open: invoke<[sessionId: string, projectPath: string], ChatSnapshot>(),
    subagentMessages: invoke<[sessionId: string, projectPath: string, toolUseId: string], UiMessage[]>(),
    start: invoke<[projectPath: string, text: string, options: SessionOptions], string>(),
    send: invoke<[sessionId: string, projectPath: string, text: string, options: SessionOptions, attachments?: string[]]>(),
    edit: invoke<[sessionId: string, projectPath: string, messageId: string, text: string]>(),
    queue: invoke<[sessionId: string, projectPath: string, action: QueueAction]>(),
    interrupt: invoke<[sessionId: string]>(),
    setMode: invoke<[sessionId: string, mode: PermissionMode]>(),
    setModel: invoke<[sessionId: string, model: string | null]>(),
    rules: invoke<[sessionId: string, path: string], PermissionRules>(),
    changeRule: invoke<[sessionId: string, path: string, change: RuleChange], PermissionRules>(),
    applySetting: invoke<[sessionId: string, path: string, key: LiveSetting, value: string]>(),
    reloadConfiguration: invoke<[sessionId: string, path: string]>(),
    taskOutput: invoke<[sessionId: string, path: string, taskId: string], TaskOutput>(),
    stopTask: invoke<[sessionId: string, path: string, taskId: string]>(),
    rewindPreview: invoke<[sessionId: string, path: string, target: string], FileRewindResult>(),
    rewindFiles: invoke<[sessionId: string, path: string, target: string], FileRewindResult>(),
    restoreConversation: invoke<[sessionId: string, path: string, messageId: string], string>(),
    setWorkflows: invoke<[sessionId: string, enabled: boolean]>(),
    prepareControls: invoke<[sessionId: string, projectPath: string]>(),
    setFastMode: invoke<[sessionId: string, enabled: boolean]>(),
    setUltracode: invoke<[sessionId: string, enabled: boolean]>(),
    refreshRuntime: invoke<[sessionId: string]>(),
    setEffort: invoke<[sessionId: string, effort: EffortLevel | null]>(),
    respond: invoke<[sessionId: string, requestId: string, decision: Decision]>(),
    /** 会话是否在别处（终端、VS Code）有了新消息 */
    checkExternal: invoke<[sessionId: string, projectPath: string], boolean>(),
    handoffToCli: invoke<[sessionId: string, projectPath: string], string>(),
    /** 丢掉缓存，从会话文件重新读取 */
    reload: invoke<[sessionId: string, projectPath: string], ChatSnapshot>(),
    /** 当前上下文窗口占用；会话不存在或读取失败时为 null */
    context: invoke<[sessionId: string, projectPath: string, model: string | null], ContextUsage | null>(),
    /** /mcp：MCP 服务器状态；sessionId 为 null 时按项目读取 */
    mcp: invoke<[sessionId: string | null, projectPath: string], McpStatus[]>(),
    /** 在临时进程里启用、停用或重连 MCP 服务，返回操作后的状态；启停会持久化到项目配置 */
    mcpAction: invoke<[projectPath: string, operation: 'enable' | 'disable' | 'reconnect', name: string], McpStatus[]>(),
    /** /btw 顺便问一下：返回回答文本，不写入会话 */
    btw: invoke<[sessionId: string, projectPath: string, question: string, history: BtwTurn[], options: SessionOptions], string | null>(),
    /** 订阅会话事件，返回取消订阅函数 */
    onEvent: event<[sessionId: string, event: ChatEvent]>()
  }
} as const

export type Contract = typeof contract
export type Namespace = keyof Contract & string
type Kind = 'invoke' | 'event' | 'local'
export type MembersOf<N extends Namespace, K extends Kind> = { [M in keyof Contract[N] & string]: Contract[N][M] extends { kind: K } ? M : never }[keyof Contract[N] & string]

type ChannelOf<K extends Kind> = { [N in Namespace]: `${N}:${MembersOf<N, K>}` }[Namespace]
export type InvokeChannel = ChannelOf<'invoke'>
export type EventChannel = ChannelOf<'event'>

type Lookup<C extends string> = C extends `${infer N extends Namespace}:${infer M}` ? M extends keyof Contract[N] ? Contract[N][M] : never : never
export type ArgsOf<C extends InvokeChannel | EventChannel> = Lookup<C> extends Invoke<infer A, unknown> ? A : Lookup<C> extends Event<infer A> ? A : never
export type ResultOf<C extends InvokeChannel> = Lookup<C> extends Invoke<unknown[], infer R> ? R : never

type Member<T> =
  T extends Invoke<infer A, infer R> ? (...args: A) => Promise<R>
  : T extends Event<infer A> ? (listener: (...args: A) => void) => () => void
  : T extends Local<infer F> ? F
  : never

export type DeskApi = { -readonly [N in Namespace]: { -readonly [M in keyof Contract[N]]: Member<Contract[N][M]> } }

export const channel = (namespace: string, member: string): string => `${namespace}:${member}`

/** 契约里所有需要主进程处理的通道，用于检查注册是否齐全 */
export function invokeChannels(): InvokeChannel[] {
  return Object.entries(contract).flatMap(([namespace, members]) =>
    Object.entries(members).filter(([, definition]) => definition.kind === 'invoke').map(([member]) => channel(namespace, member) as InvokeChannel))
}
