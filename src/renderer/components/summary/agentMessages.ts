import type { UiBlock, UiMessage } from '@shared/chat'

/** 同一文本保留较完整的前缀扩展，终态优先磁盘；不引入主会话或其他 Agent 的内容。 */
export function agentMessages(history: UiMessage[], live: UiMessage[], toolUseId: string, running = true): UiMessage[] {
  const key = (message: UiMessage): string => {
    if (message.parentToolUseId) {
      try { const scoped = JSON.parse(message.id); if (Array.isArray(scoped) && scoped.length === 2) return String(scoped[1]) } catch { /* 旧快照可能使用未加作用域的 ID。 */ }
    }
    return message.id
  }
  const merge = (disk: UiMessage, current: UiMessage): UiMessage => {
    const blocks: UiBlock[] = []
    for (let i = 0; i < Math.max(disk.blocks.length, current.blocks.length); i++) {
      const old = disk.blocks[i]; const next = current.blocks[i]
      if (!old || !next) { blocks.push(old ?? next); continue }
      if ((old.kind === 'text' && next.kind === 'text') || (old.kind === 'thinking' && next.kind === 'thinking')) {
        blocks.push(old.text.startsWith(next.text) ? old : next.text.startsWith(old.text) ? next : running ? next : old)
      } else if (old.kind === 'tool' && next.kind === 'tool' && old.id === next.id) {
        blocks.push({ ...(running ? next : old), input: running ? { ...old.input, ...next.input } : old.input, result: running ? next.result ?? old.result : old.result ?? next.result })
      } else blocks.push(running ? next : old)
    }
    return { ...(running ? current : disk), blocks }
  }
  const messages = new Map(history.map(message => [key(message), message]))
  for (const message of live) if (message.parentToolUseId === toolUseId) {
    const id = key(message)
    const disk = messages.get(id)
    messages.set(id, disk ? merge(disk, message) : message)
  }
  return [...messages.values()]
}
