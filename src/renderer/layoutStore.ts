import { create } from 'zustand'
import type { SummaryView } from '@shared/sessionSummary'
import { useBtw } from './btwStore'
import { onProjectRemoved } from './projectLifecycle'

export type RightTab = `file:${string}` | `page:${string}`
export interface SidePage {
  id: `page:${string}`
  kind: 'start' | 'files' | 'terminal' | 'browser' | 'summary' | 'chat' | 'controls' | 'tasks' | 'agents'
  sessionId?: string
  projectId?: string
  section?: SummaryView
  cwd?: string
  turnDiff?: string
  /** 后台任务页里选中的任务 */
  taskId?: string
  agentId?: string
}
export interface OpenFile { path: string; line?: number; nonce: number }
interface SessionLayout {
  projectId?: string
  rightOpen: boolean
  rightTab: RightTab | null
  pages: SidePage[]
  openFiles: OpenFile[]
  expanded: boolean
}
const empty = (): SessionLayout => ({ rightOpen: false, rightTab: null, pages: [], openFiles: [], expanded: false })
const snapshot = (s: SessionLayout): SessionLayout => ({ projectId: s.projectId, rightOpen: s.rightOpen, rightTab: s.rightTab, pages: s.pages, openFiles: s.openFiles, expanded: s.expanded })
export const MAX_SIDEBAR_PAGES = 6
export const LEFT = { min: 220, max: 420, default: 272 }
export const RIGHT = { min: 320, max: 600, default: 380 }
const KEY = 'claude-desk.layout'
const clamp = (n: number, r: { min: number; max: number }): number => Math.round(Math.min(Math.max(n, r.min), r.max))
function widths() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return { leftWidth: clamp(Number(saved.leftWidth) || LEFT.default, LEFT), rightWidth: clamp(Number(saved.rightWidth) || RIGHT.default, RIGHT) }
  } catch { return { leftWidth: LEFT.default, rightWidth: RIGHT.default } }
}
interface LayoutStore extends SessionLayout {
  leftWidth: number
  rightWidth: number
  resizing: boolean
  activeSessionId: string | null
  sessions: Record<string, SessionLayout>
  activateSession(sessionId: string | null, projectId?: string): void
  removeProject(projectId: string): void
  setExpanded(expanded: boolean): void
  openDiff(cwd: string | undefined, text: string): void
  newPage(cwd?: string, kind?: SidePage['kind']): SidePage['id'] | null
  changePage(id: SidePage['id'], kind: SidePage['kind'], cwd?: string): void
  closePage(id: SidePage['id']): void
  openSummary(sessionId: string, projectId: string, section: SummaryView): void
  openTasks(sessionId: string, projectId: string, taskId?: string): void
  openAgent(sessionId: string, projectId: string, agentId: string): boolean
  openFile(path: string, line?: number): void
  closeFile(path: string): void
  setLeftWidth(width: number): void
  setRightWidth(width: number): void
  setRightOpen(open: boolean): void
  openRight(tab: RightTab): void
  setResizing(resizing: boolean): void
}
function release(page: SidePage): void {
  useBtw.getState().remove(page.id)
  void window.desk.workspace.closePage(page.id).catch((error) => console.error('关闭工作区页面失败', error))
}
export const useLayout = create<LayoutStore>((set, get) => {
  const saveWidth = (patch: Partial<Pick<LayoutStore, 'leftWidth' | 'rightWidth'>>): void => {
    set(patch)
    const { leftWidth, rightWidth } = get()
    try { localStorage.setItem(KEY, JSON.stringify({ leftWidth, rightWidth })) } catch { /* 本次运行仍生效 */ }
  }
  return {
    ...empty(), ...widths(), resizing: false, activeSessionId: null, sessions: {},
    activateSession: (sessionId, projectId) => {
      const state = get()
      if (sessionId === state.activeSessionId) return
      const sessions = { ...state.sessions }
      if (state.activeSessionId) sessions[state.activeSessionId] = snapshot(state)
      set({ ...empty(), ...(sessionId ? sessions[sessionId] : undefined), projectId, activeSessionId: sessionId, sessions, resizing: false })
    },
    removeProject: (projectId) => {
      const state = get()
      const sessions = { ...state.sessions }
      if (state.activeSessionId) sessions[state.activeSessionId] = snapshot(state)
      for (const [id, session] of Object.entries(sessions)) {
        if (session.projectId !== projectId) continue
        session.pages.forEach(release)
        delete sessions[id]
      }
      set({ sessions, ...(state.projectId === projectId ? { ...empty(), activeSessionId: null, projectId: undefined } : {}) })
    },
    setExpanded: (expanded) => { if (get().activeSessionId) set({ expanded }) },
    openDiff: (cwd, text) => {
      const id = get().newPage(cwd, 'controls')
      if (id) set({ pages: get().pages.map(p => p.id === id ? { ...p, turnDiff: text } : p) })
    },
    newPage: (cwd, kind = 'start') => {
      const { activeSessionId, projectId, pages } = get()
      if (!activeSessionId || sidebarPageCount(get()) >= MAX_SIDEBAR_PAGES) return null
      const id = `page:${crypto.randomUUID()}` as const
      set({ pages: [...pages, { id, kind, cwd, sessionId: activeSessionId, projectId }], rightOpen: true, rightTab: id })
      return id
    },
    openSummary: (sessionId, projectId, section) => {
      if (sessionId !== get().activeSessionId) return
      const existing = get().pages.find((p) => p.kind === 'summary' && p.section === section)
      if (!existing && sidebarPageCount(get()) >= MAX_SIDEBAR_PAGES) return
      const id = existing?.id ?? `page:${crypto.randomUUID()}` as const
      if (!existing) set({ pages: [...get().pages, { id, kind: 'summary', sessionId, projectId, section }] })
      set({ rightOpen: true, rightTab: id })
    },
    openAgent: (sessionId, projectId, agentId) => {
      if (sessionId !== get().activeSessionId) return false
      const existing = get().pages.find(p => p.kind === 'agents')
      if (!existing && sidebarPageCount(get()) >= MAX_SIDEBAR_PAGES) return false
      const id = existing?.id ?? `page:${crypto.randomUUID()}` as const
      const page: SidePage = { id, kind: 'agents', sessionId, projectId, agentId }
      set({ pages: existing ? get().pages.map(p => p.id === id ? page : p) : [...get().pages, page], rightOpen: true, rightTab: id })
      return true
    },
    openTasks: (sessionId, projectId, taskId) => {
      if (sessionId !== get().activeSessionId) return
      const existing = get().pages.find((p) => p.kind === 'tasks')
      if (!existing && sidebarPageCount(get()) >= MAX_SIDEBAR_PAGES) return
      const id = existing?.id ?? `page:${crypto.randomUUID()}` as const
      const page: SidePage = { ...existing, id, kind: 'tasks', sessionId, projectId, taskId: taskId ?? existing?.taskId }
      set({ pages: existing ? get().pages.map((p) => p.id === id ? page : p) : [...get().pages, page], rightOpen: true, rightTab: id })
    },
    changePage: (id, kind, cwd) => {
      if (!get().activeSessionId) return
      set({ pages: get().pages.map((p) => p.id === id && p.kind === 'start' ? { ...p, kind, cwd: cwd ?? p.cwd } : p) })
    },
    closePage: (id) => {
      const before = get().pages
      const index = before.findIndex((p) => p.id === id)
      if (index < 0) return
      release(before[index])
      const pages = before.filter((p) => p.id !== id)
      const rightTab = get().rightTab === id ? pages[Math.min(index, pages.length - 1)]?.id ?? (get().openFiles[0] ? `file:${get().openFiles[0].path}` as const : null) : get().rightTab
      set({ pages, rightTab })
      if (!rightTab && get().rightOpen) get().newPage()
    },
    openFile: (path, line) => {
      if (!get().activeSessionId) return
      const existing = get().openFiles.find((f) => f.path === path)
      if (!existing && sidebarPageCount(get()) >= MAX_SIDEBAR_PAGES) return
      const entry = { path, line, nonce: (existing?.nonce ?? 0) + 1 }
      const openFiles = existing ? get().openFiles.map((f) => f.path === path ? entry : f) : [...get().openFiles, entry]
      set({ openFiles, rightOpen: true, rightTab: `file:${path}` })
    },
    closeFile: (path) => {
      const index = get().openFiles.findIndex((f) => f.path === path)
      const openFiles = get().openFiles.filter((f) => f.path !== path)
      set({ openFiles })
      if (get().rightTab === `file:${path}`) {
        const neighbour = openFiles[Math.min(index, openFiles.length - 1)]
        set({ rightTab: neighbour ? `file:${neighbour.path}` : get().pages[0]?.id ?? null })
        if (!get().rightTab && get().rightOpen) get().newPage()
      }
    },
    setLeftWidth: (width) => saveWidth({ leftWidth: clamp(width, LEFT) }),
    setRightWidth: (width) => saveWidth({ rightWidth: clamp(width, RIGHT) }),
    setRightOpen: (rightOpen) => {
      if (!get().activeSessionId) return
      if (rightOpen && !get().rightTab) get().newPage()
      set({ rightOpen })
    },
    openRight: (rightTab) => {
      if (!get().activeSessionId || !(get().pages.some((p) => p.id === rightTab) || get().openFiles.some((f) => `file:${f.path}` === rightTab))) return
      set({ rightOpen: true, rightTab })
    },
    setResizing: (resizing) => set({ resizing })
  }
})
export function sidebarPageCount(state: Pick<LayoutStore, 'pages' | 'openFiles'>): number {
  return state.pages.length + state.openFiles.length
}

onProjectRemoved((id) => useLayout.getState().removeProject(id))
