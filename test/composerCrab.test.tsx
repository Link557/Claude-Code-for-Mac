// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerCrab, nextVerb } from '../src/renderer/components/newSession/ComposerCrab'
import { JumpToLatest } from '../src/renderer/components/chat/ChatNavigation'
import { crabActivity } from '../src/renderer/components/newSession/crabActivity'
import { useDesk } from '../src/renderer/store'
import { SPINNER_VERBS_ZH } from '../src/renderer/components/newSession/spinnerVerbsZh'
import { SPINNER_VERBS } from '../src/renderer/components/newSession/spinnerVerbs'
import type { ChatActivity } from '../src/shared/chat'

const activity = (phase: ChatActivity['phase'], toolName?: string): ChatActivity => ({ revision: 1, phase, toolName })
const pose = () => document.querySelector('[data-crab-pose]')?.getAttribute('data-crab-pose')
const word = () => document.querySelector('.composer-crab-verb')?.textContent
const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms))
beforeEach(() => {
  vi.useFakeTimers()
  useDesk.setState({ settings: { theme: 'system', defaultModel: 'opus', defaultEffort: 'medium', defaultPermissionMode: 'default', claudePath: null, allowBypass: false, executionLanguage: 'en' } })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('composer crab', () => {
  it('makes a face while held and settles back without one; only the draft page crab can be grabbed', () => {
    const face = () => document.querySelector('[data-crab-face]')?.getAttribute('data-crab-face')
    const view = render(<ComposerCrab hasDraft={false} draggable />)
    const handle = document.querySelector<HTMLElement>('.crab-draggable')!
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 11, clientY: 11 })
    expect(face()).toBeUndefined()
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 60, clientY: -80 })
    expect(['squint', 'dizzy', 'wide']).toContain(face())
    expect(handle.style.position).toBe('fixed')
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 60, clientY: -80 })
    expect(face()).toBeUndefined()
    expect(handle.style.position).toBe('')
    view.rerender(<ComposerCrab hasDraft={false} />)
    expect(document.querySelector('.crab-draggable')).toBeNull()
  })

  it('sleeps after 30 seconds, wakes with a draft or attachment, and restarts the idle clock', () => {
    const view = render(<ComposerCrab hasDraft={false} />)
    tick(29_999); expect(pose()).toBe('idle')
    tick(1); expect(pose()).toBe('sleep')
    view.rerender(<ComposerCrab hasDraft />); expect(pose()).toBe('look')
    tick(60_000); expect(pose()).toBe('look')
    view.rerender(<ComposerCrab hasDraft={false} />); expect(pose()).toBe('idle')
    tick(30_000); expect(pose()).toBe('sleep')
    view.unmount(); expect(vi.getTimerCount()).toBe(0)
  })
  it('gives execution priority over queued draft editing, and resets after completion', () => {
    const view = render(<ComposerCrab hasDraft={false} state="running" activity={activity('thinking')} />)
    tick(60_000); expect(document.querySelector('[data-crab-gesture]')).not.toBeNull()
    view.rerender(<ComposerCrab hasDraft state="running" activity={activity('responding')} />)
    expect(document.querySelector('[data-crab-gesture]')).not.toBeNull(); expect(screen.getByRole('status').textContent).toBe('Responding')
    view.rerender(<ComposerCrab hasDraft={false} state="idle" />)
    expect(pose()).toBe('idle'); tick(30_000); expect(pose()).toBe('sleep')
  })
  it('rotates without repeats, does not restart on phase changes, and pauses for approval', () => {
    const view = render(<ComposerCrab hasDraft={false} state="running" />)
    const first = word(); tick(4000)
    view.rerender(<ComposerCrab hasDraft state="running" activity={activity('thinking')} />)
    expect(word()).toBe(first); tick(4000); expect(word()).not.toBe(first)
    const second = word()
    view.rerender(<ComposerCrab hasDraft state="awaiting" activity={activity('thinking')} />)
    expect(pose()).toBe('waiting'); expect(word()).toBeUndefined(); expect(vi.getTimerCount()).toBe(0)
    tick(60_000)
    view.rerender(<ComposerCrab hasDraft state="running" />)
    expect(word()).toBe(second)
    tick(24_000); expect(document.querySelector('.composer-crab-shimmer')).not.toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Working')
    tick(8000); expect(document.querySelector('.composer-crab-shimmer')).toBeNull()
    view.unmount(); expect(vi.getTimerCount()).toBe(0)
  })
  it('shows the crab’s current execution phrase and holds it while the jump button is hovered', () => {
    const activityTextRef = { current: '' }
    const jump = vi.fn()
    render(<>
      <JumpToLatest working activityTextRef={activityTextRef} onJump={jump} />
      <ComposerCrab hasDraft={false} state="running" activityTextRef={activityTextRef} />
    </>)
    const button = screen.getByRole('button', { name: '回到最新消息' })
    const first = word()!
    fireEvent.mouseEnter(button)
    expect(screen.getByRole('tooltip').textContent).toBe(`${first}回到最新消息`)
    tick(8000)
    expect(word()).not.toBe(first)
    expect(screen.getByRole('tooltip').textContent).toBe(`${first}回到最新消息`)
    fireEvent.mouseLeave(button)
    fireEvent.mouseEnter(button)
    expect(screen.getByRole('tooltip').textContent).toBe(`${word()}回到最新消息`)
    fireEvent.click(button)
    expect(jump).toHaveBeenCalledOnce()
  })
  it('resets on session replacement and never sleeps during errors or stopping', () => {
    const view = render(<ComposerCrab key="a" hasDraft={false} />)
    tick(30_000); expect(pose()).toBe('sleep')
    view.rerender(<ComposerCrab key="b" hasDraft={false} />); expect(pose()).toBe('idle')
    view.rerender(<ComposerCrab key="b" hasDraft={false} state="error" />)
    tick(60_000); expect(pose()).toBe('error'); expect(vi.getTimerCount()).toBe(0)
    view.rerender(<ComposerCrab key="b" hasDraft={false} state="running" activity={activity('stopping')} />)
    expect(screen.getByRole('status').textContent).toBe('Stopping…'); expect(vi.getTimerCount()).toBe(0)
  })
  it.each([
    ['Write', 'writing', 'Writing'], ['Edit', 'writing', 'Writing'], ['MultiEdit', 'writing', 'Writing'], ['NotebookEdit', 'writing', 'Writing'],
    ['Read', 'look', 'Reading'], ['Glob', 'look', 'Searching'], ['Grep', 'look', 'Searching'], ['Bash', 'working', 'Running command'],
    ['Agent', 'working', 'Delegating'], ['Task', 'working', 'Delegating'], ['mcp__custom__Write', 'working', 'Working']
  ])('maps %s only from the actual event', (tool, expectedPose, label) => {
    expect(crabActivity('running', activity('tool', tool))).toEqual({ pose: expectedPose, label, rotating: true })
  })
  it('ignores stale phases after completion and prioritizes waiting and errors', () => {
    expect(crabActivity('idle', activity('thinking')).label).toBe('')
    expect(crabActivity('awaiting', activity('tool', 'Write')).label).toBe('Waiting for you')
    expect(crabActivity('error', activity('thinking')).label).toBe('Error')
    expect(crabActivity('running').label).toBe('Working')
  })
  it('keeps the complete versioned vocabulary and excludes the previous selection', () => {
    expect(SPINNER_VERBS).toHaveLength(187)
    expect(new Set(SPINNER_VERBS).size).toBe(187)
    expect(SPINNER_VERBS).toContain('Whatchamacalliting')
    expect(SPINNER_VERBS).toContain('Clauding')
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(nextVerb(SPINNER_VERBS[0])).toBe(SPINNER_VERBS[1])
  })
})

it('defaults to Chinese with complete one-to-one copy and keeps English identifiers for deduplication', () => {
  useDesk.setState({ settings: null })
  expect(Object.keys(SPINNER_VERBS_ZH)).toEqual([...SPINNER_VERBS])
  expect(new Set(Object.values(SPINNER_VERBS_ZH)).size).toBe(187)
  for (const text of Object.values(SPINNER_VERBS_ZH)) expect(text).toMatch(/[\u4e00-\u9fff]/)
  vi.spyOn(Math, 'random').mockReturnValue(0)
  render(<ComposerCrab hasDraft={false} state="running" />)
  expect(word()).toBe(SPINNER_VERBS_ZH.Accomplishing + '…')
  expect(screen.getByRole('status').textContent).toBe('正在执行任务')
  tick(8000)
  expect(word()).toBe(SPINNER_VERBS_ZH.Actioning + '…')
})
it('translates the same active word without restarting rotation and localizes approvals', () => {
  const view = render(<ComposerCrab hasDraft={false} state="running" />)
  const english = word()!.replace(/…$/, '') as keyof typeof SPINNER_VERBS_ZH
  tick(4000)
  act(() => useDesk.setState({ settings: { ...useDesk.getState().settings!, executionLanguage: 'zh' } }))
  expect(word()).toBe(SPINNER_VERBS_ZH[english] + '…')
  expect(screen.getByRole('status').textContent).toBe('正在执行任务')
  tick(4000)
  expect(word()).not.toBe(SPINNER_VERBS_ZH[english] + '…')
  view.rerender(<ComposerCrab hasDraft={false} state="awaiting" />)
  expect(screen.getByRole('status').textContent).toBe('等你确认后继续')
  view.rerender(<ComposerCrab hasDraft={false} state="idle" />)
  view.rerender(<ComposerCrab hasDraft={false} state="running" />)
  expect(screen.getByRole('status').textContent).toBe('正在执行任务')
  expect(Object.values(SPINNER_VERBS_ZH)).toContain(word()?.replace(/…$/, ''))
  view.rerender(<ComposerCrab hasDraft={false} state="awaiting" />)
  expect(screen.getByRole('status').textContent).toBe('等你确认后继续')
  view.rerender(<ComposerCrab hasDraft={false} state="error" />)
  expect(screen.getByRole('status').textContent).toBe('出了点问题，请查看提示')
  expect(word()).toBeUndefined()
})
it.each([
 ['Read','正在读取'], ['Write','正在写入或修改'], ['Bash','正在运行命令'], ['Agent','正在交给子代理处理'], ['Grep','正在查找']
])('translates actual %s state without changing its pose or behavior', (tool,label) => {
 const en = crabActivity('running', activity('tool',tool),'en')
 expect(crabActivity('running', activity('tool',tool),'zh')).toEqual({ ...en,label })
})

it('maps every word to one of seven gestures', async () => {
 const { CRAB_GESTURES } = await import('../src/renderer/components/newSession/crabGestures')
 expect(Object.keys(CRAB_GESTURES)).toEqual([...SPINNER_VERBS])
 expect(new Set(Object.values(CRAB_GESTURES)).size).toBe(7)
})
