import { useState } from 'react'
import { ACTIVITY_LABELS, type SummaryItem } from '@shared/sessionSummary'
import { useLayout } from '../../layoutStore'
import { useSummaryUi } from '../../summaryUiStore'
import { AgentCrab } from './AgentCrab'

export function AgentList({ items, sessionId, projectId, compact = false }: { items: SummaryItem[]; sessionId: string; projectId: string; compact?: boolean }) {
  const [error, setError] = useState('')
  const open = (id: string): void => {
    if (useLayout.getState().openAgent(sessionId, projectId, id)) { setError(''); useSummaryUi.getState().close(sessionId) }
    else setError('侧栏页面已满，请关闭一个页面后重试。')
  }
  const preview = compact ? items.slice(0, 3) : items
  return <>
    {compact && <div className="grid grid-cols-[repeat(auto-fit,minmax(64px,1fr))] gap-1 pb-2" aria-label="子 Agent 小螃蟹">
      {items.map((agent, index) => <button key={agent.id} type="button" onClick={() => open(agent.id)} aria-label={`查看${agent.title}的会话`}
        className="flex min-w-0 flex-col items-center rounded-lg px-1 pb-2 hover:bg-hover">
        <AgentCrab index={agent.appearanceIndex ?? index} running={agent.status === 'running'} /><span className="w-full truncate text-center text-[11px] text-fg2" title={agent.title}>{agent.title}</span>
      </button>)}
    </div>}
    <div className={compact ? 'space-y-0.5' : 'divide-y divide-line'}>
      {preview.map((agent, index) => <button key={agent.id} type="button" onClick={() => open(agent.id)} aria-label={`打开子 Agent：${agent.title}`}
        className={`flex w-full items-center gap-2 rounded-lg text-left hover:bg-hover ${compact ? 'px-1 py-1' : 'px-1 py-3'}`}>
        <AgentCrab index={agent.appearanceIndex ?? index} small />
        <span className="min-w-0 flex-1"><span className="block truncate text-[13px]" title={agent.title}>{agent.title}</span>{!compact && <span className="mt-1 block truncate text-[11px] text-fg3">{agent.description}</span>}</span>
        <span className={`shrink-0 text-[11px] ${agent.status === 'failed' ? 'text-danger' : 'text-fg3'}`}>{ACTIVITY_LABELS[agent.status ?? 'unknown']}</span>
      </button>)}
    </div>
    {compact && items.length > preview.length && <p className="pt-1 text-[11px] text-fg3">还有 {items.length - preview.length} 位，查看全部可打开完整列表</p>}
    {error && <p role="alert" className="py-2 text-[12px] text-danger">{error}</p>}
  </>
}
