import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import { readPlanUsage, toPlanUsage } from '../src/main/usage'

const win = (utilization: number | null, resets_at: string | null = '2026-11-02T17:00:00Z') => ({ utilization, resets_at })

describe('readPlanUsage', () => {
  const empty = { subscription_type: 'pro', rate_limits_available: true, rate_limits: null } as SDKControlGetUsageResponse
  const valid = { ...empty, rate_limits: { five_hour: win(0) } } as SDKControlGetUsageResponse
  afterEach(() => vi.useRealTimers())
  const query = (read: ReturnType<typeof vi.fn>) => ({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: read })

  it('keeps the initial request pending and recovers an empty response after two seconds', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(valid)
    const result = readPlanUsage(query(read))
    await vi.advanceTimersByTimeAsync(1999)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toEqual(toPlanUsage(valid))
    expect(read).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenNthCalledWith(2, { skipBehaviors: true })
  })

  it('stops after one retry when the CLI keeps returning empty data', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockResolvedValue(empty)
    const result = expect(readPlanUsage(query(read))).rejects.toThrow('额度接口未返回数据')
    await vi.advanceTimersByTimeAsync(2000)
    await result
    await vi.advanceTimersByTimeAsync(10000)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it.each([valid, { ...empty, rate_limits_available: false }])('does not retry valid data or accounts without quota', async response => {
    const read = vi.fn().mockResolvedValue(response)
    await expect(readPlanUsage(query(read))).resolves.toEqual(toPlanUsage(response))
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('passes explicit CLI errors through without retrying', async () => {
    const read = vi.fn().mockRejectedValue(new Error('offline'))
    await expect(readPlanUsage(query(read))).rejects.toThrow('offline')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('reports an error on the retry instead of treating the first empty result as success', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockResolvedValueOnce(empty).mockRejectedValueOnce(new Error('offline'))
    const result = expect(readPlanUsage(query(read))).rejects.toThrow('offline')
    await vi.advanceTimersByTimeAsync(2000)
    await result
    expect(read).toHaveBeenCalledTimes(2)
  })
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
