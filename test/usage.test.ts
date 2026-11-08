import { describe, expect, it, vi } from 'vitest'
import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import { hasOfficialQuotaRoute, planUsage, readPlanUsage, toPlanUsage } from '../src/main/usage'

const idle = vi.hoisted(() => vi.fn())
vi.mock('../src/main/sdk', () => ({ withIdleQuery: idle }))

it('reads official limits when the user disables nonessential CLI traffic, without changing the process environment', async () => {
  vi.stubEnv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1')
  idle.mockImplementation(async (options, fn) => fn({
    accountInfo: async () => ({ apiProvider: 'firstParty' }),
    request: async () => ({ response: { effective: {}, sources: [] } }),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
      subscription_type: 'pro', rate_limits_available: true,
      rate_limits: options.settings?.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === ''
        ? { five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 43, resets_at: null } } : null
    })
  }))
  try {
    expect((await planUsage()).windows.map(w => w.percent)).toEqual([0, 43])
    expect(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
    expect(idle.mock.calls.at(-1)?.[0]).toMatchObject({ tools: [], strictMcpConfig: true, settings: { disableAllHooks: true, env: { DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' } } })
  } finally { vi.unstubAllEnvs() }
})

const win = (utilization: number | null, resets_at: string | null = '2026-11-02T17:00:00Z') => ({ utilization, resets_at })

it('does not fetch official quota for a configured gateway even when an official login remains', async () => {
  const usage = vi.fn()
  const q = {
    request: async () => ({ response: { effective: { env: { ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic' } }, sources: [] } }),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage
  } as unknown as import('@anthropic-ai/claude-agent-sdk').Query
  expect(await readPlanUsage(q, { apiProvider: 'firstParty', subscriptionType: 'pro' })).toEqual({ available: false, windows: [], subscriptionType: null })
  expect(usage).not.toHaveBeenCalled()
  expect(hasOfficialQuotaRoute({ apiProvider: 'bedrock' }, {})).toBe(false)
  expect(hasOfficialQuotaRoute({ apiProvider: 'firstParty' }, { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })).toBe(true)
})

describe('toPlanUsage', () => {
  it('按 5 小时、每周、各模型每周的顺序列出有数据的窗口', () => {
    const r = {
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        five_hour: win(85, '2026-10-30T16:30:00Z'),
        seven_day: win(14),
        seven_day_opus: null,
        seven_day_sonnet: win(null),
        model_scoped: [{ display_name: 'Fable', utilization: 3, resets_at: null }]
      }
    } as unknown as SDKControlGetUsageResponse
    expect(toPlanUsage(r)).toEqual({
      subscriptionType: 'pro',
      available: true,
      windows: [
        { kind: 'five_hour', label: '5 小时内', percent: 85, resetsAt: '2026-10-30T16:30:00Z' },
        { kind: 'seven_day', label: '本周（所有模型）', percent: 14, resetsAt: '2026-11-02T17:00:00Z' },
        { kind: 'model_week', label: '本周（Fable）', percent: 3, resetsAt: null }
      ]
    })
  })

  it('API Key 等不受套餐限制的情况', () => {
    const r = { subscription_type: null, rate_limits_available: false, rate_limits: null } as unknown as SDKControlGetUsageResponse
    expect(toPlanUsage(r)).toEqual({ subscriptionType: null, available: false, windows: [] })
  })
})
