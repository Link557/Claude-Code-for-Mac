import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'

export function applyFableMapping(models: ModelInfo[], env: Record<string, unknown>): ModelInfo[] {
  const mapping = env.ANTHROPIC_DEFAULT_FABLE_MODEL
  if (typeof mapping !== 'string' || !mapping.trim()) return models
  const id = mapping.trim()
  // Some CLI versions advertise a fixed official Fable ID even with an alias override.
  // Submit the configured wire ID, and never inherit official model capabilities.
  const known = models.find(m => m.value === id || m.resolvedModel === id)
  const mapped: ModelInfo = { ...known, value: id, resolvedModel: id, displayName: 'Fable', description: '使用当前配置的 Fable 模型映射' }
  const isFable = (m: ModelInfo) => m.value === 'fable' || /^claude-fable-/i.test(m.value) || /^fable(?:\s|$)/i.test(m.displayName)
  const index = models.findIndex(isFable)
  return index < 0 ? [...models.filter(m => m.value !== id), mapped] : models.flatMap((m, i) => i === index ? [mapped] : isFable(m) || m.value === id ? [] : [m])
}
