import { refreshSessionRuntime } from '../../refreshSessionRuntime'
import { parseDesktopCommand } from '@shared/sessionCommand'
import { errorText } from '../../ipcError'
import { ModePicker } from '../newSession/ModePicker'
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { ComposerAttachment } from '@shared/attachments'
import type { UiBlock, UiMessage } from '@shared/chat'
import type { CommandInfo } from '@shared/types'
import { groupTechnicalNotices, isInterruptionNotice } from '@shared/internalNotice'
import { InternalNotice, TaskNotice, TechnicalRecords } from './InternalNotice'
import { turnsOf } from '@shared/fileChanges'
import { sumUsage, totalTokens } from '@shared/usageStats'
import { cacheExpiresAt } from '@shared/cacheWindow'
import { useBtw } from '../../btwStore'
import { useSessionMarks } from '../../sessionMarks'
import { useChat, useChatActions } from '../../chatStore'
import { useLayout } from '../../layoutStore'
import { openAppPanel, usePanel } from '../../panelStore'
import { useDesk } from '../../store'
import { CommandPanel, type PanelContext } from '../commands/CommandPanel'
import { useCommandAutoOpen } from '../commands/useCommandAutoOpen'
import { FileContext } from '../files/FileLink'
import { Composer, PermissionChip } from '../newSession/Composer'
import { ApprovalCard } from './ApprovalCard'
import { CommandRecord } from './CommandRecord'
import { commandNotice } from '@shared/commandNotice'
import { CommandNotice } from './CommandNotice'
import { ContextMeter } from './ContextMeter'
import { useContextUsage } from '../../hooks/useContextUsage'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'
import { TurnFiles } from './TurnFiles'
import { AssistantActions } from './MessageActions'
import { UserMessage } from './UserMessage'
import { MessageQueue } from './MessageQueue'
import { ActivityIndicator } from '../ui/ActivityIndicator'
import { activityLabel, ThinkingSummary } from './ThinkingSummary'
import { useComposerDrafts, EMPTY_DRAFT } from '../../composerDraftStore'
import { UsagePill } from './UsageStats'
import { ChatError } from './ChatError'

// SDK 里没有 /btw，由应用自己实现，补进命令菜单
const EXTRA_COMMANDS: CommandInfo[] = [
  { name: 'btw', description: '顺便问一下：在右侧提问，不打断也不写入当前对话', argumentHint: '<问题>' }
]

export function ChatView({ sessionId, projectId }: { sessionId: string; projectId: string }) {
  const chat = useChat((s) => s.chats[sessionId])
  const { load, reload, send, edit, interrupt, setOptions, respond, queueAction } = useChatActions()
  const cwd = useDesk((s) => s.projects.find((p) => p.id === projectId)?.path)
  const normalDraft = useComposerDrafts(s => s.drafts[sessionId] ?? EMPTY_DRAFT)
  const editing = useComposerDrafts(s => s.edits[sessionId])
  const [editBusy, setEditBusy] = useState(false)
  const { text, attachments } = editing ?? normalDraft
  const setText = (text: string): void => {
    const store = useComposerDrafts.getState()
    if (editing) store.updateEdit(sessionId, { text }); else store.updateDraft(sessionId, { text })
  }
  const setAttachments = (attachments: ComposerAttachment[]): void => {
    const store = useComposerDrafts.getState()
    if (editing) store.updateEdit(sessionId, { attachments }); else store.updateDraft(sessionId, { attachments })
  }
  const [sendError, setSendError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    void load(sessionId, projectId)
    stick.current = true
  }, [load, sessionId, projectId])

  const unread = useSessionMarks((s) => !!s.unread[sessionId])
  const sidebarExpanded = useLayout((s) => s.rightOpen && s.expanded)
  useEffect(() => {
    const markViewed = (): void => {
      if (chat?.loaded && !sidebarExpanded && document.visibilityState === 'visible' && document.hasFocus()) {
        useSessionMarks.getState().markRead(sessionId)
      }
    }
    markViewed()
    window.addEventListener('focus', markViewed)
    document.addEventListener('visibilitychange', markViewed)
    return () => {
      window.removeEventListener('focus', markViewed)
      document.removeEventListener('visibilitychange', markViewed)
    }
  }, [sessionId, chat?.loaded, unread, sidebarExpanded])

  // 回到窗口时检查这个会话是否在终端或 VS Code 里被续写了
  const [external, setExternal] = useState(false)
  const idle = chat?.loaded && chat.state === 'idle'
  useEffect(() => {
    if (!idle || !cwd) return
    const check = (): void => {
      window.desk.chat.checkExternal(sessionId, cwd).then(setExternal, () => {})
    }
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [idle, cwd, sessionId])

  const model = chat?.options.model ?? null
  const context = useContextUsage(sessionId, cwd, model, chat?.loaded ?? false, idle)

  useCommandAutoOpen(chat?.messages, chat?.loaded)
  const panelOpen = usePanel((s) => s.panel !== null)

  const autoScroll = useDesk(s => s.settings?.autoScroll ?? true)

  // 停在底部时，新内容到来自动滚动；用户往上翻时不打扰
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current && autoScroll) el.scrollTop = el.scrollHeight
  }, [chat?.messages, chat?.approvals.length, chat?.state, autoScroll])

  if (!chat) return <div className="flex-1" />

  const running = chat.state === 'running' || chat.state === 'awaiting'
  const hasWaiting = Boolean(chat.queue?.items.some(item => item.editing || ['queued', 'failed'].includes(item.status)))
  // 本地命令在对话里只留一行记录：隐藏紧挨着它的那条用户输入
  const hidden = new Set(
    chat.messages.filter((m, i) => m.role === 'user' && chat.messages[i + 1]?.blocks[0]?.kind === 'command').map((m) => m.id)
  )
  const turns = turnsOf(chat.messages)
  const sessionUsage = sumUsage(chat.messages)
  const approval = chat.approvals[0]
  const liveIndicator = running ? <ActivityIndicator iconOnly label={activityLabel(chat.state, chat.activity)} active={chat.state === 'running' && chat.activity?.phase !== 'stopping'} /> : null
  const activeIndex = chat.activity?.blockIndex
  const anchor = running && activeIndex !== undefined
    ? chat.messages.find(m => m.id === chat.activity?.messageId && !m.parentToolUseId && m.role === 'assistant' && m.blocks[activeIndex])
    : undefined
  const activeBlock = anchor && activeIndex !== undefined ? {
    index: activeIndex,
    thinking: chat.state === 'running' && chat.activity?.phase === 'thinking',
    indicator: liveIndicator
  } : undefined
  const renderMessage = (message: UiMessage) => (
    <Message
      key={message.id}
      message={message}
      activeBlock={anchor === message ? activeBlock : undefined}
      running={running}
      cwd={cwd}
      // 编辑历史消息：会话空闲时才能改
      onEdit={running || approval || message.forkFrom === undefined ? undefined : (text) => edit(sessionId, message.id, text)}
    />
  )
  // 命令卡片里的选项（切换模型等）：会话空闲时才能点
  const runCommand = chat.loaded && !running && !approval ? (command: string) => void send(sessionId, command) : undefined
  const panelCtx: PanelContext = {
    sessionId,
    cwd,
    options: chat.options,
    runtime: chat.runtime,
    optionsUpdating: chat.optionsUpdating,
    setOptions: (patch) => void setOptions(sessionId, patch).catch(() => {}),
    onRun: runCommand,
    sessionUsage
  }

  const crabOverlap = !approval && !chat.optionsSaveError

  return (
    <FileContext.Provider value={{ cwd }}>
      <div className="chat-view flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
            className="chat-scroll min-h-0 flex-1 overflow-y-auto px-8"
          >
            <div className={`chat-messages mx-auto max-w-[760px] pt-2 ${crabOverlap ? 'pb-[76px]' : 'pb-6'}`}>
              {external && (
                <div className="chat-external-update sticky top-0 z-10 mb-2 flex items-center gap-3 rounded-xl border border-line bg-card px-4 py-2.5 text-[13px] shadow-card">
                  <span className="min-w-0 flex-1 text-fg2">会话有更新</span>
                  <button
                    type="button"
                    onClick={() => {
                      setExternal(false)
                      stick.current = true
                      void reload(sessionId)
                    }}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 font-medium hover:bg-hover"
                  >
                    <RefreshCw size={13} />
                    更新
                  </button>
                </div>
              )}
              {!chat.loaded && <div className="py-10 text-center text-fg3">正在加载对话…</div>}
              {turns.map((turn, i) => (
                <Fragment key={turn[0]!.id}>
                  {turn
                    .filter((m) => m.role === 'user' && !m.parentToolUseId && !hidden.has(m.id))
                    .map(renderMessage)}
                  {groupTechnicalNotices(turn.filter((m) => m.role !== 'user' && !m.parentToolUseId && !hidden.has(m.id)))
                    .map(entry => entry.kind === 'technical'
                      ? <TechnicalRecords key={entry.messages[0]!.id} messages={entry.messages} />
                      : renderMessage(entry.message))}
                  {/* 每轮结束后列出这一轮改过的文件，点开在右栏看对比 */}
                  {!(running && (anchor ? turn.includes(anchor) : i === turns.length - 1)) && (
                    <>
                      <TurnFiles messages={turn} cwd={cwd} />
                      <AssistantActions turn={turn} />
                    </>
                  )}
                </Fragment>
              ))}
              {!activeBlock && liveIndicator}
              {chat.error && <ChatError error={chat.error} />}
            </div>
          </div>

          {/* 螃蟹那 52px 叠到消息区上，消息从螃蟹后面透出来，不被白底截断；空白处不拦截点击 */}
          <div className={`pointer-events-none relative z-10 px-8 pb-5 ${crabOverlap ? '-mt-[52px]' : ''}`}>
            <div className="mx-auto max-w-[760px] space-y-2 [&>*:not(.composer-with-crab)]:pointer-events-auto">
              {approval && (
                <ApprovalCard
                  key={approval.requestId}
                  request={approval}
                  total={chat.approvals.length}
                  cwd={cwd}
                  onDecide={(d) => void respond(sessionId, approval.requestId, d).catch(() => {})}
                />
              )}
              {chat.optionsSaveError && <div role="alert" className="text-[12px] text-danger">{chat.optionsSaveError}</div>}

              <Composer fast={chat.runtime?.fastMode ? chat.runtime.fastMode === 'on' : undefined} rainbow={chat.runtime ? chat.runtime.ultracode === true : chat.state !== 'error' && chat.firstSendUltracode && !chat.sync?.fields.runtime}
                queuePanel={<MessageQueue key={`queue-${sessionId}`} queue={chat.queue} canInsert={chat.state === 'running' && chat.activity?.phase !== 'stopping' && !approval} onAction={action => queueAction(sessionId, action)} editingId={editing?.id} onEdit={async item => {
                await queueAction(sessionId, { type: 'beginEdit', id: item.id })
                useComposerDrafts.getState().beginEdit(sessionId, item)
                setSendError(null)
              }} />}
                sessionId={sessionId}
                promptSuggestion={!editing && !hasWaiting ? chat.promptSuggestion : null}
                sessionState={chat.state}
                activity={chat.activity}
                cacheExpiresAt={cacheExpiresAt(chat.messages)}
                key={`${sessionId}:${editing?.id ?? 'draft'}`}
                clearOnSubmit={!editing}
                submitLabel={editing ? '保存到队列' : undefined}
                header={editing && <div className="flex items-center justify-between gap-3 px-3 pt-3 text-[12px] text-fg3"><span>编辑排队消息</span><button type="button" disabled={editBusy} className="hover:text-fg disabled:opacity-40" onClick={async () => {
                  setEditBusy(true); setSendError(null)
                  try { await queueAction(sessionId, { type: 'cancelEdit', id: editing.id }); useComposerDrafts.getState().finishEdit(sessionId) }
                  catch (e) { setSendError(e instanceof Error ? e.message : String(e)) }
                  finally { setEditBusy(false) }
                }}>取消编辑</button></div>}
                history={editing ? [] : chat.messages.filter(m => m.source === 'human' && !m.parentToolUseId).map(m => ({ id: m.id, text: blockText(m.blocks) }))}
                value={text}
                onChange={setText}
                attachments={attachments}
                onAttachmentsChange={setAttachments}
                rows={2}
                autoFocus
                cwd={cwd}
                placeholder={editing ? '编辑这条排队消息…' : approval ? '处理上方请求后继续' : running ? '发送下一条任务…' : '回复 Claude…'}
                running={running && !editing}
                onStop={() => void interrupt(sessionId)}
                canSubmit={Boolean(chat.loaded && (editing || !approval) && !editBusy)}
                submitHint={editing ? '保存到队列（Enter）' : running || hasWaiting ? '加入队列（Enter）' : '发送（Enter）'}
                extraCommands={EXTRA_COMMANDS}
                panel={!editing && panelOpen && <CommandPanel ctx={panelCtx} />}
                onCommand={editing ? undefined : (name, args) => {
                  if (name === 'btw') {
                    const pageId = useLayout.getState().newPage(cwd, 'chat')
                    if (pageId && args && cwd) void useBtw.getState().ask(pageId, sessionId, cwd, args, chat.options)
                    return true
                  }
                  return openAppPanel(name, args)
                }}
                onSubmit={async ({ prompt, attachments: files }) => {
                  setSendError(null)
                  stick.current = true
                  try {
                    if (editing) {
                      if (parseDesktopCommand(prompt)) throw new Error('不能把设置指令保存到消息队列，请取消编辑后执行。')
                      setEditBusy(true)
                      await queueAction(sessionId, { type: 'edit', id: editing.id, text: prompt, attachments: [...new Set([...editing.originalPaths, ...files.map(f => f.path)])] })
                      useComposerDrafts.getState().finishEdit(sessionId)
                    } else await send(sessionId, prompt, files.map(f => f.path))
                  } catch (err) {
                    setSendError(errorText(err))
                    throw err
                  } finally { setEditBusy(false) }
                }}
                meter={
                  <>
                    {totalTokens(sessionUsage) > 0 && <UsagePill usage={sessionUsage} title="本会话用量" />}
                    {context && <ContextMeter usage={context} />}
                  </>
                }
                chips={editing ? null :
                  <>
                    <ModePicker live options={chat.options} runtime={chat.runtime} cwd={cwd} busy={chat.optionsUpdating} onChange={panelCtx.setOptions} onRetry={() => refreshSessionRuntime(sessionId, cwd)} />
                    <PermissionChip placement="top" value={chat.options.mode} applied={chat.runtime?.permissionMode} onChange={(mode) => void setOptions(sessionId, { mode }).catch(() => {})} />
                  </>
                }
              />
              {sendError && <p className="px-1 text-[12.5px] text-danger">{editing ? '编辑失败：' : '操作失败：'}{sendError}</p>}
            </div>
          </div>
        </div>
      </div>
    </FileContext.Provider>
  )
}

function Message({
  message,
  running,
  cwd,
  onEdit,
  activeBlock
}: {
  message: UiMessage
  activeBlock?: { index: number; thinking: boolean; indicator: ReactNode }
  running: boolean
  cwd?: string
  onEdit?(text: string): Promise<void>
}) {
  if (message.role === 'notice') {
    const notice = message.source !== 'human' && message.source !== 'external' ? commandNotice(blockText(message.blocks)) : null
    if (notice) return <CommandNotice text={notice} />
    if (isInterruptionNotice(message)) return <div className="my-3 text-[13px] text-fg3">已停止</div>
    if (message.source === 'internal') return <InternalNotice message={message} />
    if (message.source !== 'unknown' && message.originKind === 'task-notification') return <TaskNotice message={message} />
    if (message.source) {
      const label = message.source === 'unknown' ? (message.startsTurn ? '历史消息 · 来源未确认，按旧记录分组' : '消息 · 来源未确认') : message.originKind === 'task-notification' ? '任务通知' : message.originKind === 'peer' ? 'Agent 消息' : message.originKind === 'channel' ? '通道消息' : '外部消息'
      return <div title={label} className="my-3 whitespace-pre-wrap break-words text-[13px] text-fg2 select-text">{blockText(message.blocks)}</div>
    }
    return <div className="my-3 text-center text-[12px] text-fg3">— {blockText(message.blocks)} —</div>
  }
  if (message.role === 'user') return <UserMessage message={message} text={blockText(message.blocks)} onEdit={onEdit} />
  return (
    <div className="my-3">
      {message.blocks.map((b, i) => {
        if (!b) return null
        const activity = activeBlock?.index === i ? activeBlock : undefined
        const body = b.kind === 'text' ? (b.text ? <Markdown text={b.text} /> : null)
          : b.kind === 'thinking' ? <ThinkingSummary text={b.text} streaming={activity?.thinking} />
          : b.kind === 'command' ? <CommandRecord block={b} onOpen={() => usePanel.getState().open({ kind: 'output', block: b })} />
          : <ToolCard block={b} running={running} cwd={cwd} />
        return <Fragment key={i}>{body}{activity?.indicator}</Fragment>
      })}
    </div>
  )
}

function blockText(blocks: UiBlock[]): string {
  return blocks.map((b) => (b?.kind === 'text' ? b.text : '')).join('\n')
}
