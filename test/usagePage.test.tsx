// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuotaCrab } from '../src/renderer/components/usage/QuotaCrab'
import { UsageNav } from '../src/renderer/components/usage/UsageNav'
import { UsageCharts } from '../src/renderer/components/usage/UsageCharts'
import { useUsage } from '../src/renderer/usageStore'
import { startUsagePolling } from '../src/renderer/usagePolling'
import { useDesk } from '../src/renderer/store'
import type { UsageOverview } from '../src/shared/usageAnalytics'
const overview: UsageOverview = { account: { key: 'a', email: 'a@test.com', organization: null, subscriptionType: 'pro' }, profile: { name: 'A', avatar: null }, usage: { available: true, subscriptionType: 'pro', windows: [{ kind: 'five_hour', label: '5小时', percent: 20, resetsAt: null }, { kind: 'seven_day', label: '周', percent: 40, resetsAt: null }] }, updatedAt: 100 }
beforeEach(() => { useUsage.setState({ scope: '', overview: structuredClone(overview), error: null, loading: false, failures: 0, lastAttempt: 0 }); window.desk = { usage: { overview: vi.fn().mockResolvedValue(overview), saveProfile: vi.fn() } } as unknown as Window['desk'] })
afterEach(() => { cleanup(); vi.useRealTimers() })
describe('usage navigation and shared requests', () => {
  it('sets the project scope immediately and waits five seconds before the first poll', async () => {
    vi.useFakeTimers()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    useDesk.setState({ projects: [{ id: 'a', name: 'a', path: '/a', addedAt: 0, collapsed: false }], selectedProjectId: 'a', view: { kind: 'new' } })
    const stop = startUsagePolling()
    expect(useUsage.getState().scope).toBe('/a')
    expect(window.desk.usage.overview).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(window.desk.usage.overview).toHaveBeenCalledWith('/a')
    stop()
    hidden.mockRestore()
    useDesk.setState({ projects: [], selectedProjectId: null })
  })
  it('isolates in-flight quota responses across projects', async () => {
    let finish!: (value: UsageOverview) => void
    window.desk.usage.overview = vi.fn().mockImplementationOnce(() => new Promise<UsageOverview>(resolve => { finish = resolve }))
      .mockResolvedValueOnce({ ...overview, usage: { available: false, subscriptionType: null, windows: [] } })
    useDesk.setState({ projects: [{ id: 'a', name: 'a', path: '/a', addedAt: 0, collapsed: false }, { id: 'b', name: 'b', path: '/b', addedAt: 0, collapsed: false }], selectedProjectId: 'a', view: { kind: 'new' } })
    const stop = startUsagePolling()
    const old = useUsage.getState().refresh()
    useDesk.setState({ selectedProjectId: 'b' })
    await useUsage.getState().refresh()
    finish(overview); await old
    expect(useUsage.getState().overview?.usage?.available).toBe(false)
    expect(window.desk.usage.overview).toHaveBeenNthCalledWith(1, '/a')
    expect(window.desk.usage.overview).toHaveBeenNthCalledWith(2, '/b')
    stop()
    useDesk.setState({ projects: [], selectedProjectId: null })
    useUsage.setState({ scope: '' })
  })
  it('ignores an old response after switching A to B and back to A', async () => {
    let finishOld!: (value: UsageOverview) => void
    let finishNew!: (value: UsageOverview) => void
    window.desk.usage.overview = vi.fn()
      .mockImplementationOnce(() => new Promise<UsageOverview>(resolve => { finishOld = resolve }))
      .mockImplementationOnce(() => new Promise<UsageOverview>(resolve => { finishNew = resolve }))
    useDesk.setState({ projects: [{ id: 'a', name: 'a', path: '/a', addedAt: 0, collapsed: false }, { id: 'b', name: 'b', path: '/b', addedAt: 0, collapsed: false }], selectedProjectId: 'a', view: { kind: 'new' } })
    const stop = startUsagePolling()
    expect(useUsage.getState().scope).toBe('/a')
    const old = useUsage.getState().refresh()
    useDesk.setState({ selectedProjectId: 'b' })
    useDesk.setState({ selectedProjectId: 'a' })
    const current = useUsage.getState().refresh()
    finishOld({ ...overview, profile: { name: '旧结果', avatar: null } })
    await old
    expect(useUsage.getState().overview).toBeNull()
    expect(useUsage.getState().loading).toBe(true)
    finishNew(overview)
    await current
    expect(useUsage.getState().overview?.profile.name).toBe('A')
    stop()
    useDesk.setState({ projects: [], selectedProjectId: null })
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
    expect(['累计 Token', '缓存命中率', '输入', '输出', '缓存读取', '缓存写入'].map(value)).toEqual(['65', '50%', '60', '5', '30', '20'])
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
    expect(within(panel).getByText('45')).toBeTruthy()
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
