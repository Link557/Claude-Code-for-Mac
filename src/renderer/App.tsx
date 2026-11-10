import { isWindows, primaryModifier } from './platform'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { PanelLeft, SquarePen } from 'lucide-react'
import { cancelFirstSend, isFirstSendTarget, syncFirstSend } from './motion/firstSend'
import { finishSplash } from './motion/splash'
import { refreshSessionsInBackground, useDesk } from './store'
import { errorText } from './ipcError'
import { useChat } from './chatStore'
import { usePanel } from './panelStore'
import { LEFT, useLayout } from './layoutStore'
import { connectSessionSignals } from './sessionSignals'
import { Sidebar } from './components/sidebar/Sidebar'
import { IconButton } from './components/sidebar/SessionRow'
import { NewSessionPage } from './components/newSession/NewSessionPage'
import { UsagePage } from './components/usage/UsagePage'
import { SchedulesPage } from './components/schedules/SchedulesPage'
import { SkillsPage } from './components/skills/SkillsPage'
import { startUsagePolling } from './usagePolling'
import { SettingsPage } from './components/settings/SettingsPage'
import { ChatView } from './components/chat/ChatView'
import { RightPanel, RightPanelToggle } from './components/right/RightPanel'
import { ResizeHandle } from './components/ui/ResizeHandle'
import { AddProjectDialog } from './components/dialogs/AddProjectDialog'
import { ImportHistoryDialog } from './components/dialogs/ImportHistoryDialog'
import { SearchDialog } from './components/dialogs/SearchDialog'
import { SessionSummary } from './components/summary/SessionSummary'
import { WindowPin } from './components/ui/WindowPin'
import { WelcomePage } from './components/welcome/WelcomePage'

export function App() {
  const windows = isWindows()
  useLayoutEffect(() => {
    const root = document.getElementById('root')
    if (root && windows) root.dataset.platform = 'windows'
    return () => { if (root) delete root.dataset.platform }
  }, [windows])
  const { actionError, clearActionError, ready, view, sessions, sidebarCollapsed, pendingProjectPath, importCandidates, searchOpen, init, toggleSidebar, newChat, setSearchOpen } =
    useDesk()

  const reduceMotion = useDesk(s => s.settings?.reduceMotion ?? false)
  const welcomeOpen = useDesk(s => s.welcomeOpen)
  useLayoutEffect(() => {
    syncFirstSend(view.kind === 'session' ? view.sessionId : undefined)
  }, [view])
  useEffect(connectSessionSignals, [])
  useEffect(() => cancelFirstSend, [])
  useEffect(() => {
    if (reduceMotion) cancelFirstSend()
    document.documentElement.dataset.reduceMotion = String(reduceMotion)
    return () => { delete document.documentElement.dataset.reduceMotion }
  }, [reduceMotion])

  // init 内已等待会话列表加载；失败也要退场，避免开屏卡住
  useEffect(() => {
    void init().finally(finishSplash)
  }, [init])

  // 开发截图用：自动打开会话或自动发送消息（等会话列表加载后执行一次）
  useEffect(() => ready ? startUsagePolling() : undefined, [ready])

  const demoDone = useRef(false)
  useEffect(() => {
    const { demo, projects, sessions: all, setView, setDraft } = useDesk.getState()
    const first = projects[0]
    if (!ready || !demo || demoDone.current || (first && !all[first.id])) return
    demoDone.current = true
    if (first && demo.openSession !== undefined) {
      const s = all[first.id]?.[demo.openSession]
      if (s) setView({ kind: 'session', sessionId: s.id, projectId: first.id })
    }
    if (demo.prompt) {
      if (demo.model) setDraft({ model: demo.model })
      void useChat.getState().start(demo.prompt)
    }
  }, [ready, sessions])

  // 切换页面时收起命令浮层
  useEffect(() => usePanel.getState().close(), [view])

  // ⌘K 搜索会话；⌘B 左栏、⌘⇧B 右栏
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (useDesk.getState().welcomeOpen) return
      if (!primaryModifier(e)) return
      const key = e.key.toLowerCase()
      if (key === 'k') {
        e.preventDefault()
        setSearchOpen(!useDesk.getState().searchOpen)
      } else if (key === 'b' && e.shiftKey) {
        e.preventDefault()
        if (useDesk.getState().view.kind !== 'session') return
        const layout = useLayout.getState()
        layout.setRightOpen(!layout.rightOpen)
      } else if (key === 'b') {
        e.preventDefault()
        useDesk.getState().toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSearchOpen])

  // 回到窗口时刷新会话列表（可能在终端或 VS Code 里有新对话）
  useEffect(() => {
    const onFocus = (): void => {
      refreshSessionsInBackground()
      void window.desk.connection.refreshRuntime?.().catch(error => {
        useDesk.setState({ actionError: `检测本机 CLI 失败：${errorText(error)}` })
      })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const { leftWidth, resizing, setLeftWidth, rightOpen, expanded } = useLayout()

  if (!ready) return <div className="drag h-full" />

  const title = view.kind === 'session' ? sessions[view.projectId]?.find((s) => s.id === view.sessionId)?.title : undefined

  return (
    <><div inert={welcomeOpen} className={`relative flex h-full ${windows ? `pb-2 pr-2 ${sidebarCollapsed ? 'pl-2' : ''}` : ''}`}>
      {windows && <div className="drag fixed inset-x-0 top-0 z-50 flex h-10 items-center bg-sidebar pl-3 pr-36" data-window-toolbar>
        <div className="no-drag flex items-center gap-2">
          <IconButton label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} size="md" onClick={toggleSidebar}><PanelLeft size={18} /></IconButton>
          {sidebarCollapsed && <IconButton label="新对话" size="md" onClick={() => newChat()}><SquarePen size={17} /></IconButton>}
        </div>
      </div>}
      {/* 侧栏收起/展开：宽度和透明度过渡，内容宽度固定只做裁切，避免文字挤压换行；拖动右边缘调宽 */}
      <div
        inert={sidebarCollapsed}
        style={{ width: sidebarCollapsed ? 0 : leftWidth }}
        className={`relative shrink-0 ${
          resizing ? '' : 'transition-[width,opacity] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none'
        } ${sidebarCollapsed ? 'opacity-0' : 'opacity-100'}`}
      >
        <div className="h-full overflow-hidden">
          <Sidebar width={leftWidth} />
        </div>
        {!sidebarCollapsed && <ResizeHandle side="left" width={leftWidth} defaultWidth={LEFT.default} onResize={setLeftWidth} />}
      </div>
      <div data-workspace-shell className={`relative flex min-w-0 flex-1 ${windows ? 'overflow-hidden rounded-2xl border border-line bg-bg' : ''}`}>
      <main data-first-send-target={view.kind === 'session' && isFirstSendTarget(view.sessionId) ? '' : undefined} inert={rightOpen && expanded && view.kind === 'session'} className={`flex min-w-0 flex-1 flex-col bg-bg ${view.kind === 'session' ? 'chat-workspace' : ''} ${rightOpen && expanded ? 'overflow-hidden' : ''} ${windows && view.kind !== 'session' ? 'pt-3' : ''}`}>
        {(!windows || view.kind === 'session') && <div className={`drag relative z-40 flex shrink-0 items-center gap-1 ${view.kind === 'session' ? 'chat-titlebar' : 'h-[52px]'} ${windows ? 'pl-5' : 'pl-[96px]'}`}>
          {!windows && sidebarCollapsed && (
            <div className="no-drag animate-fade-in flex gap-1.5">
              <IconButton label="展开侧栏" size="md" onClick={toggleSidebar}>
                <PanelLeft size={18} />
              </IconButton>
              <IconButton label="新对话" size="md" onClick={() => newChat()}>
                <SquarePen size={17} />
              </IconButton>
            </div>
          )}
          {title && (
            <>
              {!windows && sidebarCollapsed && <span aria-hidden className="mx-2.5 h-4 w-px shrink-0 bg-fg3/30" />}
              <span className={`min-w-0 flex-1 truncate pr-6 font-serif text-[16px] font-normal tracking-[0.02em] text-fg ${sidebarCollapsed ? '' : 'pl-1'}`}>{title}</span>
            </>
          )}
          {view.kind !== 'settings' && (
            <div className={`ml-auto flex items-center gap-3 ${rightOpen ? 'pr-3' : 'pr-16'}`}>
              {view.kind === 'session' && <SessionSummary sessionId={view.sessionId} projectId={view.projectId} />}
            </div>
          )}
        </div>}
        {actionError && <div role="alert" className="workspace-action-error flex items-center justify-between bg-danger/10 px-4 py-2 text-sm text-danger"><span>{actionError}</span><button type="button" onClick={clearActionError}>关闭</button></div>}
        {view.kind === 'new' && <NewSessionPage />}
        {view.kind === 'settings' && <SettingsPage />}
        {view.kind === 'usage' && <UsagePage />}
        {view.kind === 'schedules' && <SchedulesPage />}
        {view.kind === 'skills' && <SkillsPage />}
        {view.kind === 'session' && <ChatView key={view.sessionId} sessionId={view.sessionId} projectId={view.projectId} />}
      </main>
      {view.kind === 'session' && <RightPanel key={view.sessionId} sessionId={view.sessionId} projectId={view.projectId} />}
      {view.kind === 'session' && <div className="absolute right-3 top-[10px] z-40"><RightPanelToggle /></div>}
      </div>
      {pendingProjectPath && <AddProjectDialog path={pendingProjectPath} />}
      {importCandidates && <ImportHistoryDialog candidates={importCandidates} />}
      {searchOpen && <SearchDialog />}
    </div>{welcomeOpen && <WelcomePage showWindowPin={windows} />}{windows && <WindowPin visible={view.kind === 'session' && !welcomeOpen} />}</>
  )
}
