// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { useLayout, sidebarPageCount } from '../src/renderer/layoutStore'
import { useDesk } from '../src/renderer/store'
import { useBtw } from '../src/renderer/btwStore'
import type { SessionSummary } from '../src/shared/types'
const options = { model: null, mode: 'default' as const, effort: null }
const session: SessionSummary = { id: 'a', title: 'A', cwd: '/a', lastModified: 0, archived: false }
const enter = (id: string): void => useDesk.getState().setView({ kind: 'session', sessionId: id, projectId: 'p' })
beforeEach(() => {
  useDesk.setState({ view: { kind: 'new' }, projects: [{ id: 'p', path: '/a', name: 'P', addedAt: 0, collapsed: false }], actionError: null })
  useLayout.setState({ activeSessionId: null, sessions: {}, pages: [], openFiles: [], rightTab: null, rightOpen: false, expanded: false })
  useBtw.setState({ threads: {}, drafts: {} })
  window.desk = { projects: { remove: vi.fn().mockResolvedValue([]) }, sessions: { setArchived: vi.fn().mockResolvedValue(undefined), list: vi.fn().mockResolvedValue([]) }, workspace: { closePage: vi.fn().mockResolvedValue(undefined) }, chat: { btw: vi.fn().mockResolvedValue('answer') } } as unknown as Window['desk']
})
it('blocks all sidebar creation on home and lazily opens a start page in a conversation', () => {
  const state = useLayout.getState()
  state.setRightOpen(true); state.newPage('/a', 'browser'); state.openFile('/a/a.md'); state.openSummary('a', 'p', 'all')
  expect(useLayout.getState().rightOpen).toBe(false)
  expect(sidebarPageCount(useLayout.getState())).toBe(0)
  enter('a')
  expect(sidebarPageCount(useLayout.getState())).toBe(0)
  state.setRightOpen(true)
  expect(useLayout.getState().pages.map((p) => p.kind)).toEqual(['start'])
})
it('restores independent tabs, selected file and expansion without closing background resources', () => {
  enter('a'); useLayout.getState().newPage('/a', 'terminal'); useLayout.getState().openFile('/a/a.md'); useLayout.getState().setExpanded(true)
  enter('b')
  expect(useLayout.getState().pages).toEqual([])
  expect(useLayout.getState().rightOpen).toBe(false)
  useLayout.getState().newPage('/b', 'browser')
  enter('a')
  expect(useLayout.getState().rightTab).toBe('file:/a/a.md')
  expect(useLayout.getState().expanded).toBe(true)
  expect(useLayout.getState().pages[0].cwd).toBe('/a')
  useDesk.getState().newChat()
  expect(useLayout.getState().rightOpen).toBe(false)
  enter('b')
  expect(useLayout.getState().pages[0].kind).toBe('browser')
  expect(window.desk.workspace.closePage).not.toHaveBeenCalled()
})
it('archives current conversation to home and restores its sidebar when reopened', async () => {
  enter('a'); const id = useLayout.getState().newPage('/a', 'chat')
  await useDesk.getState().setArchived(session, 'p', true)
  expect(useDesk.getState().view.kind).toBe('new')
  expect(useLayout.getState().rightOpen).toBe(false)
  enter('a'); expect(useLayout.getState().rightTab).toBe(id)
})
it('does not navigate when another conversation was archived or navigation changed during the request', async () => {
  enter('b'); await useDesk.getState().setArchived(session, 'p', true)
  expect(useDesk.getState().view).toMatchObject({ sessionId: 'b' })
  let finish!: () => void
  vi.mocked(window.desk.sessions.setArchived).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
  enter('a'); const pending = useDesk.getState().setArchived(session, 'p', true)
  enter('b'); finish(); await pending
  expect(useDesk.getState().view).toMatchObject({ sessionId: 'b' })
})
it('preserves the view and reports archive failure', async () => {
  enter('a'); vi.mocked(window.desk.sessions.setArchived).mockRejectedValue(new Error('disk failure'))
  await useDesk.getState().setArchived(session, 'p', true)
  expect(useDesk.getState().view).toMatchObject({ sessionId: 'a' })
  expect(useDesk.getState().actionError).toContain('disk failure')
})
it('keeps the latest refresh when an earlier project list finishes later', async () => {
  let finish!: (rows: SessionSummary[]) => void
  const list = vi.mocked(window.desk.sessions.list)
  list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  list.mockResolvedValueOnce([{ ...session, archived: true }])
  const earlier = useDesk.getState().refreshSessions()
  await useDesk.getState().refreshSessions('p')
  finish([session])
  await earlier
  expect(useDesk.getState().sessions.p).toEqual([{ ...session, archived: true }])
})
it('keeps a manual rename when an older automatic title request finishes late', async () => {
  let finish!: (rows: SessionSummary[]) => void
  const list = vi.mocked(window.desk.sessions.list)
  list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  list.mockResolvedValueOnce([{ ...session, title: '手动名称' }])
  window.desk.sessions.rename = vi.fn().mockResolvedValue(undefined)
  useDesk.setState({ sessions: { p: [session] } })
  const earlier = useDesk.getState().refreshSessions('p')
  await useDesk.getState().renameSession(session, 'p', '手动名称')
  finish([{ ...session, title: '迟到的自动标题' }])
  await earlier
  expect(useDesk.getState().sessions.p[0].title).toBe('手动名称')
})
it('does not reinsert sessions from a refresh that outlives project removal', async () => {
  let finish!: (rows: SessionSummary[]) => void
  vi.mocked(window.desk.sessions.list).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = useDesk.getState().refreshSessions('p')
  await useDesk.getState().removeProject('p')
  finish([session])
  await pending
  expect(useDesk.getState().sessions.p).toBeUndefined()
})
it('isolates drafts and histories across side chats, with no focus stealing from replies', async () => {
  enter('a'); const a = useLayout.getState().newPage('/a', 'chat')!, b = useLayout.getState().newPage('/a', 'chat')!
  useBtw.getState().setDraft(a, 'draft a'); useBtw.getState().setDraft(b, 'draft b')
  await useBtw.getState().ask(a, 'a', '/a', 'first', options)
  await useBtw.getState().ask(b, 'a', '/a', 'second', options)
  expect(vi.mocked(window.desk.chat.btw).mock.calls[1][3]).toEqual([])
  expect(useBtw.getState().drafts[a]).toBe('draft a')
  await useBtw.getState().ask(a, 'a', '/a', 'followup', options)
  expect(vi.mocked(window.desk.chat.btw).mock.calls[2][3]).toEqual([{ question: 'first', response: 'answer' }])
  expect(useLayout.getState().rightTab).toBe(b)
})
it('ignores late replies after a page closes or its conversation is cleared', async () => {
  enter('a'); const id = useLayout.getState().newPage('/a', 'chat')!
  let finish!: (value: string) => void
  vi.mocked(window.desk.chat.btw).mockImplementation(() => new Promise<string>((resolve) => { finish = resolve }))
  const pending = useBtw.getState().ask(id, 'a', '/a', 'pending', options)
  useLayout.getState().closePage(id); enter('b'); finish('late'); await pending
  expect(useBtw.getState().threads[id]).toBeUndefined()
  expect(useLayout.getState().rightOpen).toBe(false)
})
