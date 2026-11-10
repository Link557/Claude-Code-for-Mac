import { afterEach, expect, it, vi } from 'vitest'
import { LiveSession } from '../src/main/live/LiveSession'
import { Transcript } from '../src/main/transcript'
import { PushQueue } from '../src/main/live/PushQueue'
const sdk = vi.hoisted(() => ({ query: vi.fn(), allowBypass: false, promptSuggestions: undefined as boolean | undefined }))
vi.mock('../src/main/sdk', () => ({ loadSdk: async () => sdk, claudeExecutable: () => undefined }))
vi.mock('../src/main/store', () => ({ read: () => ({ settings: { allowBypass: sdk.allowBypass, promptSuggestions: sdk.promptSuggestions } }) }))
let session: LiveSession | undefined
afterEach(() => { session?.close(); session = undefined; sdk.allowBypass = false; sdk.promptSuggestions = undefined })
function setup() {
  let fast = false
  let blocked = false
  let effective: Record<string, unknown> = {}
  const stream = new PushQueue<unknown>()
  const query = Object.assign(stream, {
    close: () => stream.end(),
    initializationResult: async () => ({ commands: [], models: [], fast_mode_state: 'off', fast_mode_disabled_reason: 'sdk_opt_in_required' }),
    reinitialize: vi.fn(async () => ({ fast_mode_state: fast && !blocked ? 'on' : 'off', fast_mode_disabled_reason: blocked ? 'extra_usage_disabled' : undefined })),
    applyFlagSettings: vi.fn(async (patch: Record<string, unknown>) => { if (typeof patch.fastMode === 'boolean') fast = patch.fastMode; effective = { ...effective, ...patch } }),
    request: async () => ({ response: { effective, sources: [], applied: { model: 'opus', effort: 'high' } } })
  })
  sdk.query.mockReturnValue(query)
  const events = vi.fn()
  session = new LiveSession({ sessionId: 'test', cwd: '/tmp', resume: false, options: { model: 'opus', mode: 'default', effort: 'high' }, transcript: new Transcript(), emit: events, onClosed: vi.fn() })
  return { query, events, block: () => { blocked = true }, effective: (v: Record<string, unknown>) => { effective = v } }
}
it('keeps a confirmed fast result instead of restoring the stale initialization reason', async () => {
  setup()
  await session!.start()
  await session!.setFastMode(true, false)
  await session!.refreshRuntime()
  expect(session!.runtime.fastMode).toBe('on')
  expect(session!.runtime.fastModeReason).toBeUndefined()
})
it('rolls back to requested fast mode even when effective mode was off', async () => {
  const { query, block } = setup()
  await session!.start()
  block()
  await expect(session!.setFastMode(true, true)).rejects.toThrow()
  expect(query.applyFlagSettings).toHaveBeenLastCalledWith({ fastMode: true })
})
it('rejects an accepted setting when a higher priority effective value wins', async () => {
  const { query } = setup()
  await session!.start()
  query.request = async () => ({ response: { effective: { language: 'English' }, sources: [], applied: { model: 'opus', effort: 'high' } } })
  await expect(session!.applySetting('language', 'Chinese')).rejects.toThrow('覆盖或无法确认')
})

it('passes desktop model, effort, mode and checkpoint settings to the SDK', async () => {
  setup()
  await session!.start()
  expect(sdk.query).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ model: 'opus', effort: 'high', permissionMode: 'default', enableFileCheckpointing: true, allowDangerouslySkipPermissions: false }) }))
})
it('requires a reload when bypass is enabled after the session started', async () => {
  setup()
  await session!.start()
  sdk.allowBypass = true
  await expect(session!.setMode('bypassPermissions')).rejects.toThrow('重新加载')
})
it('blocks selecting bypass after the global option is disabled', async () => {
  setup()
  sdk.allowBypass = true
  await session!.start()
  sdk.allowBypass = false
  await expect(session!.setMode('bypassPermissions')).rejects.toThrow('请先在设置中允许')
})

it('includes only the completed SDK reply in the completion notification preview', async () => {
  const { query, events } = setup()
  await session!.start()
  query.push({ type: 'result', subtype: 'success', is_error: false, result: '**已完成**本次修改。', duration_ms: 1, uuid: 'result-id' })
  await vi.waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ kind: 'result', replyPreview: '已完成本次修改。' })))
})

it('keeps reading after result and publishes an ephemeral suggestion, clearing it before new input', async () => {
  const { query, events } = setup()
  await session!.start()
  expect(sdk.query.mock.calls.at(-1)?.[0].options.promptSuggestions).toBe(true)
  query.push({ type: 'result', subtype: 'success', is_error: false, result: 'done', duration_ms: 1, uuid: 'r', queued_turn_count: 0 })
  query.push({ type: 'prompt_suggestion', session_id: 'test', uuid: 's', suggestion: '运行测试' })
  await vi.waitFor(() => expect(session!.promptSuggestion).toEqual({ id: 's', text: '运行测试' }))
  expect(events).toHaveBeenCalledWith({ kind: 'promptSuggestion', suggestion: { id: 's', text: '运行测试' } })
  session!.send('我有别的问题')
  expect(session!.promptSuggestion).toBeNull()
  query.push({ type: 'prompt_suggestion', session_id: 'test', uuid: 'late', suggestion: '过期建议' })
  await new Promise(r => setTimeout(r, 20))
  expect(session!.promptSuggestion).toBeNull()
})
it('opts out of requesting suggestions when the desktop setting is off', async () => {
  sdk.promptSuggestions = false
  setup()
  await session!.start()
  expect(sdk.query.mock.calls.at(-1)?.[0].options.promptSuggestions).toBe(false)
})

it('ignores suggestions for another session or after a failed result', async () => {
  const { query, events } = setup()
  await session!.start()
  query.push({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, uuid: 'r' })
  query.push({ type: 'prompt_suggestion', session_id: 'another', uuid: 's', suggestion: 'wrong' })
  query.push({ type: 'result', subtype: 'success', is_error: true, result: 'error', duration_ms: 1, uuid: 'r2' })
  query.push({ type: 'prompt_suggestion', session_id: 'test', uuid: 's2', suggestion: 'wrong' })
  await vi.waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ kind: 'result', resultId: 'r2' })))
  expect(session!.promptSuggestion).toBeNull()
})
