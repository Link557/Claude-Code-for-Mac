import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionManager } from '../src/main/live/SessionManager'
import { PushQueue } from '../src/main/live/PushQueue'
import type { SessionRuntimes } from '../src/main/live/SessionRuntimes'

const sdk = vi.hoisted(() => ({ query: vi.fn(), getSessionMessages: vi.fn(), settings: {} as { retainedSessions?: number; sessionIdleMinutes?: number } }))
vi.mock('../src/main/sdk', () => ({ loadSdk: async () => sdk, claudeExecutable: () => undefined }))
vi.mock('../src/main/store', () => ({ read: () => ({ settings: { allowBypass: false, ...sdk.settings } }) }))
const options = { model: null, mode: 'default' as const, effort: null }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function query() {
  const stream = new PushQueue<unknown>()
  return Object.assign(stream, {
    close: vi.fn(() => stream.end()),
    askSideQuestion: vi.fn(async () => ({ response: 'answer' })),
    setModel: vi.fn(async (_model?: string) => {}),
    mcpServerStatus: vi.fn(async () => []),
    supportedCommands: vi.fn(async () => [])
  })
}
let manager: SessionManager
beforeEach(() => {
  sdk.settings = {}
  sdk.query.mockReset().mockImplementation(query)
  sdk.getSessionMessages.mockReset().mockResolvedValue([])
  manager = new SessionManager(() => {})
})
afterEach(() => { manager.closeAll(); vi.useRealTimers() })
async function idleSession(id = 'side') {
  await manager.sideQuestion(id, '/tmp', 'warm up', [], options)
  return sdk.query.mock.results.at(-1)!.value as ReturnType<typeof query>
}
/** 把会话的最后活动时间往前拨，模拟已闲置超过 15 分钟 */
function age(id = 'side') {
  (manager as unknown as { live: SessionRuntimes }).live.get(id)!.lastActive -= 16 * 60_000
}
function fillCapacity() {
  for (let i = 0; i < 4; i++) manager.start('/tmp', 'task', options)
}

it.each(['success', 'failure'] as const)('protects a side question from capacity eviction and releases it after %s', async outcome => {
  const output = await idleSession()
  const answer = deferred<{ response: string }>()
  output.askSideQuestion.mockReturnValueOnce(answer.promise)
  const pending = manager.sideQuestion('side', '/tmp', 'question', [], options)
  const checked = outcome === 'failure' ? expect(pending).rejects.toThrow('failed') : expect(pending).resolves.toBe('done')
  // 同一轮立即施加容量压力，覆盖 ensureLive 返回前的异步间隙。
  fillCapacity()
  expect(output.close).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(output.askSideQuestion).toHaveBeenCalledTimes(2))
  expect((await manager.open('side', '/tmp')).state).toBe('idle')
  if (outcome === 'failure') answer.reject(new Error('failed'))
  else answer.resolve({ response: 'done' })
  await checked
  age()
  manager.start('/tmp', 'one more', options)
  expect(output.close).toHaveBeenCalledOnce()
})

it('keeps the runtime occupied until every concurrent side question finishes', async () => {
  const output = await idleSession()
  const first = deferred<{ response: string }>(), second = deferred<{ response: string }>()
  output.askSideQuestion.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const a = manager.sideQuestion('side', '/tmp', 'first', [], options)
  const b = manager.sideQuestion('side', '/tmp', 'second', [], options)
  fillCapacity()
  first.resolve({ response: 'first' })
  await a
  manager.start('/tmp', 'more pressure', options)
  expect(output.close).not.toHaveBeenCalled()
  second.resolve({ response: 'second' })
  await b
  age()
  manager.start('/tmp', 'reclaim idle', options)
  expect(output.close).toHaveBeenCalledOnce()
})

it('uses updated retention settings on the next sweep and reopens a recycled runtime', async () => {
  manager.closeAll(); vi.useFakeTimers(); manager = new SessionManager(() => {})
  sdk.settings = { retainedSessions: 6, sessionIdleMinutes: 30 }
  const outputs=[]
  for(let i=0;i<6;i++) outputs.push(await idleSession(`s-${i}`))
  await vi.advanceTimersByTimeAsync(16*60_000)
  sdk.settings.retainedSessions=4
  await vi.advanceTimersByTimeAsync(60_000)
  expect(outputs.every(q=>q.close.mock.calls.length===0)).toBe(true)
  await vi.advanceTimersByTimeAsync(14*60_000)
  expect(outputs[0].close).toHaveBeenCalledOnce()
  expect(outputs[1].close).toHaveBeenCalledOnce()
  expect(outputs.slice(2).every(q=>q.close.mock.calls.length===0)).toBe(true)
  expect((await manager.open('s-0','/tmp')).live).toBe(false)
  await manager.sideQuestion('s-0','/tmp','continue',[],options)
  expect((await manager.open('s-0','/tmp')).live).toBe(true)
})
it('supports a shorter configured idle threshold without turning the limit into a hard cap', async () => {
  manager.closeAll(); vi.useFakeTimers(); manager = new SessionManager(() => {})
  sdk.settings = { retainedSessions: 1, sessionIdleMinutes: 5 }
  const old=await idleSession('old');await idleSession('recent')
  await vi.advanceTimersByTimeAsync(4*60_000)
  expect(old.close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2*60_000)
  expect(old.close).toHaveBeenCalledOnce()
})

it('protects concurrent restorations before their callers receive the created runtimes', async () => {
  const answer = deferred<{ response: string }>()
  sdk.query.mockImplementation(() => {
    const output = query()
    output.askSideQuestion.mockReturnValue(answer.promise)
    return output
  })
  const requests = Array.from({ length: 6 }, (_, i) => manager.sideQuestion(`side-${i}`, '/tmp', 'question', [], options))
  const all = Promise.all(requests)
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(6))
  for (const result of sdk.query.mock.results) expect(result.value.close).not.toHaveBeenCalled()
  answer.resolve({ response: 'done' })
  expect(await all).toEqual(Array(6).fill('done'))
})

it('does not sweep an occupied runtime and measures idle time from completion', async () => {
  manager.closeAll()
  vi.useFakeTimers()
  manager = new SessionManager(() => {})
  const output = await idleSession()
  const answer = deferred<{ response: string }>()
  output.askSideQuestion.mockReturnValueOnce(answer.promise)
  const pending = manager.sideQuestion('side', '/tmp', 'long question', [], options)
  fillCapacity()
  await vi.advanceTimersByTimeAsync(16 * 60_000)
  expect(output.close).not.toHaveBeenCalled()
  answer.resolve({ response: 'done' })
  await pending
  await vi.advanceTimersByTimeAsync(14 * 60_000)
  expect(output.close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2 * 60_000)
  expect(output.close).toHaveBeenCalledOnce()
})

it('keeps idle sessions while within the limit, however long they idle', async () => {
  manager.closeAll()
  vi.useFakeTimers()
  manager = new SessionManager(() => {})
  const output = await idleSession()
  for (let i = 0; i < 3; i++) manager.start('/tmp', 'task', options)
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(output.close).not.toHaveBeenCalled()
})

it('lets a fifth session open without closing a recently idle one, then reclaims it after 15 minutes', async () => {
  manager.closeAll()
  vi.useFakeTimers()
  manager = new SessionManager(() => {})
  const output = await idleSession()
  fillCapacity()
  expect(output.close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(14 * 60_000)
  expect(output.close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2 * 60_000)
  expect(output.close).toHaveBeenCalledOnce()
})

it('does not release a replacement runtime when an old request completes after reload', async () => {
  const old = await idleSession()
  const oldAnswer = deferred<{ response: string }>()
  old.askSideQuestion.mockReturnValueOnce(oldAnswer.promise)
  const oldRequest = manager.sideQuestion('side', '/tmp', 'old', [], options)
  await vi.waitFor(() => expect(old.askSideQuestion).toHaveBeenCalledTimes(2))
  await manager.reload('side', '/tmp')
  expect(old.close).toHaveBeenCalledOnce()
  const replacement = await idleSession()
  const newAnswer = deferred<{ response: string }>()
  replacement.askSideQuestion.mockReturnValueOnce(newAnswer.promise)
  const newRequest = manager.sideQuestion('side', '/tmp', 'new', [], options)
  oldAnswer.resolve({ response: 'late' })
  await oldRequest
  fillCapacity()
  expect(replacement.close).not.toHaveBeenCalled()
  newAnswer.resolve({ response: 'done' })
  await newRequest
  age()
  manager.start('/tmp', 'reclaim idle', options)
  expect(replacement.close).toHaveBeenCalledOnce()
})

it('still closes occupied runtimes explicitly during shutdown', async () => {
  const output = await idleSession()
  const answer = deferred<{ response: string }>()
  output.askSideQuestion.mockReturnValueOnce(answer.promise)
  const pending = manager.sideQuestion('side', '/tmp', 'question', [], options)
  await vi.waitFor(() => expect(output.askSideQuestion).toHaveBeenCalledTimes(2))
  manager.closeAll()
  expect(output.close).toHaveBeenCalledOnce()
  answer.resolve({ response: 'late' })
  await pending
  expect((await manager.open('side', '/tmp')).live).toBe(false)
})

it.each(['commands', 'mcp'] as const)('protects an in-flight %s read using the same occupancy rules', async kind => {
  const output = await idleSession()
  const result = deferred<[]>()
  if (kind === 'commands') output.supportedCommands.mockReturnValueOnce(result.promise)
  else output.mcpServerStatus.mockReturnValueOnce(result.promise)
  const pending = kind === 'commands' ? manager.commandsFor('/tmp')! : manager.mcp('side', '/tmp')
  fillCapacity()
  expect(output.close).not.toHaveBeenCalled()
  result.resolve([])
  await pending
  age()
  manager.start('/tmp', 'reclaim idle', options)
  expect(output.close).toHaveBeenCalledOnce()
})

it('protects an idle session while a configuration command awaits SDK confirmation', async () => {
  const output = await idleSession()
  const confirmation = deferred<void>()
  output.setModel.mockReturnValueOnce(confirmation.promise)
  const changing = manager.setModel('side', 'sonnet')
  await vi.waitFor(() => expect(output.setModel).toHaveBeenCalledOnce())
  fillCapacity()
  expect(output.close).not.toHaveBeenCalled()
  confirmation.resolve()
  await changing
  age()
  manager.start('/tmp', 'reclaim idle', options)
  expect(output.close).toHaveBeenCalledOnce()
})
