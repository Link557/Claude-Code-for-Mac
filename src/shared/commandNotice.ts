/** Presentation only. The original record and its provenance stay intact. */
export function commandNotice(text: string, requireWrapper = false): string | null {
  const wrapped = /^\s*<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>\s*$/.exec(text)
  if (requireWrapper && !wrapped) return null
  const body = (wrapped ? wrapped[2] : text).replace(/\x1b\[[0-9;]*m/g, '').trim()
  const model = /^Set model to\s+(.+)$/i.exec(body)
  if (model && wrapped?.[1] !== 'stderr') {
    const target = model[1].replace(/`/g, '').trim()
      .replace(/^(haiku|sonnet|opus|fable)\b/i, value => value[0].toUpperCase() + value.slice(1).toLowerCase())
      .replace(/\s*\(([^()]*)\)$/, '（$1）')
    return `模型已切换为 ${target}`
  }
  return wrapped ? `${wrapped[1] === 'stderr' ? '命令执行失败' : '命令执行结果'}：${body}` : null
}
