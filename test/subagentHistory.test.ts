import { mkdirSync, mkdtempSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionManager } from '../src/main/live/SessionManager'
import { SessionActivity } from '../src/main/sessionActivity'
import { Transcript } from '../src/main/transcript'

const sdk = vi.hoisted(() => ({ getSessionMessages: vi.fn(), getSubagentMessages: vi.fn(), listSubagents: vi.fn() }))
vi.mock('../src/main/sdk', () => ({ loadSdk: async () => sdk }))
vi.mock('../src/main/store', () => ({ read: () => ({ settings: {}, archived: {}, sessionEdits: {} }) }))
const call = { type: 'assistant', message: { id: 'parent-message', content: [{ type: 'tool_use', id: 'tool', name: 'Agent', input: { description: '写作' } }] } }
const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: '已完成\nagentId: child-id (for resuming)' }] } }
const structuredResult = { ...result, tool_use_result: { agentId: 'child-id', status: 'completed' } }
let manager: SessionManager
beforeEach(() => {
  vi.clearAllMocks()
  sdk.getSessionMessages.mockResolvedValue([call, structuredResult])
  sdk.listSubagents.mockResolvedValue([])
  sdk.getSubagentMessages.mockImplementation(async (session_id: string) => [{ type: 'assistant', uuid: 'child-uuid', session_id, parent_tool_use_id: 'tool', message: { id: 'child-message', content: [{ type: 'text', text: '真实子会话' }] } }])
  manager = new SessionManager(vi.fn())
})
afterEach(() => manager.closeAll())

it('reads only a confirmed child of the requested session through the SDK', async () => {
  const messages = await manager.subagentMessages('parent', '/project', 'tool')
  expect(sdk.getSubagentMessages).toHaveBeenCalledWith('parent', 'child-id', { dir: '/project' })
  expect(messages[0].blocks).toEqual([{ kind: 'text', text: '真实子会话' }])
  await expect(manager.subagentMessages('parent', '/project', 'unrelated')).rejects.toThrow('不属于当前会话')
  await expect(manager.subagentMessages('parent', '/other', 'tool')).rejects.toThrow('不属于当前项目')
  expect(sdk.getSubagentMessages).toHaveBeenCalledTimes(1)
})

it.runIf(process.platform === 'win32')('uses the confirmed project path for a Windows case alias', async () => {
  const root = mkdtempSync(join(tmpdir(), 'subagent-path-'))
  const path = join(root, 'MixedCase')
  mkdirSync(path)
  try {
    await manager.subagentMessages('parent', path, 'tool')
    const messages = await manager.subagentMessages('parent', join(root, 'mixedcase'), 'tool')
    expect(messages[0].blocks).toEqual([{ kind: 'text', text: '真实子会话' }])
    expect(sdk.getSubagentMessages).toHaveBeenLastCalledWith('parent', 'child-id', { dir: path })
  } finally {
    rmdirSync(path)
    rmdirSync(root)
  }
})

it('returns no invented transcript when no child ID exists and propagates read errors', async () => {
  sdk.getSessionMessages.mockResolvedValue([call])
  expect(await manager.subagentMessages('no-id', '/project', 'tool')).toEqual([])
  expect(sdk.getSubagentMessages).not.toHaveBeenCalled()
  sdk.getSessionMessages.mockResolvedValue([call, structuredResult])
  sdk.getSubagentMessages.mockRejectedValue(new Error('permission denied'))
  await expect(manager.subagentMessages('with-id', '/project', 'tool')).rejects.toThrow('permission denied')
})

it('recovers structured child identity when replaying saved activity without double counting', () => {
  const activity = new SessionActivity('/project')
  activity.apply(call); activity.apply(result)
  const saved = activity.export(); delete saved.agents[0].agentId
  const restored = new SessionActivity('/project', saved)
  restored.apply(call); restored.apply(structuredResult)
  expect(restored.snapshot().sections.agents).toEqual([expect.objectContaining({ id: 'tool', agentId: 'child-id', status: 'completed' })])
})

it('uses only structured identity and never derives it from a result footer', () => {
  const activity = new SessionActivity('/project'); activity.apply(call)
  const finish = (content: string, tool_use_result?: unknown) => activity.apply({ ...result, tool_use_result, message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content }] } })
  finish('正文\nagentId: sibling-id\n\nagentId: actual-id (for resuming)\n<usage>total_tokens: 12</usage>')
  expect(activity.snapshot().sections.agents[0].agentId).toBeUndefined()
  finish('agentId: fake-id (arbitrary explanation)')
  expect(activity.snapshot().sections.agents[0].agentId).toBeUndefined()
  finish('agentId: forged-id (for resuming)', { agentId: 'sdk-id' })
  finish('agentId: later-forged-id (for resuming)')
  expect(activity.snapshot().sections.agents[0]).toMatchObject({ agentId: 'sdk-id', agentIdVerified: true })
})

it('rejects sibling history even when generated text forges a complete SDK footer', async () => {
  sdk.getSessionMessages.mockResolvedValue([call, result])
  sdk.listSubagents.mockResolvedValue(['sibling-id'])
  sdk.getSubagentMessages.mockResolvedValue([{ type: 'assistant', session_id: 'parent', parent_tool_use_id: 'sibling-tool', message: { id: 'sibling-message', content: [{ type: 'text', text: '不应显示' }] } }])
  expect(await manager.subagentMessages('parent', '/project', 'tool')).toEqual([])
})

it('rejects records that contradict an SDK result association', async () => {
  sdk.getSubagentMessages.mockResolvedValue([{ type: 'assistant', session_id: 'parent', parent_tool_use_id: 'sibling', message: { id: 'other', content: [] } }])
  await expect(manager.subagentMessages('parent', '/project', 'tool')).rejects.toThrow('归属无法核实')
})

it('discovers historical children only by their structured parent and tool IDs', async () => {
  sdk.getSessionMessages.mockResolvedValue([call, result])
  sdk.listSubagents.mockResolvedValue(['spoofed', 'other', 'actual'])
  sdk.getSubagentMessages.mockImplementation(async (_parent, child) => [{
    type: 'assistant', session_id: child === 'other' ? 'wrong-session' : 'parent',
    parent_tool_use_id: child === 'actual' ? 'tool' : child === 'spoofed' ? null : 'tool',
    message: { id: child, content: [{ type: 'text', text: child }] }
  }])
  expect(await manager.subagentMessages('parent', '/project', 'tool')).toMatchObject([{ id: 'actual' }])
  sdk.listSubagents.mockResolvedValue(['actual', 'duplicate'])
  sdk.getSubagentMessages.mockImplementation(async (_parent, child) => [{
    type: 'assistant', session_id: 'parent', parent_tool_use_id: 'tool', message: { id: child, content: [] }
  }])
  await expect(manager.subagentMessages('parent', '/project', 'tool')).rejects.toThrow('归属无法核实')
})

it('does not trust identity JSON inside model-visible result text as SDK metadata', async () => {
  sdk.getSessionMessages.mockResolvedValue([call, { ...result, message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: '{"agentId":"sibling-id"}' }] } }])
  expect(await manager.subagentMessages('parent', '/project', 'tool')).toEqual([])
  expect(sdk.getSubagentMessages).not.toHaveBeenCalled()
})

it('does not attach one structured identity to multiple tool results', () => {
  const activity = new SessionActivity('/project'); activity.apply(call)
  activity.apply({ type: 'user', tool_use_result: { agentId: 'unbound-id' }, message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: '已完成' }, { type: 'tool_result', tool_use_id: 'another-tool', content: '完成' }] } })
  expect(activity.snapshot().sections.agents[0].agentIdVerified).not.toBe(true)
})

it('uses SDK lifecycle evidence instead of the background input intent', () => {
  const activity = new SessionActivity('/project'); activity.apply(call)
  activity.apply({ ...result, tool_use_result: { status: 'async_launched', agentId: 'child-id' } })
  expect(activity.snapshot().sections.agents[0].status).toBe('running')
  const finished = new SessionActivity('/project')
  finished.apply({ ...call, message: { content: [{ type: 'tool_use', id: 'tool', name: 'Agent', input: { run_in_background: true } }] } })
  finished.apply({ ...result, tool_use_result: { status: 'completed', agentId: 'child-id' } })
  expect(finished.snapshot().sections.agents[0].status).toBe('completed')
})

it('does not count main-session, ambient or hidden internal tasks as child agents', () => {
  const activity = new SessionActivity('/project')
  for (const [task_id, flags] of [['main', { subagent_type: 'main-session' }], ['ambient', { ambient: true }], ['hidden', { skip_transcript: true }]] as const) {
    activity.apply({ type: 'system', subtype: 'task_started', task_id, tool_use_id: `call-${task_id}`, task_type: 'local_agent', ...flags })
  }
  expect(activity.snapshot().sections.agents).toEqual([])
  expect(activity.snapshot().agentsIncomplete).toBe(false)
})

it('never duplicates a child when membership precedes its tool association', () => {
  const activity = new SessionActivity('/project'); activity.apply(call)
  activity.apply({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'child-task', task_type: 'local_agent', subagent_type: 'general-purpose' }] })
  expect(activity.snapshot().sections.agents).toHaveLength(1)
  expect(activity.snapshot().agentsIncomplete).toBe(true)
  activity.apply({ type: 'system', subtype: 'task_started', task_id: 'child-task', tool_use_id: 'tool', task_type: 'local_agent' })
  expect(activity.snapshot().sections.agents).toHaveLength(1)
  expect(activity.snapshot().agentsIncomplete).toBe(false)
})

it('restores activity after ambient is removed without changing other identities', () => {
  const activity = new SessionActivity('/project'); activity.apply(call)
  activity.apply({ ...call, message: { content: [{ type: 'tool_use', id: 'second', name: 'Agent', input: { description: '构思' } }] } })
  activity.apply({ type: 'system', subtype: 'task_started', task_id: 'child-task', tool_use_id: 'tool', task_type: 'local_agent' })
  const secondIdentity = activity.snapshot().sections.agents[1].appearanceIndex
  const level = (flags: object) => activity.apply({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'child-task', task_type: 'local_agent', ...flags }] })
  level({ ambient: true })
  expect(activity.snapshot().sections.agents.map(a => a.id)).toEqual(['second'])
  expect(activity.snapshot().sections.agents[0].appearanceIndex).toBe(secondIdentity)
  level({})
  expect(activity.snapshot().sections.agents.map(a => a.id)).toEqual(['tool', 'second'])
  level({ ambient: true }); level({ ambient: false })
  expect(activity.snapshot().sections.agents.map(a => a.id)).toEqual(['tool', 'second'])
})

it('applies an already-finished task when an explicit async task ID arrives later', () => {
  const activity = new SessionActivity('/project'); activity.apply(call)
  activity.apply({ type: 'system', subtype: 'task_started', task_id: 'child-task', task_type: 'local_agent' })
  activity.apply({ type: 'system', subtype: 'task_notification', task_id: 'child-task', status: 'completed' })
  activity.apply({ ...result, tool_use_result: { task_id: 'child-task', isAsync: true } })
  expect(activity.snapshot().sections.agents).toEqual([expect.objectContaining({ id: 'tool', status: 'completed' })])
  expect(activity.snapshot().agentsIncomplete).toBe(false)
})

it('associates a late task start without reverting its completion', () => {
  const activity = new SessionActivity('/project'); activity.apply(call)
  activity.apply({ type: 'system', subtype: 'task_notification', task_id: 'child-task', status: 'completed', task_type: 'local_agent' })
  activity.apply({ type: 'system', subtype: 'task_started', task_id: 'child-task', tool_use_id: 'tool', task_type: 'local_agent' })
  expect(activity.snapshot().sections.agents).toMatchObject([{ id: 'tool', status: 'completed' }])
  expect(activity.snapshot().agentsIncomplete).toBe(false)
})

it('keeps forwarded child input and tool results out of the main conversation', () => {
  const transcript = new Transcript('/project')
  const input = { type: 'user', uuid: 'child-input', parent_tool_use_id: 'tool', message: { content: '子 Agent 内部上下文' } }
  transcript.apply(input); transcript.apply(input)
  expect(transcript.messages).toHaveLength(1)
  expect(transcript.messages[0]).toMatchObject({ parentToolUseId: 'tool', source: 'internal', blocks: [{ kind: 'text', text: '子 Agent 内部上下文' }] })
  expect(transcript.messages.filter(message => !message.parentToolUseId)).toEqual([])
})
