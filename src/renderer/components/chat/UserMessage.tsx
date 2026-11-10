import { useLayoutEffect, useRef, useState } from 'react'
import type { UiMessage } from '@shared/chat'
import { findBarePaths } from '@shared/fileLinks'
import { LinkifiedText } from '../files/FileLink'
import { Markdown } from './Markdown'
import { UserActions } from './MessageActions'

/** 用户消息：气泡 + 悬停时的时间 / 复制 / 编辑；编辑时原地变成输入框，发送后从这里重新生成 */
export function UserMessage({ message, text, onEdit }: { message: UiMessage; text: string; onEdit?(text: string): Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`
  }, [draft, editing])

  const submit = async (): Promise<void> => {
    const next = draft.trim()
    if (!next || !onEdit || sending) return
    setSending(true)
    setError(null)
    try {
      await onEdit(next)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  if (editing) {
    return (
      <div className="animate-fade-up my-4 ml-auto w-[85%] rounded-2xl border border-line-strong bg-card p-3 shadow-card focus-within:border-accent/45">
        <textarea
          ref={input}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.setSelectionRange(draft.length, draft.length)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setEditing(false)
            }
          }}
          className="block w-full resize-none bg-transparent px-1 text-[14.5px] leading-6 outline-none select-text"
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          {error && <span className="min-w-0 flex-1 truncate text-[12px] text-danger">{error}</span>}
          <button type="button" onClick={() => setEditing(false)} className="h-7 rounded-lg px-3 text-[12.5px] text-fg2 hover:bg-hover">
            取消
          </button>
          <button
            type="button"
            disabled={!draft.trim() || !onEdit || sending}
            onClick={() => void submit()}
            className="h-7 rounded-lg bg-accent px-3 text-[12.5px] font-medium text-accent-fg transition-opacity hover:opacity-85 disabled:opacity-40"
          >
            {sending ? '发送中…' : '发送'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="group/user my-4 flex flex-col items-end">
      <div data-user-bubble className="max-w-[85%] rounded-2xl bg-chip px-4 py-2.5 break-words select-text">
        <UserMessageBody text={text} />
      </div>
      <UserActions
        message={message}
        text={text}
        onEdit={
          onEdit &&
          (() => {
            setDraft(text)
            setError(null)
            setEditing(true)
          })
        }
      />
    </div>
  )
}

function UserMessageBody({ text }: { text: string }) {
  // 发送的附件引用单独占据首段，按原文解析，避免文件名里的 Markdown 标记干扰。
  const separator = /\r?\n\r?\n/.exec(text)
  const prefix = text.slice(0, separator?.index ?? text.length)
  const hasAttachments = prefix.split(/\r?\n/).every(line =>
    line.startsWith('@') && findBarePaths(line).some(match => match.start === 0 && match.end === line.length)
  )
  if (!hasAttachments) return <Markdown text={text} userMessage />

  const body = separator ? text.slice(prefix.length + separator[0].length) : ''
  return (
    <>
      <div className="whitespace-pre-wrap"><LinkifiedText text={prefix} attachments /></div>
      {body && <Markdown text={body} userMessage />}
    </>
  )
}
