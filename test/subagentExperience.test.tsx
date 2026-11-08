// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UiMessage } from '../src/shared/chat'
import { emptySessionSummary, type SummaryItem } from '../src/shared/sessionSummary'
import { SessionSummary } from '../src/renderer/components/summary/SessionSummary'
import { AgentConversationPane } from '../src/renderer/components/right/AgentConversationPane'
import { agentMessages } from '../src/renderer/components/summary/agentMessages'
import { useChat } from '../src/renderer/chatStore'
import { useDesk } from '../src/renderer/store'
import { useLayout } from '../src/renderer/layoutStore'
import { useSummaryUi } from '../src/renderer/summaryUiStore'

const agents: SummaryItem[] = ['写作', '构思', '审阅'].map((title, i) => ({ id: `tool-${i}`, title, description: '通用 Agent', status: 'running', agentId: `agent-${i}` }))
const message = (id: string, text: string, parentToolUseId: string | null = null): UiMessage => ({ id, role: 'assistant', parentToolUseId, blocks: [{ kind: 'text', text }] })
const read = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  read.mockResolvedValue([])
  window.desk = { chat: { subagentMessages: read }, workspace: { closePage: vi.fn().mockResolvedValue(undefined) } } as unknown as Window['desk']
  useDesk.setState({ projects: [{ id: 'p', path: '/project', name: '项目', addedAt: 0, collapsed: false }] })
  useChat.setState({ chats: { s: { projectId: 'p', loaded: true, state: 'running', messages: [message('main', '主 Agent 的内容')], approvals: [], options: { model: null, mode: 'default', effort: null }, error: null, summary: emptySessionSummary() } } })
  useLayout.setState({ activeSessionId: 's', pages: [], openFiles: [], rightOpen: false, rightTab: null, expanded: false })
  useSummaryUi.setState({ opened: {}, expanded: {}, announced: {} })
})
afterEach(() => { cleanup(); vi.useRealTimers() })
function updateAgents(items = agents) {
  const summary = emptySessionSummary(); summary.sections.agents = structuredClone(items)
  act(() => useChat.getState().handle('s', { kind: 'summary', summary }))
}

it('opens once for new agents, excludes the parent and keeps identity after completion', () => {
  render(<SessionSummary sessionId="s" projectId="p" />)
  expect(screen.queryByRole('region', { name: '会话摘要' })).toBeNull()
  updateAgents()
  const panel = screen.getByRole('region', { name: '会话摘要' })
  expect(within(panel).getByText('子 Agent · 3')).toBeTruthy()
  expect(within(panel).getByText('3 位进行中')).toBeTruthy()
  const avatars = within(panel).getByLabelText('子 Agent 小螃蟹')
  expect(avatars.querySelectorAll('.agent-crab[data-working="true"]')).toHaveLength(3)
  const fills = [...avatars.querySelectorAll('svg > g')].map(g => g.getAttribute('fill'))
  expect(new Set(fills).size).toBe(3)
  expect(fills).not.toContain('#d97757')
  expect(fills).not.toContain('#8e55ce')
  expect([...avatars.querySelectorAll('.agent-crab')].map(e => e.getAttribute('data-accessory'))).toEqual(['glasses', 'hat', 'mohawk'])
  updateAgents(agents.map((agent, i) => i === 0 ? { ...agent, status: 'completed' } : agent))
  expect(within(panel).getByText('子 Agent · 3')).toBeTruthy()
  expect(within(panel).getByText('2 位进行中')).toBeTruthy()
  expect(avatars.querySelectorAll('.agent-crab[data-working="true"]')).toHaveLength(2)
  expect([...avatars.querySelectorAll('svg > g')].map(g => g.getAttribute('fill'))).toEqual(fills)
  fireEvent.click(screen.getByRole('button', { name: '切换摘要面板状态' }))
  updateAgents()
  expect(screen.queryByRole('region', { name: '会话摘要' })).toBeNull()
  updateAgents([...agents, { id: 'tool-3', title: '校对', description: '', status: 'running' }])
  expect(screen.getByRole('region', { name: '会话摘要' })).toBeTruthy()
  expect(screen.getByLabelText('子 Agent 小螃蟹').querySelectorAll('.agent-crab')).toHaveLength(4)
})

it('reuses one sidebar page, preserves the selected parent and reports a full sidebar', () => {
  updateAgents()
  render(<SessionSummary sessionId="s" projectId="p" />)
  fireEvent.click(screen.getByRole('button', { name: '查看写作的会话' }))
  expect(useLayout.getState().pages).toEqual([expect.objectContaining({ kind: 'agents', agentId: 'tool-0', sessionId: 's' })])
  expect(screen.queryByRole('region', { name: '会话摘要' })).toBeNull()
  expect(useLayout.getState().activeSessionId).toBe('s')
  expect(useLayout.getState().openAgent('s', 'p', 'tool-1')).toBe(true)
  expect(useLayout.getState().pages).toHaveLength(1)
  expect(useLayout.getState().pages[0].agentId).toBe('tool-1')
  act(() => useLayout.setState({ pages: Array.from({ length: 6 }, (_, i) => ({ id: `page:${i}` as const, kind: 'start' as const })) }))
  fireEvent.click(screen.getByRole('button', { name: '切换摘要面板状态' }))
  fireEvent.click(screen.getByRole('button', { name: '查看写作的会话' }))
  expect(screen.getByRole('alert').textContent).toContain('侧栏页面已满')
})

it('announces an unlinked child once and does not reopen when its tool identity becomes known', () => {
  render(<SessionSummary sessionId="s" projectId="p" />)
  const summary = emptySessionSummary(); summary.agentsIncomplete = true; summary.unlinkedAgentTaskIds = ['task-a']
  act(() => useChat.getState().handle('s', { kind: 'summary', summary }))
  expect(screen.getByRole('region', { name: '会话摘要' })).toBeTruthy()
  expect(screen.getByText(/子 Agent 数量可能不完整/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '切换摘要面板状态' }))
  summary.sections.agents = [{ ...agents[0], taskId: 'task-a' }]; summary.agentsIncomplete = false; summary.unlinkedAgentTaskIds = []
  act(() => useChat.getState().handle('s', { kind: 'summary', summary: structuredClone(summary) }))
  expect(screen.queryByRole('region', { name: '会话摘要' })).toBeNull()
})

it('merges actual live updates with disk history without other agents or duplicate messages', () => {
  const disk = { ...message('assistant', 'disk'), uuid: 'shared-uuid' }
  const live = { ...message('["tool-0","assistant"]', 'live', 'tool-0'), uuid: 'shared-uuid' }
  const result = agentMessages([disk], [message('main', 'main'), message('other', 'other', 'tool-1'), live], 'tool-0')
  expect(result).toEqual([live])
})

it('never masks complete disk text or tool results with stale partial live content', () => {
  const disk: UiMessage = { ...message('same', '完整的历史文本'), blocks: [{ kind: 'text', text: '完整的历史文本' }, { kind: 'tool', id: 'read', name: 'Read', input: { file_path: 'a.ts' }, result: { text: '已保存的完整结果', isError: false } }] }
  const live: UiMessage = { ...message('["tool-0","same"]', '完整的历史', 'tool-0'), blocks: [{ kind: 'text', text: '完整的历史' }, { kind: 'tool', id: 'read', name: 'Read', input: {} }] }
  const [merged] = agentMessages([disk], [live], 'tool-0')
  expect(merged.blocks[0]).toEqual(disk.blocks[0])
  expect(merged.blocks[1]).toMatchObject({ result: { text: '已保存的完整结果' }, input: { file_path: 'a.ts' } })
  expect(agentMessages([message('same', '最终修改文本')], [live], 'tool-0', false)[0].blocks[0]).toEqual({ kind: 'text', text: '最终修改文本' })
})

it('shows actual prompt, forwarded messages and history, rejecting a late response after switching', async () => {
  updateAgents()
  const late: { resolve?: (messages: UiMessage[]) => void } = {}
  read.mockImplementation((_session: string, _path: string, id: string) => id === 'tool-0' ? new Promise(resolve => { late.resolve = resolve }) : Promise.resolve([message('second-disk', '第二个 Agent 的历史')]))
  useChat.setState(state => ({ chats: { ...state.chats, s: { ...state.chats.s, messages: [message('main', '主 Agent 的内容'), message('live', '第一个 Agent 的实时内容', 'tool-0'), { ...message('tool-call', ''), blocks: [{ kind: 'tool', id: 'tool-0', name: 'Agent', input: { prompt: '实际派发的任务' }, result: { text: '实际返回的结果', isError: false } }] }] } } }))
  const view = render(<AgentConversationPane sessionId="s" projectId="p" agentId="tool-0" active />)
  expect(screen.getByText('实际派发的任务')).toBeTruthy()
  expect(screen.getByText('第一个 Agent 的实时内容')).toBeTruthy()
  expect(screen.getByText('实际返回的结果')).toBeTruthy()
  expect(screen.queryByText('主 Agent 的内容')).toBeNull()
  view.rerender(<AgentConversationPane sessionId="s" projectId="p" agentId="tool-1" active />)
  expect(await screen.findByText('第二个 Agent 的历史')).toBeTruthy()
  await act(async () => late.resolve?.([message('late', '过期的第一份历史')]))
  expect(screen.queryByText('过期的第一份历史')).toBeNull()
  expect(screen.queryByText('第一个 Agent 的实时内容')).toBeNull()
})

it('exposes read failures with retry and stops polling while hidden', async () => {
  updateAgents()
  read.mockRejectedValueOnce(new Error('磁盘读取失败'))
  const view = render(<AgentConversationPane sessionId="s" projectId="p" agentId="tool-0" active />)
  expect((await screen.findByRole('alert')).textContent).toContain('磁盘读取失败')
  read.mockResolvedValue([message('ok', '重试恢复的真实记录')])
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText('重试恢复的真实记录')).toBeTruthy()
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  vi.useFakeTimers()
  view.rerender(<AgentConversationPane sessionId="s" projectId="p" agentId="tool-0" active={false} />)
  const count = read.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
  expect(read).toHaveBeenCalledTimes(count)
})
