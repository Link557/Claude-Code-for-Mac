// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsPage } from '../src/renderer/components/settings/SettingsPage'
import { ClaudeConfigSettings } from '../src/renderer/components/settings/ClaudeConfigSettings'
import { McpSettings } from '../src/renderer/components/settings/McpSettings'
import { useDesk } from '../src/renderer/store'
import { openAppPanel } from '../src/renderer/panelStore'
import type { ClaudeConfigSnapshot } from '../src/shared/claudeConfig'
const config = 'Usage: /config key=value\n  autoCompact=true|false\n  language=<value>\n  futureOption=one|two\n  switchModelsOnFlag=Switch automatically|Ask each time'
let values: Record<string, string>
function snapshot(): ClaudeConfigSnapshot { return { cliVersion: '2.1.301', items: [
  { key: 'autoCompact', values: ['true', 'false'], value: values.autoCompact, source: 'saved' },
  { key: 'language', values: [], value: values.language, source: 'saved' },
  { key: 'futureOption', values: ['one', 'two'], value: 'one', source: 'saved' },
  { key: 'switchModelsOnFlag', values: ['Switch automatically', 'Ask each time'], value: 'Ask each time', source: 'saved' }
] } }
beforeEach(() => {
  useDesk.setState({ home: '/home', view: { kind: 'session', sessionId: 's', projectId: 'p' }, projects: [{ id: 'p', name: 'Project', path: '/project', addedAt: 0, collapsed: false }], selectedProjectId: 'p', settings: { theme: 'light', defaultModel: 'sonnet', defaultEffort: 'low', defaultPermissionMode: 'default', claudePath: null, allowBypass: false } })
  values = { autoCompact: 'true', language: 'English' }
  window.desk = { meta: { cachedModels: vi.fn().mockResolvedValue(null), get: vi.fn().mockResolvedValue({ models: [], claudeVersion: null, subscriptionType: null }), configSnapshot: vi.fn().mockImplementation(async () => snapshot()), config: vi.fn(async (_path, value) => { if (value) { const index = value.indexOf('='); values[value.slice(0, index)] = value.slice(index + 1) }; return value ? 'Saved' : config }) }, chat: { reloadConfiguration: vi.fn().mockResolvedValue(undefined), applySetting: vi.fn().mockResolvedValue(undefined), mcp: vi.fn().mockResolvedValue([{ name: 'files', status: 'connected', tools: 7, scope: 'project' }]) } } as unknown as Window['desk']
})
afterEach(cleanup)
it('distinguishes audited defaults, unknown engine values and managed settings', async () => {
  vi.mocked(window.desk.meta.configSnapshot).mockResolvedValue({ cliVersion: '2.1.299', items: [
    { key: 'language', values: [], value: 'default', source: 'default' },
    { key: 'outputStyle', values: [], value: null, source: 'unknown' },
    { key: 'autoCompact', values: ['true', 'false'], value: 'true', source: 'default', locked: '由组织策略管理' }
  ] })
  render(<ClaudeConfigSettings cwd="/project" />)
  expect((await screen.findByText('回复语言')).getAttribute('title')).toBe('引擎默认')
  expect(screen.getByPlaceholderText('无法确认当前值')).toBeTruthy()
  expect(screen.getByText('由组织策略管理')).toBeTruthy()
  expect(window.desk.meta.config).not.toHaveBeenCalled()
})
it('hides editable stale values during refresh and ignores superseded reads', async () => {
  const view = render(<ClaudeConfigSettings cwd="/project" />)
  await screen.findByRole('switch', { name: '自动压缩对话' })
  let finishOld!: (value: ReturnType<typeof snapshot>) => void
  vi.mocked(window.desk.meta.configSnapshot).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
  fireEvent.click(screen.getByLabelText('刷新 Claude Code 设置'))
  expect(screen.queryByRole('switch')).toBeNull()
  values.language = 'New project'
  view.rerender(<ClaudeConfigSettings cwd="/other" />)
  await waitFor(() => expect((screen.getByLabelText('回复语言') as HTMLInputElement).value).toBe('New project'))
  values.language = 'Stale project'
  await act(async () => finishOld(snapshot()))
  expect((screen.getByLabelText('回复语言') as HTMLInputElement).value).toBe('New project')
})
it('does not project a previous project save into a new project or retain its save lock', async () => {
  let finishWrite!: (value: string) => void
  vi.mocked(window.desk.meta.config).mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve }))
  const view = render(<ClaudeConfigSettings cwd="/project" />)
  fireEvent.click(await screen.findByRole('switch', { name: '自动压缩对话' }))
  view.rerender(<ClaudeConfigSettings cwd="/other" />)
  await waitFor(() => expect((screen.getByRole('switch', { name: '自动压缩对话' }) as HTMLButtonElement).disabled).toBe(false))
  const reads = vi.mocked(window.desk.meta.configSnapshot).mock.calls.length
  await act(async () => finishWrite('Saved'))
  expect(window.desk.meta.configSnapshot).toHaveBeenCalledTimes(reads)
  expect(screen.queryByText('已保存')).toBeNull()
  fireEvent.click(screen.getByRole('switch', { name: '自动压缩对话' }))
  await screen.findByText('已保存 · 后续启动生效')
  expect(window.desk.meta.config).toHaveBeenLastCalledWith('/other', 'autoCompact=false')
})
it('marks the saved field unknown when the confirming read fails and allows retry', async () => {
  render(<ClaudeConfigSettings cwd="/project" />)
  const toggle = await screen.findByRole('switch', { name: '自动压缩对话' })
  vi.mocked(window.desk.meta.configSnapshot).mockRejectedValueOnce(new Error('read failed'))
  fireEvent.click(toggle)
  await screen.findByText('已保存，但重新读取失败：read failed')
  expect((screen.getByLabelText('自动压缩对话') as HTMLSelectElement).value).toBe('')
  fireEvent.click(screen.getByLabelText('刷新 Claude Code 设置'))
  expect((await screen.findByRole('switch', { name: '自动压缩对话' })).getAttribute('aria-checked')).toBe('false')
})
it('routes config to settings and MCP to the skills page, preserving the originating session and project', async () => {
  expect(openAppPanel('config', '')).toBe(true)
  expect(useDesk.getState().view).toMatchObject({ kind: 'settings', tab: 'claude', sessionId: 's', projectId: 'p' })
  render(<SettingsPage />)
  expect(screen.queryByRole('button', { name: '连接与 MCP' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '上下文' }))
  await screen.findByLabelText('自动压缩对话')
  useDesk.setState({ view: { kind: 'session', sessionId: 's', projectId: 'p' } })
  expect(openAppPanel('mcp', '')).toBe(true)
  expect(useDesk.getState().view).toEqual({ kind: 'skills', tab: 'mcp', projectId: 'p' })
})
it('renders every returned option, searches labels and saves enumerated and free values', async () => {
  render(<ClaudeConfigSettings cwd="/project" />)
  await screen.findByLabelText('futureOption')
  expect(screen.getAllByRole('combobox')).toHaveLength(3)
  expect(screen.getByRole('switch', { name: '自动压缩对话' }).getAttribute('aria-checked')).toBe('true')
  expect((screen.getByLabelText('回复语言') as HTMLInputElement).value).toBe('English')
  fireEvent.click(screen.getByRole('switch', { name: '自动压缩对话' }))
  await screen.findByText('已保存 · 后续启动生效')
  expect(screen.getByRole('switch', { name: '自动压缩对话' }).getAttribute('aria-checked')).toBe('false')
  expect(window.desk.meta.config).toHaveBeenCalledWith('/project', 'autoCompact=false')
  fireEvent.change(screen.getByLabelText('回复语言'), { target: { value: '简体中文' } })
  await waitFor(() => expect((screen.getByLabelText('回复语言') as HTMLInputElement).value).toBe('简体中文'))
  expect(window.desk.meta.config).toHaveBeenCalledWith('/project', 'language=简体中文')
  fireEvent.change(screen.getByLabelText('搜索 Claude Code 设置'), { target: { value: '语言' } })
  expect(screen.queryByLabelText('futureOption')).toBeNull()
})
it('does not claim success or permit conflicting edits while a write is pending', async () => {
  let reject!: (error: Error) => void
  window.desk.meta.config = vi.fn((_path, value) => value ? new Promise<string>((_resolve, fail) => { reject = fail }) : Promise.resolve(config))
  render(<ClaudeConfigSettings cwd="/project" />)
  fireEvent.click(await screen.findByRole('switch', { name: '自动压缩对话' }))
  expect((screen.getByLabelText('futureOption') as HTMLSelectElement).disabled).toBe(true)
  await act(async () => reject(new Error('managed policy')))
  expect(screen.getByRole('alert').textContent).toContain('managed policy')
  expect(screen.queryByText('已保存')).toBeNull()
  expect(screen.getByRole('switch', { name: '自动压缩对话' }).getAttribute('aria-checked')).toBe('true')
})
it('MCP empty and failure states both allow retry', async () => {
  window.desk.chat.mcp = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([{ name: 'recovered', status: 'pending', tools: 0 }])
  render(<McpSettings cwd="/project" sessionId={null} />)
  await screen.findByText('没有配置 MCP 服务器。')
  fireEvent.click(screen.getByLabelText('刷新 MCP'))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByLabelText('刷新 MCP'))
  await screen.findByText('recovered')
})
it('leaves argument commands on their existing route and does not intercept btw', () => {
  expect(openAppPanel('config', 'language=Chinese')).toBe(false)
  expect(openAppPanel('btw', 'question')).toBe(false)
})

it('reads persisted values when reopening and surfaces read errors instead of invented defaults', async () => {
  const view = render(<ClaudeConfigSettings cwd="/project" />)
  fireEvent.click(await screen.findByRole('switch', { name: '自动压缩对话' }))
  await screen.findByText('已保存 · 后续启动生效')
  view.unmount()
  render(<ClaudeConfigSettings cwd="/project" />)
  expect((await screen.findByRole('switch', { name: '自动压缩对话' })).getAttribute('aria-checked')).toBe('false')
  window.desk.meta.configSnapshot = vi.fn().mockRejectedValue(new Error('Cannot read preferences'))
  fireEvent.click(screen.getByLabelText('刷新 Claude Code 设置'))
  await screen.findByRole('alert')
  expect(screen.queryByRole('switch')).toBeNull()
})

it('shows only desktop model defaults while retaining context settings', async () => {
  useDesk.setState({ view: { kind: 'settings', tab: 'models' } })
  render(<SettingsPage />)
  expect(screen.getByText('新对话默认值')).toBeTruthy()
  expect(window.desk.meta.configSnapshot).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '终端默认值' })).toBeNull()
  expect(screen.queryByRole('button', { name: '桌面新对话' })).toBeNull()
  expect(screen.queryByLabelText('项目')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '上下文' }))
  await screen.findByLabelText('自动压缩对话')
  expect(screen.queryByLabelText('安全检查标记消息时切换模型')).toBeNull()
})
it('defaults input suggestions to on and persists opt-out as a desktop setting', async () => {
  const updateSettings = vi.fn(async patch => useDesk.setState(state => ({ settings: { ...state.settings!, ...patch } })))
  useDesk.setState({ view: { kind: 'settings', tab: 'context' }, updateSettings })
  render(<SettingsPage />)
  const toggle = screen.getByRole('switch', { name: '请求输入建议' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  expect(updateSettings).toHaveBeenCalledWith({ promptSuggestions: false })
  expect(window.desk.meta.config).not.toHaveBeenCalled()
  expect(window.desk.chat.reloadConfiguration).not.toHaveBeenCalled()
})

it('updates desktop interaction preferences without writing terminal config', async () => {
  const updateSettings = vi.fn().mockResolvedValue(undefined)
  useDesk.setState({ view: { kind: 'settings' }, updateSettings })
  render(<SettingsPage />)
  fireEvent.click(screen.getByRole('switch', { name: '自动跟随最新回复' }))
  expect(updateSettings).toHaveBeenCalledWith({ autoScroll: false })
  fireEvent.click(screen.getByRole('switch', { name: '减少动效' }))
  expect(updateSettings).toHaveBeenCalledWith({ reduceMotion: true })
  expect(window.desk.meta.config).not.toHaveBeenCalled()
})
it('surfaces failed desktop preference writes and keeps the last confirmed value', async () => {
  useDesk.setState({ view: { kind: 'settings' }, updateSettings: vi.fn().mockRejectedValue(new Error('disk full')) })
  render(<SettingsPage />)
  fireEvent.click(screen.getByRole('switch', { name: '减少动效' }))
  expect((await screen.findByRole('alert')).textContent).toBe('设置保存失败：disk full')
  expect(screen.getByRole('switch', { name: '减少动效' }).getAttribute('aria-checked')).toBe('false')
})
it('shows the CLI version but not the account when advanced settings are opened', async () => {
  vi.mocked(window.desk.meta.get).mockResolvedValue({ models: [], claudeVersion: '2.1.301', subscriptionType: 'pro' })
  useDesk.setState({ view: { kind: 'settings', tab: 'advanced' } })
  render(<SettingsPage />)
  await screen.findByText('自动检测 v2.1.301 · 查看接入状态')
  expect(screen.queryByText('账户')).toBeNull()
})
it('does not offer Fast in desktop default model selection', async () => {
  vi.mocked(window.desk.meta.get).mockResolvedValue({ models: [{ value: 'sonnet', label: 'Sonnet', efforts: ['low'] }], claudeVersion: null, subscriptionType: null })
  useDesk.setState({ view: { kind: 'settings', tab: 'models' } })
  render(<SettingsPage />)
  fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
  await screen.findByRole('button', { name: 'Sonnet' })
  expect(screen.queryByRole('checkbox', { name: 'Fast' })).toBeNull()
})

it.each([['config', 'settings'], ['mcp', 'skills']] as const)('preserves the draft project for /%s and falls back only without a selection', (name, kind) => {
  useDesk.setState({ view: { kind: 'new' }, selectedProjectId: 'p' })
  openAppPanel(name, '')
  expect(useDesk.getState().view).toMatchObject({ kind, projectId: 'p' })
  useDesk.setState({ view: { kind: 'new' }, selectedProjectId: null })
  openAppPanel(name, '')
  expect(useDesk.getState().view).toMatchObject({ kind, projectId: null })
})

it('refreshes matching project changes, all user changes, and ignores late results after switching project', async () => {
  type Change = Parameters<Parameters<Window['desk']['meta']['onConfigChanged']>[0]>[0]
  const listeners = new Set<(change: Change) => void>()
  window.desk.meta.onConfigChanged = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const notify = (change: Change) => act(() => { for (const listener of listeners) listener(change) })
  const view = render(<ClaudeConfigSettings cwd="/project" />)
  await screen.findByLabelText('回复语言')
  const reads = vi.mocked(window.desk.meta.configSnapshot).mock.calls.length
  notify({ cwd: '/other', scope: 'project' })
  expect(window.desk.meta.configSnapshot).toHaveBeenCalledTimes(reads)
  values.language = 'Global update'
  notify({ cwd: '/other', scope: 'user' })
  await waitFor(() => expect((screen.getByLabelText('回复语言') as HTMLInputElement).value).toBe('Global update'))
  let late!: (value: ClaudeConfigSnapshot) => void
  vi.mocked(window.desk.meta.configSnapshot).mockImplementationOnce(() => new Promise(resolve => { late = resolve }))
  notify({ cwd: '/project', scope: 'project' })
  expect(screen.queryByLabelText('回复语言')).toBeNull()
  values.language = 'Current project'
  view.rerender(<ClaudeConfigSettings cwd="/other" />)
  await waitFor(() => expect((screen.getByLabelText('回复语言') as HTMLInputElement).value).toBe('Current project'))
  values.language = 'Old project'
  await act(async () => late(snapshot()))
  expect((screen.getByLabelText('回复语言') as HTMLInputElement).value).toBe('Current project')
  view.unmount()
  expect(listeners.size).toBe(0)
})

it('does not cancel the save or claim live application when receiving its own invalidation', async () => {
  let notify!: Parameters<Window['desk']['meta']['onConfigChanged']>[0]
  window.desk.meta.onConfigChanged = listener => { notify = listener; return () => {} }
  vi.mocked(window.desk.meta.config).mockImplementation(async () => {
    values.autoCompact = 'false'
    notify({ cwd: '/project', scope: 'user' })
    return 'Set autoCompact to false'
  })
  render(<ClaudeConfigSettings cwd="/project" />)
  fireEvent.click(await screen.findByRole('switch', { name: '自动压缩对话' }))
  await screen.findByText('已保存 · 后续启动生效')
  expect(window.desk.chat.applySetting).not.toHaveBeenCalled()
  expect(screen.getByRole('switch', { name: '自动压缩对话' }).getAttribute('aria-checked')).toBe('false')
})


it('keeps desktop execution and workflow controls but hides terminal and unknown options', async () => {
  const keys = ['workflows', 'workflowKeywordTriggerEnabled', 'workflowSizeGuideline', 'worktreeBaseRef', 'thinking', 'useAutoModeDuringPlan', 'switchModelsOnFlag', 'theme', 'autoScroll', 'reduceMotion', 'copyOnSelect', 'copyFullResponse', 'editor', 'defaultToAgentsView', 'leftArrowOpensAgents', 'prStatus', 'progressBar', 'promptSuggestionEnabled', 'recap', 'timeFormat', 'tips', 'turnDuration', 'verbose', 'autoConnectIde', 'externalEditorContext', 'agentPushNotifEnabled', 'inputNeededNotifEnabled', 'notifChannel', 'remoteControl', 'checkpoints', 'futureOption']
  vi.mocked(window.desk.meta.configSnapshot).mockResolvedValue({ cliVersion: '2.1.301', items: keys.map(key => ({ key, values: ['true', 'false'], value: 'true', source: 'saved' })) })
  useDesk.setState({ view: { kind: 'settings', tab: 'advanced', projectId: 'p' } })
  render(<SettingsPage />)
  const workflows = await screen.findByRole('switch', { name: '工作流' })
  expect(screen.getAllByRole('switch')).toHaveLength(6)
  expect(screen.queryByText('终端主题')).toBeNull()
  expect(screen.queryByText('futureOption')).toBeNull()
  expect(screen.queryByRole('switch', { name: /检查点/ })).toBeNull()
  expect(screen.queryByText('文件检查点')).toBeNull()
  fireEvent.click(workflows)
  await waitFor(() => expect(window.desk.meta.config).toHaveBeenCalledWith('/project', 'workflows=false'))
})

it('drops informational-only rows and reports reload errors in the desktop context page', async () => {
  useDesk.setState({ view: { kind: 'settings', tab: 'context', sessionId: 's', projectId: 'p' } })
  window.desk.chat.reloadConfiguration = vi.fn().mockRejectedValue(new Error('请等待当前任务结束后重载'))
  render(<SettingsPage />)
  await screen.findByRole('switch', { name: '自动压缩对话' })
  expect(screen.queryByText('遵循 .gitignore')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重新加载当前对话设置' }))
  expect((await screen.findByRole('alert')).textContent).toContain('请等待当前任务结束后重载')
  expect(window.desk.chat.reloadConfiguration).toHaveBeenCalledWith('s', '/project')
})


it('does not claim success or apply a value to the current session when reread disagrees', async () => {
  useDesk.setState({ view: { kind: 'settings', tab: 'context', sessionId: 's', projectId: 'p' } })
  window.desk.meta.config = vi.fn().mockResolvedValue('Saved')
  render(<SettingsPage />)
  const input = await screen.findByLabelText('回复语言')
  fireEvent.change(input, { target: { value: 'Japanese' } })
  expect((await screen.findByRole('alert')).textContent).toContain('读取结果与所选值不一致')
  expect(window.desk.chat.applySetting).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toContain('当前读取值：English')
  expect((screen.getByLabelText('回复语言') as HTMLSelectElement).value).toBe('English')
})

it('confirms immediate language application only after persisted value agrees', async () => {
  useDesk.setState({ view: { kind: 'settings', tab: 'context', sessionId: 's', projectId: 'p' } })
  render(<SettingsPage />)
  fireEvent.change(await screen.findByLabelText('回复语言'), { target: { value: 'Japanese' } })
  await screen.findByText('已保存 · 当前对话配置已确认')
  expect(window.desk.chat.applySetting).toHaveBeenCalledWith('s', '/project', 'language', 'Japanese')
})

it('reports native test delivery and provides a system-settings shortcut', async () => {
  let deliver!: () => void
  const notify = vi.fn(() => new Promise<void>(resolve => { deliver = resolve }))
  const openNotificationSettings = vi.fn().mockResolvedValue(undefined)
  window.desk.app = { notify, openNotificationSettings } as unknown as Window['desk']['app']
  useDesk.setState({ view: { kind: 'settings', tab: 'notifications' } })
  render(<SettingsPage />)
  fireEvent.click(screen.getByRole('button', { name: '发送测试通知' }))
  expect((screen.getByRole('button', { name: '正在发送…' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByRole('status')).toBeNull()
  await act(async () => deliver())
  expect(screen.getByRole('status').textContent).toBe('已发送测试通知。')
  fireEvent.click(screen.getByRole('button', { name: '打开系统设置' }))
  expect(openNotificationSettings).toHaveBeenCalledOnce()
})

it('exposes local retention defaults and saves them without writing CLI configuration', async () => {
 const updateSettings=vi.fn().mockResolvedValue(undefined)
 useDesk.setState({view:{kind:'settings',tab:'general'},updateSettings})
 render(<SettingsPage />)
 expect((screen.getByLabelText('驻留会话保留数量') as HTMLSelectElement).value).toBe('4')
 expect((screen.getByLabelText('超额会话闲置回收时间') as HTMLSelectElement).value).toBe('15')
 fireEvent.change(screen.getByLabelText('驻留会话保留数量'),{target:{value:'6'}})
 await waitFor(()=>expect(updateSettings).toHaveBeenCalledWith({retainedSessions:6}))
 fireEvent.change(screen.getByLabelText('超额会话闲置回收时间'),{target:{value:'30'}})
 await waitFor(()=>expect(updateSettings).toHaveBeenCalledWith({sessionIdleMinutes:30}))
 expect(window.desk.meta.config).not.toHaveBeenCalled()
})
