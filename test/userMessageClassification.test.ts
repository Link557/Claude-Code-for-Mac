import { expect, it } from 'vitest'
import { Transcript } from '../src/main/transcript'
import { TurnActivity } from '../src/main/live/TurnActivity'
import { turnsOf } from '../src/shared/fileChanges'

const imageNote = '[Image: original 1500x2880, displayed at 1042x2000. Multiply coordinates by 1.44 to map to original image.]'
const user = (content: unknown, extra = {}) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content }, ...extra })

it('hides only a uniquely matched successful synthetic Skill body in its tool scope', () => {
  const t = new Transcript()
  const skill = (id: string, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id: `a-${id}`, content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: 'demo' } }] } })
  const receipt = (id: string, parent: string | null = null, error = false) => ({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Launching skill: demo', is_error: error }] } })
  const body = (uuid: string, extra = {}) => user('Base directory for this skill: /demo\n\n# Body', { uuid, isSynthetic: true, ...extra })
  t.apply(skill('one')); t.apply(receipt('one')); t.apply(body('hidden'))
  expect(t.messages.some(m => m.uuid === 'hidden')).toBe(false)
  t.apply(skill('bad')); t.apply(receipt('bad', null, true)); t.apply(body('failed'))
  expect(t.messages.some(m => m.uuid === 'failed')).toBe(true)
  t.apply(skill('a')); t.apply(skill('b')); t.apply(receipt('a')); t.apply(receipt('b')); t.apply(body('ambiguous'))
  expect(t.messages.some(m => m.uuid === 'ambiguous')).toBe(true)
  t.apply(body('wrong-id', { sourceToolUseID: 'missing' }))
  expect(t.messages.some(m => m.uuid === 'wrong-id')).toBe(true)
  t.apply(body('a-hidden', { sourceToolUseID: 'a' }))
  t.apply(body('b-hidden', { sourceToolUseID: 'b' }))
  expect(t.messages.some(m => m.uuid === 'a-hidden' || m.uuid === 'b-hidden')).toBe(false)
  t.apply(skill('nested', 'agent')); t.apply(receipt('nested', 'agent')); t.apply(body('wrong-scope'))
  expect(t.messages.some(m => m.uuid === 'wrong-scope')).toBe(true)
  t.apply({ ...body('nested-hidden', { sourceToolUseID: 'nested' }), parent_tool_use_id: 'agent' })
  expect(t.messages.some(m => m.uuid === 'nested-hidden')).toBe(false)
  t.addUser('Base directory for this skill: /demo\n\n# pasted', 'human')
  t.apply(body('human'))
  expect(t.messages.find(m => m.uuid === 'human')?.source).toBe('human')
})
const assistant = (id: string, content: unknown[]) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, content } })

it('keeps repeated image tool results within the original turn without ending execution', () => {
  const t = new Transcript()
  const activity = new TurnActivity()
  t.addUser('检查图片并汇总')
  activity.start()
  const apply = (m: unknown) => { t.apply(m); activity.apply(m) }
  for (let i = 0; i < 100; i++) {
    apply(assistant(`a${i}`, [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: {} }]))
    apply(user([
      { type: 'tool_result', tool_use_id: `t${i}`, content: 'image read' },
      { type: 'text', text: imageNote }
    ], i % 2 ? { isSynthetic: true } : {}))
    expect(activity.snapshot().phase).toBe('working')
  }
  apply(assistant('final', [{ type: 'text', text: '检查完成' }]))
  expect(activity.snapshot().phase).toBe('responding')
  expect(t.messages.filter(m => m.role === 'user')).toHaveLength(1)
  expect(turnsOf(t.messages)).toHaveLength(1)
  const tools = t.messages.flatMap(m => m.blocks).filter(b => b.kind === 'tool')
  expect(tools).toHaveLength(100)
  expect(tools.every(b => b.result?.text === 'image read')).toBe(true)
  apply({ type: 'result', subtype: 'success' })
  expect(activity.snapshot().phase).toBe('idle')
})

it.each(['isSynthetic', 'isMeta', 'is_meta', 'isCompactSummary', 'isVisibleInTranscriptOnly'])('does not display %s text as human input', flag => {
  const t = new Transcript()
  t.apply(user('内部辅助内容', { [flag]: true }))
  expect(t.messages).toEqual([expect.objectContaining({ role: 'notice', source: 'internal', startsTurn: false })])
})

it('never uses image-note wording to classify or erase unknown input', () => {
  const t = new Transcript()
  t.apply(user(imageNote, { uuid: 'old' }))
  t.apply(user(imageNote, { uuid: 'live' }), 'live')
  t.apply(user(imageNote, { uuid: 'human', origin: { kind: 'human' } }))
  expect(t.messages.map(m => [m.source, m.startsTurn])).toEqual([['unknown', true], ['unknown', false], ['human', true]])
  expect(t.messages.every(m => m.blocks[0]?.kind === 'text' && m.blocks[0].text === imageNote)).toBe(true)
})

it.each([imageNote, '  <system-reminder>不要删除</system-reminder>\n', '<local-command-stdout>原文</local-command-stdout>', '[Request interrupted by user]', '<command-name>/model</command-name>'])('preserves human original text through echo and history: %s', text => {
  const t = new Transcript()
  t.addUser(text, 'human')
  const echo = user('CLI 改写后的正文', { uuid: 'human', is_meta: true })
  t.apply(echo, 'live')
  t.apply(echo, 'live')
  expect(t.messages).toHaveLength(1)
  expect(t.messages[0]).toMatchObject({ id: 'human', uuid: 'human', source: 'human', blocks: [{ kind: 'text', text }] })
  const history = new Transcript(undefined, undefined, t.humanSubmissions())
  history.apply(echo)
  expect(history.messages[0]).toMatchObject({ id: 'human', source: 'human', blocks: [{ kind: 'text', text }] })
  const cli = new Transcript()
  cli.apply(user(text, { uuid: 'cli', origin: { kind: 'human' } }))
  expect(cli.messages[0].blocks).toEqual([{ kind: 'text', text }])
})

it('keeps unknown markup unchanged and keeps legacy groups separate', () => {
  const t = new Transcript()
  const text = '  <system-reminder>原文</system-reminder>  '
  t.apply(user(text, { uuid: 'one' }))
  t.apply(assistant('reply', [{ type: 'text', text: '答复' }]))
  t.apply(user(text, { uuid: 'two' }))
  expect(t.messages[0].blocks).toEqual([{ kind: 'text', text }])
  expect(turnsOf(t.messages)).toHaveLength(2)
})

it('handles a human text block and tool result independently even in the same event', () => {
  const t = new Transcript()
  t.apply(assistant('a', [{ type: 'tool_use', id: 't', name: 'Read', input: {} }]))
  t.apply(user([{ type: 'tool_result', tool_use_id: 't', content: 'done' }, { type: 'text', text: imageNote }], { uuid: 'human', origin: { kind: 'human' } }))
  expect(t.messages[0].blocks[0]).toMatchObject({ result: { text: 'done' } })
  expect(t.messages[1]).toMatchObject({ source: 'human', startsTurn: true, blocks: [{ kind: 'text', text: imageNote }] })
})

it('retains external messages as notices rather than silently losing them or starting a user turn', () => {
  const t = new Transcript()
  t.addUser('开始')
  t.apply(user('后台任务完成', { origin: { kind: 'task-notification' } }))
  expect(t.messages.at(-1)).toMatchObject({ role: 'notice', blocks: [{ kind: 'text', text: '后台任务完成' }] })
  expect(turnsOf(t.messages)).toHaveLength(1)
})

it('preserves command output, interruption notices and fork positions across hidden messages', () => {
  const t = new Transcript()
  t.addUser('/model')
  t.apply(user('辅助说明', { isSynthetic: true, uuid: 'hidden' }))
  t.apply(user('<local-command-stdout>sonnet</local-command-stdout>', { isSynthetic: true }))
  expect(t.messages.at(-1)?.blocks).toEqual([{ kind: 'command', name: 'model', args: '', output: 'sonnet' }])
  t.addUser('下一条')
  expect(t.messages.at(-1)?.forkFrom).toBe('hidden')
  t.apply(user('[Request interrupted by user]', { isSynthetic: true }))
  expect(t.messages.at(-1)).toMatchObject({ role: 'notice', blocks: [{ kind: 'text', text: '[Request interrupted by user]' }] })
})

it('does not turn unmatched tool-result annotations into human input on history replay', () => {
  const t = new Transcript()
  t.apply(user([{ type: 'tool_result', tool_use_id: 'missing', content: 'ok' }, { type: 'text', text: '工具辅助说明' }]))
  expect(t.messages).toEqual([expect.objectContaining({ role: 'notice', source: 'internal', startsTurn: false })])
})

it('does not rewind the fork position when an old SDK user event is replayed', () => {
  const t = new Transcript()
  const original = user('first', { uuid: 'u1', origin: { kind: 'human' } })
  t.apply(original)
  t.apply({ ...assistant('answer', [{ type: 'text', text: 'reply' }]), uuid: 'a1' })
  t.apply(original)
  t.addUser('next', 'u2')
  expect(t.messages.at(-1)?.forkFrom).toBe('a1')
})
