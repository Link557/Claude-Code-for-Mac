import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { UiMessage } from '@shared/chat'
import { ACTIVITY_LABELS, emptySessionSummary } from '@shared/sessionSummary'
import { useChat } from '../../chatStore'
import { useDesk } from '../../store'
import { useLayout } from '../../layoutStore'
import { Markdown } from '../chat/Markdown'
import { ThinkingSummary } from '../chat/ThinkingSummary'
import { ToolCard } from '../chat/ToolCard'
import { AgentCrab } from '../summary/AgentCrab'
import { agentMessages } from '../summary/agentMessages'

const EMPTY = emptySessionSummary()
const NO_MESSAGES: UiMessage[] = []

export function AgentConversationPane({ sessionId, projectId, agentId, active }: { sessionId: string; projectId: string; agentId?: string; active: boolean }) {
  const chat = useChat(s => s.chats[sessionId])
  const project = useDesk(s => s.projects.find(p => p.id === projectId))
  const agents = chat?.summary?.sections.agents ?? EMPTY.sections.agents
  const index = agents.findIndex(item => item.id === agentId)
  const agent = agents[index]
  const [record, setRecord] = useState<{ key: string; messages: UiMessage[] }>()
  const [failure, setFailure] = useState<{ key: string; text: string }>()
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const key = JSON.stringify([sessionId, agentId])
  const running = agent?.status === 'running'
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)

  useEffect(() => {
    if (!active || !project || !agent) return
    let stale = false
    let pending = false
    const read = async (): Promise<void> => {
      if (pending) return
      pending = true
      setLoading(true)
      try {
        const messages = await window.desk.chat.subagentMessages(sessionId, project.path, agent.id)
        if (!stale) { setRecord({ key, messages }); setFailure(undefined) }
      } catch (error) {
        if (!stale) setFailure({ key, text: error instanceof Error ? error.message : String(error) })
      } finally { pending = false; if (!stale) setLoading(false) }
    }
    void read()
    const timer = running ? setInterval(() => { void read() }, 2000) : undefined
    return () => { stale = true; if (timer) clearInterval(timer) }
  }, [sessionId, project?.path, agent?.id, agent?.agentId, agent?.status, active, retry])

  const messages = agentMessages(record?.key === key ? record.messages : NO_MESSAGES, chat?.messages ?? NO_MESSAGES, agentId ?? '', running)
  const tool = chat?.messages.flatMap(message => message.blocks).find(block => block.kind === 'tool' && block.id === agentId)
  const prompt = tool?.kind === 'tool' && typeof tool.input.prompt === 'string' ? tool.input.prompt : ''
  const result = tool?.kind === 'tool' ? tool.result : undefined
  useLayoutEffect(() => { follow.current = true; if (scroll.current) scroll.current.scrollTop = 0 }, [key])
  useLayoutEffect(() => {
    if (active && follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [active, messages])

  return <section aria-label="子 Agent 会话" className="flex h-full min-h-0 flex-col">
    <div className="shrink-0 border-b border-line px-5 py-3"><h2 className="text-[15px] font-medium">子 Agent</h2><p className="mt-1 truncate text-[11px] text-fg3">{project?.name ?? '项目已移除'} · {agents.length} 位</p></div>
    <div className="flex shrink-0 flex-wrap gap-1 border-b border-line px-3 py-2" aria-label="切换子 Agent">
      {agents.map((item, i) => <button key={item.id} type="button" aria-label={`切换到${item.title}`} aria-pressed={item.id === agentId}
        onClick={() => useLayout.getState().openAgent(sessionId, projectId, item.id)} title={item.title}
        className={`flex w-[82px] min-w-0 flex-col items-center rounded-lg px-1 pb-2 text-[11px] ${item.id === agentId ? 'bg-active text-fg' : 'text-fg2 hover:bg-hover'}`}>
        <AgentCrab index={item.appearanceIndex ?? i} /><span className="w-full truncate text-center">{item.title}</span>
      </button>)}
    </div>
    <div ref={scroll} onScroll={event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32 }} className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
      {!agent ? <p className="py-4 text-[12px] text-fg3">该子 Agent 的记录已不可用。</p> : <>
        <div className="flex items-center gap-2 py-4"><AgentCrab index={agent.appearanceIndex ?? index} /><div className="min-w-0"><h3 className="break-words text-[14px] font-medium">{agent.title}</h3><p className={`mt-1 text-[11px] ${agent.status === 'failed' ? 'text-danger' : 'text-fg3'}`}>{ACTIVITY_LABELS[agent.status ?? 'unknown']} · {agent.description}</p></div></div>
        {prompt && <div className="mb-5"><h4 className="mb-2 text-[12px] text-fg2">收到的任务</h4><div className="select-text whitespace-pre-wrap break-words rounded-xl bg-sidebar p-3 text-[12px] leading-relaxed">{prompt}</div></div>}
        <h4 className="mb-3 text-[12px] text-fg2">会话记录</h4>
        {failure?.key === key && <div role="alert" className="mb-3 text-[12px] text-danger">读取子会话失败：{failure.text}<button type="button" className="ml-2 underline" onClick={() => setRetry(value => value + 1)}>重试</button></div>}
        {!messages.length && <p className="mb-4 text-[12px] text-fg3">{loading ? '正在读取子会话…' : running ? '暂未取得内部会话记录，收到后会自动更新。' : result ? '未能取得内部会话记录（可能未保存或不可读取）。下方仅展示实际返回结果。' : '未能取得内部会话记录（可能未保存或不可读取），也没有保存返回结果。'}</p>}
        {messages.map(message => <div key={message.id} className="mb-5" data-agent-message={message.id}>
          <p className="mb-2 text-[11px] text-fg3">{message.role === 'assistant' ? '子 Agent' : '上下文'}</p>
          {message.blocks.map((block, i) => block.kind === 'text' ? <Markdown key={i} text={block.text} />
            : block.kind === 'thinking' ? <ThinkingSummary key={i} text={block.text} />
            : block.kind === 'tool' ? <ToolCard key={i} block={block} running={running} cwd={project?.path} />
            : <pre key={i} className="whitespace-pre-wrap break-words text-[12px]">{block.output ?? '该命令未保存输出'}</pre>)}
        </div>)}
        {result && <div className="mt-5 border-t border-line pt-4"><h4 className={`mb-2 text-[12px] ${result.isError ? 'text-danger' : 'text-fg2'}`}>{result.isError ? '调用错误' : '返回主会话的结果'}</h4><Markdown text={result.text || '（无输出）'} /></div>}
      </>}
    </div>
  </section>
}
