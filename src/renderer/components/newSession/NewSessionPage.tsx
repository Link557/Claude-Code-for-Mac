import { ModePicker } from '../newSession/ModePicker'
import { parseDesktopCommand, sessionCommand } from '@shared/sessionCommand'
import { useEffect, useRef, useState } from 'react'
import { FolderPlus } from 'lucide-react'
import { attachmentTitle, type ComposerAttachment } from '@shared/attachments'
import { captureFirstSend } from '../../motion/firstSend'
import { useDesk } from '../../store'
import { draftSessionOptions } from '../../sessionOptions'
import { useChat } from '../../chatStore'
import { EMPTY_DRAFT, NEW_CHAT_DRAFT, useComposerDrafts } from '../../composerDraftStore'
import { openAppPanel, usePanel } from '../../panelStore'
import { CommandPanel } from '../commands/CommandPanel'
import { Button } from '../ui/Dialog'
import { Composer, PermissionChip, ProjectChip } from './Composer'
import { CliInstallCard } from '../connection/CliInstallCard'
import { useCliConnection } from '../connection/useCliConnection'

export function NewSessionPage() {
  const composerRoot = useRef<HTMLDivElement>(null)
  const transition = useRef<ReturnType<typeof captureFirstSend>>(undefined)
  useEffect(() => () => transition.current?.release(), [])
  const desk = useDesk()
  const { projects, selectedProjectId, pickProject, setDraft } = desk
  const options = draftSessionOptions(desk)
  const start = useChat((s) => s.start)
  useState(() => {
    const prefill = useDesk.getState().takeNewChatPrefill()
    if (prefill) useComposerDrafts.getState().updateDraft(NEW_CHAT_DRAFT, { text: prefill })
  })
  const { text, attachments } = useComposerDrafts((s) => s.drafts[NEW_CHAT_DRAFT] ?? EMPTY_DRAFT)
  const setText = (text: string): void => useComposerDrafts.getState().updateDraft(NEW_CHAT_DRAFT, { text })
  const setAttachments = (attachments: ComposerAttachment[]): void => useComposerDrafts.getState().updateDraft(NEW_CHAT_DRAFT, { attachments })
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [configStatus, setConfigStatus] = useState<string | null>(null)
  const project = projects.find((p) => p.id === selectedProjectId)
  const cli = useCliConnection(project?.path)
  const panelOpen = usePanel((s) => s.panel !== null)

  if (projects.length === 0) {
    return (
      <Centered>
        <h1 className="font-serif text-[30px] font-normal tracking-tight">先添加一个项目文件夹</h1>
        <div className="mt-4"><CliInstallCard status={cli.status} checking={cli.checking} loadError={cli.error} onRefresh={cli.refresh} /></div>
        <div className="mt-6">
          <Button variant="primary" onClick={() => void pickProject()}>
            <span className="flex items-center gap-1.5">
              <FolderPlus size={15} />
              添加项目…
            </span>
          </Button>
        </div>
      </Centered>
    )
  }

  return (
    <Centered>
      <h1 className="font-serif text-[38px] font-light tracking-[0.04em] text-[var(--greeting)]">{desk.greeting}</h1>
      <div className="mt-4"><CliInstallCard status={cli.status} checking={cli.checking} loadError={cli.error} onRefresh={cli.refresh} /></div>
      <div ref={composerRoot} className="relative mt-4">
        <Composer fast={!!options.fastMode} rainbow={options.ultracode}
          sessionState={error ? 'error' : sending ? 'running' : 'idle'}
          value={text}
          onChange={setText}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          autoFocus
          cwd={project?.path}
          panel={
            panelOpen && (
              <CommandPanel
                ctx={{
                  sessionId: null,
                  cwd: project?.path,
                  options,
                  setOptions: (patch) => setDraft(patch)
                }}
              />
            )
          }
          onCommand={(name, args) => {
            const control = sessionCommand('/' + name + ' ' + args)
            if (control) { setDraft(control); return true }
            return openAppPanel(name, args)
          }}
          onSubmit={async ({ text: body, prompt, attachments: submitted }) => {
            const command = parseDesktopCommand(body)
            if (command?.kind === 'config') {
              setSending(true); setError(null); setConfigStatus(null)
              try { await window.desk.meta.config(project!.path, command.setting); setConfigStatus('已保存 · 后续会话读取设置') }
              catch (err) { setError(err instanceof Error ? err.message : String(err)); throw err }
              finally { setSending(false) }
              return
            }
            if (command?.kind === 'session') {
              const err = new Error('此指令需要已有会话，请先开始对话。')
              setError(err.message); throw err
            }
            transition.current = captureFirstSend(composerRoot.current)
            setSending(true)
            setError(null)
            try {
              await start(prompt, attachmentTitle(body, submitted), transition.current?.arm)
            } catch (err) {
              transition.current?.cancel()
              setError(err instanceof Error ? err.message : String(err))
              throw err
            } finally {
              setSending(false)
            }
          }}
          canSubmit={Boolean(project && !sending)}
          submitHint={project ? '发送（Enter）' : '请先选择项目'}
          chips={
            <>
              <ProjectChip />
              <ModePicker options={options} cwd={project?.path} onChange={setDraft} />
              <PermissionChip value={options.mode} onChange={(mode) => setDraft({ mode })} />
            </>
          }
        />
        {configStatus && <p role="status" className="mt-2 text-[12.5px] text-fg3">{configStatus}</p>}
        {error && <p className="mt-2 text-[12.5px] text-danger">发送失败：{error}</p>}
      </div>
    </Centered>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-8 pb-[10vh]">
      <div className="w-full max-w-[720px]">{children}</div>
    </div>
  )
}
