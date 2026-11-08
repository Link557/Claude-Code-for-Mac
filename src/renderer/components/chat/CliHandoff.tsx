import { useEffect, useState } from 'react'
import { SquareTerminal, X } from 'lucide-react'
import { useChat } from '../../chatStore'
import { EMPTY_DRAFT, useComposerDrafts } from '../../composerDraftStore'
import { errorText } from '../../ipcError'
import { useDesk } from '../../store'

export function CliHandoff({ sessionId, projectId }: { sessionId: string; projectId: string }) {
  const chat = useChat(s => s.chats[sessionId])
  const cwd = useDesk(s => s.projects.find(p => p.id === projectId)?.path)
  const draft = useComposerDrafts(s => s.drafts[sessionId] ?? EMPTY_DRAFT)
  const editing = useComposerDrafts(s => s.edits[sessionId])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  useEffect(() => {
    if (!notice || notice.error) return
    const timer = setTimeout(() => setNotice(null), 3500)
    return () => clearTimeout(timer)
  }, [notice])
  const disabled = !cwd || !chat?.loaded || chat.state === 'running' || chat.state === 'awaiting' || busy || !!editing
    || !!chat.approvals?.length || chat.tasks?.some(task => task.status === 'running')
    || !!draft.text.trim() || draft.attachments.length > 0
    || chat.queue?.items.some(item => item.editing || ['queued', 'failed', 'submitting', 'submitted', 'received', 'unknown'].includes(item.status))
  return <div className="no-drag relative">
    <button type="button" aria-label="在 CLI 继续" title="复制终端接续命令；退出 CLI 后可回到桌面继续"
      disabled={disabled} className="flex size-7 items-center justify-center rounded-md text-fg2 hover:bg-hover hover:text-fg disabled:opacity-40"
      onClick={async () => {
        if (!cwd) return
        setBusy(true); setNotice(null)
        try {
          await window.desk.chat.handoffToCli(sessionId, cwd)
          setNotice({ text: '命令已复制，请在终端中粘贴', error: false })
        } catch (error) { setNotice({ text: errorText(error), error: true }) }
        finally { setBusy(false) }
      }}><SquareTerminal size={17} /></button>
    {notice && <div role={notice.error ? 'alert' : 'status'} className="absolute right-0 top-full z-50 mt-2 flex w-max max-w-[320px] items-start gap-2 rounded-xl border border-line bg-card px-3 py-2 text-[12px] shadow-pop">
      <span className={notice.error ? 'text-danger' : 'text-fg2'}>{notice.text}</span>
      <button type="button" aria-label="关闭提示" className="mt-0.5 shrink-0 text-fg3 hover:text-fg" onClick={() => setNotice(null)}><X size={13} /></button>
    </div>}
  </div>
}
