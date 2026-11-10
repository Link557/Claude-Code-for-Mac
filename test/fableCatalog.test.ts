import { expect, it, vi } from 'vitest'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { resolveFableCatalog } from '../src/main/fableCatalog'

const previous = {
  value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: '',
  supportsEffort: true, supportedEffortLevels: ['max' as const]
}
const fable52 = { value: 'fable', resolvedModel: 'claude-fable-5-2', displayName: 'Fable 5.2', description: '' }

function runtime(model: string) {
  return {
    setModel: vi.fn<Pick<Query, 'setModel'>['setModel']>().mockResolvedValue(undefined),
    getContextUsage: vi.fn<Pick<Query, 'getContextUsage'>['getContextUsage']>().mockResolvedValue({ model } as Awaited<ReturnType<Query['getContextUsage']>>)
  }
}

it('replaces the stale Fable entry with the verified alias', async () => {
  const query = runtime(fable52.resolvedModel)
  expect(await resolveFableCatalog([previous], query)).toEqual([fable52])
  expect(query.setModel).toHaveBeenCalledWith('fable')
  expect(query.getContextUsage).toHaveBeenCalledWith({ detail: 'summary' })
})

it('uses the runtime ID and the matching entry capabilities when the alias changes again', async () => {
  const next = { ...previous, value: 'claude-fable-6-1', resolvedModel: 'claude-fable-6-1', supportedEffortLevels: ['high' as const] }
  expect(await resolveFableCatalog([fable52, next], runtime(next.value))).toEqual([
    { ...next, value: 'fable', displayName: 'Fable 6.1' }
  ])
})

it('keeps the catalog when Fable is missing or the runtime gives no new Fable ID', async () => {
  const query = runtime(previous.resolvedModel)
  expect(await resolveFableCatalog([], query)).toEqual([])
  expect(query.setModel).not.toHaveBeenCalled()
  expect(await resolveFableCatalog([previous], query)).toEqual([previous])
  expect(await resolveFableCatalog([previous], runtime('claude-sonnet-5-5'))).toEqual([previous])
})
