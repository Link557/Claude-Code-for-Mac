import { isWindows } from '../../platform'
import { useEffect, useState, type CSSProperties } from 'react'
import { Activity, Bot, Compass, FileText, FolderOpen, Globe, ListTree, Maximize2, MessageCircleQuestion, Minimize2, Plus, Terminal, X } from 'lucide-react'
import { fileName } from '@shared/fileLinks'
import { FilePreview } from '../files/FilePreview'
import { useChat } from '../../chatStore'
import { RIGHT, MAX_SIDEBAR_PAGES, sidebarPageCount, useLayout, type SidePage } from '../../layoutStore'
import { useDesk } from '../../store'
import { useModal } from '../../modalStore'
import { ResizeHandle } from '../ui/ResizeHandle'
import { BtwPane } from './BtwPane'
import { ProjectFilesPane } from './ProjectFilesPane'
import { FileContext } from '../files/FileLink'
import { StartPane } from './StartPane'
import { TerminalPane } from './TerminalPane'
import { BrowserPane } from './BrowserPane'
import { SessionControlsPane } from './SessionControlsPane'
import { BackgroundTasksPane } from './BackgroundTasksPane'
import { AgentConversationPane } from './AgentConversationPane'
import { SummaryDetail } from '../summary/SessionSummary'
import { SUMMARY_LABELS } from '@shared/sessionSummary'

const LABELS = { controls: '会话控制', start: '开始', files: '工作区文件', terminal: '终端', browser: '浏览器', summary: '摘要', chat: '侧边聊天', tasks: '后台任务', agents: '子 Agent' }
const ICONS = { controls: ListTree, start: Compass, files: FolderOpen, terminal: Terminal, browser: Globe, summary: ListTree, chat: MessageCircleQuestion, tasks: Activity, agents: Bot }

export function RightPanel({ sessionId, projectId }: { sessionId: string; projectId: string }) {
  const layout = useLayout()
  const { rightOpen, rightTab, openFiles, pages, expanded } = layout
  const leftShown = useDesk((s) => !s.sidebarCollapsed)
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  useEffect(() => {
    const resize = (): void => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const frameWidth = isWindows() ? (leftShown ? 10 : 18) : 0
  const available = windowWidth - (leftShown ? layout.leftWidth : 0) - frameWidth
  const rightWidth = expanded ? available : Math.max(RIGHT.min, Math.min(layout.rightWidth, available - 420))
  const cwd = useDesk((s) => s.projects.find((p) => p.id === projectId)?.path)
  const options = useChat((s) => sessionId ? s.chats[sessionId]?.options : undefined)
  const modalOpen = useModal((s) => s.count > 0)
  const current = openFiles.find((f) => `file:${f.path}` === rightTab)
  const choose = (page: SidePage, kind: SidePage['kind']): void => layout.changePage(page.id, kind, page.cwd ?? cwd)

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.isComposing || e.defaultPrevented || modalOpen) return
      const kind = e.metaKey && e.key.toLowerCase() === 'p' ? 'files'
        : e.metaKey && e.key.toLowerCase() === 't' ? 'browser'
        : e.ctrlKey && e.code === 'Backquote' ? 'terminal' : null
      if (!kind || (!cwd && kind !== 'browser')) return
      e.preventDefault()
      const state = useLayout.getState()
      const page = state.pages.find((p) => p.id === state.rightTab)
      if (page?.kind === 'start') { state.changePage(page.id, kind, cwd); state.setRightOpen(true) }
      else state.newPage(cwd, kind)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [cwd, modalOpen])

  useEffect(() => window.desk.workspace.onShortcut((kind) => {
    if (!modalOpen && (cwd || kind === 'browser')) useLayout.getState().newPage(cwd, kind)
  }), [cwd, modalOpen])

  const tabs = [
    ...pages.map((p) => ({ id: p.id, label: p.kind === 'summary' && p.section ? (p.section === 'all' ? '会话摘要' : SUMMARY_LABELS[p.section]) : LABELS[p.kind], icon: ICONS[p.kind], close: () => layout.closePage(p.id) })),
    ...openFiles.map((f) => ({ id: `file:${f.path}` as const, label: fileName(f.path), icon: FileText, close: () => layout.closeFile(f.path), title: f.path }))
  ]

  return (
    <div
      inert={!rightOpen}
      style={{ width: rightOpen ? rightWidth : 0 }}
      className={`relative shrink-0 ${layout.resizing ? '' : 'transition-[width] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none'}`}
    >
      <div data-sidebar-viewport className="h-full overflow-hidden">
      <aside style={{ width: rightWidth }} aria-label="工作区侧栏" className="flex h-full flex-col border-l border-line bg-bg">
        <div className="drag flex h-[52px] shrink-0 items-center gap-1 pl-2 pr-12">
          <div role="tablist" aria-label="侧栏页面" className="no-drag flex min-w-0 flex-1 gap-0.5 overflow-x-auto [scrollbar-width:none]">
            {tabs.map((tab) => {
              const active = tab.id === rightTab
              const close = 'close' in tab ? tab.close : undefined
              return (
                <div key={tab.id} className={`group flex h-8 max-w-[180px] shrink-0 items-center rounded-lg ${active ? 'bg-active' : 'hover:bg-hover'}`}>
                  <button type="button" role="tab" aria-selected={active} title={'title' in tab ? tab.title : tab.label}
                    ref={active ? (el) => el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) : undefined}
                    onClick={() => layout.openRight(tab.id)} onMouseDown={(e) => { if (e.button === 1 && close) { e.preventDefault(); close() } }}
                    className={`flex min-w-0 items-center gap-2 px-2 py-1.5 ${active ? 'font-medium' : 'text-fg2'}`}>
                    <tab.icon size={16} className="shrink-0" /><span className="truncate">{tab.label}</span>
                  </button>
                  {close && <button type="button" aria-label={`关闭${tab.label}`} onClick={close} className="mr-1 rounded p-0.5 text-fg3 hover:bg-active hover:text-fg"><X size={12} /></button>}
                </div>
              )
            })}
          </div>
          <div className="no-drag flex items-center gap-1">
            {sidebarPageCount(layout) < MAX_SIDEBAR_PAGES && <button type="button" aria-label="新建侧栏页面" title="新建侧栏页面" onClick={() => layout.newPage(cwd)} className="session-toolbar-button text-fg2 hover:bg-hover hover:text-fg"><Plus size={16} /></button>}
            <button type="button" aria-label={expanded ? '还原侧栏宽度' : '展开侧栏页面'} title={expanded ? '还原侧栏宽度' : '展开侧栏页面'} onClick={() => layout.setExpanded(!expanded)} className="session-toolbar-button text-fg2 hover:bg-hover hover:text-fg">{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
          </div>
        </div>
        <FileContext.Provider value={{ cwd }}>
          <div className="relative min-h-0 flex-1">
            {current && <FilePreview key={current.path} path={current.path} line={current.line} nonce={current.nonce} cwd={cwd} />}
            {pages.map((page) => {
              const active = page.id === rightTab && rightOpen
              return (
                <div key={page.id} hidden={page.id !== rightTab} className={page.id === rightTab ? 'h-full' : 'hidden'}>
                  {page.kind === 'summary' && page.sessionId && page.projectId && page.section && <SummaryDetail sessionId={page.sessionId} projectId={page.projectId} section={page.section} />}
                  {page.kind === 'chat' && options && <BtwPane pageId={page.id} sessionId={sessionId} cwd={page.cwd ?? cwd} options={options} active={active} />}
                  {page.kind === 'tasks' && cwd && <BackgroundTasksPane sessionId={sessionId} cwd={cwd} taskId={page.taskId} active={active} />}
                  {page.kind === 'agents' && page.projectId && <AgentConversationPane sessionId={sessionId} projectId={page.projectId} agentId={page.agentId} active={active} />}
                  {page.kind === 'controls' && cwd && <SessionControlsPane sessionId={sessionId} cwd={cwd} active={active} turnDiff={page.turnDiff} />}
                  {page.kind === 'start' && <StartPane hasProject={Boolean(page.cwd ?? cwd)} onSelect={(kind) => choose(page, kind)} />}
                  {page.kind === 'files' && <ProjectFilesPane cwd={page.cwd ?? cwd} refreshKey={0} />}
                  {page.kind === 'terminal' && <TerminalPane id={page.id} cwd={page.cwd ?? cwd} active={active} />}
                  {page.kind === 'browser' && <BrowserPane id={page.id} active={page.id === rightTab && !modalOpen} />}
                </div>
              )
            })}
          </div>
        </FileContext.Provider>
      </aside>
      </div>
      {rightOpen && !expanded && <ResizeHandle side="right" width={rightWidth} defaultWidth={RIGHT.default} onResize={layout.setRightWidth} />}
    </div>
  )
}

const PAGE_COLORS = [
  ['#B96D4F', '#D99A7E'], // I · Hestia / hearth
  ['#71805A', '#A4B88A'], // II · Athena / olive
  ['#487D96', '#82B4CC'], // III · Poseidon / sea
  ['#A68538', '#D2B264'], // IV · Apollo / light
  ['#AD7187', '#D49BAF'], // V · Aphrodite / rose
  ['#826394', '#B49AC6']  // VI · Dionysus / grape
]

function romanPageCount(count: number): string {
  if (count === 0) return '—'
  let result = ''
  for (const [value, numeral] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']] as const) {
    while (count >= value) { result += numeral; count -= value }
  }
  return result
}

export function RightPanelToggle() {
  const layout = useLayout()
  const count = sidebarPageCount(layout)
  const palette = PAGE_COLORS[Math.min(count, MAX_SIDEBAR_PAGES) - 1]
  const countStyle = palette ? { '--page-count-color': palette[0], '--page-count-color-dark': palette[1] } as CSSProperties : undefined
  const shortcut = isWindows() ? 'Ctrl+Shift+B' : '⌘⇧B'
  const label = layout.rightOpen ? `收起右栏（${shortcut}）` : `展开右栏（${shortcut}）`
  return <div className="no-drag">
    <button type="button" title={`${label} · ${count} 个页面`} aria-label={label} aria-expanded={layout.rightOpen} data-page-count={count} onClick={() => layout.setRightOpen(!layout.rightOpen)} className={`session-toolbar-button ${layout.rightOpen ? 'bg-active text-fg' : 'text-fg2 hover:bg-hover'}`}>
      <svg viewBox="0 0 24 24" className="sidebar-page-count size-[23px] overflow-visible" style={countStyle} role="img" aria-label={`已打开 ${count} 个侧栏页面`}>
        <g fill="none" stroke="currentColor" strokeWidth="0.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.4 5.1 Q10.8 5.6 18.9 6.5 L18.6 21 Q11.2 20.3 3.1 19.4 Z" />
          <path d="M3.4 5.1 L7.4 2.9 Q14.8 3.4 22.1 4.3 L18.9 6.5 M22.1 4.3 L21.8 18.3 L18.6 21" />
          {layout.rightOpen && <path d="M14.6 6.1 Q14.3 13.5 14.5 20.6 M16.2 9 L17.3 9.1 M16.2 11.1 L17.3 11.2" />}
        </g>
        {!layout.rightOpen && <text x="10.9" y="15.6" textAnchor="middle" fill="currentColor" fontFamily="Georgia, serif" fontSize="8" transform="rotate(5 10.9 13)">{romanPageCount(count)}</text>}
      </svg>
    </button>
  </div>
}
