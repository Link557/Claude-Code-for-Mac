// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuotaCrab } from '../src/renderer/components/usage/QuotaCrab'
import { UsageNav } from '../src/renderer/components/usage/UsageNav'
import { UsageCharts } from '../src/renderer/components/usage/UsageCharts'
import { UsagePage } from '../src/renderer/components/usage/UsagePage'
import { useUsage, useUsageStats } from '../src/renderer/usageStore'
import { startUsagePolling } from '../src/renderer/usagePolling'
import { useDesk } from '../src/renderer/store'
import type { UsageAnalytics, UsageOverview } from '../src/shared/usageAnalytics'
const overview: UsageOverview = { account: { key: 'a', email: 'a@test.com', organization: null, subscriptionType: 'pro' }, profile: { name: 'A', avatar: null }, usage: { available: true, subscriptionType: 'pro', windows: [{ kind: 'five_hour', label: '5小时', percent: 20, resetsAt: null }, { kind: 'seven_day', label: '周', percent: 40, resetsAt: null }] }, updatedAt: 100 }
beforeEach(() => { useUsage.setState({ scope: '', overview: structuredClone(overview), error: null, loading: false, failures: 0, lastAttempt: 0 }); useUsageStats.setState({ stats: null, loading: false, error: null }); window.desk = { usage: { overview: vi.fn().mockResolvedValue(overview), saveProfile: vi.fn() } } as unknown as Window['desk'] })
afterEach(() => { cleanup(); vi.useRealTimers() })
describe('usage navigation and shared requests', () => {
  const projects = [
    { id: 'a', name: 'A', path: '/a', addedAt: 0, collapsed: false },
    { id: 'b', name: 'B', path: '/b', addedAt: 0, collapsed: false }
  ]

  it('starts polling the conversation project after five seconds, then follows project selection', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    useDesk.setState({ projects, selectedProjectId: 'a', view: { kind: 'session', sessionId: 's', projectId: 'b' } })
    const stop = startUsagePolling()
    try {
      expect(useUsage.getState().scope).toBe('/b')
      await vi.advanceTimersByTimeAsync(4999)
      expect(window.desk.usage.overview).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(window.desk.usage.overview).toHaveBeenCalledWith('/b')
      useDesk.setState({ view: { kind: 'new' } })
      await useUsage.getState().refresh()
      expect(window.desk.usage.overview).toHaveBeenLastCalledWith('/a')
      expect(window.desk.usage.overview).toHaveBeenCalledTimes(2)
    } finally {
      stop()
      visibility.mockRestore()
    }
  })

  it('ignores superseded successes and failures after switching A to B to A', async () => {
    let finishOldA!: (value: UsageOverview) => void
    let failB!: (reason: Error) => void
    let finishCurrent!: (value: UsageOverview) => void
    window.desk.usage.overview = vi.fn()
      .mockImplementationOnce(() => new Promise<UsageOverview>(resolve => { finishOldA = resolve }))
      .mockImplementationOnce(() => new Promise<UsageOverview>((_resolve, reject) => { failB = reject }))
      .mockImplementationOnce(() => new Promise<UsageOverview>(resolve => { finishCurrent = resolve }))
    useDesk.setState({ projects, selectedProjectId: 'a', view: { kind: 'new' } })
    const stop = startUsagePolling()
    try {
      const oldA = useUsage.getState().refresh()
      useDesk.setState({ selectedProjectId: 'b' })
      const oldB = useUsage.getState().refresh()
      useDesk.setState({ selectedProjectId: 'a' })
      const current = useUsage.getState().refresh()
      expect(vi.mocked(window.desk.usage.overview).mock.calls).toEqual([['/a'], ['/b'], ['/a']])
      finishOldA({ ...overview, profile: { name: '旧结果', avatar: null } })
      failB(new Error('旧请求失败'))
      await Promise.all([oldA, oldB])
      expect(useUsage.getState()).toMatchObject({ scope: '/a', overview: null, error: null, loading: true, failures: 0 })
      finishCurrent(overview)
      await current
      expect(useUsage.getState()).toMatchObject({ overview, loading: false })
    } finally {
      stop()
    }
  })

  it('saves the current project profile without applying the response to another project', async () => {
    let finish!: (profile: UsageOverview['profile']) => void
    const profile = { name: '更新的头像', avatar: null }
    window.desk.usage.saveProfile = vi.fn(() => new Promise<UsageOverview['profile']>(resolve => { finish = resolve }))
    useUsage.getState().setScope('/a')
    await useUsage.getState().refresh()
    const saving = useUsage.getState().saveProfile(profile)
    expect(window.desk.usage.saveProfile).toHaveBeenCalledWith(overview.account.key, profile, '/a')
    useUsage.getState().setScope('/b')
    await useUsage.getState().refresh()
    finish(profile)
    await saving
    expect(useUsage.getState().overview?.profile).toEqual(overview.profile)
  })

  it('scans on opening and shows no zero-valued chart before the first result', async () => {
    let resolve!: (value: UsageAnalytics) => void
    const stats = vi.fn(() => new Promise<UsageAnalytics>(done => { resolve = done }))
    window.desk.usage.stats = stats
    window.desk.chat = { onEvent: vi.fn(() => () => {}) } as any
    render(<UsagePage />)
    expect(stats).toHaveBeenCalledWith(true)
    expect(screen.queryByLabelText('用量明细')).toBeNull()
    await act(async () => resolve({ days: [], total: 0, peak: 0, longestTaskMs: null, longestStreak: 0, currentStreak: 0, updatedAt: 1, firstDate: null, issues: 0, scanning: false }))
    expect(screen.getByLabelText('用量明细')).toBeTruthy()
  })
  it('retains the last successful statistics when a later scan fails', async () => {
    const previous = { days: [], total: 42, peak: 42, longestTaskMs: null, longestStreak: 1, currentStreak: 1, updatedAt: 1, firstDate: '2026-11-10', issues: 0, scanning: false }
    window.desk.usage.stats = vi.fn().mockResolvedValueOnce(previous).mockRejectedValueOnce(new Error('offline'))
    await useUsageStats.getState().refresh()
    const a = useUsageStats.getState().refresh(), b = useUsageStats.getState().refresh()
    expect(a).toBe(b)
    await a
    expect(useUsageStats.getState()).toMatchObject({ stats: previous, error: 'offline', loading: false })
  })
  it('shows remaining windows on one entry and routes without changing session state', () => {
    render(<UsageNav />)
    expect(screen.getByText('5h 80% · 周 60%')).toBeTruthy()
    expect(screen.getByText('柴火正旺')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '剩余额度' }))
    expect(useDesk.getState().view).toEqual({ kind: 'usage' })
  })
  it('retains last data on failure, and unknown is not shown as zero', async () => {
    window.desk.usage.overview = vi.fn().mockRejectedValue(new Error('offline'))
    render(<UsageNav />)
    await act(() => useUsage.getState().refresh())
    expect(useUsage.getState().overview).toEqual(overview)
    expect(screen.getByRole('button').title).toContain('上次读取')
    act(() => useUsage.setState({ overview: null }))
    expect(screen.getByText('暂不可用')).toBeTruthy()
    expect(screen.queryByText(/0%/)).toBeNull()
  })
  it('never carries old quota into a different account when the new quota fails', async () => {
    window.desk.usage.overview = vi.fn().mockResolvedValue({ ...overview, account: { ...overview.account, key: 'b' }, profile: { name: 'B', avatar: null }, usage: null, usageError: 'unavailable' })
    render(<UsageNav />)
    await act(() => useUsage.getState().refresh())
    expect(useUsage.getState().overview?.account.key).toBe('b')
    expect(useUsage.getState().overview?.usage).toBeNull()
    expect(screen.getByText(/暂不可用/)).toBeTruthy()
    expect(screen.queryByText(/80%/)).toBeNull()
  })
  it('deduplicates simultaneous refreshes and replaces account profile together', async () => {
    let resolve!: (value: UsageOverview) => void
    window.desk.usage.overview = vi.fn(() => new Promise<UsageOverview>(done => { resolve = done }))
    const a = useUsage.getState().refresh(), b = useUsage.getState().refresh()
    expect(window.desk.usage.overview).toHaveBeenCalledTimes(1)
    resolve({ ...overview, account: { ...overview.account, key: 'b' }, profile: { name: 'B', avatar: null } })
    await Promise.all([a, b])
    expect(useUsage.getState().overview?.profile.name).toBe('B')
  })
})
describe('chart views', () => {
  it('filters all six detail metrics by model while preserving the selected date range', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 1, 12))
    render(<UsageCharts days={[
      { date: '2025-01-01', input: 40, output: 0, cacheRead: 0, cacheWrite: 0, total: 40, byModel: { opus: { input: 40, output: 0, cacheRead: 0, cacheWrite: 0 } } },
      { date: '2026-10-30', input: 100, output: 25, cacheRead: 50, cacheWrite: 25, total: 200, byModel: {
        opus: { input: 10, output: 5, cacheRead: 30, cacheWrite: 20 },
        sonnet: { input: 20, output: 10, cacheRead: 10, cacheWrite: 5 },
        fable: { input: 30, output: 5, cacheRead: 10, cacheWrite: 0 }
      } }
    ]} />)
    const panel = screen.getByLabelText('用量明细'), picker = within(panel).getByRole('group', { name: '用量模型' })
    const value = (label: string) => panel.querySelector(`[data-usage-metric="${label}"]`)?.lastElementChild?.textContent
    const choose = (model: string) => fireEvent.click(within(picker).getByRole('button', { name: model[0].toUpperCase() + model.slice(1) }))
    expect(within(picker).getAllByRole('button').map(button => button.textContent)).toEqual(['Total', 'Fable', 'Opus', 'Sonnet', 'Haiku'])
    expect(within(picker).getByRole('button', { name: 'Total' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.mouseEnter(screen.getByRole('button', { name: '2026-10-30 · 200 Token' }))
    choose('opus')
    expect(['累计 Token', '缓存命中率', '输入', '输出', '缓存读取', '缓存写入'].map(value)).toEqual(['65', '50%', '10', '5', '30', '20'])
    expect(panel.textContent).toContain('2026年10月30日')
    choose('sonnet'); expect(value('累计 Token')).toBe('45')
    choose('fable'); expect(value('累计 Token')).toBe('45')
    choose('haiku'); expect(value('累计 Token')).toBe('0'); expect(value('缓存命中率')).toBe('—')
    choose('total'); expect(value('累计 Token')).toBe('200')
    choose('opus'); fireEvent.click(screen.getByText('每周'))
    expect(value('累计 Token')).toBe('65')
    fireEvent.click(screen.getByText('累计'))
    expect(value('累计 Token')).toBe('105')
    expect(value('缓存命中率')).toBe('30%')
    expect(panel.textContent).toContain('2025年1月1日 至 2026年11月1日')
    fireEvent.click(screen.getByText('每天'))
    expect(value('累计 Token')).toBe('0')
    expect(within(picker).getByRole('button', { name: 'Opus' }).getAttribute('aria-pressed')).toBe('true')
  })
  it('updates the lower card on hover and focus, keeping cumulative history and weighted cache rates', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 1, 12))
    render(<UsageCharts days={[{ date: '2025-01-01', input: 100, output: 0, cacheRead: 0, cacheWrite: 0, total: 100 }, { date: '2026-10-30', input: 20, output: 5, cacheRead: 10, cacheWrite: 15, total: 50 }]} />)
    const panel = screen.getByLabelText('用量明细')
    fireEvent.mouseEnter(screen.getByRole('button', { name: /2026-10-30 · 50 Token/ }))
    expect(panel.textContent).toContain('2026年10月30日')
    expect(within(panel).getByText('20')).toBeTruthy()
    expect(within(panel).getByText('22.2%')).toBeTruthy()
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    fireEvent.click(screen.getByText('每周'))
    const week = screen.getByRole('button', { name: /2026-10-26 至 2026-11-01 · 50 Token/ })
    expect(week.children.length).toBe(7)
    fireEvent.focus(week)
    expect(panel.textContent).toContain('2026年10月26日 至 2026年11月1日')
    fireEvent.click(screen.getByText('累计'))
    fireEvent.focus(screen.getByRole('button', { name: /累计至 2026-11-01 · 150 Token/ }))
    expect(panel.textContent).toContain('2025年1月1日 至 2026年11月1日')
    expect(within(panel).getByText('150')).toBeTruthy()
    expect(panel.querySelectorAll('[data-usage-metric]')).toHaveLength(6)
    expect(within(panel).getByText('累计 Token')).toBeTruthy()
    expect(within(panel).getByText('6.9%')).toBeTruthy()
    fireEvent.click(screen.getByText('每天'))
    expect(within(panel).getByText('—')).toBeTruthy()
    vi.useRealTimers()
  })
})

it('renders independent five-hour and weekly remaining amounts, including empty and unavailable states', () => {
  const view = render(<QuotaCrab fiveHour={80} weekly={25} />)
  expect(view.container.querySelector('[data-quota-crab]')?.getAttribute('data-five-hour')).toBe('80')
  expect(view.container.querySelector('[data-quota-fill]')?.getAttribute('height')).toBe('4')
  expect(view.container.querySelector('[data-quota-fill]')?.getAttribute('y')).toBe('24')
  view.rerender(<QuotaCrab fiveHour={0} weekly={100} />)
  expect(view.container.querySelector('[data-quota-ring]')).toBeNull()
  expect(view.container.querySelector('[data-quota-fill]')?.getAttribute('height')).toBe('16')
  view.rerender(<QuotaCrab fiveHour={null} weekly={undefined} />)
  expect(view.container.querySelector('[data-quota-crab]')?.getAttribute('data-weekly')).toBe('unknown')
  expect(view.container.querySelector('[data-quota-fill]')).toBeNull()
})
