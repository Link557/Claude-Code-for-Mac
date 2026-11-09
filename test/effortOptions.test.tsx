// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { ModePicker } from '../src/renderer/components/newSession/ModePicker'
import { useDesk } from '../src/renderer/store'
import { sessionCommand } from '../src/shared/sessionCommand'
import type { ModelOption } from '../src/shared/types'
import type { SessionOptions } from '../src/shared/chat'

const opus: ModelOption = { value: 'opus', label: 'Opus', efforts: ['high'] }
const meta = (models: ModelOption[]) => ({ models, claudeVersion: null, subscriptionType: null })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function Harness({ cwd = '/project' }: { cwd?: string }) {
  const [options, setOptions] = useState<SessionOptions>({ model: 'opus', mode: 'default', effort: null })
  return <ModePicker cwd={cwd} options={options} onChange={patch => setOptions(o => ({ ...o, ...patch }))} />
}
beforeEach(() => {
  useDesk.setState({ demo: null, settings: null })
  Object.defineProperty(window, 'desk', { configurable: true, value: { meta: { cachedModels: vi.fn(async () => [opus]), get: vi.fn(async () => meta([opus])) } } })
})
afterEach(cleanup)

it('shows the resolved third-party model and submits its CLI identifier unchanged', async () => {
  vi.mocked(window.desk.meta.get).mockResolvedValue(meta([
    { value: 'sonnet', label: 'Sonnet', resolvedModel: 'deepseek-chat', efforts: [] },
    { value: 'vendor/custom-model', label: 'Custom model', efforts: [] }
  ]))
  const change = vi.fn()
  render(<ModePicker cwd="/project" options={{ model: 'sonnet', mode: 'default', effort: null }} onChange={change} />)
  fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
  await screen.findByText('deepseek-chat')
  fireEvent.click(screen.getByRole('button', { name: 'Custom model' }))
  expect(change).toHaveBeenCalledWith({ model: 'vendor/custom-model' })
})

it('refreshes the visible model catalog when the current CLI configuration changes', async () => {
  let changed!: (change: { cwd: string; scope: 'user' | 'project' }) => void
  const off = vi.fn()
  window.desk.meta.onConfigChanged = vi.fn(listener => { changed = listener; return off })
  const view = render(<Harness />)
  await waitFor(() => expect(window.desk.meta.get).toHaveBeenCalledOnce())
  vi.mocked(window.desk.meta.get).mockResolvedValue(meta([{ value: 'default', label: 'DeepSeek', resolvedModel: 'deepseek-chat', efforts: [] }]))
  act(() => changed({ cwd: '/different-project', scope: 'project' }))
  expect(window.desk.meta.get).toHaveBeenCalledOnce()
  act(() => changed({ cwd: '/different-project', scope: 'user' }))
  fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
  await screen.findByRole('button', { name: 'DeepSeek' })
  view.unmount()
  expect(off).toHaveBeenCalledOnce()
})

it('hides cached Fable while awaiting current models and does not invent resolved IDs', async () => {
  const live = deferred<ReturnType<typeof meta>>()
  vi.mocked(window.desk.meta.cachedModels).mockResolvedValue([{ value: 'fable', label: 'Fable', resolvedModel: 'old-fable-id', efforts: [] }])
  vi.mocked(window.desk.meta.get).mockReturnValue(live.promise)
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
  await act(async () => {})
  expect(screen.queryByRole('button', { name: 'Fable' })).toBeNull()
  await act(async () => live.resolve(meta([{ value: 'vendor/custom', label: 'Custom', efforts: [] }])))
  expect(screen.queryByRole('button', { name: 'Fable' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Custom' }).querySelector('small')).toBeNull()
})

it('shows the alias mapping but sends the original alias to the CLI', async () => {
  vi.mocked(window.desk.meta.get).mockResolvedValue(meta([{ value: 'sonnet', label: 'Provider model', resolvedModel: 'deepseek-chat', efforts: [] }]))
  const change = vi.fn()
  render(<ModePicker options={{ model: null, mode: 'default', effort: null }} onChange={change} />)
  fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
  const option = await screen.findByRole('button', { name: 'Provider model' })
  expect(option.querySelector('small')?.textContent).toBe('deepseek-chat')
  fireEvent.click(option)
  expect(change).toHaveBeenCalledWith({ model: 'sonnet' })
})

it('uses cached model capability while the live query is pending and keeps Ultracode selected', async () => {
  const live = deferred<ReturnType<typeof meta>>()
  vi.mocked(window.desk.meta.get).mockReturnValue(live.promise)
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: '选择思考程度' }))
  await screen.findByRole('button', { name: '高' })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Ultracode' }))
  fireEvent.click(screen.getByRole('button', { name: '高' }))
  fireEvent.click(screen.getByRole('button', { name: '选择思考程度' }))
  expect((screen.getByRole('checkbox', { name: 'Ultracode' }) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '自动' }))
  await act(async () => live.resolve(meta([opus])))
})
it('uses identical patches for commands and buttons', () => {
  expect(sessionCommand('/effort ultracode')).toEqual({ ultracode: true })
  expect(sessionCommand('/effort ultracode off')).toEqual({ ultracode: false })
  expect(sessionCommand('/effort auto')).toEqual({ effort: null })
  expect(sessionCommand('/effort high')).toEqual({ effort: 'high' })
})
it('keeps automatic available and exposes a retry when loading fails', async () => {
  vi.mocked(window.desk.meta.cachedModels).mockResolvedValue(null)
  vi.mocked(window.desk.meta.get).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(meta([opus]))
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: '选择思考程度' }))
  expect(screen.getByRole('button', { name: '自动' })).toBeTruthy()
  fireEvent.click(await screen.findByRole('button', { name: /读取失败/ }))
  await screen.findByRole('button', { name: '高' })
})
it('ignores late results from another project and late cached data', async () => {
  const old = deferred<ReturnType<typeof meta>>()
  const cache = deferred<ModelOption[] | null>()
  vi.mocked(window.desk.meta.cachedModels).mockImplementation(cwd => cwd === '/other' ? cache.promise : Promise.resolve(null))
  vi.mocked(window.desk.meta.get).mockImplementation(cwd => cwd === '/other' ? Promise.resolve(meta([{ value: 'opus', label: 'New', efforts: ['low'] }])) : old.promise)
  const view = render(<Harness />)
  view.rerender(<Harness cwd="/other" />)
  fireEvent.click(screen.getByRole('button', { name: '选择思考程度' }))
  await screen.findByRole('button', { name: '低' })
  await act(async () => { old.resolve(meta([opus])); cache.resolve([opus]) })
  await waitFor(() => expect(screen.queryByRole('button', { name: '高' })).toBeNull())
})

it('shows a cache that arrives after live failure and retains the retry', async () => {
  const cache = deferred<ModelOption[] | null>()
  vi.mocked(window.desk.meta.cachedModels).mockReturnValue(cache.promise)
  vi.mocked(window.desk.meta.get).mockRejectedValue(new Error('offline'))
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: '选择思考程度' }))
  await screen.findByRole('button', { name: /读取失败/ })
  await act(async () => cache.resolve([opus]))
  expect(screen.getByRole('button', { name: '高' })).toBeTruthy()
  expect(screen.queryByText('显示上次结果')).toBeNull()
})
it('retains cached capabilities and the error when the model catalog query fails after initialization', async () => {
  const cache = deferred<ModelOption[] | null>()
  vi.mocked(window.desk.meta.cachedModels).mockReturnValue(cache.promise)
  vi.mocked(window.desk.meta.get).mockResolvedValue({ ...meta([]), modelCatalogError: '网关不可用' })
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: '选择思考程度' }))
  await screen.findByText('网关不可用')
  await act(async () => cache.resolve([opus]))
  expect(screen.getByRole('button', { name: '高' })).toBeTruthy()
  expect(screen.getByText('网关不可用')).toBeTruthy()
})

it('selects the default model for a null model preference', async () => {
  const defaultModel = { value: 'default', label: '默认模型', efforts: ['high' as const] }
  vi.mocked(window.desk.meta.get).mockResolvedValue(meta([defaultModel, opus]))
  const change = vi.fn()
  render(<ModePicker options={{ model: null, mode: 'default', effort: null }} onChange={change} />)
  fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
  const option = await screen.findByRole('button', { name: '默认模型' })
  expect(option.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(option)
  expect(change).toHaveBeenCalledWith({ model: 'default' })
})
it('allows retry after an empty response', async () => {
  vi.mocked(window.desk.meta.cachedModels).mockResolvedValue(null)
  vi.mocked(window.desk.meta.get).mockResolvedValueOnce(meta([])).mockResolvedValue(meta([opus]))
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
  fireEvent.click(await screen.findByRole('button', { name: /没有可用模型/ }))
  await screen.findByRole('button', { name: 'Opus' })
})
it('discards an old CLI response when the executable changes', async () => {
  const old = deferred<ReturnType<typeof meta>>()
  vi.mocked(window.desk.meta.cachedModels).mockResolvedValue(null)
  vi.mocked(window.desk.meta.get).mockReturnValueOnce(old.promise).mockResolvedValue(meta([{ ...opus, efforts: ['low'] }]))
  render(<Harness />)
  act(() => useDesk.setState({ settings: { theme: 'system', defaultModel: 'opus', defaultEffort: null, defaultPermissionMode: 'default', claudePath: '/new', allowBypass: false } }))
  fireEvent.click(screen.getByRole('button', { name: '选择思考程度' }))
  await screen.findByRole('button', { name: '低' })
  await act(async () => old.resolve(meta([opus])))
  expect(screen.queryByRole('button', { name: '高' })).toBeNull()
})

it('shows resolved live values while keeping the requested automatic effort selected', async () => {
  const models = [
    { value: 'default', label: 'Default (recommended)', resolvedModel: 'claude-opus-resolved', efforts: [] },
    { ...opus, resolvedModel: 'claude-opus-resolved' }
  ]
  vi.mocked(window.desk.meta.cachedModels).mockResolvedValue(models)
  vi.mocked(window.desk.meta.get).mockResolvedValue(meta(models))
  render(<ModePicker live options={{ model: 'opus', mode: 'default', effort: null }} runtime={{ model: 'claude-opus-resolved', effort: 'high' }} onChange={vi.fn()} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '选择模型' }).textContent).toContain('Opus'))
  expect(screen.getByRole('button', { name: '选择思考程度' }).textContent).toContain('自动')
  fireEvent.click(screen.getByRole('button', { name: '选择思考程度' }))
  expect(screen.queryByText('实际思考程度：高')).toBeNull()
  expect(screen.queryByText(/当前使用/)).toBeNull()
  expect(screen.getByRole('button', { name: '自动' }).getAttribute('aria-pressed')).toBe('true')
})
it('explains environment overrides and does not show stale values as confirmed after an error', async () => {
  const onRetry = vi.fn()
  const props = { live: true, options: { model: 'opus', mode: 'default' as const, effort: 'low' as const }, onChange: vi.fn(), onRetry }
  const view = render(<ModePicker {...props} runtime={{ model: 'opus', effort: 'high', effortSource: 'CLAUDE_CODE_EFFORT_LEVEL 环境变量' }} />)
  fireEvent.click(screen.getByRole('button', { name: '选择思考程度' }))
  expect((await screen.findByText('当前使用：高（已选：低）')).getAttribute('title')).toContain('CLAUDE_CODE_EFFORT_LEVEL')
  view.rerender(<ModePicker {...props} runtime={{ model: 'opus', effort: 'high', error: 'read failed' }} />)
  expect(screen.getByRole('button', { name: '选择模型' }).textContent).toContain('Opus')
  expect(screen.getByRole('button', { name: '选择思考程度' }).textContent).toContain('低')
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(onRetry).toHaveBeenCalledOnce()
})
it('shows a requested model separately when the engine uses a different model', async () => {
  render(<ModePicker live inline="model" options={{ model: 'opus', mode: 'default', effort: null }} runtime={{ model: 'other-model', effort: 'high' }} onChange={vi.fn()} />)
  await screen.findByText('当前使用：other-model（已选：Opus）')
  expect(screen.getByRole('button', { name: 'Opus' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByText('当前使用：other-model（已选：Opus）')).toBeTruthy()
})

it('keeps Fast enabled during cooldown and lets the user turn it off', async () => {
  const onChange = vi.fn()
  render(<ModePicker live inline="model" options={{ model: 'opus', mode: 'default', effort: null, fastMode: true }} runtime={{ model: 'opus', effort: 'high', fastMode: 'cooldown' }} onChange={onChange} />)
  await screen.findByText('快速模式已开启，限流冷却中')
  const fast = screen.getByRole('checkbox', { name: 'Fast' }) as HTMLInputElement
  expect(fast.checked).toBe(true)
  fireEvent.click(fast)
  expect(onChange).toHaveBeenCalledWith({ fastMode: false })
})

it('shows saved choices and supported effort levels for a conversation without a running process', async () => {
  render(<ModePicker live options={{ model: 'opus', effort: 'high', mode: 'default' }} onChange={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '选择思考程度' }))
  await screen.findByRole('button', { name: '高' })
  expect(screen.getByRole('button', { name: '选择模型' }).textContent).toContain('Opus')
  expect(screen.getByRole('button', { name: '选择思考程度' }).textContent).toContain('高')
  expect(screen.queryByText(/状态未确认|无法读取会话状态/)).toBeNull()
  expect((screen.getByRole('checkbox', { name: 'Ultracode' }) as HTMLInputElement).disabled).toBe(false)
})
it('keeps retry failures visible in one message without rejecting into the UI', async () => {
  const retry = vi.fn().mockRejectedValue(new Error('offline'))
  render(<ModePicker live inline="effort" runtime={{ error: 'read failed' }} options={{ model: 'opus', effort: 'high', mode: 'default' }} onChange={vi.fn()} onRetry={retry} />)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await waitFor(() => expect(screen.getByText(/暂时无法读取/).parentElement?.title).toBe('offline'))
  expect(screen.getAllByRole('button', { name: '重试' })).toHaveLength(1)
  await screen.findByRole('button', { name: '高' })
})

it('omits Fable when the connection does not offer it', async () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
  await screen.findByRole('button', { name: 'Opus' })
  expect(screen.queryByRole('button', { name: 'Fable' })).toBeNull()
})
it('allows a mapped Fable without a subscription and sends the configured model ID', async () => {
  vi.mocked(window.desk.meta.get).mockResolvedValue(meta([{ value: 'deepseek-chat', label: 'Fable', resolvedModel: 'deepseek-chat', efforts: [] }]))
  const change = vi.fn()
  render(<ModePicker options={{ model: 'opus', mode: 'default', effort: null }} onChange={change} />)
  fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
  await screen.findByText('deepseek-chat')
  const button = screen.getByRole('button', { name: 'Fable' }) as HTMLButtonElement
  expect(button.disabled).toBe(false)
  fireEvent.click(button)
  expect(change).toHaveBeenCalledWith({ model: 'deepseek-chat' })
})
