import { useState } from 'react'
import { diffLines } from 'diff'
import { Check, ChevronRight, Circle, CircleCheck, CircleDot, FileText, LoaderCircle, X } from 'lucide-react'
import { useLayout } from '../../layoutStore'
import type { UiBlock } from '@shared/chat'
import { toolFilePath } from '@shared/fileChanges'
import { toolNameZh, toolSummary } from '@shared/format'
import { ToolImagePreview } from './ToolImagePreview'

type ToolBlock = Extract<UiBlock, { kind: 'tool' }>

const OPEN_BY_DEFAULT = new Set(['Edit', 'MultiEdit', 'Write', 'TodoWrite'])

export function ToolCard({ block, running, cwd }: { block: ToolBlock; running: boolean; cwd?: string }) {
  const [open, setOpen] = useState(OPEN_BY_DEFAULT.has(block.name))
  const status = block.result ? (block.result.isError ? 'error' : 'done') : running ? 'running' : 'done'
  const summary = toolSummary(block.name, block.input, cwd)

  const file = toolFilePath(block.name, block.input) ?? ''

  return (
    <div className="group/tool my-2 overflow-hidden rounded-xl border border-line">
      <div className="flex items-center hover:bg-hover">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-[13px]"
        >
          <span className="shrink-0">
            {status === 'running' && <LoaderCircle size={14} className="animate-spin text-fg3" />}
            {status === 'done' && <Check size={14} className="text-fg3" />}
            {status === 'error' && <X size={14} className="text-danger" />}
          </span>
          <span className="shrink-0 font-medium">{toolNameZh(block.name)}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg3">{summary}</span>
          <ChevronRight size={14} className={`shrink-0 text-fg3 transition-transform ${open ? 'rotate-90' : ''}`} />
        </button>
        {file.startsWith('/') && (
          <button
            type="button"
            title="在右栏打开"
            aria-label="在右栏打开"
            onClick={() => useLayout.getState().openFile(file)}
            className="mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-md text-fg3 opacity-0 transition-opacity group-hover/tool:opacity-100 hover:bg-active hover:text-fg"
          >
            <FileText size={13} />
          </button>
        )}
      </div>
      <ToolImagePreview block={block} cwd={cwd} />
      {open && <div className="border-t border-line">{<ToolBody block={block} />}</div>}
    </div>
  )
}

export function ToolBody({ block }: { block: ToolBlock }) {
  const { name, input, result } = block
  const str = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '')

  if (name === 'Edit') return <DiffView before={str('old_string')} after={str('new_string')} />
  if (name === 'MultiEdit' && Array.isArray(input.edits))
    return (
      <>
        {(input.edits as { old_string: string; new_string: string }[]).map((e, i) => (
          <DiffView key={i} before={e.old_string} after={e.new_string} />
        ))}
      </>
    )
  if (name === 'Write') return <DiffView before="" after={str('content')} />
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return <Todos todos={input.todos as Todo[]} />

  return (
    <div className="flex flex-col gap-2 p-3">
      {name === 'Bash' ? (
        <Pre>{'$ ' + str('command')}</Pre>
      ) : (
        <Pre>{JSON.stringify(input, null, 2)}</Pre>
      )}
      {result && <Pre error={result.isError}>{result.text || '（无输出）'}</Pre>}
    </div>
  )
}

function Pre({ children, error }: { children: string; error?: boolean }) {
  return (
    <pre
      className={`max-h-72 overflow-auto rounded-lg bg-chip px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap break-all select-text ${
        error ? 'text-danger' : 'text-fg2'
      }`}
    >
      {children}
    </pre>
  )
}

const MAX_DIFF_LINES = 400

export function DiffView({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after).flatMap((part) =>
    part.value
      .replace(/\n$/, '')
      .split('\n')
      .map((text) => ({ text, kind: part.added ? 'add' : part.removed ? 'del' : 'same' }))
  )
  return (
    <div className="max-h-96 overflow-auto font-mono text-[12px] leading-5 select-text">
      {lines.slice(0, MAX_DIFF_LINES).map((l, i) => (
        <div
          key={i}
          className={`flex px-3 whitespace-pre-wrap break-all ${
            l.kind === 'add' ? 'bg-[#2da44e1f] text-fg' : l.kind === 'del' ? 'bg-[#cf222e1f] text-fg' : 'text-fg2'
          }`}
        >
          <span className="w-4 shrink-0 select-none text-fg3">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}</span>
          <span>{l.text}</span>
        </div>
      ))}
      {lines.length > MAX_DIFF_LINES && <div className="px-3 py-1 text-fg3">…还有 {lines.length - MAX_DIFF_LINES} 行</div>}
    </div>
  )
}

interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

function Todos({ todos }: { todos: Todo[] }) {
  return (
    <ul className="flex flex-col gap-1 p-3">
      {todos.map((t, i) => (
        <li key={i} className={`flex items-start gap-2 ${t.status === 'completed' ? 'text-fg3 line-through' : ''}`}>
          <span className="mt-0.5 shrink-0">
            {t.status === 'completed' ? <CircleCheck size={14} /> : t.status === 'in_progress' ? <CircleDot size={14} /> : <Circle size={14} />}
          </span>
          {t.content}
        </li>
      ))}
    </ul>
  )
}
