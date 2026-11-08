import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionManager } from '../src/main/live/SessionManager'
import { LiveSession } from '../src/main/live/LiveSession'
import { Transcript } from '../src/main/transcript'
import { PushQueue } from '../src/main/live/PushQueue'
import { list } from '../src/main/sessions'

const sdk = vi.hoisted(() => ({ query: vi.fn(), getSessionMessages: vi.fn(), listSessions: vi.fn(), load: vi.fn() }))
vi.mock('../src/main/sdk', () => ({ loadSdk: () => sdk.load(), claudeExecutable: () => undefined, withIdleQuery: vi.fn() }))
const saved = vi.hoisted(() => ({ settings: { allowBypass: false }, archived: {}, sessionEdits: {} as Record<string, string[]> }))
vi.mock('../src/main/store', () => ({ read: () => saved, update: (change: (data: typeof saved) => void) => change(saved) }))
const options = { model: null, mode: 'default' as const, effort: null }
let manager: SessionManager
const emit = vi.fn()
function liveQuery() {
  const stream = new PushQueue<unknown>()
  return Object.assign(stream, { close: vi.fn(() => stream.end()), interrupt: vi.fn().mockResolvedValue(undefined) })
}
beforeEach(() => {
  vi.clearAllMocks()
  saved.sessionEdits = {}
  sdk.load.mockImplementation(async () => sdk)
  sdk.getSessionMessages.mockResolvedValue([])
  sdk.query.mockImplementation(liveQuery)
  manager = new SessionManager(emit)
})
afterEach(() => manager.closeAll())
it('hands off persisted idle history and incorporates CLI additions before the next desktop send', async () => {
  const original = { type: 'user', uuid: 'first', origin: { kind: 'human' }, message: { content: 'from CLI' } }
  sdk.getSessionMessages.mockResolvedValue([original])
  await manager.open('shared', '/tmp')
  expect(await manager.handoffToCli('shared', '/tmp')).toBe('shared')
  expect((await manager.open('shared', '/tmp')).live).toBe(false)
  sdk.getSessionMessages.mockResolvedValue([original, { type: 'user', uuid: 'second', origin: { kind: 'human' }, message: { content: 'CLI continued' } }])
  await manager.send('shared', '/tmp', 'back in desktop', options)
  expect((await manager.open('shared', '/tmp')).messages.some(m => m.blocks.some(b => b.kind === 'text' && b.text === 'CLI continued'))).toBe(true)
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(1))
  expect(sdk.query.mock.calls[0][0].options.resume).toBe('shared')
})
it('does not hand off running or unsaved sessions', async () => {
  await expect(manager.handoffToCli('unsaved', '/tmp')).rejects.toThrow('尚未保存')
  const id = manager.start('/tmp', 'working', options)
  await expect(manager.handoffToCli(id, '/tmp')).rejects.toThrow('等待当前任务')
})
it('recreates the SDK query after a stream error and consumes the retry', async () => {
  sdk.query.mockImplementationOnce(() => ({ close: vi.fn(), async *[Symbol.asyncIterator]() { throw new Error('process exited') } }))
  const id = manager.start('/tmp', 'first', options)
  await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(id, expect.objectContaining({ kind: 'state', state: 'error' })))
  expect((await manager.open(id, '/tmp')).live).toBe(false)
  await manager.send(id, '/tmp', 'retry', options)
  await manager.queueAction(id, '/tmp', { type: 'resume' })
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(2))
  const init = sdk.query.mock.calls[1][0]
  expect(init.options.resume).toBe(id)
  const item = await init.prompt[Symbol.asyncIterator]().next()
  expect(item.value.message.content).toBe('retry')
  expect((await manager.open(id, '/tmp')).live).toBe(true)
})
it('removes a stream that exits without a result instead of leaving running state', async () => {
  sdk.query.mockImplementationOnce(() => ({ close: vi.fn(), async *[Symbol.asyncIterator]() {} }))
  const id = manager.start('/tmp', 'first', options)
  await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(id, expect.objectContaining({ kind: 'state', state: 'error' })))
  expect((await manager.open(id, '/tmp')).live).toBe(false)
})
it('settles waiting side questions when the SDK query constructor throws', async () => {
  sdk.query.mockImplementationOnce(() => { throw new Error('invalid executable') })
  await expect(manager.sideQuestion('existing', '/tmp', 'question', [], options)).rejects.toThrow('invalid executable')
  expect((await manager.open('existing', '/tmp')).live).toBe(false)
})
it('cancels a session closed before SDK loading completes', async () => {
  let resolve!: (value: typeof sdk) => void
  sdk.load.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
  const onClosed = vi.fn()
  const session = new LiveSession({ sessionId: 'delayed', cwd: '/tmp', resume: false, options, transcript: new Transcript(), emit, onClosed })
  const start = session.start()
  const pending = session.mcpStatus()
  session.close()
  await expect(pending).rejects.toThrow('会话已关闭')
  resolve(sdk)
  await start
  session.close()
  expect(sdk.query).not.toHaveBeenCalled()
  expect(onClosed).toHaveBeenCalledTimes(1)
})
it('shares one replacement instance between concurrent retries', async () => {
  await Promise.all([manager.send('existing', '/tmp', 'one', options), manager.send('existing', '/tmp', 'two', options)])
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(1))
  expect((await manager.open('existing', '/tmp')).messages).toHaveLength(1)
  expect((await manager.open('existing', '/tmp')).queue?.items).toHaveLength(1)
})
it('late termination of an old query does not delete its replacement', async () => {
  let finish!: () => void
  const wait = new Promise<void>((resolve) => { finish = resolve })
  sdk.query.mockImplementationOnce(() => ({ close: vi.fn(), async *[Symbol.asyncIterator]() { await wait } }))
  const id = manager.start('/tmp', 'first', options)
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(1))
  await manager.reload(id, '/tmp')
  await manager.send(id, '/tmp', 'retry', options)
  finish()
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(2))
  expect((await manager.open(id, '/tmp')).live).toBe(true)
})

it('includes historical activity in snapshots and marks incomplete history', async () => {
  sdk.getSessionMessages.mockResolvedValue([
    { type: 'assistant', message: { id: 'history', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/tmp/source.md' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'text' }] } }
  ])
  const snapshot = await manager.open('history', '/tmp')
  expect(snapshot.summary?.sections.sources).toEqual([expect.objectContaining({ path: '/tmp/source.md', description: '调用 1 次 · 成功 1' })])
  expect(snapshot.summary?.historyIncomplete).toBe(true)
})
it('emits and persists live summary changes, including SDK directory hooks', async () => {
  manager.closeAll()
  const save = vi.fn()
  manager = new SessionManager(emit, { load: () => undefined, save })
  const id = manager.start('/tmp', 'Read sources', options)
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(1))
  const query = sdk.query.mock.results[0].value
  query.push({ type: 'assistant', message: { id: 'live', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/tmp/live.md' } }] } })
  query.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'text' }] } })
  const hooks = sdk.query.mock.calls[0][0].options.hooks
  await hooks.DirectoryAdded[0].hooks[0]({ hook_event_name: 'DirectoryAdded', directory: '/other' })
  await hooks.CwdChanged[0].hooks[0]({ hook_event_name: 'CwdChanged', new_cwd: '/other/subdir' })
  await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(id, expect.objectContaining({ kind: 'summary', summary: expect.objectContaining({ sections: expect.objectContaining({ sources: [expect.objectContaining({ path: '/tmp/live.md' })] }) }) })))
  expect(save).toHaveBeenCalledWith(id, expect.objectContaining({ version: 1, tools: [expect.objectContaining({ id: 'read' })] }))
  expect((await manager.open(id, '/tmp')).summary?.sections.projects.map((p) => p.path)).toEqual(['/tmp', '/other', '/other/subdir'])
})

it('requests summarized thinking for new, resumed and forked queries without changing model or effort', async () => {
  manager.start('/tmp', 'new', options)
  await manager.send('resumed', '/tmp', 'continue', options)
  sdk.getSessionMessages.mockResolvedValue([
    { type: 'assistant', uuid: 'at', message: { id: 'reply', content: [{ type: 'text', text: 'kept' }] } },
    { type: 'user', uuid: 'target', origin: { kind: 'human' }, message: { content: 'old' } }
  ])
  await manager.edit('source', '/tmp', 'target', 'edited')
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(3))
  for (const [request] of sdk.query.mock.calls) {
    expect(request.options.extraArgs).toEqual({ 'thinking-display': 'summarized', 'replay-user-messages': null })
    expect(request.options.includePartialMessages).toBe(true)
    expect(request.options.thinking).toBeUndefined()
    expect(request.options.effort).toBeUndefined()
  }
  expect(sdk.query.mock.calls[1][0].options.resume).toBe('resumed')
  expect(sdk.query.mock.calls[2][0].options).toMatchObject({ resume: 'source', resumeSessionAt: 'at', forkSession: true })
})
it('publishes current activity in events and snapshots and clears it after interruption', async () => {
  const id = manager.start('/tmp', 'think', options)
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(1))
  const query = sdk.query.mock.results[0].value
  query.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm' } } })
  query.push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } })
  await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(id, expect.objectContaining({ kind: 'activity', activity: expect.objectContaining({ phase: 'thinking' }) })))
  expect((await manager.open(id, '/tmp')).activity?.phase).toBe('thinking')
  await manager.interrupt(id)
  expect((await manager.open(id, '/tmp')).activity?.phase).toBe('stopping')
  query.push({ type: 'result', subtype: 'error_during_execution', duration_ms: 10 })
  await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(id, expect.objectContaining({ kind: 'state', state: 'idle' })))
  expect((await manager.open(id, '/tmp')).activity?.phase).toBe('idle')
})

it('reuses live command lists only for the same executable configuration and forwards updates', async () => {
  manager.closeAll()
  let configuration = 'sdk-a'
  const publish = vi.fn()
  manager = new SessionManager(emit, undefined, { configuration: () => configuration, publisher: () => publish })
  let initialize!: (value: unknown) => void
  const query = Object.assign(liveQuery(), { initializationResult: () => new Promise(resolve => { initialize = resolve }), supportedCommands: vi.fn().mockResolvedValue([{ name: 'latest', description: '', argumentHint: '' }]) })
  sdk.query.mockReturnValue(query)
  manager.start('/tmp', 'question', options)
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledOnce())
  query.push({ type: 'system', subtype: 'commands_changed', commands: [{ name: 'latest', description: '', argumentHint: '' }] })
  await vi.waitFor(() => expect(publish).toHaveBeenCalledWith([{ name: 'latest', description: '', argumentHint: '' }]))
  initialize({ commands: [{ name: 'old', description: '', argumentHint: '' }] })
  await Promise.resolve()
  expect(publish).toHaveBeenCalledTimes(1)
  await expect(manager.commandsFor('/tmp', 'sdk-a')).resolves.toEqual([{ name: 'latest', description: '', argumentHint: '' }])
  configuration = 'sdk-b'
  expect(manager.commandsFor('/tmp', configuration)).toBeUndefined()
})

it('keeps plan approval pending until its permission mode is accepted', async () => {
  const setPermissionMode = vi.fn().mockRejectedValueOnce(new Error('mode rejected')).mockResolvedValue(undefined)
  const query = Object.assign(liveQuery(), { setPermissionMode })
  sdk.query.mockReturnValue(query)
  const id = manager.start('/tmp', 'plan', options)
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledOnce())
  const canUseTool = sdk.query.mock.calls[0][0].options.canUseTool
  const decision = canUseTool('ExitPlanMode', {}, { requestId: 'approval', toolUseID: 'tool', signal: new AbortController().signal })
  await expect(manager.respond(id, 'approval', { type: 'planApprove', mode: 'acceptEdits' })).rejects.toThrow('mode rejected')
  expect((await manager.open(id, '/tmp')).approvals).toHaveLength(1)
  expect(emit).not.toHaveBeenCalledWith(id, expect.objectContaining({ kind: 'approvalDone', requestId: 'approval' }))
  await manager.respond(id, 'approval', { type: 'planApprove', mode: 'acceptEdits' })
  await expect(decision).resolves.toMatchObject({ behavior: 'allow' })
  expect((await manager.open(id, '/tmp')).approvals).toHaveLength(0)
})

it('uses the same human UUID for UI and SDK, deduplicates echoes and retains queued human text', async () => {
  const original = '  <system-reminder>真人输入</system-reminder>  '
  const id = manager.start('/tmp', original, options)
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledOnce())
  const input = sdk.query.mock.calls[0][0].prompt[Symbol.asyncIterator]()
  const first = (await input.next()).value
  expect(first).toMatchObject({ origin: { kind: 'human' }, message: { content: original } })
  expect((await manager.open(id, '/tmp')).messages[0]).toMatchObject({ id: first.uuid, uuid: first.uuid, source: 'human' })
  const query = sdk.query.mock.results[0].value
  query.push({ ...first, is_meta: true, message: { content: 'expanded by CLI' } })
  query.push({ type: 'assistant', uuid: 'answer', message: { id: 'answer', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: {} }] } })
  await manager.send(id, '/tmp', '追加真人消息', options)
  const queued = (await manager.open(id, '/tmp')).queue!.items[0]
  await manager.queueAction(id, '/tmp', { type: 'insert', id: queued.id })
  const second = (await input.next()).value
  query.push({ ...second, message: { content: 'another expansion' } })
  query.push({ type: 'user', uuid: 'tool-result', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'done' }, { type: 'text', text: '图片说明' }] } })
  query.push(first)
  await vi.waitFor(async () => {
    const snapshot = await manager.open(id, '/tmp')
    expect(snapshot.messages.find(m => m.id === 'tool-result')).toMatchObject({ source: 'internal', startsTurn: false })
    expect(snapshot.messages.filter(m => m.source === 'human').map(m => m.blocks)).toEqual([[{ kind: 'text', text: original }], [{ kind: 'text', text: '追加真人消息' }]])
  })
})

it('keeps prior submissions and reloads the edited history through the same session', async () => {
  manager.closeAll()
  const records = new Map<string, import('../src/main/humanSubmissionRepository').HumanSubmission[]>()
  manager = new SessionManager(emit, undefined, undefined, {
    load: id => structuredClone(records.get(id) ?? []),
    save: (id, rows) => { records.set(id, structuredClone(rows)) }
  })
  const id = manager.start('/tmp', '<local-command-stdout>原文</local-command-stdout>', options)
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledOnce())
  const first = (await sdk.query.mock.calls[0][0].prompt[Symbol.asyncIterator]().next()).value
  await manager.send(id, '/tmp', '后续输入', options)
  const queued = (await manager.open(id, '/tmp')).queue!.items[0]
  await manager.queueAction(id, '/tmp', { type: 'insert', id: queued.id })
  const second = records.get(id)![1]
  sdk.getSessionMessages.mockResolvedValue([
    { ...first, is_meta: true, message: { content: 'expanded first' } },
    { type: 'assistant', uuid: 'fork-point', message: { id: 'reply', content: [{ type: 'text', text: 'reply' }] } },
    { type: 'user', uuid: second.uuid, message: { content: 'expanded second' } }
  ])
  const restored = await manager.reload(id, '/tmp')
  expect(restored.messages.filter(m => m.source === 'human').map(m => m.blocks)).toEqual([
    [{ kind: 'text', text: first.message.content }], [{ kind: 'text', text: '后续输入' }]
  ])
  await manager.edit(id, '/tmp', second.uuid, '修改后的输入')
  const replacementId = saved.sessionEdits[id][0]
  expect(replacementId).not.toBe(id)
  expect(records.get(replacementId)!.map(s => s.text)).toEqual([first.message.content, '修改后的输入'])
  expect((await manager.open(id, '/tmp')).messages.filter(m => m.source === 'human').map(m => m.blocks)).toEqual([
    [{ kind: 'text', text: first.message.content }], [{ kind: 'text', text: '修改后的输入' }]
  ])
  expect(records.get(id)!.map(s => s.text)).toEqual([first.message.content, '后续输入'])
  const rewritten = records.get(replacementId)!.at(-1)!
  sdk.getSessionMessages.mockImplementation(async historyId => historyId === replacementId ? [
    { ...first, message: { content: 'expanded first' } },
    { type: 'user', uuid: rewritten.uuid, message: { content: 'expanded edit' } }
  ] : [])
  await manager.reload(id, '/tmp')
  expect(sdk.getSessionMessages).toHaveBeenLastCalledWith(replacementId, { dir: '/tmp' })
  await manager.send(id, '/tmp', 'continue', options)
  expect(sdk.query.mock.lastCall![0].options.resume).toBe(replacementId)
})

it('edits the first message without adding a sidebar entry and keeps the existing title', async () => {
  sdk.getSessionMessages.mockResolvedValue([
    { type: 'user', uuid: 'first', origin: { kind: 'human' }, message: { content: 'old' } },
    { type: 'assistant', uuid: 'second', message: { id: 'reply', content: [{ type: 'text', text: 'old reply' }] } }
  ])
  await manager.edit('source', '/tmp', 'first', 'new first')
  const replacementId = saved.sessionEdits.source[0]
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledOnce())
  expect(sdk.query.mock.lastCall![0].options).toMatchObject({ sessionId: replacementId })
  expect(sdk.query.mock.lastCall![0].options.resume).toBeUndefined()
  expect((await manager.open('source', '/tmp')).messages).toMatchObject([{ role: 'user', blocks: [{ kind: 'text', text: 'new first' }] }])

  sdk.listSessions.mockResolvedValue([
    { sessionId: 'source', customTitle: 'My title', lastModified: 1 },
    { sessionId: replacementId, firstPrompt: 'new first', lastModified: 2 },
    { sessionId: 'independent', firstPrompt: 'other chat', lastModified: 3 }
  ])
  expect(await list('/tmp')).toMatchObject([{ id: 'independent' }, { id: 'source', title: 'My title', lastModified: 2 }])
  expect(emit.mock.calls.every(([id]) => id === 'source')).toBe(true)
})

it.each([
  { stop: false, reason: 'turn_setup_failed', matching: true, stopped: false },
  { stop: true, reason: 'api_error', matching: true, stopped: false },
  { stop: true, reason: 'aborted_tools', matching: false, stopped: false },
  { stop: true, reason: 'aborted_streaming', matching: true, stopped: true }
])('preserves execution errors and requires correlated abort evidence: %j', async ({ stop, reason, matching, stopped }) => {
  const id = manager.start('/tmp', 'work', options)
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledOnce())
  const input = (await sdk.query.mock.calls[0][0].prompt[Symbol.asyncIterator]().next()).value
  if (stop) await manager.interrupt(id)
  sdk.query.mock.results[0].value.push({ type: 'result', subtype: 'error_during_execution', uuid: 'failure', duration_ms: 10, errors: ['diagnostic detail'], terminal_reason: reason, user_message_uuid: matching ? input.uuid : 'unrelated' })
  await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(id, expect.objectContaining({
    kind: 'result', error: stopped ? null : expect.stringContaining('diagnostic detail'),
    diagnostic: expect.objectContaining({ terminalReason: reason, userStopped: stopped, errors: ['diagnostic detail'] })
  })))
})
