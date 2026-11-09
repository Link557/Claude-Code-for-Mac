// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionSummary, SummaryDetail } from '../src/renderer/components/summary/SessionSummary'
import { RightPanelToggle } from '../src/renderer/components/right/RightPanel'
import { useChat } from '../src/renderer/chatStore'
import { useDesk } from '../src/renderer/store'
import { useLayout } from '../src/renderer/layoutStore'
import { useSummaryUi } from '../src/renderer/summaryUiStore'
import { emptySessionSummary } from '../src/shared/sessionSummary'
vi.mock('../src/renderer/components/files/FilePreview', () => ({ FilePreview: () => null }))
vi.mock('../src/renderer/components/right/TerminalPane', () => ({ TerminalPane: () => null }))
vi.mock('../src/renderer/components/right/BrowserPane', () => ({ BrowserPane: () => null }))
beforeEach(() => {
  const summary = emptySessionSummary()
  summary.sections.sources = Array.from({ length: 5 }, (_, i) => ({ id: String(i), title: `Source ${i + 1}`, description: '成功读取' }))
  useDesk.setState({ view: { kind: 'session', sessionId: 'first', projectId: 'p' }, projects: [{ id: 'p', path: '/project', name: 'Workspace', addedAt: 0, collapsed: false }] })
  const base = { projectId: 'p', messages: [], state: 'idle' as const, approvals: [], loaded: true, options: { model: null, mode: 'default' as const, effort: null }, error: null }
  useChat.setState({ chats: { first: { ...base, summary }, second: { ...base, summary: emptySessionSummary() } } })
  useSummaryUi.setState({ opened: {}, expanded: {}, announced: {} })
  useLayout.setState({ pages: [{ id: 'page:home', kind: 'start' }], openFiles: [], rightTab: 'page:home', rightOpen: false })
  window.desk = { workspace: { closePage: vi.fn().mockResolvedValue(undefined) } } as unknown as Window['desk']
})
afterEach(cleanup)
it('starts collapsed, previews three items on demand and has one global view-all button', () => {
  render(<SessionSummary sessionId="first" projectId="p" />)
  fireEvent.click(screen.getByRole('button', { name: '切换摘要面板状态' }))
  const panel = screen.getByRole('region', { name: '会话摘要' })
  expect(within(panel).queryByText('Source 1')).toBeNull()
  for (const name of ['变更分类', '项目分类', '任务分类', '子 Agent分类']) {
    expect(within(panel).queryByRole('button', { name })).toBeNull()
  }
  expect(within(panel).getAllByRole('button', { name: '查看全部' })).toHaveLength(1)
  fireEvent.click(within(panel).getByRole('button', { name: '来源分类' }))
  expect(within(panel).getByRole('button', { name: '来源分类' }).getAttribute('aria-expanded')).toBe('true')
  expect(within(panel).getByText('Source 3')).toBeTruthy()
  expect(within(panel).queryByText('Source 4')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '查看全部' }))
  fireEvent.click(screen.getByRole('button', { name: '查看全部' }))
  expect(useLayout.getState().pages.filter((p) => p.kind === 'summary')).toHaveLength(1)
  expect(useLayout.getState().rightOpen).toBe(true)
  render(<SummaryDetail sessionId="first" projectId="p" section="all" />)
  expect(within(screen.getByRole('region', { name: '会话摘要详情' })).getByText('Source 5')).toBeTruthy()
  expect(screen.queryByRole('region', { name: '子 Agent完整列表' })).toBeNull()
})
it('keeps summary visibility and data isolated by session and updates live', () => {
  const view = render(<SessionSummary sessionId="first" projectId="p" />)
  fireEvent.click(screen.getByRole('button', { name: '切换摘要面板状态' }))
  view.rerender(<SessionSummary sessionId="second" projectId="p" />)
  expect(screen.queryByRole('region', { name: '会话摘要' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '切换摘要面板状态' }))
  expect(screen.queryByText('Source 1')).toBeNull()
  expect(screen.queryByRole('button', { name: '子 Agent分类' })).toBeNull()
  act(() => {
    const summary = emptySessionSummary(); summary.sections.agents = [{ id: 'agent', title: 'Review agent', description: 'Explore', status: 'running' }]
    useChat.getState().handle('second', { kind: 'summary', summary })
  })
  expect(screen.getByRole('button', { name: '子 Agent分类' }).getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('button', { name: '打开子 Agent：Review agent' })).toBeTruthy()
  expect(screen.getByText('进行中')).toBeTruthy()
  act(() => useChat.getState().handle('second', { kind: 'summary', summary: emptySessionSummary() }))
  expect(screen.queryByRole('button', { name: '子 Agent分类' })).toBeNull()
})
it('keeps changed files visible and only displays known line counts', () => {
  const summary = emptySessionSummary()
  summary.sections.changes = [
    { id: 'known', title: 'known.ts', description: '', added: 46, removed: 0 },
    { id: 'unknown', title: 'unknown.ts', description: '' }
  ]
  useChat.getState().handle('first', { kind: 'summary', summary })
  render(<SessionSummary sessionId="first" projectId="p" />)
  fireEvent.click(screen.getByRole('button', { name: '切换摘要面板状态' }))
  const category = screen.getByRole('button', { name: '变更分类' })
  expect(category.textContent).toContain('+46 −0')
  expect(category.textContent).toContain('已统计 1/2 个文件')
  fireEvent.click(category)
  expect(screen.getByText('unknown.ts')).toBeTruthy()
  expect(screen.queryByText(/行数未知/)).toBeNull()
})
it('counts actual tabs and does not reset the badge when the sidebar closes', () => {
  render(<RightPanelToggle />)
  expect(screen.getByLabelText('已打开 1 个侧栏页面')).toBeTruthy()
  act(() => useLayout.getState().openSummary('first', 'p', 'all'))
  const hideButton = screen.getByRole('button', { name: '收起右栏（⌘⇧B）' })
  expect(hideButton.getAttribute('data-page-count')).toBe('2')
  expect(hideButton.querySelector('svg')).toBeTruthy()
  // 展开时仍保留可访问的计数描述，只隐藏图标中的罗马数字。
  expect(screen.getByLabelText('已打开 2 个侧栏页面').querySelector('text')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '收起右栏（⌘⇧B）' }))
  expect(screen.getByLabelText('已打开 2 个侧栏页面')).toBeTruthy()
  act(() => useLayout.getState().closePage(useLayout.getState().pages[1].id))
  expect(screen.getByLabelText('已打开 1 个侧栏页面')).toBeTruthy()
})

it('collapses categories independently and remembers their state per session', () => {
  const summary = structuredClone(useChat.getState().chats.first.summary!)
  summary.sections.tasks = [{ id: 'task', title: 'Review', description: '', status: 'pending' }]
  useChat.getState().handle('first', { kind: 'summary', summary })
  const view = render(<SessionSummary sessionId="first" projectId="p" />)
  fireEvent.click(screen.getByRole('button', { name: '切换摘要面板状态' }))
  fireEvent.click(screen.getByRole('button', { name: '来源分类' }))
  fireEvent.click(screen.getByRole('button', { name: '任务分类' }))
  fireEvent.click(screen.getByRole('button', { name: '来源分类' }))
  expect(screen.queryByText('Source 1')).toBeNull()
  expect(screen.getByRole('button', { name: '任务分类' }).getAttribute('aria-expanded')).toBe('true')
  view.rerender(<SessionSummary sessionId="second" projectId="p" />)
  fireEvent.click(screen.getByRole('button', { name: '切换摘要面板状态' }))
  expect(screen.queryByRole('button', { name: '任务分类' })).toBeNull()
  view.rerender(<SessionSummary sessionId="first" projectId="p" />)
  expect(screen.getByRole('button', { name: '任务分类' }).getAttribute('aria-expanded')).toBe('true')
})
