import type { UiMessage } from '@shared/chat'
import { internalNoticeKind, parseTaskNotification } from '@shared/internalNotice'
import { commandNotice } from '@shared/commandNotice'
import { CommandNotice } from './CommandNotice'
const textOf = (message: UiMessage) => message.blocks.filter(b => b.kind === 'text').map(b => b.text).join('\n')

export function TechnicalRecords({ messages }: { messages: UiMessage[] }) {
  return <details className="my-3 text-[12px] text-fg3">
    <summary className="cursor-pointer">技术记录 · {messages.length} 条</summary>
    <div className="mt-2 space-y-3 text-fg2">
      {messages.map((message, index) => <div key={message.id}>
        <div className="mb-1 text-fg3">记录 {index + 1}</div>
        <div className="whitespace-pre-wrap break-words select-text">{textOf(message)}</div>
      </div>)}
    </div>
  </details>
}

export function InternalNotice({ message }: { message: UiMessage }) {
  const notice = commandNotice(textOf(message))
  if (notice) return <CommandNotice text={notice} />
  const kind = internalNoticeKind(message)
  if (kind === 'command') return null
  if (kind === 'technical') return <TechnicalRecords messages={[message]} />
  if (kind === 'compact') return <details className="my-3 text-[12px] text-fg3">
    <summary className="cursor-pointer">已整理上下文</summary>
    <div className="mt-2 whitespace-pre-wrap break-words text-fg2 select-text">{textOf(message)}</div>
  </details>
  // Synthetic notifications and old snapshots without display metadata remain visible.
  return <div className="my-3 text-[12px] text-fg2">
    <div className="whitespace-pre-wrap break-words select-text">{textOf(message)}</div>
  </div>
}

const TASK_STATUS: Record<string, string> = { completed: '已完成', failed: '失败', killed: '已停止', stopped: '已停止' }
/** Compact display for CLI task notifications; the raw record stays available on expand. */
export function TaskNotice({ message }: { message: UiMessage }) {
  const text = textOf(message)
  const task = parseTaskNotification(text)
  if (!task) return <div className="my-3 whitespace-pre-wrap break-words text-[13px] text-fg2 select-text">{text}</div>
  const status = task.status ? TASK_STATUS[task.status] ?? task.status : undefined
  return <details className="my-3 text-[12px] text-fg3">
    <summary className="cursor-pointer">后台任务{status ? ` · ${status}` : ''}{task.summary ? ` · ${task.summary}` : ''}</summary>
    <div className="mt-2 whitespace-pre-wrap break-words text-fg2 select-text">{text}</div>
  </details>
}
