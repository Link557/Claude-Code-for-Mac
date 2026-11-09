import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'

const families = new Map([
  ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']
])

export function modelChoices(cli: ModelInfo[], gateway?: ModelInfo[], env: Record<string, unknown> = {}): ModelInfo[] {
  const gatewayById = gateway && new Map(gateway.map(model => [model.value, model]))
  const choices: ModelInfo[] = []
  const represented = new Set<string>()
  const mappedFamilies = new Set<string>()
  const defaultModel = cli.find(row => row.value === 'default')
  if (defaultModel) {
    const target = defaultModel.resolvedModel ? gatewayById?.get(defaultModel.resolvedModel) : undefined
    choices.push(gateway
      ? { ...(target ?? { description: '' }), value: 'default', displayName: defaultModel.displayName || '默认模型' }
      : defaultModel)
  }
  for (const [alias, displayName] of families) {
    const model = cli.find(row => row.value === alias)
    if (!model) continue
    const configured = alias === 'fable' && typeof env.ANTHROPIC_DEFAULT_FABLE_MODEL === 'string'
      ? env.ANTHROPIC_DEFAULT_FABLE_MODEL.trim() : ''
    const id = configured || model.resolvedModel
    if (!id) continue
    const target = gatewayById ? gatewayById.get(id) : configured && configured !== model.resolvedModel
      ? cli.find(row => row !== model && (row.value === id || row.resolvedModel === id)) ?? { description: '' }
      : model
    if (!target) continue
    choices.push({ ...target, value: alias, resolvedModel: id, displayName })
    represented.add(id)
    mappedFamilies.add(alias)
  }

  for (const model of gateway ?? cli) {
    if (!gateway && (model.value === 'default' || families.has(model.value))) continue
    const id = model.resolvedModel ?? model.value
    if (represented.has(id)) continue
    const family = /^claude-(fable|opus|sonnet|haiku)-\d/i.exec(id)?.[1].toLowerCase()
    if (family && mappedFamilies.has(family)) continue
    if (choices.some(choice => choice.value === model.value)) continue
    choices.push({ ...model, resolvedModel: id })
    represented.add(id)
  }
  return choices
}
