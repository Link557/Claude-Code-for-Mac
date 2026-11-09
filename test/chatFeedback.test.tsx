// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ChatError } from '../src/renderer/components/chat/ChatError'
import { ChatHistoryRail } from '../src/renderer/components/chat/ChatNavigation'
import { isInterruptionNotice } from '../src/shared/internalNotice'
import type { UiMessage } from '../src/shared/chat'

afterEach(cleanup)

it('does not present a legacy user stop as an error', () => {
  const view = render(<ChatError error={'已按用户请求停止\n[ede_diagnostic] stop_reason=null\n结束原因：aborted_streaming'} />)
  expect(view.container.textContent).toBe('')
})

it('keeps failure diagnostics available behind one collapsed summary', () => {
  const error = '运行结束：error_during_execution\nAPI Error: 500\n[ede_diagnostic] stop_reason=null'
  const view = render(<ChatError error={error} />)
  expect(view.getByText('执行未完成')).toBeTruthy()
  const details = view.container.querySelector('details')!
  expect(details.open).toBe(false)
  fireEvent.click(view.getByText('执行未完成'))
  expect(details.open).toBe(true)
  expect(details.textContent).toContain(error)
})

it('shows a short actionable error directly', () => {
  const view = render(<ChatError error="连接失败，请重试" />)
  expect(view.getByRole('alert').textContent).toBe('连接失败，请重试')
})

it('summarizes a connection reset in the history preview when there is no reply to show', () => {
  const input: UiMessage = { id: 'input', role: 'user', parentToolUseId: null, blocks: [{ kind: 'text', text: '请继续' }] }
  const error: UiMessage = { id: 'error', role: 'assistant', parentToolUseId: null, blocks: [{ kind: 'text', text: 'API Error: Connection dropped (ECONNRESET)' }] }
  const reply: UiMessage = { id: 'reply', role: 'assistant', parentToolUseId: null, blocks: [{ kind: 'text', text: '已完成第一步。' }] }
  const view = render(<ChatHistoryRail turns={[[input, error]]} activeIndex={0} onJump={() => {}} />)
  fireEvent.focus(view.getByRole('button'))
  expect(view.getByRole('tooltip').textContent).toBe('请继续连接中断')
  view.rerender(<ChatHistoryRail turns={[[input, reply, error]]} activeIndex={0} onJump={() => {}} />)
  expect(view.getByRole('tooltip').textContent).toBe('请继续已完成第一步。')
})

it('normalizes only standalone stop notices and preserves user content', () => {
  const message: UiMessage = { id: 'stop', role: 'notice', source: 'unknown', startsTurn: false, parentToolUseId: null, blocks: [{ kind: 'text', text: '[Request interrupted by user]' }] }
  expect(isInterruptionNotice(message)).toBe(true)
  expect(isInterruptionNotice({ ...message, source: 'internal' })).toBe(true)
  expect(isInterruptionNotice({ ...message, role: 'user', source: 'human' })).toBe(false)
  expect(isInterruptionNotice({ ...message, startsTurn: true })).toBe(false)
  expect(isInterruptionNotice({ ...message, source: 'external' })).toBe(false)
  expect(isInterruptionNotice({ ...message, blocks: [{ kind: 'text', text: 'Explain [Request interrupted by user]' }] })).toBe(false)
})
