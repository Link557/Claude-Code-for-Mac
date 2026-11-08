import { expect, it } from 'vitest'
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { applyFableMapping } from '../src/main/fableMapping'
const fable: ModelInfo = { value: 'fable', displayName: 'Fable', description: 'Official', resolvedModel: 'claude-fable-5', supportsEffort: true, supportedEffortLevels: ['max'] }
it('does not synthesize Fable when the CLI omits it, even if an alias mapping is configured', () => {
  expect(applyFableMapping([], { ANTHROPIC_DEFAULT_FABLE_MODEL: 'custom-id' })).toEqual([])
})
it('corrects an existing alias without carrying official capabilities into a custom model', () => {
  expect(applyFableMapping([fable], { ANTHROPIC_DEFAULT_FABLE_MODEL: 'custom-id' })).toEqual([{ value: 'custom-id', resolvedModel: 'custom-id', displayName: 'Fable', description: 'Official' }])
})
it('reuses only reported target capabilities and deduplicates an earlier target row', () => {
  const target: ModelInfo = { value: 'custom-id', displayName: 'Custom', description: '', supportsEffort: true, supportedEffortLevels: ['low'] }
  expect(applyFableMapping([target, fable], { ANTHROPIC_DEFAULT_FABLE_MODEL: 'custom-id' })).toEqual([{ ...target, displayName: 'Fable', description: 'Official', resolvedModel: 'custom-id' }])
})
