import { expect, it } from 'vitest'
import { applyFableMapping } from '../src/main/fableMapping'
const official = { value: 'claude-fable-5-1[1m]', displayName: 'Fable', description: '', supportsEffort: true, supportedEffortLevels: ['high' as const] }
it('replaces a fixed official ID with the configured third-party ID without assuming capabilities', () => {
  expect(applyFableMapping([official], { ANTHROPIC_DEFAULT_FABLE_MODEL: 'deepseek-chat' })).toEqual([
    { value: 'deepseek-chat', resolvedModel: 'deepseek-chat', displayName: 'Fable', description: '使用当前配置的 Fable 模型映射' }
  ])
})
it('retains Fable without a subscription when a mapping exists but CLI omits Fable', () => {
  expect(applyFableMapping([], { ANTHROPIC_DEFAULT_FABLE_MODEL: 'vendor/model' })[0].value).toBe('vendor/model')
})
it('preserves CLI models without an override and respects known target capabilities', () => {
  expect(applyFableMapping([official], {})).toEqual([official])
  const target = { value: 'custom', displayName: 'Custom', description: '', supportsEffort: true, supportedEffortLevels: ['low' as const] }
  expect(applyFableMapping([official, target], { ANTHROPIC_DEFAULT_FABLE_MODEL: 'custom' })[0].supportedEffortLevels).toEqual(['low'])
})
