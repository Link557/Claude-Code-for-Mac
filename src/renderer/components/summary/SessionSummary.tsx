import summaryNote from '../../assets/icons/summary-note.svg'
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, ListFilter } from 'lucide-react'
import type { BackgroundTask } from '@shared/chat'
import { emptySessionSummary, SUMMARY_LABELS, SUMMARY_SECTIONS, type SummaryView } from '@shared/sessionSummary'
import { useChat } from '../../chatStore'
import { useDesk } from '../../store'
import { useSummaryUi } from '../../summaryUiStore'
import { useLayout } from '../../layoutStore'
import { ChangeCounts, SUMMARY_ICONS, SummaryRows } from './SummaryContent'
import { TaskStatus, taskType, useNow } from '../right/BackgroundTasksPane'
import { AgentList } from './AgentList'

const EMPTY = emptySessionSummary()
const NO_TASKS: BackgroundTask[] = []
/** 弹出面板里最多列出的后台任务 */
const TASK_ROWS = 5
export function SessionSummary({ sessionId, projectId }: { sessionId: string; projectId: string }) {
  const expanded = useSummaryUi((s) => s.expanded[sessionId])
  const opened = useSummaryUi((s) => s.opened[sessionId] ?? false)
  const summary = useChat((s) => s.chats[sessionId]?.summary ?? EMPTY)
  const project = useDesk((s) => s.projects.find((p) => p.id === projectId))
  const visibleSections = SUMMARY_SECTIONS.filter((section) => summary.sections[section].length > 0)
  const tasks = useChat((s) => s.chats[sessionId]?.tasks ?? NO_TASKS)
  const backgroundTasks = tasks.filter(task => task.type !== 'local_agent')
  const running = backgroundTasks.filter((task) => task.status === 'running')
  const runningIds = running.map((task) => task.id).join('\n')
  const agents = summary.sections.agents
  const runningAgents = agents.filter(agent => agent.status === 'running')
  const agentAnnouncements = JSON.stringify([
    ...runningAgents.map(agent => [`agent:${agent.id}`, ...(agent.taskId ? [`agent-task:${agent.taskId}`] : [])]),
    // 已有未关联的前台工具调用时，不凭 membership 再假设另一个新 Agent。
    ...(!runningAgents.some(agent => !agent.taskId) ? (summary.unlinkedAgentTaskIds ?? []).map(id => [`agent-task:${id}`]) : [])
  ])
  // 有新的后台任务开始时自动弹出一次；关掉后同一个任务不再弹
  useEffect(() => { if (runningIds) useSummaryUi.getState().announce(sessionId, runningIds.split('\n')) }, [sessionId, runningIds])
  useEffect(() => { useSummaryUi.getState().announce(sessionId, JSON.parse(agentAnnouncements), 'agents') }, [sessionId, agentAnnouncements])
  const badge = runningAgents.length + running.length
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!opened) return
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && box.current?.contains(document.activeElement)) {
        e.preventDefault(); useSummaryUi.getState().toggle(sessionId)
      }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [opened, sessionId])
  return <div ref={box} className="no-drag relative">
    <button type="button" aria-label="切换摘要面板状态" title={badge ? `会话摘要 · ${runningAgents.length} 位子 Agent 进行中${running.length ? ` · ${running.length} 个后台任务运行中` : ''}` : '会话摘要'} aria-expanded={opened} onClick={() => useSummaryUi.getState().toggle(sessionId)}
      className={`session-toolbar-button relative ${opened ? 'bg-active text-fg' : 'text-fg2 hover:bg-hover'}`}>
      {badge > 0 && <span aria-hidden="true" data-task-badge className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-fg px-1 text-[10px] font-medium tabular-nums leading-none text-bg ring-2 ring-bg">{badge}</span>}<span aria-hidden="true" data-summary-note className="inline-block size-[23px] shrink-0 bg-current" style={{ mask: `url("${summaryNote}") center / contain no-repeat`, WebkitMask: `url("${summaryNote}") center / contain no-repeat` }} /></button>
    {opened && <section aria-label="会话摘要" className="absolute right-0 top-full z-40 mt-3 max-h-[calc(100vh-100px)] w-[340px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-2xl border border-line-strong bg-card p-5 shadow-pop animate-summary-in">
      <h2 className="mb-3 truncate text-[14px] font-medium text-fg2" title={project?.path}>{project?.name ?? '当前会话'}</h2>
      {backgroundTasks.length > 0 && <SummaryTasks sessionId={sessionId} projectId={projectId} tasks={backgroundTasks} />}
      <div className="border-t border-line py-2">
        {visibleSections.length === 0 && tasks.length === 0 && <p className="px-1 py-2 text-[12px] text-fg3">暂无活动记录</p>}
        {visibleSections.map((section) => {
          const Icon = SUMMARY_ICONS[section]
          const items = summary.sections[section]
          const isExpanded = expanded?.[section] ?? false
          return <div key={section}>
            <button type="button" aria-label={`${SUMMARY_LABELS[section]}分类`} aria-expanded={isExpanded}
              onClick={() => useSummaryUi.getState().toggleSection(sessionId, section)}
              className="flex min-h-10 w-full items-center gap-2 rounded-lg px-1 text-left text-[13px] text-fg2 hover:bg-hover">
              <Icon size={16} className="shrink-0" />
              <span>{SUMMARY_LABELS[section]} · {items.length}</span>
              <ChevronRight size={14} className={`shrink-0 transition-transform motion-reduce:transition-none ${isExpanded ? 'rotate-90' : ''}`} />
              <span className="ml-auto">{section === 'changes' && <ChangeCounts items={items} />}{section === 'agents' && <span className="text-[11px] text-fg3">{runningAgents.length} 位进行中</span>}</span>
            </button>
            {isExpanded && <div className="pb-2 pl-5">
              {section === 'agents' ? <AgentList items={items} sessionId={sessionId} projectId={projectId} compact /> : <SummaryRows section={section} items={items.slice(0, 3)} compact />}
              {section !== 'agents' && items.length > 3 && <p className="px-1 pt-1 text-[11px] text-fg3">还有 {items.length - 3} 项</p>}
            </div>}
          </div>
        })}
      </div>
      {summary.agentsIncomplete && <p className="pb-2 text-[11px] text-fg3">部分后台活动尚未关联到工具调用，子 Agent 数量可能不完整。</p>}
      <div className="sticky bottom-0 border-t border-line bg-card pt-2">
        <button type="button" onClick={() => useLayout.getState().openSummary(sessionId, projectId, 'all')} aria-label="查看全部" className="flex w-full items-center gap-2 rounded-lg px-1 py-2 text-left text-[12px] text-fg2 hover:bg-hover"><ListFilter size={15} />查看全部</button>
      </div>
    </section>}
  </div>
}

function SummaryTasks({ sessionId, projectId, tasks }: { sessionId: string; projectId: string; tasks: BackgroundTask[] }) {
  const now = useNow(tasks.some((task) => task.status === 'running'))
  const open = (taskId?: string): void => useLayout.getState().openTasks(sessionId, projectId, taskId)
  return <div className="border-t border-line py-2">
    <button type="button" onClick={() => open()} className="flex min-h-10 w-full items-center gap-2 rounded-lg px-1 text-left text-[13px] text-fg2 hover:bg-hover">
      <span>后台任务 · {tasks.length}</span><ChevronRight size={14} className="shrink-0" />
    </button>
    <ul aria-label="后台任务" className="space-y-0.5 pl-1">
      {tasks.slice(0, TASK_ROWS).map((task) => {
        const Icon = taskType(task).icon
        return <li key={task.id}>
          <button type="button" title={task.description} onClick={() => open(task.id)} className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-[13px] hover:bg-hover">
            <Icon size={15} className={`shrink-0 ${task.status === 'running' ? 'text-accent' : 'text-fg2'}`} />
            <span className="min-w-0 flex-1 truncate">{task.description}</span>
            <TaskStatus task={task} now={now} />
          </button>
        </li>
      })}
    </ul>
    {tasks.length > TASK_ROWS && <p className="px-1 pt-1 text-[11px] text-fg3">还有 {tasks.length - TASK_ROWS} 项</p>}
  </div>
}

export function SummaryDetail({ sessionId, projectId, section }: { sessionId: string; projectId: string; section: SummaryView }) {
  const chat = useChat((s) => s.chats[sessionId])
  const project = useDesk((s) => s.projects.find((p) => p.id === projectId))
  const title = useDesk((s) => s.sessions[projectId]?.find((item) => item.id === sessionId)?.title)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { let stale = false; void useChat.getState().load(sessionId, projectId).catch((e: Error) => { if (!stale) setError(e.message) }); return () => { stale = true } }, [sessionId, projectId])
  const summary = chat?.summary ?? EMPTY
  const sections = section === 'all' ? SUMMARY_SECTIONS.filter((category) => summary.sections[category].length > 0) : [section]
  const label = section === 'all' ? '会话摘要' : SUMMARY_LABELS[section]
  return <section aria-label={`${label}详情`} className="flex h-full flex-col">
    <div className="shrink-0 border-b border-line px-5 py-3"><h2 className="text-[15px] font-medium">{label}</h2><p className="mt-1 truncate text-[11px] text-fg3" title={title}>{project?.name ?? '项目已移除'} · {title || sessionId.slice(0, 8)}</p></div>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
      {error ? <p role="alert" className="py-4 text-danger">{error}</p> : !chat?.loaded ? <p className="py-4 text-fg3">正在读取会话摘要…</p> : sections.length === 0 ? <p className="py-4 text-[12px] text-fg3">暂无活动记录</p> : sections.map((category) => {
        const Icon = SUMMARY_ICONS[category]
        return <section key={category} aria-label={`${SUMMARY_LABELS[category]}完整列表`} className="border-b border-line py-4 last:border-0">
          <h3 className="flex items-center gap-2 text-[13px] font-medium"><Icon size={16} />{SUMMARY_LABELS[category]} <span className="text-fg3">{summary.sections[category].length}</span></h3>
          {category === 'agents' ? <AgentList items={summary.sections.agents} sessionId={sessionId} projectId={projectId} /> : <SummaryRows section={category} items={summary.sections[category]} />}
        </section>
      })}
      {summary.historyIncomplete && <p className="mt-4 text-[11px] text-fg3">此会话历史记录不完整，部分来源、任务或子 Agent 状态可能未保存。</p>}
      {summary.agentsIncomplete && <p className="mt-4 text-[11px] text-fg3">部分后台活动尚未关联到工具调用，子 Agent 数量可能不完整。</p>}
    </div>
  </section>
}
