// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WelcomePage } from '../src/renderer/components/welcome/WelcomePage'
import { SettingsPage } from '../src/renderer/components/settings/SettingsPage'
import { useDesk } from '../src/renderer/store'
import { validators } from '../src/main/ipc/validators'
import type { MetaInfo, ModelOption, Settings } from '../src/shared/types'

const initial: Settings = { theme: 'light', defaultModel: 'sonnet', defaultEffort: 'high', defaultPermissionMode: 'default', claudePath: null, allowBypass: false }
const models: ModelOption[] = [
  { value: 'sonnet', label: 'Sonnet', resolvedModel: 'deepseek-chat', efforts: [] },
  { value: 'custom/code', label: 'Custom Code', resolvedModel: 'vendor-code-v2', efforts: ['low', 'high'] }
]
const meta = (items = models): MetaInfo => ({ models: items, claudeVersion: null, subscriptionType: null })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { resolve, reject, promise }
}
beforeEach(() => {
  useDesk.setState({ home: '/home', projects: [], settings: { ...initial }, welcomeOpen: true, demo: null, view: { kind: 'settings', tab: 'general' } })
  window.desk = {
    meta: { cachedModels: vi.fn().mockResolvedValue(null), get: vi.fn().mockResolvedValue(meta()) },
    settings: { get: vi.fn().mockResolvedValue(initial), set: vi.fn(async patch => ({ ...useDesk.getState().settings!, ...patch })) },
    app: { state: vi.fn().mockResolvedValue({ home: '/home', demo: null, seededFromHistory: true }) },
    projects: { list: vi.fn().mockResolvedValue([]) }
  } as unknown as Window['desk']
})
afterEach(cleanup)

function nextStep() {
  fireEvent.click(screen.getByRole('button', { name: '继续' }))
}

function openPreferences() {
  nextStep()
  nextStep()
}

it('previews both themes without writing settings and discards an interrupted flow', async () => {
  const { container, unmount } = render(<WelcomePage />)
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1')
  nextStep()
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2')
  fireEvent.click(screen.getByRole('radio', { name: '深色' }))
  expect(container.querySelector('[data-welcome-page]')?.getAttribute('data-preview')).toBe('dark')
  expect(window.desk.settings.set).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(useDesk.getState().welcomeOpen).toBe(false)
  expect(useDesk.getState().settings?.theme).toBe('light')
  unmount()
  render(<WelcomePage />)
  nextStep()
  expect((screen.getByRole('radio', { name: '浅色' }) as HTMLInputElement).checked).toBe(true)
})

it('uses the real catalog, displays mapped IDs, constrains effort, and saves CLI values atomically', async () => {
  render(<WelcomePage />)
  nextStep()
  fireEvent.click(screen.getByRole('radio', { name: '深色' }))
  nextStep()
  await screen.findByText('实际模型：deepseek-chat')
  expect(window.desk.meta.get).toHaveBeenCalledWith('/home')
  const model = screen.getByLabelText(/默认模型/)
  const effort = screen.getByLabelText(/思考程度/)
  expect((effort as HTMLSelectElement).disabled).toBe(true)
  fireEvent.change(model, { target: { value: 'custom/code' } })
  expect([...screen.getAllByRole('option')].filter(option => option.parentElement === effort).map(option => (option as HTMLOptionElement).value)).toEqual(['', 'low', 'high'])
  fireEvent.change(effort, { target: { value: 'high' } })
  fireEvent.click(screen.getByRole('button', { name: '开始使用' }))
  await waitFor(() => expect(useDesk.getState().welcomeOpen).toBe(false))
  expect(window.desk.settings.set).toHaveBeenCalledExactlyOnceWith({ welcomeCompleted: true, theme: 'dark', defaultModel: 'custom/code', defaultEffort: 'high' })
})

it('refreshes on provider changes without retaining unsupported effort or saving a disappeared model', async () => {
  let changed!: Parameters<NonNullable<Window['desk']['meta']['onConfigChanged']>>[0]
  const off = vi.fn()
  window.desk.meta.onConfigChanged = vi.fn(listener => { changed = listener; return off })
  const { unmount } = render(<WelcomePage />)
  openPreferences()
  await screen.findByText('实际模型：deepseek-chat')
  fireEvent.change(screen.getByLabelText(/默认模型/), { target: { value: 'custom/code' } })
  fireEvent.change(screen.getByLabelText(/思考程度/), { target: { value: 'high' } })
  vi.mocked(window.desk.meta.get).mockResolvedValue(meta([{ value: 'custom/code', label: 'Custom Code', resolvedModel: 'replacement', efforts: [] }]))
  act(() => changed({ scope: 'user', cwd: '/home' }))
  await screen.findByText('实际模型：replacement')
  expect((screen.getByLabelText(/思考程度/) as HTMLSelectElement).value).toBe('')
  vi.mocked(window.desk.meta.get).mockResolvedValue(meta([]))
  act(() => changed({ scope: 'user', cwd: '/home' }))
  await screen.findByText('当前 CLI 未提供可用模型。')
  fireEvent.click(screen.getByRole('button', { name: '开始使用' }))
  await waitFor(() => expect(window.desk.settings.set).toHaveBeenCalledExactlyOnceWith({ welcomeCompleted: true, theme: 'light' }))
  unmount()
  expect(off).toHaveBeenCalledOnce()
})

it('prompts for a model when the saved default is absent from the current CLI catalog', async () => {
  useDesk.setState({ settings: { ...initial, defaultModel: 'old-provider-model' } })
  render(<WelcomePage />)
  openPreferences()
  await screen.findByRole('option', { name: 'Custom Code' })
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3')
  const model = screen.getByLabelText('默认模型') as HTMLSelectElement
  const finish = screen.getByRole('button', { name: '开始使用' }) as HTMLButtonElement
  expect(model.selectedOptions[0].textContent).toBe('选择模型')
  expect(finish.disabled).toBe(true)
  fireEvent.change(model, { target: { value: 'custom/code' } })
  expect(finish.disabled).toBe(false)
  fireEvent.click(finish)
  await waitFor(() => expect(window.desk.settings.set).toHaveBeenCalledExactlyOnceWith({
    welcomeCompleted: true, theme: 'light', defaultModel: 'custom/code', defaultEffort: null
  }))
})

it('handles loading, cached metadata and failure without inventing models; retry recovers', async () => {
  const pending = deferred<MetaInfo>()
  vi.mocked(window.desk.meta.cachedModels).mockResolvedValue(models)
  vi.mocked(window.desk.meta.get).mockReturnValueOnce(pending.promise)
  render(<WelcomePage />)
  openPreferences()
  await screen.findByText('正在读取 CLI 模型…')
  expect((screen.getByLabelText(/默认模型/) as HTMLSelectElement).disabled).toBe(true)
  await act(async () => pending.reject(new Error('CLI unavailable')))
  await screen.findByText('模型读取失败。')
  expect(screen.queryByRole('option', { name: 'Opus' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '刷新欢迎页模型' }))
  await waitFor(() => expect((screen.getByLabelText(/默认模型/) as HTMLSelectElement).disabled).toBe(false))
  expect((screen.getByLabelText(/默认模型/) as HTMLSelectElement).disabled).toBe(false)
})

it('locks repeated submissions and dismissal during writes, then retains the draft on failure', async () => {
  const write = deferred<Settings>()
  vi.mocked(window.desk.settings.set).mockReturnValueOnce(write.promise)
  render(<WelcomePage />)
  nextStep()
  fireEvent.click(screen.getByRole('radio', { name: '深色' }))
  nextStep()
  await screen.findByText('实际模型：deepseek-chat')
  const finish = screen.getByRole('button', { name: '开始使用' })
  fireEvent.click(finish)
  fireEvent.click(finish)
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(useDesk.getState().welcomeOpen).toBe(true)
  expect(window.desk.settings.set).toHaveBeenCalledOnce()
  await act(async () => write.reject(new Error('disk full')))
  expect(screen.getByRole('alert').textContent).toContain('disk full')
  fireEvent.click(screen.getByRole('button', { name: '上一步' }))
  expect((screen.getByRole('radio', { name: '深色' }) as HTMLInputElement).checked).toBe(true)
  nextStep()
  fireEvent.click(screen.getByRole('button', { name: '开始使用' }))
  await waitFor(() => expect(useDesk.getState().welcomeOpen).toBe(false))
})

it('persists first-run completion through the existing settings contract and allows reopening', async () => {
  expect(validators['settings:set']([{ welcomeCompleted: true }])).toEqual([{ welcomeCompleted: true }])
  expect(() => validators['settings:set']([{ welcomeCompleted: 'yes' }])).toThrow()
  await useDesk.getState().init()
  expect(useDesk.getState().welcomeOpen).toBe(true)
  vi.mocked(window.desk.settings.get).mockResolvedValue({ ...initial, welcomeCompleted: true })
  await useDesk.getState().init()
  expect(useDesk.getState().welcomeOpen).toBe(false)
  useDesk.setState({ view: { kind: 'settings', tab: 'general' } })
  render(<SettingsPage />)
  fireEvent.click(screen.getByRole('button', { name: '打开欢迎页' }))
  expect(useDesk.getState().welcomeOpen).toBe(true)
  expect(window.desk.settings.set).not.toHaveBeenCalled()
})

it('traps keyboard focus in the welcome dialog and restores the prior control', async () => {
  const prior = document.createElement('button')
  document.body.appendChild(prior)
  prior.focus()
  const { unmount } = render(<WelcomePage />)
  const dialog = screen.getByRole('dialog')
  expect(document.activeElement).toBe(dialog)
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '继续' }))
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
  expect(screen.queryByRole('button', { name: '关闭欢迎页' })).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '稍后设置' }))
  unmount()
  expect(document.activeElement).toBe(prior)
  prior.remove()
})
