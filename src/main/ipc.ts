import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir, userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { app, BrowserWindow, clipboard, Menu, nativeTheme, shell } from 'electron'
import type { ChatEvent } from '../shared/chat'
import type { DemoState, Settings } from '../shared/types'
import { broadcast as broadcastEvent, registerNamespace } from './ipc/register'
import { SessionManager } from './live/SessionManager'
import * as files from './files'
import { gitDiff } from './gitDiff'
import * as meta from './meta'
import { planUsage, readRoutedUsage, withUsageQuery } from './usage'
import { UsageWorkerClient } from './usageWorkerClient'
import { UsageProfiles, usageAccount } from './usageProfile'
import type { UsageOverview } from '../shared/usageAnalytics'
import { onClaudeConfigChanged, watchClaudeConfig } from './claudeConfigChanges'
import { readClaudeConfig } from './claudeConfigSnapshot'
import { runLocalCommand } from './localCommand'
import * as projects from './projects'
import * as sessions from './sessions'
import * as store from './store'
import { CommandCatalog } from './commandCatalog'
import { readMetadata } from './metadataQuery'
import { activityRepository } from './activityRepository'
import { createSessionPreferencesRepository } from './sessionPreferences'
import { createHumanSubmissionRepository } from './humanSubmissionRepository'
import { appNotificationHandlers } from './appNotifications'
import { Scheduler } from './schedules'
import { readSkillBody, readSkillCatalog, setPluginEnabled } from './skills'
import { claudeRuntime } from './sdk'
import { connectionStatus, openOfficialLogin, openInstallationHelp, pickClaudeExecutable, posixResumeCommand } from './connection'

export function applyTheme(theme: Settings['theme']): void {
  nativeTheme.themeSource = theme
}

let usageIndex: UsageWorkerClient | undefined
function statistics(): UsageWorkerClient {
  return usageIndex ??= new UsageWorkerClient(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), join(app.getPath('userData'), 'usage-index.json'))
}
function profiles(): UsageProfiles { return new UsageProfiles(join(app.getPath('userData'), 'usage-profiles')) }
const overviewRequests = new Map<string, Promise<UsageOverview>>()
let activeAccountKey: string | null = null
function overview(cwd = homedir()): Promise<UsageOverview> {
  const pending = overviewRequests.get(cwd)
  if (pending) return pending
  const request = withUsageQuery(async q => {
    const identity = await q.accountInfo()
    const account = usageAccount(identity)
    activeAccountKey = account.key
    const profile = await profiles().get(account)
    try {
      const usage = await readRoutedUsage(q, identity)
      return { account, usage, profile, updatedAt: Date.now() }
    } catch (error: any) {
      return { account, usage: null, usageError: String(error.message ?? error), profile, updatedAt: Date.now() }
    }
  }, cwd).finally(() => { overviewRequests.delete(cwd) })
  overviewRequests.set(cwd, request)
  return request
}
function broadcast(sessionId: string, event: ChatEvent): void {
  if (event.kind === 'result') void statistics().recordDuration(event.durationMs).catch(error => console.error('Usage statistics:', error))
  if (process.env.CLAUDE_DESK_DEBUG) console.log('[emit]', sessionId.slice(0, 8), event.kind)
  broadcastEvent('chat:onEvent', sessionId, event)
}

onClaudeConfigChanged(change => {
  meta.invalidate()
  broadcastEvent('meta:onConfigChanged', change)
})

const commandConfiguration = (): string => JSON.stringify([store.read().settings.claudePath ?? null, app.getVersion()])
export const commandCatalog: CommandCatalog = new CommandCatalog({
  directory: () => join(app.getPath('userData'), 'command-catalog'),
  configuration: commandConfiguration,
  load: (cwd, signal, configuration) => chats.commandsFor(cwd, configuration) ?? readMetadata(cwd, signal).then((init) => init.commands),
  publish: (snapshot) => broadcastEvent('meta:onCommands', snapshot)
})
export const chats: SessionManager = new SessionManager(broadcast, activityRepository, { configuration: commandConfiguration, publisher: (cwd) => commandCatalog.publisher(cwd) }, createHumanSubmissionRepository(() => join(app.getPath('userData'), 'human-submissions')), createSessionPreferencesRepository(() => join(app.getPath('userData'), 'session-preferences')))

export const scheduler: Scheduler = new Scheduler({
  file: () => join(app.getPath('userData'), 'schedules.json'),
  options: (task) => {
    const { settings } = store.read()
    if (task.mode === 'bypassPermissions' && !settings.allowBypass) throw new Error('「跳过所有权限」未在设置中启用')
    return { model: settings.defaultModel ?? null, mode: task.mode, effort: settings.defaultEffort ?? null }
  },
  start: (projectPath, prompt, options) => chats.start(projectPath, prompt, options),
  isBusy: (sessionId) => chats.isBusy(sessionId),
  onStarted: (run) => broadcastEvent('schedules:onStarted', run),
  onChanged: (tasks) => broadcastEvent('schedules:onChanged', tasks)
})

export function projectMetadata(cwd: string) {
  watchClaudeConfig(cwd)
  return meta.get(cwd, commandCatalog.seedFromMetadata(cwd))
}


export function registerIpc(demo: DemoState | null, focusWindow?: () => void): void {
  registerNamespace('connection', {
    status: async (_e, path) => {
      const status = await connectionStatus(path)
      meta.invalidate(); commandCatalog.invalidate()
      return status
    },
    pickExecutable: () => pickClaudeExecutable(), login: () => openOfficialLogin(), installationHelp: () => openInstallationHelp()
  })
  registerNamespace('app', {
    ...appNotificationHandlers(focusWindow),
    state: () => {
      let username: string | null = null
      try { username = userInfo().username } catch { /* greeting may omit the name */ }
      return { seededFromHistory: store.read().seededFromHistory, demo, home: homedir(), username }
    },
    focus: (e) => {
      if (focusWindow) { focusWindow(); return }
      const win = BrowserWindow.fromWebContents(e.sender)
      if (win?.isMinimized()) win.restore()
      win?.show()
      app.focus({ steal: true })
    }
  })

  registerNamespace('projects', {
    pickFolder: (e) => projects.pickFolder(BrowserWindow.fromWebContents(e.sender)!),
    list: () => projects.list(),
    add: (_e, path) => projects.add(path),
    remove: (_e, id) => projects.remove(id),
    setCollapsed: (_e, id, collapsed) => projects.setCollapsed(id, collapsed),
    detectFromHistory: () => projects.detectFromHistory(),
    markSeeded: () => projects.markSeeded(),
    revealInFinder: (_e, path) => projects.revealInFinder(path)
  })

  registerNamespace('skills', {
    list: (_e, path) => readSkillCatalog(path),
    read: (_e, path) => readSkillBody(path),
    setPluginEnabled: (_e, id, enabled) => setPluginEnabled(id, enabled)
  })

  registerNamespace('schedules', {
    list: () => scheduler.list(),
    create: (_e, input) => scheduler.create(input),
    update: (_e, id, input) => scheduler.update(id, input),
    setEnabled: (_e, id, enabled) => scheduler.setEnabled(id, enabled),
    remove: (_e, id) => scheduler.remove(id),
    runNow: (_e, id) => scheduler.runNow(id)
  })

  registerNamespace('sessions', {
    list: (_e, path) => sessions.list(path),
    rename: (_e, id, title, path) => sessions.rename(id, title, path),
    setArchived: (_e, id, archived) => sessions.setArchived(id, archived)
  })

  registerNamespace('settings', {
    get: () => store.read().settings,
    set: (_e, patch) => {
      const previousPath = store.read().settings.claudePath
      const next = store.update((d) => {
        d.settings = { ...d.settings, ...patch }
      }).settings
      if (next.claudePath !== previousPath) { commandCatalog.invalidate(); meta.invalidate() }
      applyTheme(next.theme)
      return next
    }
  })

  registerNamespace('meta', {
    get: (_e, path) => projectMetadata(path ?? homedir()),
    cachedModels: (_e, path) => meta.cachedModels(path),
    commands: (_e, cwd, force) => {
      if (!isAbsolute(cwd)) throw new Error('项目路径必须是绝对路径')
      return commandCatalog.get(cwd, force === true)
    },
    usage: () => planUsage(),
    configSnapshot: (_e, cwd) => { watchClaudeConfig(cwd); return readClaudeConfig(cwd) },
    config: (_e, path, setting) => runLocalCommand(path, setting ? `/config ${setting}` : '/config')
  })

  registerNamespace('usage', {
    overview: (_e, cwd) => overview(cwd),
    stats: (_e, refresh) => refresh === true ? statistics().refresh() : statistics().get(),
    saveProfile: (_e, key, profile) => {
      if (key !== activeAccountKey) throw new Error('账户信息已变化，请刷新后重试')
      return profiles().save(key, profile)
    }
  })

  registerNamespace('files', {
    diff: (_e, path, source) => gitDiff(path, source),
    saveImage: async (_e, bytes, mime) => {
      const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
      const ext = extensions[mime]
      if (!ext || !bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error('图片格式不支持或超过 25 MB')
      const directory = join(app.getPath('userData'), 'pasted-images')
      await mkdir(directory, { recursive: true })
      const path = join(directory, `${randomUUID()}.${ext}`)
      await writeFile(path, bytes)
      return path
    },
    search: (_e, path, query) => files.search(path, query),
    list: (_e, projectPath, directory) => files.listProjectDirectory(projectPath, directory),
    create: (_e, projectPath, directory, kind, name) => files.createProjectEntry(projectPath, directory, kind, name),
    read: (_e, path) => files.readForPreview(path),
    watch: (_e, path) => files.watchFile(path, () => broadcastEvent('files:onChanged', path)),
    unwatch: (_e, path) => files.unwatchFile(path),
    stat: (_e, paths) => files.statPaths(paths),
    open: async (_e, path) => {
      if (!isAbsolute(path)) throw new Error('参数 path 无效')
      const error = await shell.openPath(path)
      if (error) throw new Error(error)
    },
    contextMenu: (e, path, kind) => {
      if (!isAbsolute(path)) throw new Error('参数 path 无效')
      Menu.buildFromTemplate([
        ...(kind === 'file' ? [{ label: '用默认应用打开', click: () => void shell.openPath(path) }] : []),
        { label: '在 Finder 中显示', click: () => shell.showItemInFolder(path) },
        { type: 'separator' as const },
        { label: '复制路径', click: () => clipboard.writeText(path) }
      ]).popup({ window: BrowserWindow.fromWebContents(e.sender) ?? undefined })
    },
    describe: (_e, paths) => files.describePaths(paths)
  })

  registerNamespace('chat', {
    prepareControls: (_e, id, path) => chats.prepareControls(id, path),
    open: (_e, id, path) => chats.openForDisplay(id, path),
    start: (_e, path, text, options) => chats.start(path, text, options),
    edit: (_e, id, path, messageId, text) => chats.edit(id, path, messageId, text),
    send: (_e, id, path, text, options, attachments) => chats.send(id, path, text, options, attachments),
    queue: (_e, id, path, action) => chats.queueAction(id, path, action),
    interrupt: (_e, id) => chats.interrupt(id),
    setMode: (_e, id, mode) => chats.setMode(id, mode),
    setModel: (_e, id, model) => chats.setModel(id, model),
    rules: (_e, id, path) => chats.rules(id, path),
    changeRule: (_e, id, path, change) => chats.changeRule(id, path, change),
    applySetting: (_e, id, path, key, value) => chats.applySetting(id, path, key, value),
    reloadConfiguration: (_e, id, path) => chats.reloadConfiguration(id, path),
    taskOutput: (_e, id, path, taskId) => chats.taskOutput(id, path, taskId),
    stopTask: (_e, id, path, taskId) => chats.stopTask(id, path, taskId),
    rewindPreview: (_e, id, path, target) => chats.rewindPreview(id, path, target),
    rewindFiles: (_e, id, path, target) => chats.rewindFiles(id, path, target),
    restoreConversation: (_e, id, path, messageId) => chats.restoreConversation(id, path, messageId),
    setWorkflows: (_e, id, value) => chats.setWorkflows(id, value),
    setFastMode: (_e, id, value) => chats.setFastMode(id, value),
    setUltracode: (_e, id, enabled) => chats.setUltracode(id, enabled),
    refreshRuntime: (_e, id) => chats.refreshRuntime(id),
    setEffort: (_e, id, effort) => chats.setEffort(id, effort),
    respond: (_e, id, requestId, decision) => chats.respond(id, requestId, decision),
    checkExternal: (_e, id, path) => chats.checkExternal(id, path),
    handoffToCli: async (_e, id, path) => {
      const executable = claudeRuntime().path
      const historyId = await chats.handoffToCli(id, path)
      const command = posixResumeCommand(executable, path, historyId, process.env.CLAUDE_CONFIG_DIR)
      clipboard.writeText(command)
      return command
    },
    reload: (_e, id, path) => chats.reload(id, path),
    btw: (_e, id, path, question, history, options) => chats.sideQuestion(id, path, question, history, options),
    mcp: (_e, id, path) => chats.mcp(id, path),
    mcpAction: (_e, path, operation, name) => chats.mcpAction(path, operation, name),
    context: (_e, id, path, model) => chats.context(id, path, model)
  })
}
