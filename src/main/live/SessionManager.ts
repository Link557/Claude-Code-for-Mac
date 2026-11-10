import { parseDesktopCommand, assertChatPrompt, type DesktopCommand } from '../../shared/sessionCommand'
import { runLocalCommand } from '../localCommand'
import { changeRule } from '../permissionRules'
import { access, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import * as store from '../store'
import { historyIds, recordEdit } from '../sessions'
import type { SessionPreferences, SessionPreferencesRepository } from '../sessionPreferences'
import { randomUUID } from 'node:crypto'
import type { LiveSetting, RuleChange } from '../../shared/sessionControl'
import type { CommandInfo } from '../../shared/types'
import type { BtwTurn, ChatEvent, ChatSnapshot, ContextUsage, Decision, QueueAction, QueuedMessage, McpStatus, SessionOptions } from '../../shared/chat'
import { peekContext } from '../context'
import { loadSdk, withIdleQuery } from '../sdk'
import type { McpServerStatus, Query, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { Transcript } from '../transcript'
import { LiveSession } from './LiveSession'
import { SessionRuntimes } from './SessionRuntimes'
import { SessionPreferencesState } from './SessionPreferencesState'
import type { ActivityRepository } from '../activityRepository'
import type { HumanSubmissionRepository } from '../humanSubmissionRepository'

interface CommandObserver {
  configuration(cwd: string): string
  publisher(cwd: string, configuration: string): (commands: CommandInfo[]) => void
}

type Emit = (sessionId: string, event: ChatEvent) => void

async function sameProjectDirectory(a: string, b: string): Promise<boolean> {
  if (resolve(a) === resolve(b)) return true
  // The filesystem decides which path aliases refer to the same project.
  try {
    const [first, second] = await Promise.all([realpath(a), realpath(b)])
    return first === second
  } catch { return false }
}

export class SessionManager {
  private live = new SessionRuntimes()
  private commandConfigurations = new WeakMap<LiveSession, string>()
  private transcripts = new Map<string, Transcript>()
  private activeHistoryIds = new Map<string, string>()
  private transcriptLoads = new Map<string, Promise<Transcript>>()
  private seen = new Map<string, string>()
  private sweeper = setInterval(() => this.recycle(), 60_000)

  private preferences: SessionPreferencesState
  private revisions = new Map<string, number>()
  private dispatchEpochs = new Map<string, number>()
  private locks = new Map<string, Promise<unknown>>()
  private shuttingDown = false

  constructor(private emit: Emit, private activityStore?: ActivityRepository, private commandObserver?: CommandObserver, private submissionStore?: HumanSubmissionRepository, preferencesStore?: SessionPreferencesRepository) {
    this.preferences = new SessionPreferencesState(preferencesStore, (id, event) => this.publish(id, event))
  }

  private publish(id: string, event: ChatEvent): void {
    const revision = (this.revisions.get(id) ?? 0) + 1
    this.revisions.set(id, revision)
    this.emit(id, { ...event, revision })
  }

  commandsFor(cwd: string, configuration?: string): Promise<CommandInfo[]> | undefined {
    const entry = [...this.live].find(([, candidate]) => candidate.cwd === cwd && (configuration === undefined || this.commandConfigurations.get(candidate) === configuration))
    return entry ? this.live.use(entry[0], () => entry[1].commands()) : undefined
  }

  async openForDisplay(sessionId: string, projectPath: string): Promise<ChatSnapshot> {
    const prefs = this.prefs(sessionId).options
    if (!this.live.has(sessionId) && (prefs?.ultracode || prefs?.fastMode)) {
      try { await this.prepareControls(sessionId, projectPath) }
      catch (error) {
        return { ...await this.open(sessionId, projectPath), runtime: { error: String(error) } }
      }
    }
    return this.open(sessionId, projectPath)
  }

  prepareControls(sessionId: string, projectPath: string): Promise<void> {
    return this.lock(sessionId, async () => {
      const live = await this.ensureLive(sessionId, projectPath, this.options(sessionId))
      await live.readyForControls()
    })
  }

  async open(sessionId: string, projectPath: string): Promise<ChatSnapshot> {
    const transcript = await this.transcript(sessionId, projectPath)
    return this.snapshot(sessionId, this.transcripts.get(sessionId) ?? transcript)
  }

  async subagentMessages(sessionId: string, projectPath: string, toolUseId: string) {
    const parent = await this.transcript(sessionId, projectPath)
    const parentPath = parent.projectPath
    if (!parentPath || !await sameProjectDirectory(parentPath, projectPath)) {
      throw new Error('该会话不属于当前项目')
    }
    const historyId = this.historyId(sessionId)
    const agent = parent.activity.snapshot().sections.agents.find(item => item.id === toolUseId)
    if (!agent) throw new Error('该子 Agent 不属于当前会话')
    const verifiedId = agent.agentIdVerified ? agent.agentId : undefined
    if (!verifiedId && agent.status === 'running' && this.live.has(sessionId)) return []
    const sdk = await loadSdk()
    const dir = { dir: parentPath }
    const read = (id: string) => sdk.getSubagentMessages(historyId, id, dir)
    const belongs = (message: Awaited<ReturnType<typeof read>>[number], allowMissingTool: boolean) =>
      message.session_id === historyId &&
      (message.parent_tool_use_id === toolUseId || (allowMissingTool && !message.parent_tool_use_id))
    let messages: Awaited<ReturnType<typeof read>> = []
    if (verifiedId) {
      messages = await read(verifiedId)
      if (messages.some(message => !belongs(message, true))) {
        throw new Error('子会话的父会话或工具归属无法核实，已阻止展示。')
      }
    } else {
      // The SDK strips tool result metadata when loading the parent history.
      // Recover the link from the SDK's structured child messages.
      for (const id of new Set(await sdk.listSubagents(historyId, dir))) {
        const candidate = await read(id)
        if (!candidate.some(message => belongs(message, false))) continue
        if (messages.length || candidate.some(message => !belongs(message, false))) {
          throw new Error('子会话的父会话或工具归属无法核实，已阻止展示。')
        }
        messages = candidate
      }
    }
    const current = parent.activity.snapshot().sections.agents.find(item => item.id === toolUseId)
    if (this.transcripts.get(sessionId) !== parent || this.historyId(sessionId) !== historyId ||
      !current || (current.agentIdVerified ? current.agentId : undefined) !== verifiedId) {
      throw new Error('会话已更新，请重新读取子会话。')
    }
    const transcript = new Transcript(projectPath)
    // 文件已由 SDK 按父会话与 Agent ID 定位；其中的主链就是该子 Agent 的会话。
    for (const message of messages) transcript.apply({ ...message, parent_tool_use_id: null })
    transcript.finish()
    return transcript.messages
  }

  private snapshot(sessionId: string, transcript: Transcript): ChatSnapshot {
    const session = this.live.get(sessionId)
    const prefs = this.prefs(sessionId)
    return {
      ...(prefs.options ? { options: structuredClone(prefs.options) } : {}),
      queue: structuredClone(prefs.queue),
      ...this.preferences.persistence(sessionId),
      revision: this.revisions.get(sessionId) ?? 0,
      runtime: session?.runtime,
      promptSuggestion: session?.promptSuggestion ?? null,
      activity: session?.activity.snapshot(),
      summary: transcript.activity.snapshot(),
      tasks: session?.backgroundTasks() ?? [],
      messages: structuredClone(transcript.messages),
      state: session?.state ?? 'idle',
      approvals: session?.approvals ?? [],
      live: Boolean(session)
    }
  }

  start(projectPath: string, text: string, options: SessionOptions): string
  start(projectPath: string, text: string, options: SessionOptions, confirmStartup: true): Promise<string>
  start(projectPath: string, text: string, options: SessionOptions, confirmStartup = false): string | Promise<string> {
    assertChatPrompt(text)
    const sessionId = randomUUID()
    const transcript = new Transcript(projectPath)
    this.transcripts.set(sessionId, transcript)
    this.updatePrefs(sessionId, p => { p.options = options })
    const live = this.spawn(sessionId, projectPath, false, options, transcript)
    if (confirmStartup && options.mode === 'auto') {
      return this.live.use(sessionId, async () => {
        try {
          await live.readyForControls()
          live.send(text)
          return sessionId
        } catch (error) {
          live.close()
          this.transcripts.delete(sessionId)
          throw error
        }
      })
    }
    live.send(text)
    return confirmStartup ? Promise.resolve(sessionId) : sessionId
  }

  /** 正在回复、等待确认或仍有后台任务在跑 */
  isBusy(sessionId: string): boolean {
    const live = this.live.get(sessionId)
    return Boolean(live && (live.state !== 'idle' || live.approvals.length || live.hasBackgroundWork()))
  }

  edit(sessionId: string, projectPath: string, messageId: string, text: string): Promise<void> {
    return this.lock(sessionId, async () => {
      assertChatPrompt(text)
      if (this.isBusy(sessionId)) {
        throw new Error('请等待当前任务结束后编辑')
      }
      const original = await this.transcript(sessionId, projectPath)
      const target = original.messages.find(m => m.id === messageId && m.role === 'user')
      if (!target || target.forkFrom === undefined) throw new Error('找不到可编辑的消息')
      const sourceId = this.historyId(sessionId)
      const at = target.forkFrom
      const transcript = new Transcript(projectPath, undefined, at === null ? [] : this.submissionStore?.load(sourceId))
      if (at !== null) {
        const sdk = await loadSdk()
        const messages = await sdk.getSessionMessages(sourceId, { dir: projectPath })
        const boundary = messages.findIndex(message => message.uuid === at)
        if (boundary < 0) throw new Error('历史位置尚未保存，请稍后重试')
        for (const message of messages.slice(0, boundary + 1)) transcript.apply(message)
      }
      transcript.finish()
      transcript.activity.finishHistory(true)
      transcript.takeChanged()

      if (this.shuttingDown) throw new Error('应用已关闭')
      const options = this.options(sessionId)
      const historyId = randomUUID()
      const submission = { uuid: randomUUID(), text, time: Date.now() }
      this.closeSession(sessionId)
      this.activeHistoryIds.set(sessionId, historyId)
      const replacement = this.spawn(sessionId, projectPath, false, options, transcript, at === null ? undefined : { from: sourceId, at })
      try {
        if (options.mode === 'auto') await replacement.readyForControls()
        this.submissionStore?.save(historyId, [...transcript.humanSubmissions(), submission])
        recordEdit(sessionId, historyId)
      } catch (error) {
        replacement.close()
        this.activeHistoryIds.set(sessionId, sourceId)
        throw error
      }
      if (this.prefs(sessionId).queue.items.length && !this.prefs(sessionId).queue.paused) this.pauseQueue(sessionId)
      this.transcripts.set(sessionId, transcript)
      this.publish(sessionId, { kind: 'replaceHistory', snapshot: this.snapshot(sessionId, transcript) })
      replacement.send(text, submission.uuid)
    })
  }

  async send(sessionId: string, projectPath: string, text: string, options: SessionOptions, attachments: string[] = []): Promise<void> {
    return this.lock(sessionId, async () => {
      const control = parseDesktopCommand(text)
      if (control) {
        if (attachments.length) throw new Error('设置指令不能附带文件，请移除附件后执行')
        await this.executeDesktopCommand(sessionId, projectPath, control)
        return
      }
      for (const path of attachments) await access(path)
      await this.syncExternalHistory(sessionId, projectPath)
      const prefs = this.prefs(sessionId)
      const session = this.live.get(sessionId)
      const busy = session?.state === 'running' || session?.state === 'awaiting'
      const hasWaiting = prefs.queue.items.some(item => item.editing || ['queued', 'failed'].includes(item.status))
      // 提交历史/未知交付记录不是待发消息，也不能把新的手动输入锁进旧队列。
      if (busy || hasWaiting) {
        this.updatePrefs(sessionId, p => { p.queue.items.push({ id: randomUUID(), text, options: { ...(prefs.options ?? options) }, attachments, status: 'queued' }) })
        if (!busy) await this.dispatch(sessionId, projectPath)
        return
      }
      if (prefs.queue.paused || prefs.queue.items.some(i => ['submitting', 'submitted', 'received'].includes(i.status))) {
        this.updatePrefs(sessionId, p => {
          p.queue.paused = false
          for (const item of p.queue.items) if (['submitting', 'submitted', 'received'].includes(item.status)) { item.status = 'unknown'; item.error = '前次执行已结束，交付记录待核对；不会自动重发' }
        })
      }
      const live = await this.ensureLive(sessionId, projectPath, options)
      await this.applyOptions(sessionId, options)
      live.send(text)
    })
  }

  async queueAction(sessionId: string, projectPath: string, action: QueueAction): Promise<void> {
    // 暂停不排在正在等待 SDK 的派发之后。
    if (action.type === 'pause') { this.pauseQueue(sessionId); return }
    const requestedEpoch = this.dispatchEpochs.get(sessionId) ?? 0
    return this.lock(sessionId, async () => {
      const prefs = this.prefs(sessionId)
      if (action.type === 'resume') {
        if (requestedEpoch !== (this.dispatchEpochs.get(sessionId) ?? 0)) return
        this.updatePrefs(sessionId, p => { p.queue.paused = false; for (const item of p.queue.items) if (item.status === 'failed') item.status = 'queued' })
        await this.dispatch(sessionId, projectPath); return
      }
      if (action.type === 'clear') { this.updatePrefs(sessionId, p => { p.queue.items = p.queue.items.filter(i => !['queued', 'failed'].includes(i.status) || i.editing) }); return }
      if (!('id' in action)) throw new Error('无效队列操作')
      const item = prefs.queue.items.find(i => i.id === action.id)
      if (!item) {
        if (['beginEdit', 'edit', 'cancelEdit', 'move'].includes(action.type)) throw new Error('这条消息已不在队列中，无法编辑')
        return
      }
      if (action.type === 'forget' && item.status === 'unknown') { this.updatePrefs(sessionId, p => { p.queue.items = p.queue.items.filter(i => i.id !== item.id) }); return }
      if (!['queued', 'failed'].includes(item.status)) throw new Error('消息已经提交，不能再次发送或修改')
      if (action.type === 'beginEdit') {
        if (item.editing) throw new Error('这条消息正在编辑中')
        this.updatePrefs(sessionId, p => { p.queue.items.find(i => i.id === item.id)!.editing = true }); return
      }
      if (action.type === 'cancelEdit') {
        this.updatePrefs(sessionId, p => {
          delete p.queue.items.find(i => i.id === item.id)!.editing
          if (!this.live.get(sessionId) || this.live.get(sessionId)?.state === 'idle') p.queue.paused = true
        }); return
      }
      if (item.editing && action.type !== 'edit') throw new Error('请先保存或取消编辑')
      if (action.type === 'move') {
        if (!['before', 'after'].includes(action.position)) throw new Error('无效排序位置')
        const movable = (entry: QueuedMessage): boolean => !entry.editing && ['queued', 'failed'].includes(entry.status)
        const target = prefs.queue.items.find(i => i.id === action.targetId)
        if (!target || !movable(target)) throw new Error('目标消息已提交或正在编辑，请重新调整顺序')
        if (item.id === target.id) return
        this.updatePrefs(sessionId, p => {
          const ordered = p.queue.items.filter(movable)
          const [moving] = ordered.splice(ordered.findIndex(i => i.id === item.id), 1)
          const index = ordered.findIndex(i => i.id === target.id) + (action.position === 'after' ? 1 : 0)
          ordered.splice(index, 0, moving)
          let cursor = 0
          // 已提交和编辑中的记录留在原槽位，只调整可派发消息的顺序。
          p.queue.items = p.queue.items.map(i => movable(i) ? ordered[cursor++] : i)
        }); return
      }
      if (action.type === 'delete') { this.updatePrefs(sessionId, p => { p.queue.items = p.queue.items.filter(i => i.id !== item.id) }); return }
      if (action.type === 'edit') {
        if (!item.editing) throw new Error('请先进入编辑模式')
        if (!action.text.trim()) throw new Error('消息不能为空')
        assertChatPrompt(action.text)
        const paths = action.attachments ?? item.attachments ?? []
        for (const path of paths) await access(path)
        this.updatePrefs(sessionId, p => {
          const target = p.queue.items.find(i => i.id === item.id)!
          target.text = action.text; target.attachments = paths; target.status = 'queued'; delete target.error; delete target.editing
          if (!this.live.get(sessionId) || this.live.get(sessionId)?.state === 'idle') p.queue.paused = true
        }); return
      }
      if (action.type !== 'insert') throw new Error('无效队列操作')
      const live = this.live.get(sessionId)
      if (!live || live.state !== 'running' || live.activity.snapshot().phase === 'stopping') throw new Error('当前会话不可插入，请等待执行恢复或使用继续队列')
      await this.submitQueued(sessionId, projectPath, item, true)
    })
  }

  /** /btw：在会话旁边问个小问题，不写入会话。会话进程没在运行时先恢复它（不发消息） */
  async sideQuestion(
    sessionId: string,
    projectPath: string,
    question: string,
    history: BtwTurn[],
    options: SessionOptions
  ): Promise<string | null> {
    return this.live.use(sessionId, async () => {
      const session = await this.ensureLive(sessionId, projectPath, options)
      return session.sideQuestion(question, history)
    })
  }

  /** /mcp：会话在运行就问它，否则临时起一个进程读取（不发消息） */
  async mcp(sessionId: string | null, projectPath: string): Promise<McpStatus[]> {
    const live = sessionId ? this.live.get(sessionId) : undefined
    const list = live ? await this.live.use(sessionId!, () => live.mcpStatus()) : await withIdleQuery({ cwd: projectPath }, (q) => settledMcpStatus(q))
    return list.map(mcpView)
  }

  /** 不依赖会话启停或重连 MCP：停用状态由 Claude Code 写入项目配置，之后的新会话生效 */
  async mcpAction(projectPath: string, operation: 'enable' | 'disable' | 'reconnect', name: string): Promise<McpStatus[]> {
    const list = await withIdleQuery({ cwd: projectPath }, async (q) => {
      if (!(await q.mcpServerStatus()).some((s) => s.name === name)) throw new Error('没有找到 MCP 服务：' + name)
      if (operation === 'reconnect') await q.reconnectMcpServer(name)
      else await q.toggleMcpServer(name, operation === 'enable')
      return settledMcpStatus(q)
    })
    return list.map(mcpView)
  }

  async interrupt(sessionId: string): Promise<void> {
    this.pauseQueue(sessionId)
    await this.live.use(sessionId, async () => { await this.live.get(sessionId)?.interrupt() })
  }

  setMode(sessionId: string, mode: SessionOptions['mode']): Promise<void> {
    return this.lock(sessionId, () => {
      const applied = this.live.get(sessionId)?.runtime.permissionMode
      return this.applyOptions(sessionId, { mode }, applied !== undefined && applied !== mode)
    })
  }
  setModel(sessionId: string, model: string | null): Promise<void> { return this.lock(sessionId, () => this.applyOptions(sessionId, { model }, true)) }
  setWorkflows(sessionId: string, workflows: boolean): Promise<void> { return this.lock(sessionId, () => this.applyOptions(sessionId, { workflows })) }
  setFastMode(sessionId: string, enabled: boolean): Promise<void> { return this.lock(sessionId, () => this.applyOptions(sessionId, { fastMode: enabled }, true)) }

  rules(sessionId: string, path: string) {
    return this.withRuntime(sessionId, path, live => live.permissionRules())
  }

  taskOutput(sessionId: string, path: string, taskId: string) {
    return this.withRuntime(sessionId, path, live => live.taskOutput(taskId))
  }

  stopTask(sessionId: string, path: string, taskId: string): Promise<void> {
    return this.withRuntime(sessionId, path, live => live.stopTask(taskId))
  }

  rewindPreview(sessionId: string, path: string, target: string) {
    return this.withRuntime(sessionId, path, live => live.rewind(target, true))
  }

  applySetting(sessionId: string, path: string, key: LiveSetting, value: string): Promise<void> {
    return this.lock(sessionId, async () => {
      const live = await this.ensureLive(sessionId, path, this.options(sessionId))
      await live.readyForControls()
      await live.applySetting(key, value)
      await live.refreshRuntime()
    })
  }

  changeRule(sessionId: string, path: string, change: RuleChange) {
    return this.lock(sessionId, async () => {
      const live = await this.ensureLive(sessionId, path, this.options(sessionId))
      const state = await live.permissionRules()
      if (state.managedOnly) throw new Error('当前策略不允许编辑权限规则')
      if (change.remove && !state.rules.some(r => r.rule === change.rule && r.source === change.source && r.behavior === change.behavior && r.editability === 'persistent')) throw new Error('该规则无法撤销')
      await changeRule(path, change)
      await live.refreshConfiguration()
      return live.permissionRules()
    })
  }

  reloadConfiguration(sessionId: string, path: string): Promise<void> {
    return this.lock(sessionId, async () => {
      this.assertInactive(sessionId, '重载')
      this.closeSession(sessionId)
      const live = await this.ensureLive(sessionId, path, this.options(sessionId))
      await live.readyForControls()
      await live.refreshRuntime()
    })
  }

  restoreConversation(sessionId: string, path: string, messageId: string): Promise<string> {
    return this.lock(sessionId, async () => {
      this.assertInactive(sessionId, '恢复对话')
      const original = await this.transcript(sessionId, path)
      const message = original.messages.find(m => m.id === messageId && m.role === 'user')
      if (!message || message.forkFrom === undefined) throw new Error('找不到可恢复的消息位置')
      const options = { ...this.options(sessionId) }
      if (message.forkFrom === null) {
        const id = randomUUID()
        const transcript = new Transcript(path)
        this.transcripts.set(id, transcript)
        this.updatePrefs(id, p => { p.options = options })
        this.spawn(id, path, false, options, transcript)
        return id
      }
      const sdk = await loadSdk()
      const result = await sdk.forkSession(this.historyId(sessionId), { dir: path, upToMessageId: message.forkFrom })
      this.updatePrefs(result.sessionId, p => { p.options = options })
      return result.sessionId
    })
  }

  rewindFiles(sessionId: string, path: string, target: string) {
    return this.lock(sessionId, async () => {
      this.assertInactive(sessionId, '恢复文件')
      const live = await this.ensureLive(sessionId, path, this.options(sessionId))
      return live.rewind(target, false)
    })
  }

  private assertInactive(sessionId: string, action: string): void {
    if (this.isBusy(sessionId)) throw new Error(`请等待当前任务及后台任务结束后${action}`)
  }

  /** Non-serial operations hold an eviction lease. Reload invalidates their late answers. */
  private withRuntime<T>(sessionId: string, path: string, operation: (live: LiveSession) => Promise<T>): Promise<T> {
    return this.live.use(sessionId, async () => {
      const live = await this.ensureLive(sessionId, path, this.options(sessionId))
      const result = await operation(live)
      if (this.live.get(sessionId) !== live) throw new Error('会话已重载或结束，请重新读取')
      return result
    })
  }

  refreshRuntime(sessionId: string): Promise<void> { return this.lock(sessionId, async () => { await this.live.get(sessionId)?.reloadSettings() }) }
  setUltracode(sessionId: string, enabled: boolean): Promise<void> { return this.lock(sessionId, () => this.applyOptions(sessionId, { ultracode: enabled })) }
  setEffort(sessionId: string, effort: SessionOptions['effort']): Promise<void> { return this.lock(sessionId, () => this.applyOptions(sessionId, { effort }, true)) }

  async respond(sessionId: string, requestId: string, decision: Decision): Promise<void> {
    return this.lock(sessionId, async () => {
      const live = this.live.get(sessionId)
      if (!live?.approvals.some(request => request.requestId === requestId)) return
      await live.respond(requestId, decision)
      if (decision.type === 'planApprove') this.updatePrefs(sessionId, p => { p.options = { ...this.options(sessionId), mode: decision.mode } }, 'applied')
    })
  }

  checkExternal(sessionId: string, projectPath: string): Promise<boolean> {
    return this.lock(sessionId, () => this.syncExternalHistory(sessionId, projectPath))
  }

  private async syncExternalHistory(sessionId: string, projectPath: string): Promise<boolean> {
    const current = this.transcripts.get(sessionId)
    if (!current || this.isBusy(sessionId)) return false
    const historyId = this.historyId(sessionId)
    const sdk = await loadSdk()
    const messages = await sdk.getSessionMessages(historyId, { dir: projectPath })
    const stamp = this.historyStamp(messages)
    if (!messages.length || this.seen.get(sessionId) === stamp || this.shuttingDown || this.isBusy(sessionId)) return false

    const transcript = this.restoreHistory(historyId, projectPath, messages)
    if (this.live.has(sessionId)) {
      // 等待中的 SDK 调用和队列继续由原进程负责。自己的磁盘回写不触发重连。
      if (this.live.hasConcurrentUse(sessionId) || this.prefs(sessionId).queue.items.some(
        item => item.editing || ['queued', 'submitting', 'submitted', 'received'].includes(item.status)
      )) return false
      const known = new Set(current.messages.map(message => message.uuid))
      if (!transcript.messages.some(message => message.startsTurn && message.uuid && !known.has(message.uuid))) {
        this.seen.set(sessionId, stamp)
        return false
      }
      this.closeSession(sessionId)
    }
    this.transcripts.set(sessionId, transcript)
    this.seen.set(sessionId, stamp)
    this.publish(sessionId, { kind: 'replaceHistory', snapshot: this.snapshot(sessionId, transcript) })
    return true
  }

  private historyStamp(messages: SessionMessage[]): string {
    return `${messages.length}:${messages.at(-1)?.uuid ?? ''}`
  }

  private restoreHistory(historyId: string, projectPath: string, messages: SessionMessage[]): Transcript {
    const saved = this.activityStore?.load(historyId)
    const transcript = new Transcript(projectPath, saved, this.submissionStore?.load(historyId))
    for (const message of messages) transcript.apply(message)
    transcript.finish()
    transcript.activity.finishHistory(!saved)
    transcript.takeChanged()
    return transcript
  }

  async context(sessionId: string, projectPath: string, model: string | null): Promise<ContextUsage | null> {
    const live = this.live.get(sessionId)
    // 新会话还没写出会话文件时读不到，返回 null 即可
    return (live ? this.live.use(sessionId, () => live.contextUsage()) : peekContext(this.historyId(sessionId), projectPath, model)).catch(() => null)
  }

  reload(sessionId: string, projectPath: string): Promise<ChatSnapshot> {
    return this.lock(sessionId, () => {
      this.closeSession(sessionId)
      this.transcripts.delete(sessionId)
      this.transcriptLoads.delete(sessionId)
      return this.open(sessionId, projectPath)
    })
  }

  closeAll(): void {
    this.shuttingDown = true
    clearInterval(this.sweeper)
    this.live.closeAll()
  }

  private historyId(sessionId: string): string {
    return this.activeHistoryIds.get(sessionId) ?? sessionId
  }

  private async transcript(sessionId: string, projectPath: string): Promise<Transcript> {
    const existing = this.transcripts.get(sessionId)
    if (existing) return existing
    const pending = this.transcriptLoads.get(sessionId)
    if (pending) return pending
    // 并发恢复共享同一份记录，避免缓存和 LiveSession 持有不同实例。
    const loading = loadSdk().then(async (sdk) => {
      const candidates = historyIds(sessionId).reverse()
      let historyId = sessionId
      let messages: Awaited<ReturnType<typeof sdk.getSessionMessages>> = []
      // A restart before the replacement writes any messages can still open the last saved history.
      for (const candidate of candidates) {
        historyId = candidate
        messages = await sdk.getSessionMessages(candidate, { dir: projectPath })
        if (messages.length) break
      }
      const transcript = this.restoreHistory(historyId, projectPath, messages)
      if (this.transcriptLoads.get(sessionId) === loading) {
        this.activeHistoryIds.set(sessionId, historyId)
        this.seen.set(sessionId, this.historyStamp(messages))
        this.transcripts.set(sessionId, transcript)
      }
      return transcript
    })
    this.transcriptLoads.set(sessionId, loading)
    try {
      return await loading
    } finally {
      if (this.transcriptLoads.get(sessionId) === loading) this.transcriptLoads.delete(sessionId)
    }
  }

  private spawn(
    sessionId: string,
    cwd: string,
    resume: boolean,
    options: SessionOptions,
    transcript: Transcript,
    fork?: { from: string; at: string }
  ): LiveSession {
    this.recycle(1)
    const historyId = this.historyId(sessionId)
    const emit = (event: ChatEvent): void => {
      if (event.kind === 'summary') this.activityStore?.save(historyId, transcript.activity.export())
      if (event.kind === 'result') {
        const ids = event.diagnostic?.userMessageIds ?? []
        this.preferences.observe(sessionId, p => {
          p.queue.items = p.queue.items.filter(i => !ids.includes(i.id))
          if (!ids.length) for (const item of p.queue.items) {
            if (['submitting', 'submitted', 'received'].includes(item.status)) { item.status = 'unknown'; item.error = '执行已结束，但引擎未提供消息关联信息，请核对会话'; p.queue.paused = true }
          }
          if (event.error) p.queue.paused = true
        })
      }
      if (event.kind === 'state' && event.state === 'error') this.preferences.observe(sessionId, p => { p.queue.paused = true })
      this.publish(sessionId, event)
      if (event.kind === 'state' && event.state === 'idle' && !this.shuttingDown) {
        void this.lock(sessionId, () => this.dispatch(sessionId, cwd)).catch(error => this.publish(sessionId, { kind: 'notice', text: String(error) }))
      }
    }
    const configuration = this.commandObserver?.configuration(cwd)
    const session = new LiveSession({
      sessionId: historyId, cwd, resume, fork, options, transcript, emit, onCommands: configuration === undefined ? undefined : this.commandObserver?.publisher(cwd, configuration),
      onConsumed: (ids) => {
        this.preferences.observe(sessionId, p => { for (const item of p.queue.items) if (ids.includes(item.id)) item.status = 'received' })
      },
      onSubmit: (submission) => {
        if (!this.submissionStore) return
        const previous = this.submissionStore.load(historyId)
        if (previous.some(s => s.uuid === submission.uuid && s.text === submission.text)) return
        this.submissionStore.save(historyId, [...previous.filter(s => s.uuid !== submission.uuid), submission])
      },
      onClosed: (closed) => {
        // 迟到的旧实例退出事件不能删除已经替换它的新实例。
        if (!this.live.remove(sessionId, closed)) return
        this.preferences.observe(sessionId, p => {
          if (p.queue.items.length) p.queue.paused = true
          for (const item of p.queue.items) if (['submitting', 'submitted', 'received'].includes(item.status)) item.status = 'unknown'
        })
        this.seen.delete(sessionId)
      }
    })
    if (configuration !== undefined) this.commandConfigurations.set(session, configuration)
    this.live.add(sessionId, session)
    void session.start()
    return session
  }

  private prefs(id: string): SessionPreferences { return this.preferences.get(id) }

  private options(id: string): SessionOptions {
    const defaults = store.read().settings
    const options = this.prefs(id).options ?? { model: defaults.defaultModel ?? null, mode: defaults.defaultPermissionMode ?? 'default', effort: defaults.defaultEffort ?? null }
    return !this.live.get(id) && !defaults.allowBypass && options.mode === 'bypassPermissions' ? { ...options, mode: 'default' } : options
  }

  private updatePrefs(id: string, update: (prefs: SessionPreferences) => void, commit: 'durable' | 'applied' = 'durable'): void {
    this.preferences.update(id, update, commit)
  }

  private pauseQueue(id: string): void {
    this.dispatchEpochs.set(id, (this.dispatchEpochs.get(id) ?? 0) + 1)
    this.preferences.observe(id, p => { p.queue.paused = true })
  }

  private ensureLive(id: string, cwd: string, fallback: SessionOptions): Promise<LiveSession> {
    return this.live.getOrCreate(id, () => this.transcript(id, cwd), transcript => {
      const options = this.prefs(id).options ?? fallback
      if (!this.prefs(id).options) this.updatePrefs(id, p => { p.options = options })
      return this.spawn(id, cwd, true, options, transcript)
    })
  }

  private lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(id) ?? Promise.resolve()).catch(() => {}).then(() => this.live.use(id, fn))
    this.locks.set(id, next)
    void next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id) }).catch(() => {})
    return next
  }

  private async executeDesktopCommand(id: string, cwd: string, command: DesktopCommand): Promise<void> {
    if (command.kind === 'panel') throw new Error('请在桌面输入框打开对应设置面板')
    if (command.kind === 'options') {
      if (command.patch.fastMode !== undefined || command.patch.ultracode !== undefined || command.patch.workflows !== undefined) {
        await (await this.ensureLive(id, cwd, this.options(id))).readyForControls()
      }
      await this.applyOptions(id, command.patch, true)
      return
    }
    if (command.kind === 'session' && command.name !== 'output-style') {
      const live = await this.ensureLive(id, cwd, this.options(id))
      await live.readyForControls()
      if (command.name === 'autocompact') await live.autoCompact(command.args)
      else {
        const [operation, target = 'all'] = command.args.split(/\s+/)
        await live.mcpCommand(operation as 'enable' | 'disable' | 'reconnect', target)
      }
      return
    }
    const setting = command.kind === 'config' ? command.setting : `outputStyle=${command.args}`
    const equal = setting.indexOf('=')
    const key = setting.slice(0, equal), value = setting.slice(equal + 1)
    await runLocalCommand(cwd, `/config ${setting}`)
    try {
      if (key === 'model') await this.applyOptions(id, { model: ['auto', 'default'].includes(value) ? null : value }, true)
      else if (key === 'outputStyle' || key === 'language' || key === 'thinking') {
        const live = this.live.get(id)
        if (live) { await live.applySetting(key, value); await live.refreshRuntime() }
      }
    } catch (error) { throw new Error(`设置已保存，但当前会话应用失败：${error instanceof Error ? error.message : String(error)}`) }
  }

  private async applyOptions(id: string, patch: Partial<SessionOptions>, force = false): Promise<void> {
    if (patch.mode === 'bypassPermissions' && !store.read().settings.allowBypass) throw new Error('请先在设置中允许选择跳过权限模式')
    // 初始配置完成后再接受修改，避免启动时的默认值覆盖用户刚选的设置。
    const existing = this.live.get(id)
    if (existing) await existing.readyForControls()
    const runtime = this.live.get(id)?.runtime
    if (patch.ultracode && runtime?.ultracodeAvailable === false && runtime.workflowAction) {
      patch = { ...patch, workflows: true }
      force = true
    }
    for (const key of ['model', 'effort', 'mode', 'workflows', 'ultracode', 'fastMode'] as const) {
      if (patch[key] === undefined) continue
      const live = this.live.get(id)
      if (live && (force || this.options(id)[key] !== patch[key])) {
        if (key === 'model') await live.setModel(patch.model!)
        if (key === 'effort') await live.setEffort(patch.effort!, patch.ultracode ?? this.options(id).ultracode)
        if (key === 'workflows') await live.setWorkflows(patch.workflows!)
        if (key === 'fastMode') await live.setFastMode(patch.fastMode!, this.options(id).fastMode)
        if (key === 'ultracode') await live.setUltracode(patch.ultracode!)
        if (key === 'mode') await live.setMode(patch.mode!)
      }
      this.updatePrefs(id, p => { p.options = { ...this.options(id), [key]: patch[key] }; for (const item of p.queue.items) if (['queued', 'failed'].includes(item.status)) item.options = { ...p.options } }, live ? 'applied' : 'durable')
    }
    await this.live.get(id)?.refreshRuntime()
  }

  private async dispatch(id: string, cwd: string): Promise<void> {
    if (this.shuttingDown) return
    const prefs = this.prefs(id), live = this.live.get(id)
    if (prefs.queue.paused || (live && live.state !== 'idle') || prefs.queue.items.some(i => ['submitting', 'submitted', 'received'].includes(i.status))) return
    const item = prefs.queue.items.find(i => i.status === 'queued')
    if (item && !item.editing) await this.submitQueued(id, cwd, item, false)
  }

  private async submitQueued(id: string, cwd: string, item: QueuedMessage, insert: boolean): Promise<void> {
    let handedOff = false
    const epoch = this.dispatchEpochs.get(id) ?? 0
    const cancelled = (): boolean => this.shuttingDown || epoch !== (this.dispatchEpochs.get(id) ?? 0)
    try {
      assertChatPrompt(item.text)
      for (const path of item.attachments ?? []) await access(path)
      if (cancelled()) return
      const currentOptions = this.prefs(id).options ?? item.options
      const live = await this.ensureLive(id, cwd, currentOptions)
      await live.readyForControls()
      if (cancelled()) return
      if (cancelled()) return
      if (insert && (live.state !== 'running' || live.activity.snapshot().phase === 'stopping')) throw new Error('当前会话不可插入，请使用继续队列')
      if (!insert && (this.prefs(id).queue.paused || live.state !== 'idle')) return
      this.updatePrefs(id, p => { const target = p.queue.items.find(i => i.id === item.id)!; target.status = 'submitting'; target.options = { ...this.options(id) }; delete target.error })
      // 进入发送调用后，异常也不能证明消息未交付；保守标记未知，避免重发。
      handedOff = true
      live.send(item.text, item.id)
      this.preferences.observe(id, p => { const target = p.queue.items.find(i => i.id === item.id); if (target?.status === 'submitting') target.status = 'submitted' })
    } catch (error) {
      if (!handedOff && cancelled()) return
      this.preferences.observe(id, p => {
        p.queue.paused = true
        const target = p.queue.items.find(i => i.id === item.id)
        if (target) { target.status = handedOff ? 'unknown' : 'failed'; target.error = String(error) }
      })
      throw error
    }
  }

  /**
   * 驻留实例超出本机设置时，才回收已达到闲置时长的会话，从最久没用的开始。
   * 没超出上限就全部保留；超出但都没闲置够时，暂时允许多开，等下一轮再回收。
   * reserve 是即将新建、还没登记的会话数。
   */
  private recycle(reserve = 0): void {
    const settings = store.read().settings
    const retained = Number.isInteger(settings.retainedSessions) && settings.retainedSessions! >= 1 && settings.retainedSessions! <= 16 ? settings.retainedSessions! : 4
    const minutes = Number.isInteger(settings.sessionIdleMinutes) && settings.sessionIdleMinutes! >= 1 && settings.sessionIdleMinutes! <= 120 ? settings.sessionIdleMinutes! : 15
    const excess = this.live.size + reserve - retained
    if (excess <= 0) return
    const now = Date.now()
    const stale = this.live.idle()
      .filter(([, s]) => now - s.lastActive > minutes * 60_000)
      .sort((a, b) => a[1].lastActive - b[1].lastActive)
    for (const [id] of stale.slice(0, excess)) this.closeSession(id)
  }

  private closeSession(id: string): void {
    this.dispatchEpochs.set(id, (this.dispatchEpochs.get(id) ?? 0) + 1)
    const session = this.live.get(id)
    if (session) this.preferences.observe(id, p => {
      if (p.queue.items.length) p.queue.paused = true
      for (const item of p.queue.items) if (['submitting', 'submitted', 'received'].includes(item.status)) item.status = 'unknown'
    })
    this.live.close(id)
    this.seen.delete(id) // 进程刚写完文件，下次检查时重新记基准
  }
}

function mcpView(s: McpServerStatus): McpStatus {
  return { name: s.name, status: s.status, error: s.error, scope: s.scope, tools: s.tools?.length ?? 0 }
}

/** 临时进程刚启动时服务器多半还在连接，等状态稳定（最多 timeout）再返回，避免页面一直显示连接中 */
export async function settledMcpStatus(q: Pick<Query, 'mcpServerStatus'>, timeout = 10_000, interval = 400): Promise<McpServerStatus[]> {
  const deadline = Date.now() + timeout
  let list = await q.mcpServerStatus()
  while (list.some((s) => s.status === 'pending') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval))
    list = await q.mcpServerStatus()
  }
  return list
}
