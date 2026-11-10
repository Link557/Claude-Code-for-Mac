// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RightPanel, RightPanelToggle } from '../src/renderer/components/right/RightPanel'
import { useLayout } from '../src/renderer/layoutStore'
import { useDesk } from '../src/renderer/store'
import { Dialog } from '../src/renderer/components/ui/Dialog'
vi.mock('../src/renderer/components/right/TerminalPane', () => ({ TerminalPane: () => <div>内嵌终端</div> }))
vi.mock('../src/renderer/components/right/BrowserPane', () => ({ BrowserPane: ({ active }: { active: boolean }) => <div data-testid="browser-pane" data-active={active}>内嵌浏览器</div> }))
vi.mock('../src/renderer/components/files/FilePreview', () => ({ FilePreview: ({ path }: { path: string }) => <div>预览 {path}</div> }))
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn()

  useDesk.setState({ view: { kind: 'session', sessionId: 'test', projectId: 'p' }, projects: [{ id: 'p', path: '/project', name: 'project', addedAt: 0, collapsed: false }] })
  useLayout.setState({ activeSessionId: 'test', sessions: {}, pages: [{ id: 'page:home', kind: 'start' }], openFiles: [], rightTab: 'page:home', rightOpen: true, expanded: false })
  window.desk = { workspace: { closePage: vi.fn().mockResolvedValue(undefined), onShortcut: () => () => {} }, files: { list: vi.fn().mockResolvedValue([{ name: 'README.md', path: '/project/README.md', kind: 'file' }]) } } as unknown as Window['desk']
})
afterEach(cleanup)
it('plus opens a separate start page, with four working entries and no file-creation menu', () => {
  render(<RightPanel sessionId="test" projectId="p" />)
  fireEvent.click(screen.getByRole('button', { name: '新建侧栏页面' }))
  expect(useLayout.getState().pages).toHaveLength(2)
  expect(screen.getAllByRole('tab', { name: '开始' })).toHaveLength(2)
  expect(screen.getByRole('button', { name: /工作区文件/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /新建终端/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /浏览器/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /侧边聊天/ })).toBeTruthy()
  expect(screen.queryByText('更多工具')).toBeNull()
  expect(screen.queryByText('新建文件')).toBeNull()
})
it('opens a file preview from the start page inside its owning chat session', async () => {
  render(<RightPanel sessionId="test" projectId="p" />)
  fireEvent.click(screen.getByRole('button', { name: /工作区文件/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'README.md' }))
  expect(screen.getByText('预览 /project/README.md')).toBeTruthy()
  expect(screen.getByRole('tab', { name: 'README.md' }).getAttribute('aria-selected')).toBe('true')
})
it('changes the current start page into a terminal, and closing it returns to a usable page', () => {
  render(<RightPanel sessionId="test" projectId="p" />)
  fireEvent.click(screen.getByRole('button', { name: /新建终端/ }))
  expect(screen.getByText('内嵌终端')).toBeTruthy()
  expect(useLayout.getState().pages[0].cwd).toBe('/project')
  fireEvent.click(screen.getByRole('button', { name: '关闭终端' }))
  expect(screen.getByRole('button', { name: /工作区文件/ })).toBeTruthy()
})

it('hides the native browser for generic dialogs outside the desk store', () => {
  useLayout.setState({ pages: [{ id: 'page:browser', kind: 'browser' }], rightTab: 'page:browser' })
  render(<RightPanel sessionId="test" projectId="p" />)
  expect(screen.getByTestId('browser-pane').getAttribute('data-active')).toBe('true')
  const modal = render(<Dialog title="移除项目" footer={null} onClose={() => {}}>确认移除</Dialog>)
  expect(screen.getByTestId('browser-pane').getAttribute('data-active')).toBe('false')
  modal.unmount()
  expect(screen.getByTestId('browser-pane').getAttribute('data-active')).toBe('true')
})

it('counts files and pages together, refuses seventh without evicting anything, and permits existing tabs', () => {
  const layout = useLayout.getState()
  for (let i = 0; i < 5; i++) layout.openFile(`/file-${i}`)
  const files = useLayout.getState().openFiles
  const pages = useLayout.getState().pages
  expect(layout.newPage('/project', 'terminal')).toBeNull()
  layout.openFile('/seventh')
  layout.openSummary('test', 'p', 'all')
  expect(useLayout.getState().pages).toEqual(pages)
  expect(useLayout.getState().openFiles).toEqual(files)
  layout.openFile('/file-0', 42)
  expect(useLayout.getState().rightTab).toBe('file:/file-0')
  expect(useLayout.getState().openFiles[0].line).toBe(42)
  layout.closeFile('/file-1')
  expect(layout.newPage('/project', 'terminal')).not.toBeNull()
  expect(useLayout.getState().openFiles.some(f => f.path === '/file-0')).toBe(true)
})
it('hides plus at six and restores it after closing a page; keyboard cannot bypass cap', () => {
  for (let i = 0; i < 5; i++) useLayout.getState().newPage()
  render(<RightPanel sessionId="test" projectId="p" />)
  expect(screen.queryByRole('button', { name: '新建侧栏页面' })).toBeNull()
  // An existing start page can change kind without consuming another slot.
  fireEvent.keyDown(window, { key: 't', metaKey: true })
  expect(useLayout.getState().pages).toHaveLength(6)
  fireEvent.keyDown(window, { key: 't', metaKey: true })
  expect(useLayout.getState().pages).toHaveLength(6)
  fireEvent.click(screen.getByRole('button', { name: '关闭浏览器' }))
  expect(screen.getByRole('button', { name: '新建侧栏页面' })).toBeTruthy()
})
it('uses a distinct color for each Roman page count', () => {
  useLayout.setState({ rightOpen: false })
  render(<RightPanelToggle />)
  const labels = ['I', 'II', 'III', 'IV', 'V', 'VI']
  const colors = new Set<string>()
  for (let i = 0; i < 6; i++) {
    if (i) act(() => { useLayout.getState().newPage(); useLayout.setState({ rightOpen: false }) })
    const badge = screen.getByLabelText(`已打开 ${i + 1} 个侧栏页面`)
    expect(badge.textContent).toBe(labels[i])
    colors.add(badge.style.getPropertyValue('--page-count-color'))
  }
  expect(colors.size).toBe(6)
})

it('keeps the three toolbar controls at 32px with 4px spacing and a Windows shortcut', () => {
  const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows')
  try {
    render(<><RightPanel sessionId="test" projectId="p" /><RightPanelToggle /></>)
    const add = screen.getByRole('button', { name: '新建侧栏页面' })
    const expand = screen.getByRole('button', { name: '展开侧栏页面' })
    const toggle = screen.getByRole('button', { name: '收起右栏（Ctrl+Shift+B）' })
    expect(add.className).toContain('session-toolbar-button')
    expect(expand.className).toContain('session-toolbar-button')
    expect(toggle.className).toContain('session-toolbar-button')
    expect(add.parentElement?.className).toContain('gap-1')
    fireEvent.click(expand)
    expect(screen.getByRole('button', { name: '还原侧栏宽度' })).toBeTruthy()
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: '展开右栏（Ctrl+Shift+B）' })).toBeTruthy()
  } finally { userAgent.mockRestore() }
})
