// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DisplayNameEditor } from '../src/renderer/components/settings/DisplayNameEditor'
import { UsagePage } from '../src/renderer/components/usage/UsagePage'
import { UsageNav } from '../src/renderer/components/usage/UsageNav'
import { useDesk } from '../src/renderer/store'
import { useUsage } from '../src/renderer/usageStore'
import { EMPTY_ANALYTICS } from '../src/shared/usageAnalytics'
import { EMPTY_HISTORY } from '../src/renderer/greeting'

beforeEach(() => {
  useDesk.setState({ username: '本机用户', settings: { theme: 'light', defaultModel: 'opus', defaultPermissionMode: 'default', defaultEffort: null, claudePath: null, allowBypass: false } })
  useUsage.setState({ overview: null, error: 'offline', loading: false, lastAttempt: Date.now() })
  window.desk = {
    settings: { set: vi.fn(async patch => ({ ...useDesk.getState().settings!, ...patch })) },
    usage: { stats: vi.fn(async () => ({ ...EMPTY_ANALYTICS, updatedAt: Date.now(), total: 42 })) },
    chat: { onEvent: vi.fn(() => () => {}) }
  } as unknown as Window['desk']
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('edits a local name offline and updates both shared entry points', async () => {
  render(<><DisplayNameEditor /><DisplayNameEditor compact /></>)
  fireEvent.click(screen.getAllByRole('button', { name: '修改显示名称' })[0])
  fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '小林' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await screen.findAllByText('小林')
  expect(screen.getAllByRole('button', { name: '修改显示名称' }).every(b => b.textContent === '小林')).toBe(true)
  expect(window.desk.settings.set).toHaveBeenCalledWith({ displayName: '小林' })
})

it('keeps the old name and shows save errors', async () => {
  vi.mocked(window.desk.settings.set).mockRejectedValue(new Error('磁盘不可写'))
  render(<DisplayNameEditor />)
  fireEvent.click(screen.getByRole('button', { name: '修改显示名称' }))
  fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '小林' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  expect((await screen.findByRole('alert')).textContent).toContain('磁盘不可写')
  expect(useDesk.getState().settings?.displayName).toBeUndefined()
})

it('retains local token charts and name editing without subscription quota', async () => {
  useUsage.setState({ error: null, overview: {
    account: { key: 'gateway', email: null, organization: null, subscriptionType: null },
    profile: { name: '本机用户', avatar: null }, usage: { available: false, windows: [], subscriptionType: null }, updatedAt: Date.now()
  } })
  render(<><UsageNav /><UsagePage /></>)
  expect(screen.getByRole('button', { name: '使用情况' })).toBeTruthy()
  expect(screen.queryByLabelText('套餐额度')).toBeNull()
  expect(screen.queryByText(/5h/)).toBeNull()
  expect(screen.getByLabelText('Token 活动')).toBeTruthy()
  expect(screen.getByRole('button', { name: '修改显示名称' })).toBeTruthy()
  await screen.findByText('42')
})

it('allows editing while account lookup fails and uses the local name for subsequent greetings', async () => {
  render(<UsagePage />)
  fireEvent.click(screen.getByRole('button', { name: '修改显示名称' }))
  fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '小林' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await screen.findByText('小林')
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 8, 9))
  vi.spyOn(Math, 'random').mockReturnValue(0)
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(EMPTY_HISTORY), setItem: vi.fn() })
  act(() => { useDesk.setState({ projects: [{ id: 'p', name: 'p', path: '/tmp', addedAt: 0, collapsed: false }] }); useDesk.getState().newChat() })
  expect(useDesk.getState().greeting).toBe('早上好，小林')
})
