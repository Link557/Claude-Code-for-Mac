import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { PushQueue } from './live/PushQueue'

const active = new Set<AbortController>()
export function closeTemporaryQueries(): void {
  for (const controller of active) controller.abort()
}

/** 临时 SDK 查询的唯一生命周期所有者，不等待输出流自然结束。 */
export async function temporaryQuery<T>(
  create: (controller: AbortController, input: PushQueue<SDKUserMessage>) => Promise<Query>,
  read: (query: Query, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const controller = new AbortController()
  const input = new PushQueue<SDKUserMessage>()
  active.add(controller)
  const cancel = (): void => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  let timer: ReturnType<typeof setTimeout> | undefined
  let query: Query | undefined
  const cancelled = new Promise<never>((_, reject) => {
    const fail = (): void => reject(new Error('临时查询已取消'))
    if (controller.signal.aborted) fail()
    else controller.signal.addEventListener('abort', fail, { once: true })
    timer = setTimeout(() => { reject(new Error('临时查询超时')); cancel() }, 15_000)
  })
  try {
    const creating = (async () => {
      if (controller.signal.aborted) throw new Error('临时查询已取消')
      const created = await create(controller, input)
      // 即使工厂没有响应取消，也不能泄漏迟到的查询。
      if (controller.signal.aborted) { created.close(); throw new Error('临时查询已取消') }
      query = created
      return created
    })()
    query = await Promise.race([creating, cancelled])
    return await Promise.race([read(query, controller.signal), cancelled])
  } finally {
    active.delete(controller)
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    input.end()
    try { query?.close() } finally { controller.abort() }
  }
}
