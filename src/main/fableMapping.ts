import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'

/** Correct an existing CLI row only. Never synthesize a Fable entry. */
export function applyFableMapping(models: ModelInfo[], env: Record<string, unknown>): ModelInfo[] {
  const mapping = env.ANTHROPIC_DEFAULT_FABLE_MODEL
  if (typeof mapping !== 'string' || !mapping.trim()) return models
  const id = mapping.trim()
  const fable = models.find(model => model.value === 'fable')
  if (!fable || fable.resolvedModel === id) return models
  const target = models.find(candidate => candidate !== fable && (candidate.value === id || candidate.resolvedModel === id))
  const mapped = { ...target, value: id, resolvedModel: id, displayName: fable.displayName, description: fable.description }
  return models.flatMap(model => model === fable ? [mapped] : model.value === id ? [] : [model])
}
