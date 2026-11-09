import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { UiBlock, UiMessage } from '@shared/chat'
import { agentResultFooter } from '@shared/agentResult'
import { ACTIVITY_LABELS, emptySessionSummary } from '@shared/sessionSummary'
import { useChat } from '../../chatStore'
import { useDesk } from '../../store'
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
  const replies = messages.filter(message => message.role === 'assistant' && message.blocks.some(block => block.kind !== 'thinking'))
  const context = messages.filter(message => message.role !== 'assistant' || message.blocks.some(block => block.kind === 'thinking'))
  const tool = chat?.messages.flatMap(message => message.blocks).find(block => block.kind === 'tool' && block.id === agentId)
  const prompt = tool?.kind === 'tool' && typeof tool.input.prompt === 'string' ? tool.input.prompt : ''
  const result = tool?.kind === 'tool' ? tool.result : undefined
  const footer = result && !result.isError ? agentResultFooter(result.text) : undefined
  const resultText = footer ? result?.text.slice(0, footer.start).trimEnd() : result?.text
  const showResult = result && (result.isError || !replies.length)
  const extraResult = result && !showResult && resultText?.trim() && !messages.some(message =>
    message.role === 'assistant' && message.blocks.some(block => block.kind === 'text' && block.text.trim() === resultText.trim())
  ) ? resultText : undefined
  const renderBlocks = (blocks: UiBlock[]) => blocks.map((block, i) => block.kind === 'text' ? <Markdown key={i} text={block.text} />
    : block.kind === 'thinking' ? <ThinkingSummary key={i} text={block.text} />
    : block.kind === 'tool' ? <ToolCard key={i} block={block} running={running} cwd={project?.path} />
    : <pre key={i} className="whitespace-pre-wrap break-words text-[12px]">{block.output ?? '该命令未保存输出'}</pre>)
  useLayoutEffect(() => { follow.current = false; if (scroll.current) scroll.current.scrollTop = 0 }, [key])
  useLayoutEffect(() => {
    if (active && follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [active, messages])

  return <section ref={scroll} aria-label="子 Agent 会话" onScroll={event => {
    const element = event.currentTarget
    follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32
  }} className="h-full overflow-y-auto">
    <header className="agent-conversation-header sticky top-0 z-10 px-6 pt-3 pb-5">
      <h2 className="line-clamp-2 break-words text-lg leading-snug font-medium" title={agent?.title}>{agent?.title ?? '子 Agent'}</h2>
      {agent && <span className="mt-2 block w-fit" role="img" aria-label={ACTIVITY_LABELS[agent.status ?? 'unknown']} title={ACTIVITY_LABELS[agent.status ?? 'unknown']}>
        <AgentCrab index={agent.appearanceIndex ?? index} running={active && running} />
      </span>}
    </header>
    <div key={key} className="px-6 pt-1 pb-7">
      {!agent ? <p className="text-sm text-fg2">该子 Agent 的记录已不可用。</p> : <>
        {failure?.key === key && <div role="alert" className="mb-3 text-[12px] text-danger">读取子会话失败：{failure.text}<button type="button" className="ml-2 underline" onClick={() => setRetry(value => value + 1)}>重试</button></div>}
        {!replies.length && failure?.key !== key && <p className="mb-4 text-sm text-fg2">{loading ? '正在读取子会话…' : running ? '等待子 Agent 回复…' : result ? '暂无会话正文，以下为返回结果。' : '暂无可读取的会话正文。'}</p>}
        {replies.map(message => <div key={message.id} className="mb-5" data-agent-message={message.id}>
          {renderBlocks(message.blocks.filter(block => block.kind !== 'thinking'))}
        </div>)}
        {showResult && <div className={result.isError ? 'text-danger' : undefined}>
          {result.isError && <p className="mb-2 text-sm">调用错误</p>}
          <Markdown text={resultText || '（无输出）'} />
        </div>}
        {(prompt || extraResult || context.length > 0) && <details className="mt-5">
          <summary className="w-fit cursor-pointer rounded text-sm text-fg2 hover:text-fg">{context.length ? '会话详情' : prompt && extraResult ? '任务与返回结果' : prompt ? '任务说明' : '返回结果'}</summary>
          {prompt && <div className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">{prompt}</div>}
          {context.map(message => <div key={message.id} className="mt-3">
            {renderBlocks(message.role === 'assistant' ? message.blocks.filter(block => block.kind === 'thinking') : message.blocks)}
          </div>)}
          {extraResult && <div className="mt-3"><Markdown text={extraResult} /></div>}
        </details>}
      </>}
    </div>
  </section>
}
