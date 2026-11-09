import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionManager } from '../src/main/live/SessionManager'
import { PushQueue } from '../src/main/live/PushQueue'
import { parseDesktopCommand } from '../src/shared/sessionCommand'
const sdk = vi.hoisted(() => ({ query: vi.fn(), getSessionMessages: vi.fn(), config: vi.fn() }))
vi.mock('../src/main/sdk', () => ({ loadSdk: async () => sdk, claudeExecutable: () => undefined }))
vi.mock('../src/main/localCommand', () => ({ runLocalCommand: (...args: unknown[]) => sdk.config(...args) }))
vi.mock('../src/main/store', () => ({ read: () => ({ settings: { allowBypass: false } }) }))
const options = { model: 'opus', mode: 'default' as const, effort: 'high' as const, fastMode: false }
let manager: SessionManager
beforeEach(() => {
  vi.clearAllMocks(); sdk.getSessionMessages.mockResolvedValue([]); sdk.config.mockResolvedValue('Set value')
  sdk.query.mockImplementation(({ options: initial }) => {
    let fast = initial.settings.fastMode, model = initial.model, effort = initial.effort
    const stream = new PushQueue<unknown>()
    return Object.assign(stream, {
      close: () => stream.end(), initializationResult: async () => ({ models: [], commands: [], fast_mode_state: 'off', fast_mode_disabled_reason: 'sdk_opt_in_required' }),
      reinitialize: async () => ({ fast_mode_state: fast ? 'on' : 'off' }),
      setModel: vi.fn(async value => { model = value }),
      setPermissionMode: vi.fn(async () => {}),
      applyFlagSettings: vi.fn(async patch => { if (patch.fastMode !== undefined) fast = patch.fastMode; if (patch.effortLevel !== undefined) effort = patch.effortLevel }),
      request: async () => ({ response: { effective: {}, sources: [], applied: { model, effort } } })
    })
  })
  manager = new SessionManager(vi.fn())
})
afterEach(() => manager.closeAll())
async function start() {
  const id = manager.start('/tmp', 'first', options)
  await manager.prepareControls(id, '/tmp')
  const query = sdk.query.mock.results[0].value
  const input = sdk.query.mock.calls[0][0].prompt[Symbol.asyncIterator]()
  const first = (await input.next()).value
  return { id, query, input, first }
}
it('recognizes bare fast as a panel and rejects malformed controls instead of forwarding', () => {
  expect(parseDesktopCommand('/fast')).toEqual({ kind: 'panel', panel: 'fast' })
  for (const command of ['/fast invalid', '/effort invalid', '/model one two', '/config invalid']) expect(() => parseDesktopCommand(command)).toThrow()
  expect(parseDesktopCommand('/code-review branch')).toBeNull()
})
it('blocks controls at start, history editing, and queue editing without creating prompt records', async () => {
  expect(() => manager.start('/tmp', '/fast', options)).toThrow('设置指令')
  await expect(manager.edit('source', '/tmp', 'at', '/model opus')).rejects.toThrow('设置指令')
  const { id } = await start()
  await manager.send(id, '/tmp', 'pending', options)
  const pending = (await manager.open(id, '/tmp')).queue!.items[0]
  await manager.queueAction(id, '/tmp', { type: 'beginEdit', id: pending.id })
  await expect(manager.queueAction(id, '/tmp', { type: 'edit', id: pending.id, text: '/fast on' })).rejects.toThrow('设置指令')
  expect((await manager.open(id, '/tmp')).queue!.items[0].text).toBe('pending')
})
it('applies config model changes through the same preferences and SDK control as the picker', async () => {
  const { id, query } = await start()
  await manager.send(id, '/tmp', '/config model=haiku', options)
  expect(sdk.config).toHaveBeenCalledWith('/tmp', '/config model=haiku')
  expect(query.setModel).toHaveBeenLastCalledWith('haiku')
  expect((await manager.open(id, '/tmp')).options!.model).toBe('haiku')
  await manager.send(id, '/tmp', '/model opus', options)
  expect(query.setModel).toHaveBeenLastCalledWith('opus')
  expect((await manager.open(id, '/tmp')).messages).toHaveLength(1)
})
it('dispatches queued messages with the latest fast and model choices, not the old snapshot', async () => {
  const { id, query, input, first } = await start()
  await manager.send(id, '/tmp', 'second', options)
  await manager.send(id, '/tmp', '/fast on', options)
  await manager.send(id, '/tmp', '/model haiku', options)
  expect((await manager.open(id, '/tmp')).queue!.items[0].options).toMatchObject({ fastMode: true, model: 'haiku' })
  query.push({ type: 'result', subtype: 'success', is_error: false, duration_ms: 0, user_message_uuid: first.uuid, queued_turn_count: 0 })
  expect((await input.next()).value.message.content).toBe('second')
  const snapshot = await manager.open(id, '/tmp')
  expect(snapshot.options).toMatchObject({ fastMode: true, model: 'haiku' })
  expect(query.applyFlagSettings).not.toHaveBeenCalledWith({ fastMode: false })
})
it('keeps failed config saves and attached controls out of chat', async () => {
  const { id } = await start()
  sdk.config.mockRejectedValueOnce(new Error('write failed'))
  await expect(manager.send(id, '/tmp', '/config model=haiku', options)).rejects.toThrow('write failed')
  await expect(manager.send(id, '/tmp', '/fast on', options, ['/file'])).rejects.toThrow('附带文件')
  await expect(manager.send(id, '/tmp', '/fast', options)).rejects.toThrow('设置面板')
  expect((await manager.open(id, '/tmp')).messages).toHaveLength(1)
  expect((await manager.open(id, '/tmp')).queue!.items).toHaveLength(0)
})

it('waits for auto before submitting the first prompt and lets users retry after fallback', async () => {
  let acknowledge!: () => void
  const createQuery = sdk.query.getMockImplementation()!
  sdk.query.mockImplementationOnce(params => {
    const query = createQuery(params)
    query.setPermissionMode.mockImplementationOnce(() => new Promise<void>(resolve => { acknowledge = resolve }))
    return query
  })
  const starting = manager.start('/tmp', 'first', { ...options, mode: 'auto' }, true)
  await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'))
  const { prompt, options: initial } = sdk.query.mock.calls[0][0]
  const input = prompt[Symbol.asyncIterator]()
  const received = vi.fn()
  const first = input.next().then(received)
  await Promise.resolve()
  expect(received).not.toHaveBeenCalled()
  acknowledge()
  const id = await starting
  await first
  expect(received).toHaveBeenCalledWith(expect.objectContaining({ value: expect.objectContaining({ message: { role: 'user', content: 'first' } }) }))
  const query = sdk.query.mock.results[0].value
  query.push({ type: 'system', subtype: 'status', session_id: 'other', permissionMode: 'default' })
  query.push({ type: 'system', subtype: 'status', session_id: initial.sessionId, permissionMode: 'plan' })
  await vi.waitFor(async () => expect((await manager.open(id, '/tmp')).runtime?.permissionMode).toBe('plan'))
  expect((await manager.open(id, '/tmp')).options?.mode).toBe('auto')
  await manager.setMode(id, 'auto')
  expect(query.setPermissionMode.mock.calls).toEqual([['auto'], ['auto']])
})

it('rejects new and resumed sends without exposing a prompt when auto is denied', async () => {
  const createQuery = sdk.query.getMockImplementation()!
  sdk.query.mockImplementation(params => {
    const query = createQuery(params)
    query.setPermissionMode.mockRejectedValue(new Error('auto blocked by policy'))
    return query
  })
  const auto = { ...options, mode: 'auto' as const }
  await expect(manager.start('/tmp', 'draft', auto, true)).rejects.toThrow('auto blocked by policy')
  await expect(manager.send('restored', '/tmp', 'draft', auto)).rejects.toThrow('auto blocked by policy')
  for (const [params] of sdk.query.mock.calls) {
    expect(await params.prompt[Symbol.asyncIterator]().next()).toMatchObject({ done: true })
  }
  expect((await manager.open('restored', '/tmp')).messages).toEqual([])
})

it('keeps a queued prompt retryable when the restored engine rejects auto', async () => {
  const auto = { ...options, mode: 'auto' as const }
  const id = await manager.start('/tmp', 'first', auto, true)
  const first = sdk.query.mock.results[0].value
  await manager.send(id, '/tmp', 'queued draft', auto)
  first.end()
  await vi.waitFor(async () => expect((await manager.open(id, '/tmp')).live).toBe(false))
  const createQuery = sdk.query.getMockImplementation()!
  sdk.query.mockImplementationOnce(params => {
    const query = createQuery(params)
    query.setPermissionMode.mockRejectedValue(new Error('auto blocked by policy'))
    return query
  })
  await expect(manager.queueAction(id, '/tmp', { type: 'resume' })).rejects.toThrow('auto blocked by policy')
  expect((await manager.open(id, '/tmp')).queue).toMatchObject({ paused: true, items: [{ text: 'queued draft', status: 'failed' }] })
  const prompt = sdk.query.mock.calls.at(-1)![0].prompt
  expect(await prompt[Symbol.asyncIterator]().next()).toMatchObject({ done: true })
})
