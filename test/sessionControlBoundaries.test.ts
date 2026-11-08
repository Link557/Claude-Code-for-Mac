import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionManager } from '../src/main/live/SessionManager'
import { PushQueue } from '../src/main/live/PushQueue'

const sdk = vi.hoisted(() => ({ query: vi.fn(), getSessionMessages: vi.fn(), output: vi.fn() }))
vi.mock('../src/main/sdk', () => ({ loadSdk: async () => sdk, claudeExecutable: () => undefined }))
vi.mock('../src/main/store', () => ({ read: () => ({ settings: { allowBypass: false } }) }))
const options = { model: 'opus', mode: 'default' as const, effort: 'high' as const }
let manager: SessionManager
function query() {
  const stream = new PushQueue<unknown>()
  return Object.assign(stream, {
    close: vi.fn(() => stream.end()),
    initializationResult: async () => ({ commands: [], models: [] }),
    reinitialize: vi.fn(async () => ({ fast_mode_state: 'off' })),
    stopTask: vi.fn(async () => {}),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    request: vi.fn(async (request: { subtype: string }) => {
      if (request.subtype === 'get_task_output') return sdk.output()
      if (request.subtype === 'list_permission_rules') return { state: { rules: [], managedOnly: false } }
      return { response: { effective: {}, sources: [], applied: { model: 'opus', effort: 'high' } } }
    })
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  sdk.query.mockImplementation(query)
  sdk.getSessionMessages.mockResolvedValue([])
  sdk.output.mockResolvedValue({ output: 'log', truncated: false })
  manager = new SessionManager(() => {})
})
afterEach(() => manager.closeAll())
async function idle() {
  const id = manager.start('/tmp', 'synthetic', options)
  await manager.prepareControls(id, '/tmp')
  const q = sdk.query.mock.results[0].value as ReturnType<typeof query>
  q.push({ type: 'result', subtype: 'success', uuid: 'result', result: 'done', is_error: false, duration_ms: 1, queued_turn_count: 0 })
  await vi.waitFor(async () => expect((await manager.open(id, '/tmp')).state).toBe('idle'))
  return { id, q }
}
async function background(id: string, q: ReturnType<typeof query>) {
  q.push({ type: 'system', subtype: 'task_started', task_id: 'agent', run_id: 'b', task_type: 'local_agent', is_backgrounded: true, description: 'current run' })
  await vi.waitFor(() => expect(manager.isBusy(id)).toBe(true))
}

it.each(['reload', 'rewind', 'restore'] as const)('protects background tasks during %s even when the foreground is idle', async operation => {
  const { id, q } = await idle()
  await background(id, q)
  const action = operation === 'reload' ? manager.reloadConfiguration(id, '/tmp')
    : operation === 'rewind' ? manager.rewindFiles(id, '/tmp', 'checkpoint')
      : manager.restoreConversation(id, '/tmp', 'message')
  await expect(action).rejects.toThrow('后台任务')
  expect(q.close).not.toHaveBeenCalled()
  expect(q.rewindFiles).not.toHaveBeenCalled()
  expect(sdk.query).toHaveBeenCalledOnce()
})

it('uses the same run version for the task pane, summary and busy policy', async () => {
  const { id, q } = await idle()
  await background(id, q)
  // 摘要只接受有证据的子 Agent 关联；未关联任务仍由 busy policy 跟踪。
  q.push({ type: 'system', subtype: 'task_progress', task_id: 'agent', run_id: 'b', tool_use_id: 'agent-tool', task_type: 'local_agent' })
  q.push({ type: 'system', subtype: 'task_notification', task_id: 'agent', run_id: 'a', status: 'completed', summary: 'stale result' })
  // A following read waits until this marker has been consumed, without sleeping for a guessed interval.
  q.push({ type: 'system', subtype: 'task_progress', task_id: 'agent', run_id: 'b', description: 'marker' })
  await vi.waitFor(async () => expect((await manager.open(id, '/tmp')).tasks?.[0].description).toBe('marker'))
  const snapshot = await manager.open(id, '/tmp')
  expect(snapshot.tasks?.[0].status).toBe('running')
  expect(snapshot.summary?.sections.agents[0].status).toBe('running')
  expect(manager.isBusy(id)).toBe(true)
})

it('lets approval replies and task stops complete while an output read is stalled', async () => {
  const { id, q } = await idle()
  let release!: (value: unknown) => void
  sdk.output.mockReturnValue(new Promise(resolve => { release = resolve }))
  const reading = manager.taskOutput(id, '/tmp', 'shell')
  try {
    await vi.waitFor(() => expect(sdk.output).toHaveBeenCalledOnce())
    const decision = sdk.query.mock.calls[0][0].options.canUseTool('Read', {}, { requestId: 'approval', toolUseID: 'tool', signal: new AbortController().signal })
    let replied = false
    const reply = manager.respond(id, 'approval', { type: 'allow' }).then(() => { replied = true })
    await manager.stopTask(id, '/tmp', 'shell')
    await vi.waitFor(() => expect(replied).toBe(true))
    await expect(decision).resolves.toMatchObject({ behavior: 'allow' })
    await reply
    expect(q.stopTask).toHaveBeenCalledWith('shell')
  } finally { release({ output: 'done' }); await reading }
})

it('rejects an output from a replaced runtime rather than delivering stale data', async () => {
  const { id, q } = await idle()
  let release!: (value: unknown) => void
  sdk.output.mockReturnValue(new Promise(resolve => { release = resolve }))
  const reading = manager.taskOutput(id, '/tmp', 'shell')
  const checked = expect(reading).rejects.toThrow('已重载或结束')
  await vi.waitFor(() => expect(sdk.output).toHaveBeenCalledOnce())
  await manager.reloadConfiguration(id, '/tmp')
  expect(q.close).toHaveBeenCalledOnce()
  release({ output: 'stale' })
  await checked
})
