import { parseDesktopCommand } from '@shared/sessionCommand'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowUp,
  Box,
  Brain,
  ChevronDown,
  FilePlus2,
  Folder,
  FolderPlus,
  Plus,
  Shield,
  Square
} from 'lucide-react'
import {
  buildPrompt,
  mergeAttachments,
  type ComposerAttachment,
  type ComposerSubmission
} from '@shared/attachments'
import type { CommandInfo, EffortLevel, PermissionMode } from '@shared/types'
import { EFFORT_LEVELS, findTrigger, PERMISSION_MODES, shortenPath } from '@shared/format'
import { useDesk } from '../../store'
import { useDismiss } from '../../hooks/useDismiss'
import type { RuntimeSettings } from '@shared/chat'
import { Menu } from '../ui/Menu'
import type { ChatActivity, ChatState } from '@shared/chat'
import { AttachmentCard } from '../files/AttachmentCard'
import { ComposerCrab } from './ComposerCrab'
import { ComposerEditor, type EditorHandle } from './ComposerEditor'
import { useSuggestions, type Suggestion } from './useSuggestions'
import { useCacheMinutes } from '../../hooks/useCacheMinutes'

interface ComposerProps {
  fast?: boolean
  rainbow?: boolean
  sessionState?: ChatState
  activity?: ChatActivity
  sessionId?: string
  promptSuggestion?: import('@shared/chat').PromptSuggestion | null
  queuePanel?: ReactNode
  header?: ReactNode
  clearOnSubmit?: boolean
  submitLabel?: string
  history?: { id: string; text: string }[]
  value: string
  onChange(value: string): void
  attachments: ComposerAttachment[]
  onAttachmentsChange(next: ComposerAttachment[]): void
  onSubmit(submission: ComposerSubmission): Promise<void>
  /** 页面是否已准备好接收消息；正文或附件至少有一项时才真正可发送 */
  canSubmit: boolean
  submitHint: string
  chips: ReactNode
  rows?: number
  placeholder?: string
  /** 运行中且输入框为空时，发送按钮变成停止按钮 */
  running?: boolean
  onStop?(): void
  autoFocus?: boolean
  /** 项目文件夹：用于 / 命令和 @ 文件建议 */
  cwd?: string
  /** 显示在发送按钮左边（如上下文占用） */
  meter?: ReactNode
  /** 提示缓存的过期时间；给了就在右上角显示倒计时，并用边框颜色区分缓存是否有效 */
  cacheExpiresAt?: number
  /** 应用自己实现、SDK 里没有的命令，排在命令菜单最前面 */
  extraCommands?: CommandInfo[]
  /** 输入框上方的浮层（命令面板），打开时盖住建议列表 */
  panel?: ReactNode
  /** 应用自己处理的命令（从菜单选中或直接回车）：返回 true 表示已处理，不再作为消息发送 */
  onCommand?(name: string, args: string): boolean
}

export function Composer({
  fast, rainbow,
  sessionState,
  activity,
  sessionId,
  promptSuggestion,
  header,
  queuePanel,
  clearOnSubmit = true,
  submitLabel,
  history = [],
  value,
  onChange,
  attachments,
  onAttachmentsChange,
  onSubmit,
  canSubmit,
  submitHint,
  chips,
  rows = 3,
  placeholder = '描述你的任务，输入 / 使用命令，@ 引用文件',
  running = false,
  onStop,
  autoFocus,
  cwd,
  meter,
  cacheExpiresAt,
  extraCommands,
  panel,
  onCommand
}: ComposerProps) {
  const editor = useRef<EditorHandle>(null)
  const [dismissedSuggestion, setDismissedSuggestion] = useState<string | null>(null)
  useEffect(() => {
    if (promptSuggestion && (value !== '' || attachments.length)) setDismissedSuggestion(promptSuggestion.id)
  }, [promptSuggestion, value, attachments.length])
  const ghost = promptSuggestion && promptSuggestion.id !== dismissedSuggestion && value === '' && !attachments.length && !running && !panel && canSubmit && (sessionState === undefined || sessionState === 'idle') ? promptSuggestion : null
  const historyIndex = useRef(-1)
  const home = useDesk((s) => s.home)
  const fileInput = useRef<HTMLInputElement>(null)
  const cacheMinutes = useCacheMinutes(cacheExpiresAt)
  const cacheWarm = cacheMinutes !== null && cacheMinutes > 0
  // 缓存角标压在边框线上：量出角标宽度，边框在这一段留缺口，角标背后保持透明
  const cacheBadge = useRef<HTMLSpanElement>(null)
  const [cacheGap, setCacheGap] = useState(0)
  useLayoutEffect(() => setCacheGap(cacheBadge.current?.offsetWidth ?? 0), [cacheMinutes])
  const showStop = running && !value.trim() && attachments.length === 0 && onStop
  // 光标前后的文字（文件小组件换成占位符），用来识别 / 命令和 @ 补全
  const [cursor, setCursor] = useState({ text: value, caret: value.length })
  const [dragging, setDragging] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [burst, setBurst] = useState(0)
  const valueRef = useRef(value)
  const attachmentsRef = useRef(attachments)
  valueRef.current = value
  attachmentsRef.current = attachments
  const trigger = findTrigger(cursor.text, cursor.caret)
  const suggest = useSuggestions(trigger, cwd, extraCommands)
  const canSend = canSubmit && Boolean(value.trim() || attachments.length) && !submitting

  const pick = (item: Suggestion): void => {
    if (!trigger) return
    // 应用自己处理的命令：选中即执行，把命令从输入框里拿掉
    const length = cursor.caret - trigger.start
    if (trigger.kind === '/' && !attachments.length && onCommand?.(item.key, '')) {
      editor.current?.replaceBeforeCaret(length, { text: '' })
      return
    }
    // @ 选中的文件插成文件小组件，/ 命令插入命令文字
    if (trigger.kind === '@' && cwd) editor.current?.replaceBeforeCaret(length, { file: `${cwd.replace(/\/$/, '')}/${item.key}` })
    else editor.current?.replaceBeforeCaret(length, { text: item.insert + ' ' })
  }

  const onKey = (e: KeyboardEvent): boolean => {
    if (ghost && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      if (e.key === 'Escape') { setDismissedSuggestion(ghost.id); return true }
      if (e.key === 'Tab') {
        setDismissedSuggestion(ghost.id)
        valueRef.current = ghost.text
        onChange(ghost.text)
        return true
      }
    }
    if (suggest.open) {
      const n = suggest.items.length
      if (e.key === 'Escape') { suggest.dismiss(); return true }
      if (n && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        suggest.setActive(suggest.active < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (suggest.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
        return true
      }
      if (n && suggest.active >= 0 && (e.key === 'Enter' || e.key === 'Tab')) {
        pick(suggest.items[suggest.active])
        return true
      }
    }
    if (!e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !panel && !attachments.length && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (historyIndex.current >= 0 || (e.key === 'ArrowUp' && valueRef.current === '')) {
        const next = e.key === 'ArrowUp' ? Math.min(historyIndex.current + 1, history.length - 1) : historyIndex.current - 1
        if (next >= -1 && history.length) {
          historyIndex.current = next
          const recalled = next < 0 ? '' : history[history.length - 1 - next].text
          valueRef.current = recalled
          onChange(recalled)
          return true
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (canSend) void submit()
      return true
    }
    return false
  }

  const triggerBurst = (): void => setBurst((value) => value + 1)

  const addFiles = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0) return
      setAdding(true)
      try {
        const paths = [...new Set(await Promise.all(files.map(async file => {
          const path = window.desk.files.pathFor(file)
          if (path) return path
          if (!file.type.startsWith('image/')) return ''
          return window.desk.files.saveImage(new Uint8Array(await file.arrayBuffer()), file.type)
        })))].filter(Boolean)
        if (paths.length === 0) return
        const infos = await window.desk.files.describe(paths)
        if (infos.length === 0) return
        const current = attachmentsRef.current
        const next = mergeAttachments(current, infos)
        if (next.length === current.length) return
        attachmentsRef.current = next
        onAttachmentsChange(next)
        triggerBurst()
      } catch {
        // 文件读取失败时保持现有草稿不变
      } finally {
        setAdding(false)
      }
    },
    [onAttachmentsChange]
  )

  // 文件拖过窗口任意位置时都提示可放入当前 Composer；普通文本拖拽保持原生行为
  useEffect(() => {
    let depth = 0
    const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const reset = (): void => {
      depth = 0
      setDragging(false)
    }
    const onDragEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth += 1
      setDragging(true)
    }
    const onDragOver = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDrop = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      reset()
      const items = Array.from(event.dataTransfer?.items ?? [])
      const dropped = items.length
        ? items.flatMap((item) => {
            if (item.kind !== 'file') return []
            const entry = item.webkitGetAsEntry?.()
            if (entry && !entry.isFile) return []
            const file = item.getAsFile()
            return file ? [file] : []
          })
        : Array.from(event.dataTransfer?.files ?? [])
      void addFiles(dropped)
    }
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    window.addEventListener('dragend', reset)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', reset)
    }
  }, [addFiles])

  const submit = async (): Promise<void> => {
    if (!canSend) return
    let command: ReturnType<typeof parseDesktopCommand>
    try {
      command = parseDesktopCommand(value.trim())
      if (command && attachments.length) throw new Error('设置指令不能附带文件，请先移除附件。')
      if (command && !onCommand) throw new Error('不能把设置指令保存到消息队列，请取消编辑后执行。')
      setCommandError(null)
      const cmd = /^\/(\S+)\s*([\s\S]*)$/.exec(value.trim())
      if (cmd && onCommand?.(cmd[1], cmd[2].trim())) {
        valueRef.current = ''
        historyIndex.current = -1
        onChange('')
        return
      }
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      return
    }
    const submission: ComposerSubmission = {
      text: value.trim(),
      prompt: command ? value.trim() : buildPrompt(value, attachments, cwd),
      attachments
    }
    setSubmitting(true)
    try {
      await onSubmit(submission)
      if (!clearOnSubmit) return
      const submittedPaths = new Set(submission.attachments.map((file) => file.path))
      const currentAttachments = attachmentsRef.current
      const remaining = currentAttachments.filter((file) => !submittedPaths.has(file.path))
      if (remaining.length !== currentAttachments.length) {
        attachmentsRef.current = remaining
        onAttachmentsChange(remaining)
      }
      if (valueRef.current.trim() === submission.text) {
        valueRef.current = ''
        historyIndex.current = -1
        onChange('')
      }
    } catch {
      // 调用方负责展示错误；失败时保留正文和附件
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="relative pt-[52px] composer-with-crab [&>*]:pointer-events-auto">
      <ComposerCrab fast={fast} rainbow={rainbow} key={sessionId ?? 'new'} draggable={!sessionId} state={sessionState ?? (running || submitting ? 'running' : 'idle')} activity={activity} hasDraft={Boolean(value.trim() || attachments.length)} queue={queuePanel} />
      {panel}
      {suggest.open && !panel && <SuggestionList status={suggest.status} error={suggest.error} onRetry={suggest.retry} items={suggest.items} active={suggest.active} onPick={pick} onHover={suggest.setActive} />}
      <div data-composer-surface data-ultracode={rainbow || undefined} data-cache={cacheMinutes === null ? undefined : cacheWarm ? 'warm' : 'cold'} style={cacheMinutes === null ? undefined : { '--cache-gap': `${cacheGap}px` } as React.CSSProperties} className={`relative rounded-[20px] border bg-card shadow-card transition-colors ${cacheMinutes === null ? 'border-line-strong focus-within:border-accent/45' : cacheWarm ? 'border-accent/35 focus-within:border-accent/60' : 'border-line-strong focus-within:border-fg3/45'}`}>
        {cacheMinutes !== null && (
          <span ref={cacheBadge} data-cache-badge title={cacheWarm ? `提示缓存约剩 ${cacheMinutes} 分钟，期间发送可命中缓存` : '提示缓存已过期，下一条消息会重新写入缓存'}
            className={`pointer-events-none absolute right-6 top-0 z-20 -translate-y-1/2 px-1.5 font-display text-[13px] italic leading-none tabular-nums ${cacheWarm ? 'text-accent' : 'text-fg3'}`}>
            {cacheMinutes}m
          </span>
        )}
        {header}
        {attachments.length > 0 && (
          <AttachmentRail
            attachments={attachments}
            onRemove={(path) => {
              const next = attachmentsRef.current.filter((file) => file.path !== path)
              attachmentsRef.current = next
              onAttachmentsChange(next)
            }}
          />
        )}
        <ComposerEditor
          onFiles={files => { void addFiles(files) }}
          editorRef={editor}
          value={value}
          rows={rows}
          autoFocus={autoFocus}
          placeholder={ghost ? <span data-prompt-suggestion>{ghost.text}<kbd className="ml-2 rounded border border-line px-1 text-[11px]">Tab 接受</kbd></span> : placeholder}
          cwd={cwd}
          home={home}
          onChange={(next, text, caret) => {
            setCursor({ text, caret })
            if (next === valueRef.current) return
            historyIndex.current = -1
            valueRef.current = next
            onChange(next)
          }}
          onKey={onKey}
        />
        <div className="flex items-center gap-1 px-2.5 pb-2.5">
          <button
            type="button"
            title="添加文件"
            aria-label="添加文件"
            disabled={submitting}
            onClick={() => {
              triggerBurst()
              fileInput.current?.click()
            }}
            className="composer-add-button relative flex size-7 shrink-0 items-center justify-center rounded-full text-fg2 disabled:opacity-40"
          >
            <Plus size={15} />
            {attachments.length > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full bg-accent text-[9px] font-medium leading-none text-accent-fg">
                {attachments.length > 9 ? '9+' : attachments.length}
              </span>
            )}
            {burst > 0 && <span key={burst} className="composer-add-burst" />}
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? [])
              event.currentTarget.value = ''
              void addFiles(files)
            }}
          />
          {/* 窄窗口下选择器折行，不把发送按钮挤出去 */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{chips}</div>
          {meter}
          {showStop ? (
            <button
              type="button"
              title="停止"
              data-composer-action
              aria-label="停止"
              onClick={onStop}
              className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-fg hover:opacity-85"
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              title={submitHint}
              data-composer-action
              aria-label={submitLabel ?? "发送"}
              disabled={!canSend}
              onClick={() => {
                void submit()
              }}
              className={`flex h-8 ${submitLabel ? 'px-3 text-[12px]' : 'w-8'} items-center justify-center rounded-lg bg-accent text-accent-fg transition-opacity hover:opacity-85 disabled:opacity-25`}
            >
              {submitLabel ?? <ArrowUp size={17} strokeWidth={2.2} />}
            </button>
          )}
        </div>
        {dragging && (
          <div
            role="status"
            className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center rounded-[20px] border-2 border-dashed border-accent bg-card/95 text-center backdrop-blur-sm"
          >
            <span className="flex size-9 items-center justify-center rounded-full bg-accent/10 text-accent">
              <FilePlus2 size={18} />
            </span>
            <span className="mt-2 text-[13px] font-medium">松开以添加文件</span>
          </div>
        )}
      </div>
      {commandError && <p role="alert" className="mt-1 text-[12px] text-danger">{commandError}</p>}
      {adding && <div className="pointer-events-none absolute bottom-2 left-11 text-[11px] text-fg3">正在读取文件…</div>}
    </div>
  )
}

function AttachmentRail({
  attachments,
  onRemove
}: {
  attachments: ComposerAttachment[]
  onRemove(path: string): void
}) {
  return (
    <div
      role="list"
      aria-label="已添加文件"
      className="flex gap-2 overflow-x-auto px-3 pb-1 pt-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {attachments.map((file) => (
        <div key={file.path} role="listitem" className="shrink-0">
          <AttachmentCard path={file.path} bytes={file.bytes} onRemove={() => onRemove(file.path)} />
        </div>
      ))}
    </div>
  )
}

function SuggestionList({
  items,
  active,
  onPick,
  onHover,
  status,
  error,
  onRetry
}: {
  status: 'loading' | 'ready' | 'error'
  error?: string
  onRetry(): void
  items: Suggestion[]
  active: number
  onPick(item: Suggestion): void
  onHover(index: number): void
}) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelectorAll('[role="option"]')[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <div
      ref={list}
      className="absolute bottom-full left-0 right-0 z-40 mb-2 max-h-[280px] overflow-y-auto rounded-xl border border-line bg-card p-1 shadow-pop"
    >
      <div role="listbox" aria-label="输入建议">
      {items.map((item, i) => (
        <div
          key={item.key}
          role="option"
          aria-selected={i === active}
          // 用 mousedown 并阻止默认行为，点选时输入框不失去焦点
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(item)
          }}
          onMouseMove={() => i !== active && onHover(i)}
          className={`flex items-baseline gap-2 rounded-lg px-2.5 py-1.5 ${i === active ? 'bg-active' : ''}`}
        >
          <span className="shrink-0 font-mono text-[12.5px]">{item.label}</span>
          {item.hint && <span className="shrink-0 font-mono text-[12px] text-fg3">{item.hint}</span>}
          {item.detail && <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg3">{item.detail}</span>}
        </div>
      ))}
      </div>
      {status === 'loading' && <p role="status" className="px-2.5 py-2 text-[12px] text-fg3">正在加载项目命令…</p>}
      {status === 'error' && <div className="flex items-center justify-between gap-3 px-2.5 py-2 text-[12px] text-fg3"><span role="status" title={error}>项目命令加载失败</span><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onRetry} className="rounded px-2 py-1 text-fg2 hover:bg-active">重试</button></div>}
      {status === 'ready' && items.length === 0 && <p role="status" className="px-2.5 py-2 text-[12px] text-fg3">没有匹配的命令</p>}
    </div>
  )
}

function Chip({ icon, children, onClick, title }: { icon: ReactNode; children: ReactNode; onClick(): void; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-7 max-w-[220px] items-center gap-1.5 rounded-full px-2.5 text-[12.5px] text-fg2 hover:bg-hover hover:text-fg"
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{children}</span>
      <ChevronDown size={12} className="shrink-0 opacity-60" />
    </button>
  )
}

type Placement = 'top' | 'bottom'

export function ProjectChip({ placement = 'top' }: { placement?: Placement }) {
  const { projects, selectedProjectId, home, demo, setDraft, pickProject } = useDesk()
  const current = projects.find((p) => p.id === selectedProjectId)
  return (
    <Menu
      placement={placement}
      width={300}
      defaultOpen={demo?.openMenu === 'project-picker'}
      trigger={({ toggle }) => (
        <Chip icon={<Folder size={13} />} onClick={toggle} title={current?.path}>
          {current?.name ?? '选择项目'}
        </Chip>
      )}
      items={[
        ...projects.map((p) => ({
          key: p.id,
          label: p.name,
          description: shortenPath(p.path, home),
          icon: <Folder size={14} />,
          checked: p.id === selectedProjectId,
          onSelect: () => setDraft({ projectId: p.id })
        })),
        {
          key: 'add',
          label: '添加项目…',
          icon: <FolderPlus size={14} />,
          separatorBefore: projects.length > 0,
          onSelect: () => void pickProject()
        }
      ]}
    />
  )
}

export function PermissionChip({ value, applied, onChange, placement = 'top' }: { value: PermissionMode; applied?: PermissionMode | 'dontAsk'; onChange(v: PermissionMode): void; placement?: Placement }) {
  const { settings, demo } = useDesk()
  const modes = PERMISSION_MODES.filter((m) => m.value !== 'bypassPermissions' || settings?.allowBypass)
  // 当前生效模式不受“是否允许选择”影响，关闭开关不会撤销已有会话权限。
  const mode = applied ?? value
  const label = mode === 'dontAsk' ? '不询问' : PERMISSION_MODES.find(m => m.value === mode)?.label ?? mode
  const requested = PERMISSION_MODES.find(m => m.value === value)?.label ?? value
  const mismatch = mode !== value ? `引擎当前使用「${label}」，已选「${requested}」` : undefined
  return (
    <Menu
      placement={placement}
      width={280}
      defaultOpen={demo?.openMenu === 'permission'}
      trigger={({ toggle }) => (
        <Chip icon={<Shield size={13} />} onClick={toggle} title={mismatch ? `权限模式 · ${mismatch}` : '权限模式'}>
          {label}
        </Chip>
      )}
      items={modes.map((m) => ({
        key: m.value,
        label: m.label,
        description: m.description,
        danger: m.value === 'bypassPermissions',
        checked: m.value === mode,
        onSelect: () => onChange(m.value)
      }))}
      footer={mismatch && <p className="px-2.5 py-2 text-[12px] text-fg2">{mismatch}</p>}
    />
  )
}
