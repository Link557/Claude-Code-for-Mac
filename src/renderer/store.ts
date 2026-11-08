import { create } from 'zustand'
import { FALLBACK_GREETING, greetingName, nextGreeting } from './greeting'
import { useUsage } from './usageStore'
import { useLayout } from './layoutStore'
import { projectRemoved } from './projectLifecycle'
import { errorText } from './ipcError'
import type { DemoState, DetectedFolder, Project, SessionSummary, Settings } from '@shared/types'
import type { SessionOptions } from '@shared/chat'

export type View = { kind: 'new' } | { kind: 'session'; sessionId: string; projectId: string } | { kind: 'settings'; tab?: 'general' | 'connection' | 'claude' | 'models' | 'context' | 'notifications' | 'advanced'; projectId?: string | null; sessionId?: string | null } | { kind: 'usage' } | { kind: 'schedules' } | { kind: 'skills'; tab?: 'skills' | 'mcp'; projectId?: string | null }

interface DeskState {
  greeting: string
  greetingSelected: boolean
  username: string | null
  actionError: string | null
  clearActionError(): void
  ready: boolean
  home: string
  demo: DemoState | null
  projects: Project[]
  sessions: Record<string, SessionSummary[]>
  settings: Settings | null
  view: View
  selectedProjectId: string | null
  draftOverrides: Partial<SessionOptions>
  sidebarCollapsed: boolean
  /** 待确认添加的项目路径（选择器选完后弹确认框） */
  pendingProjectPath: string | null
  importCandidates: DetectedFolder[] | null
  searchOpen: boolean

  init(): Promise<void>
  refreshSessions(projectId?: string): Promise<void>
  setView(view: View): void
  /** prefill：新对话输入框的初始内容（如从技能页发起的 /skill） */
  newChat(projectId?: string, prefill?: string): void
  newChatPrefill: string | null
  takeNewChatPrefill(): string
  pickProject(): Promise<void>
  confirmAddProject(): Promise<void>
  cancelAddProject(): void
  removeProject(id: string): Promise<void>
  toggleProject(id: string): Promise<void>
  importProjects(paths: string[]): Promise<void>
  renameSession(session: SessionSummary, projectId: string, title: string): Promise<void>
  setArchived(session: SessionSummary, projectId: string, archived: boolean): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<void>
  setDraft(patch: Partial<SessionOptions> & { projectId?: string }): void
  toggleSidebar(): void
  setSearchOpen(open: boolean): void
  /** 新会话刚开始时先在侧栏放一条，等会话文件写出后刷新成真实标题 */
  addPendingSession(projectId: string, sessionId: string, firstPrompt: string): void
  /** 会话开始执行时立即排到侧栏最上方，不必等本轮结束后的刷新 */
  touchSession(projectId: string, sessionId: string): void
}

const desk = (): Window['desk'] => window.desk
const sessionRefreshes = new Map<string, object>()

export function refreshSessionsInBackground(projectId?: string): void {
  void useDesk.getState().refreshSessions(projectId).catch(error => {
    useDesk.setState({ actionError: `会话列表刷新失败：${errorText(error)}` })
  })
}

function chooseGreeting(state: DeskState): string {
  const { overview, error } = useUsage.getState()
  return nextGreeting(greetingName(state.settings?.displayName ?? overview?.profile.name, overview?.account.email, overview || error ? state.username : null))
}

export const useDesk = create<DeskState>((set, get) => ({
  greeting: FALLBACK_GREETING,
  greetingSelected: false,
  username: null,
  actionError: null,
  clearActionError: () => set({ actionError: null }),
  ready: false,
  home: '',
  demo: null,
  projects: [],
  sessions: {},
  settings: null,
  view: { kind: 'new' },
  selectedProjectId: null,
  draftOverrides: {},
  sidebarCollapsed: false,
  searchOpen: false,
  pendingProjectPath: null,
  importCandidates: null,

  async init() {
    const [state, projects, settings] = await Promise.all([desk().app.state(), desk().projects.list(), desk().settings.get()])
    const demo = state.demo
    set({
      ready: true,
      home: state.home,
      username: state.username ?? null,
      greetingSelected: !!projects.length && demo?.route !== 'settings',
      greeting: projects.length && demo?.route !== 'settings' ? nextGreeting(greetingName(settings.displayName, null, null)) : FALLBACK_GREETING,
      demo,
      projects,
      settings,
      selectedProjectId: projects[0]?.id ?? null,
      draftOverrides: {},
      view: demo?.route === 'settings' ? { kind: 'settings' } : { kind: 'new' },
      pendingProjectPath: demo?.dialog === 'add-project' ? (demo.dialogPath ?? state.home) : null
    })
    await get().refreshSessions()

    if (demo?.dialog === 'import' || (!state.seededFromHistory && projects.length === 0)) {
      const candidates = await desk().projects.detectFromHistory()
      if (candidates.length > 0) set({ importCandidates: candidates })
      else await desk().projects.markSeeded()
    }
  },

  async refreshSessions(projectId) {
    const targets = get().projects.filter((p) => !projectId || p.id === projectId)
    await Promise.all(targets.map(async ({ id, path }) => {
      const request = {}
      sessionRefreshes.set(id, request)
      try {
        const list = await desk().sessions.list(path)
        if (sessionRefreshes.get(id) === request) {
          set(state => ({ sessions: { ...state.sessions, [id]: list } }))
        }
      } catch (error) {
        if (sessionRefreshes.get(id) === request) throw error
      } finally {
        if (sessionRefreshes.get(id) === request) sessionRefreshes.delete(id)
      }
    }))
  },

  setView(view) {
    const previous = get().view
    if (view.kind === 'settings') {
      const source = previous.kind === 'session' || previous.kind === 'settings' ? previous : null
      view = { ...view, projectId: view.projectId === undefined ? source?.projectId ?? get().selectedProjectId : view.projectId, sessionId: view.sessionId === undefined ? source?.sessionId ?? null : view.sessionId }
    }
    set({ view, ...(view.kind === 'new' && !get().greetingSelected && get().projects.length ? { greeting: chooseGreeting(get()), greetingSelected: true } : {}) })
  },

  newChatPrefill: null,
  takeNewChatPrefill() {
    const text = get().newChatPrefill ?? ''
    if (text) set({ newChatPrefill: null })
    return text
  },

  newChat(projectId, prefill) {
    set({ newChatPrefill: prefill ?? null, greetingSelected: !!get().projects.length, greeting: get().projects.length ? chooseGreeting(get()) : FALLBACK_GREETING, view: { kind: 'new' }, draftOverrides: {}, selectedProjectId: projectId ?? get().selectedProjectId ?? get().projects[0]?.id ?? null })
  },

  async pickProject() {
    const path = await desk().projects.pickFolder()
    if (path) set({ pendingProjectPath: path })
  },

  async confirmAddProject() {
    const path = get().pendingProjectPath
    if (!path) return
    const projects = await desk().projects.add(path)
    const added = projects.find((p) => p.path === path)
    set({ projects, pendingProjectPath: null, selectedProjectId: added?.id ?? get().selectedProjectId })
    if (!get().greetingSelected && get().view.kind === 'new' && projects.length) set({ greeting: chooseGreeting(get()), greetingSelected: true })
    if (added) await get().refreshSessions(added.id)
  },

  cancelAddProject() {
    set({ pendingProjectPath: null })
  },

  async removeProject(id) {
    const projects = await desk().projects.remove(id)
    sessionRefreshes.delete(id)
    projectRemoved(id)
    const sessions = { ...get().sessions }
    delete sessions[id]
    const selectedProjectId = get().selectedProjectId === id ? (projects[0]?.id ?? null) : get().selectedProjectId
    const view = get().view
    set({ projects, sessions, selectedProjectId, view: view.kind === 'session' && view.projectId === id ? { kind: 'new' } : view })
  },

  async toggleProject(id) {
    const p = get().projects.find((x) => x.id === id)
    if (p) set({ projects: await desk().projects.setCollapsed(id, !p.collapsed) })
  },

  async importProjects(paths) {
    let projects = get().projects
    for (const path of paths) projects = await desk().projects.add(path)
    await desk().projects.markSeeded()
    set({ projects, importCandidates: null, selectedProjectId: get().selectedProjectId ?? projects[0]?.id ?? null })
    if (!get().greetingSelected && get().view.kind === 'new' && projects.length) set({ greeting: chooseGreeting(get()), greetingSelected: true })
    await get().refreshSessions()
  },

  async renameSession(session, projectId, title) {
    const project = get().projects.find((p) => p.id === projectId)
    if (!project || !title.trim() || title === session.title) return
    await desk().sessions.rename(session.id, title.trim(), project.path)
    await get().refreshSessions(projectId)
  },

  async setArchived(session, projectId, archived) {
    const originalView = get().view
    set({ actionError: null })
    try {
      await desk().sessions.setArchived(session.id, archived)
    } catch (error) {
      set({ actionError: `归档状态更新失败：${errorText(error)}` })
      return
    }
    if (archived && get().view === originalView && originalView.kind === 'session' && originalView.sessionId === session.id) {
      get().newChat(projectId)
    }
    try { await get().refreshSessions(projectId) }
    catch (error) { set({ actionError: `会话列表刷新失败：${errorText(error)}` }) }
  },

  async updateSettings(patch) {
    set({ settings: await desk().settings.set(patch) })
  },

  setDraft({ model, mode, effort, ultracode, workflows, fastMode, projectId }) {
    set({
      draftOverrides: {
        ...get().draftOverrides,
        ...(model !== undefined && { model }),
        ...(mode !== undefined && { mode }),
        ...(effort !== undefined && { effort }),
        ...(ultracode !== undefined && { ultracode }),
        ...(workflows !== undefined && { workflows }),
        ...(fastMode !== undefined && { fastMode })
      },
      ...(projectId !== undefined && { selectedProjectId: projectId })
    })
  },

  toggleSidebar() {
    set({ sidebarCollapsed: !get().sidebarCollapsed })
  },

  setSearchOpen(open) {
    set({ searchOpen: open })
  },

  addPendingSession(projectId, sessionId, firstPrompt) {
    const list = get().sessions[projectId] ?? []
    if (list.some((s) => s.id === sessionId)) return
    const project = get().projects.find((p) => p.id === projectId)
    const entry = { id: sessionId, title: firstPrompt.replace(/\s+/g, ' ').trim().slice(0, 80), cwd: project?.path ?? '', lastModified: Date.now(), archived: false }
    set({ sessions: { ...get().sessions, [projectId]: [entry, ...list] } })
  },

  touchSession(projectId, sessionId) {
    const list = get().sessions[projectId] ?? []
    const session = list.find((s) => s.id === sessionId)
    if (!session) return
    const touched = { ...session, lastModified: Date.now() }
    set({ sessions: { ...get().sessions, [projectId]: [touched, ...list.filter((s) => s.id !== sessionId)] } })
  }
}))

// 在导航状态改变的同一轮同步侧栏，避免新会话短暂显示旧页面。
useDesk.subscribe((state, previous) => {
  if (state.view === previous.view) return
  useLayout.getState().activateSession(state.view.kind === 'session' ? state.view.sessionId : null, state.view.kind === 'session' ? state.view.projectId : undefined)
})
