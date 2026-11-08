import { SquareTerminal } from 'lucide-react'
import type { CommandBlock } from '@shared/chat'
import { commandText } from '@shared/commands'
import { commandNotice } from '@shared/commandNotice'
import { CommandNotice } from './CommandNotice'

/** 对话里的本地命令只留一行细记录，点开重新弹出浮层 */
export function CommandRecord({ block, onOpen }: { block: CommandBlock; onOpen(): void }) {
  const notice = block.output ? commandNotice(block.output) : null
  if (notice) return <CommandNotice text={notice} />
  const line = block.output !== null && !block.output.includes('\n') ? block.output : null
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group my-2 flex max-w-full items-center gap-2 rounded-lg px-2 py-1 text-[12.5px] text-fg3 hover:bg-hover hover:text-fg2"
    >
      <SquareTerminal size={13} className="shrink-0" />
      <span className="shrink-0">已运行</span>
      <code className="shrink-0 font-mono text-[12px] text-fg2">{commandText(block.name, block.args)}</code>
      {line && <span className="min-w-0 truncate">· {line.replace(/`/g, '')}</span>}
      <span className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">· 查看</span>
    </button>
  )
}
