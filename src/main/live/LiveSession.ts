import { notificationPreview } from '../../shared/notificationPreview'
// 一个常驻的 claude 进程，对应一个打开着的会话（流式输入模式，可随时追加消息、中断、切换模式）。
import type { CanUseTool, HookCallback, McpServerStatus, PermissionResult, PermissionUpdate, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { observeClaudeConfig, isConfigMutation } from '../claudeConfigChanges'
import { runLocalCommand } from '../localCommand'
import { readTrackedTaskOutput } from '../taskOutput'
import { readPermissionRules, readTaskOutput } from '../sessionControlProtocol'
import type { LiveSetting, PermissionRules, TaskOutput } from '../../shared/sessionControl'
import { readConfigState } from '../claudeConfigProtocol'
import type { RuntimeSettings, PromptSuggestion } from '../../shared/chat'
import { randomUUID } from 'node:crypto'
import type { HumanSubmission } from '../humanSubmissionRepository'
import type { CommandInfo } from '../../shared/types'
import type { ApprovalRequest, BtwTurn, ChatEvent, ChatState, ContextUsage, Decision, SessionOptions } from '../../shared/chat'
import { toPermissionResult } from '../approval'
import { toContextUsage } from '../context'
import { claudeExecutable, loadSdk } from '../sdk'
import * as store from '../store'
import type { Transcript } from '../transcript'
import { TurnActivity } from './TurnActivity'
import { PushQueue } from './PushQueue'

interface Pending {
  request: ApprovalRequest
  suggestions?: PermissionUpdate[]
  resolve(result: PermissionResult): void
}

/** SDK 里没写进类型定义的接口（VS Code 插件的 /btw 用的就是它）：基于当前上下文回答，不写入会话、不调用工具 */
interface SideQuestionApi {
  askSideQuestion(
    question: string,
    options?: { history?: BtwTurn[] }
  ): Promise<{ response: string; synthetic: boolean; refusalFallback?: { content: string } } | null>
}

interface LiveSessionInit {
  sessionId: string
  cwd: string
  /** true：接着已有的会话继续；false：用 sessionId 新建会话 */
  resume: boolean
  /** 从另一个会话的某个位置分叉出来（编辑历史消息）：新会话用 sessionId */
  fork?: { from: string; at: string }
  options: SessionOptions
  transcript: Transcript
  emit(event: ChatEvent): void
  onClosed(session: LiveSession): void
  onCommands?(commands: CommandInfo[]): void
  onSubmit?(submission: HumanSubmission): void
  onConsumed?(ids: string[]): void
}

const FLUSH_MS = 50
const debug = (...args: unknown[]): void => {
  if (process.env.CLAUDE_DESK_DEBUG) console.log('[live]', ...args)
}

export class LiveSession {
  readonly activity = new TurnActivity()
  get tasks() { return this.init.transcript.activity.taskTracker.tasks }
  private publishedTasks = '[]'
  runtime: RuntimeSettings = {}
  promptSuggestion: PromptSuggestion | null = null
  private acceptsSuggestion = false
  private clearSuggestion(): void {
    this.acceptsSuggestion = false
    if (!this.promptSuggestion) return
    this.promptSuggestion = null
    this.init.emit({ kind: 'promptSuggestion', suggestion: null })
  }
  state: ChatState = 'idle'
  lastActive = Date.now()
  private pending = new Map<string, Pending>()
  private input = new PushQueue<SDKUserMessage>()
  private releaseInput!: () => void
  private configured = new Promise<void>(resolve => { this.releaseInput = resolve })
  private async *configuredInput() {
    await this.configured
    yield* this.input
  }
  private abort = new AbortController()
  private q: Query | null = null
  private closed = false
  private bypassAllowed = false
  private configCommands = new Set<string>()
  private configChanged: (fallback?: boolean) => void
  private commandsChanged = false
  private runtimeRequest = 0
  private outstandingInputs = new Set<string>()
  private turnInputIds = new Set<string>()
  private stopTargets: Set<string> | undefined
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private onStarted!: (q: Query) => void
  private onStartFailed!: (err: unknown) => void
  private started = new Promise<Query>((resolve, reject) => {
    this.onStarted = resolve
    this.onStartFailed = reject
  })

  constructor(private init: LiveSessionInit) {
    this.configChanged = observeClaudeConfig(init.cwd)
    this.started.catch(() => {}) // 启动失败由 start() 提示，这里只防止未处理的 rejection
  }

  get approvals(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request)
  }

  async start(): Promise<void> {
    try {
      const sdk = await loadSdk()
      if (this.closed) return
      const { sessionId, cwd, resume, fork, options } = this.init
      this.bypassAllowed = store.read().settings.allowBypass
      this.q = sdk.query({
        prompt: this.configuredInput(),
        options: {
          cwd,
          ...(fork
            ? { resume: fork.from, resumeSessionAt: fork.at, forkSession: true, sessionId }
            : resume
              ? { resume: sessionId }
              : { sessionId }),
          model: options.model ?? undefined,
          permissionMode: options.mode === 'bypassPermissions' && !this.bypassAllowed ? 'default' : options.mode,
          effort: options.effort ?? undefined,
          settings: { ...(options.workflows !== undefined ? { enableWorkflows: options.workflows } : {}), ...(options.ultracode !== undefined ? { ultracode: options.ultracode } : {}), ...(options.fastMode !== undefined ? { fastMode: options.fastMode } : {}) },
          enableFileCheckpointing: true,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          includePartialMessages: true,
          forwardSubagentText: true,
          promptSuggestions: true,
          // SDK 会话默认不返回思考文字（只有签名），界面就看不到思考过程；要求返回思考摘要
          extraArgs: { 'thinking-display': 'summarized', 'replay-user-messages': null },
          hooks: {
            CwdChanged: [{ hooks: [this.observeDirectory] }],
            DirectoryAdded: [{ hooks: [this.observeDirectory] }]
          },
          canUseTool: this.canUseTool,
          allowDangerouslySkipPermissions: this.bypassAllowed,
          pathToClaudeCodeExecutable: claudeExecutable(),
          abortController: this.abort,
          stderr: (data) => console.error('[claude]', data.trimEnd())
        }
      })
      this.onStarted(this.q)
      await this.refreshRuntime(false)
      if (options.ultracode && !this.runtime.ultracodeAvailable && this.runtime.workflowAction) {
        await this.q.applyFlagSettings({ enableWorkflows: true, ultracode: true })
        await this.refreshRuntime(false)
      }
      if (options.effort === null && typeof this.q.applyFlagSettings === 'function') {
        const ultracode = options.ultracode ?? this.runtime.ultracodeRequested
        await this.q.applyFlagSettings({ effortLevel: null, ...(ultracode !== undefined ? { ultracode } : {}) })
        await this.refreshRuntime(false)
      }
      if (!this.closed) this.init.emit({ kind: 'runtime', runtime: this.runtime })
      this.releaseInput()
      if (this.init.onCommands) void this.q.initializationResult().then((result) => {
        if (!this.closed && !this.commandsChanged) this.publishCommands(result.commands)
      }).catch(() => {})
      void this.pump(this.q)
    } catch (err) {
      this.onStartFailed(err)
      if (!this.closed) this.fail(err, '无法启动 Claude')
    }
  }

  async readyForControls(): Promise<void> { await this.configured; await this.query() }

  get cwd(): string { return this.init.cwd }

  async commands(): Promise<CommandInfo[]> { return (await this.query()).supportedCommands() }

  async mcpStatus(): Promise<McpServerStatus[]> {
    return (await this.query()).mcpServerStatus()
  }

  async sideQuestion(question: string, history: BtwTurn[]): Promise<string | null> {
    this.lastActive = Date.now()
    const q = (await this.query()) as Query & SideQuestionApi
    const r = await q.askSideQuestion(question, { history })
    return r?.refusalFallback?.content ?? r?.response ?? null
  }

  send(text: string, uuid: string = randomUUID()): void {
    if (this.closed) throw new Error('会话已结束，请重试')
    this.clearSuggestion()
    this.lastActive = Date.now()
    const submission = { uuid, text, time: Date.now() }
    this.init.onSubmit?.(submission)
    if (this.state !== 'running' && this.state !== 'awaiting') this.activity.start()
    this.init.transcript.addUser(text, submission.uuid, submission.time)
    if (isConfigMutation(text)) this.configCommands.add(submission.uuid)
    this.outstandingInputs.add(submission.uuid)
    this.flush()
    this.input.push({ type: 'user', uuid: submission.uuid as SDKUserMessage['uuid'], message: { role: 'user', content: text }, parent_tool_use_id: null, origin: { kind: 'human' } })
    this.setState('running')
  }

  async interrupt(): Promise<void> {
    this.clearSuggestion()
    const targets = new Set(this.outstandingInputs)
    this.stopTargets = targets
    this.activity.stop()
    this.flush()
    try { await (await this.query()).interrupt() }
    catch (error) {
      if (this.stopTargets === targets) this.stopTargets = undefined
      if (!this.closed && this.state === 'running') { this.activity.resume(); this.flush() }
      throw error
    }
  }

  async setMode(mode: SessionOptions['mode']): Promise<void> {
    this.clearSuggestion()
    if (mode === 'bypassPermissions') {
      if (!store.read().settings.allowBypass) throw new Error('请先在设置中允许选择跳过权限模式')
      if (!this.bypassAllowed) throw new Error('此对话启动时未启用跳过权限，请在高级设置中重新加载当前对话设置')
    }
    await (await this.query()).setPermissionMode(mode)
  }

  async setModel(model: string | null): Promise<void> {
    this.clearSuggestion()
    await (await this.query()).setModel(model ?? undefined)
  }

  async setEffort(effort: SessionOptions['effort'], ultracode?: boolean): Promise<void> {
    const q = await this.query()
    const requested = ultracode ?? this.runtime.ultracodeRequested
    await q.applyFlagSettings({ effortLevel: effort, ...(requested !== undefined ? { ultracode: requested } : {}) })
  }

  async setWorkflows(enableWorkflows: boolean) {
    await (await this.query()).applyFlagSettings({ enableWorkflows })
  }

  async setFastMode(fastMode: boolean, previousRequested?: boolean): Promise<void> {
    const q = await this.query()
    const previous = previousRequested ?? (this.runtime.fastMode === 'on' || this.runtime.fastMode === 'cooldown')
    try {
      await q.applyFlagSettings({ fastMode })
      const init = await q.reinitialize()
      this.runtime.fastMode = init.fast_mode_state
      this.runtime.fastModeReason = init.fast_mode_disabled_reason
      if (!init.fast_mode_state || (fastMode ? init.fast_mode_state === 'off' : init.fast_mode_state !== 'off')) {
        throw new Error(init.fast_mode_disabled_reason === 'extra_usage_disabled' ? '快速模式未开启：账号未启用额外用量' : '快速模式未生效：' + (init.fast_mode_disabled_reason ?? 'CLI 未确认状态'))
      }
    } catch (error) {
      // A rejected flag may still have changed CLI settings. Restore before reporting failure.
      try {
        await q.applyFlagSettings({ fastMode: previous })
        const restored = await q.reinitialize()
        this.runtime.fastMode = restored.fast_mode_state
        this.runtime.fastModeReason = restored.fast_mode_disabled_reason
        await this.refreshRuntime()
      } catch (rollback) {
        this.runtime = { error: `快速模式恢复失败：${String(rollback)}` }
        this.init.emit({ kind: 'runtime', runtime: this.runtime })
      }
      throw error
    }
  }

  async permissionRules(): Promise<PermissionRules> { return readPermissionRules(await this.query()) }
  async configurationState() { return readConfigState(await this.query()) }

  async taskOutput(taskId: string): Promise<TaskOutput> {
    const task = this.tasks.get(taskId)
    if (task?.task_type === 'local_workflow') {
      const empty = ['stopped', 'killed'].includes(String(task.status)) ? '工作流已停止，尚未生成结果。'
        : task.status === 'failed' ? '工作流失败，未生成结果。' : '工作流尚未生成输出，请稍后刷新。'
      if (typeof task.output_file !== 'string') return { output: empty }
      try { return { output: (await readTrackedTaskOutput(task.output_file)) || empty } }
      catch (error: any) { if (error.code === 'ENOENT' && ['stopped', 'killed'].includes(String(task.status))) return { output: empty }; throw error }
    }
    return readTaskOutput(await this.query(), taskId)
  }

  async applySetting(key: LiveSetting, value: string): Promise<void> {
    const settings: Record<string, unknown> = {}
    if (key === 'outputStyle' || key === 'language') settings[key] = value
    else if (key === 'thinking') settings.alwaysThinkingEnabled = value === 'true'
    else throw new Error('此选项需要重载会话')
    const q = await this.query()
    await q.applyFlagSettings(settings)
    const state = await readConfigState(q)
    const [setting, expected] = Object.entries(settings)[0]
    if (state.effective[setting] !== expected) throw new Error('设置被其他配置覆盖或无法确认，请检查策略')
  }

  async autoCompact(args: string): Promise<void> {
    await runLocalCommand(this.init.cwd, '/autocompact ' + args, this.runtime.model ?? this.init.options.model)
    await this.reloadSettings()
  }

  async mcpCommand(operation: 'enable' | 'disable' | 'reconnect', target: string): Promise<void> {
    const q = await this.query()
    const servers = await q.mcpServerStatus()
    const selected = target === 'all' ? servers : servers.filter(server => server.name === target)
    if (!selected.length) throw new Error('没有找到 MCP 服务：' + target)
    for (const server of selected) {
      if (operation === 'reconnect') await q.reconnectMcpServer(server.name)
      else await q.toggleMcpServer(server.name, operation === 'enable')
    }
    this.publishCommands(await q.supportedCommands())
  }

  async reloadSettings(): Promise<void> {
    await this.refreshConfiguration()
    await this.refreshRuntime()
  }

  async refreshConfiguration() {
    const fresh = await (await this.query()).reinitialize()
    this.runtime.fastMode = fresh.fast_mode_state
    this.runtime.fastModeReason = fresh.fast_mode_disabled_reason
  }

  async rewind(target: string, dryRun: boolean) { return (await this.query()).rewindFiles(target, { dryRun }) }
  async stopTask(taskId: string) { await (await this.query()).stopTask(taskId) }

  async setUltracode(ultracode: boolean): Promise<void> {
    await (await this.query()).applyFlagSettings({ ultracode })
  }

  async refreshRuntime(publish = true): Promise<void> {
    const request = ++this.runtimeRequest
    try {
      const q = await this.query()
      const state = await readConfigState(q)
      const init = await q.initializationResult?.()
      if (request !== this.runtimeRequest || this.closed) return
      if (!state.applied) throw new Error('当前 CLI 不提供实际会话状态')
      const a = state.applied
      const configEnv = state.effective.env as Record<string, unknown> | undefined
      const environmentEffort = process.env.CLAUDE_CODE_EFFORT_LEVEL ?? configEnv?.CLAUDE_CODE_EFFORT_LEVEL
      const model = init?.models?.find(m => m.resolvedModel === a.model || m.value === a.model)
      const workflowEnv = process.env.CLAUDE_CODE_WORKFLOWS ?? configEnv?.CLAUDE_CODE_WORKFLOWS
      const envDisabled = ['0', 'false'].includes(String(workflowEnv))
      const policyDisabled = state.sources.some(entry => entry.source === 'policySettings' &&
        (entry.settings.disableWorkflows === true || entry.settings.enableWorkflows === false))
      const modelBlocked = model?.supportsEffort === false || model?.supportedEffortLevels?.includes('xhigh') === false
      const proDefault = state.effective.enableWorkflows === undefined && workflowEnv === undefined &&
        /^(claude )?pro$/i.test(init?.account?.subscriptionType ?? '')
      const workflowOff = state.effective.enableWorkflows === false || proDefault
      const restriction = policyDisabled ? '组织策略已禁用工作流'
        : state.effective.disableWorkflows === true ? 'Claude Code 配置 disableWorkflows 已禁用工作流'
        : envDisabled ? '环境变量 CLAUDE_CODE_WORKFLOWS 已禁用工作流'
        : modelBlocked ? '当前模型不支持 Ultracode 所需的 xhigh 档位' : undefined
      this.runtime = {
        workflowAction: !restriction && workflowOff,
        ultraReason: restriction ?? (workflowOff ? '当前会话尚未启用工作流' : 'CLI 未提供具体限制原因'),
        effortSource: environmentEffort !== undefined ? 'CLAUDE_CODE_EFFORT_LEVEL 环境变量' : undefined,
        fastMode: this.runtime.fastMode ?? init?.fast_mode_state,
        fastModeReason: this.runtime.fastMode !== undefined ? this.runtime.fastModeReason : init?.fast_mode_disabled_reason,
        model: typeof a.model === 'string' ? a.model : undefined,
        effort: a.effort as RuntimeSettings['effort'],
        ultracode: typeof a.ultracode === 'boolean' ? a.ultracode : undefined,
        ultracodeRequested: typeof a.ultracodeRequested === 'boolean' ? a.ultracodeRequested : undefined,
        ultracodeAvailable: typeof a.ultracodeAvailable === 'boolean' ? a.ultracodeAvailable : undefined
      }
    } catch (e) {
      if (request !== this.runtimeRequest || this.closed) return
      this.runtime = { error: e instanceof Error ? e.message : String(e) }
    }
    if (publish && !this.closed) this.init.emit({ kind: 'runtime', runtime: this.runtime })
  }

  async contextUsage(): Promise<ContextUsage | null> {
    return this.q ? toContextUsage(await this.q.getContextUsage({ detail: 'summary' })) : null
  }

  async respond(requestId: string, decision: Decision): Promise<void> {
    const p = this.pending.get(requestId)
    if (!p) return
    if (decision.type === 'planApprove') await this.setMode(decision.mode)
    if (this.closed || this.pending.get(requestId) !== p) return
    this.pending.delete(requestId)
    this.init.emit({ kind: 'approvalDone', requestId })
    p.resolve(toPermissionResult(decision, p.request.input, p.suggestions))
    this.setState(this.pending.size > 0 ? 'awaiting' : 'running')
  }

  close(): void {
    this.clearSuggestion()
    if (this.closed) return
    this.closed = true
    this.onStartFailed(new Error('会话已关闭'))
    for (const [requestId, pending] of this.pending) {
      this.init.emit({ kind: 'approvalDone', requestId })
      pending.resolve({ behavior: 'deny', message: '会话已结束' })
    }
    this.pending.clear()
    this.configChanged()
    this.configCommands.clear()
    this.releaseInput()
    this.input.end()
    this.activity.finish()
    this.init.transcript.activity.markInactive()
    this.flush()
    this.publishTasks()
    try {
      this.q?.close()
    } catch (error) {
      debug('close error', error)
    } finally {
      this.abort.abort()
      this.init.onClosed(this)
    }
  }

  private publishCommands(commands: CommandInfo[]): void {
    try { this.init.onCommands?.(commands) }
    catch (error) { console.error('更新命令目录失败', error) }
  }

  private async query(): Promise<Query> {
    const q = await this.started
    if (this.closed) throw new Error('会话已结束，请重试')
    return q
  }

  private fail(error: unknown, prefix = '会话出错'): void {
    this.init.emit({ kind: 'notice', text: `${prefix}：${error instanceof Error ? error.message : String(error)}` })
    this.setState('error')
    this.close()
  }

  private observeDirectory: HookCallback = async (input) => {
    if (this.closed) return {}
    if (input.hook_event_name === 'CwdChanged') this.init.transcript.activity.observeDirectory(input.new_cwd, !input.agent_id, input.agent_id ? '子 Agent 工作目录' : '会话工作目录')
    else if (input.hook_event_name === 'DirectoryAdded') this.init.transcript.activity.observeDirectory(input.directory)
    else return {}
    this.scheduleFlush()
    return {}
  }

  private canUseTool: CanUseTool = (toolName, input, options) =>
    new Promise((resolve) => {
      if (this.closed || options.signal.aborted) {
        resolve({ behavior: 'deny', message: '会话已结束' })
        return
      }
      const requestId = options.requestId ?? options.toolUseID
      const request: ApprovalRequest = {
        requestId,
        toolName,
        input,
        canAlwaysAllow: !options.suppressAlwaysAllowRule && (options.suggestions?.length ?? 0) > 0,
        grants: options.suggestions?.map(s => JSON.stringify(s)),
        reason: options.decisionReason
      }
      this.pending.set(requestId, { request, suggestions: options.suggestions, resolve })
      this.flush()
      this.init.emit({ kind: 'approval', request })
      this.setState('awaiting')
      options.signal.addEventListener('abort', () => {
        if (!this.pending.delete(requestId)) return
        this.init.emit({ kind: 'approvalDone', requestId })
        resolve({ behavior: 'deny', message: '已取消' })
      })
    })

  private async pump(q: Query): Promise<void> {
    debug('pump start', this.init.sessionId)
    try {
      for await (const m of q) {
        if (this.closed) break
        debug('msg', m.type, 'subtype' in m ? m.subtype : '')
        this.handle(m)
      }
      debug('pump end')
      if (!this.closed && (this.state === 'running' || this.state === 'awaiting')) {
        this.fail(new Error('Claude 进程已退出，请重试'))
      }
    } catch (err) {
      debug('pump error', err)
      if (!this.closed) this.fail(err)
    } finally {
      // 即便 SDK 正常结束迭代，也不能继续向没有消费者的队列发送消息。
      this.close()
    }
  }

  private handle(m: SDKMessage): void {
    this.lastActive = Date.now()
    if (m.type === 'prompt_suggestion') {
      if (this.acceptsSuggestion && this.state === 'idle' && m.session_id === this.init.sessionId && m.suggestion.trim()) {
        this.acceptsSuggestion = false
        this.promptSuggestion = { id: m.uuid, text: m.suggestion.trim() }
        this.init.emit({ kind: 'promptSuggestion', suggestion: this.promptSuggestion })
      }
      return
    }
    if (m.type === 'system' && m.subtype === 'commands_changed') { this.commandsChanged = true; this.publishCommands(m.commands) }
    this.activity.apply(m)
    this.init.transcript.apply(m, 'live')
    if (m.type === 'system' && (m.subtype === 'background_tasks_changed' || m.subtype.startsWith('task_'))) this.publishTasks()
    this.activity.locate(this.init.transcript.messages, m)
    if (m.type === 'assistant' && !m.parent_tool_use_id) {
      const ids = [...(m.user_message_uuids ?? []), ...(m.user_message_uuid ? [m.user_message_uuid] : [])]
      for (const id of ids) this.turnInputIds.add(id)
      if (ids.length) this.init.onConsumed?.(ids)
    }
    this.scheduleFlush()
    if ((m.type === 'result' || (m.type === 'system' && m.subtype === 'init')) && m.fast_mode_state) {
      this.runtime.fastMode = m.fast_mode_state
      this.runtime.fastModeReason = m.fast_mode_disabled_reason
    }
    if (m.type === 'result') {
      this.clearSuggestion()
      void this.refreshRuntime()
      this.flush()
      const ids = [...new Set([...this.turnInputIds, ...(m.user_message_uuids ?? []), ...(m.user_message_uuid ? [m.user_message_uuid] : [])])]
      this.turnInputIds.clear()
      const userStopped = (m.terminal_reason === 'aborted_streaming' || m.terminal_reason === 'aborted_tools') && ids.some(id => this.stopTargets?.has(id))
      const errors = m.subtype === 'success' ? (m.is_error && m.result ? [m.result] : []) : (m.errors ?? [])
      const failed = m.subtype !== 'success' || m.is_error
      this.acceptsSuggestion = !failed && !userStopped && (m.queued_turn_count ?? 0) === 0
      const completed = ids.length ? ids : (m.queued_turn_count ?? 0) === 0 ? [...this.configCommands] : []
      this.configChanged(!failed && completed.some(id => this.configCommands.has(id)))
      for (const id of completed) this.configCommands.delete(id)
      const error = failed && !userStopped
        ? [`运行结束：${m.subtype}`, ...errors, ...(m.terminal_reason ? [`结束原因：${m.terminal_reason}`] : [])].join('\n')
        : null
      this.stopTargets = undefined
      for (const id of ids) this.outstandingInputs.delete(id)
      if (m.queued_turn_count === 0) this.outstandingInputs.clear()
      this.init.emit({ kind: 'result', resultId: m.uuid, replyPreview: !failed && typeof m.result === 'string' ? notificationPreview(m.result) : undefined, durationMs: m.duration_ms, error, diagnostic: { subtype: m.subtype, errors, terminalReason: m.terminal_reason, userMessageIds: ids, userStopped } })
      if ((m.queued_turn_count ?? 0) > 0) { this.activity.start(); this.setState('running') }
      else this.setState(this.pending.size > 0 ? 'awaiting' : 'idle')
    }
  }

  private setState(state: ChatState): void {
    if (state === 'idle' || state === 'error') { this.activity.finish(); this.flush() }
    if (state === this.state) return
    this.state = state
    this.init.emit({ kind: 'state', state })
  }

  /** 有后台任务在跑（不含前台子 Agent 和 CLI 内部任务）。这样的会话不能因闲置被回收，否则任务会被一起停掉 */
  hasBackgroundWork(): boolean {
    return this.init.transcript.activity.taskTracker.hasBackgroundWork()
  }

  backgroundTasks() { return this.init.transcript.activity.taskTracker.list() }

  private publishTasks(): void {
    const tasks = this.backgroundTasks()
    const text = JSON.stringify(tasks)
    if (text === this.publishedTasks) return
    this.publishedTasks = text
    this.init.emit({ kind: 'tasks', tasks })
  }

  private scheduleFlush(): void {
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS)
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    const activity = this.activity.takeChanged()
    if (activity) this.init.emit({ kind: 'activity', activity })
    const summary = this.init.transcript.activity.takeChanged()
    if (summary) this.init.emit({ kind: 'summary', summary })
    const messages = this.init.transcript.takeChanged()
    // 深拷贝一份再发，避免后续流式修改影响已发出的数据
    if (messages.length) this.init.emit({ kind: 'upsert', messages: structuredClone(messages) })
  }
}
