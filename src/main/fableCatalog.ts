import type { ModelInfo, Query } from '@anthropic-ai/claude-agent-sdk'

const concreteId = (id: string) => id.replace(/\[1m\]$/, '')
const isFableId = (id: string) => /^claude-fable-[a-z0-9-]+$/i.test(id)
const modelId = (model: ModelInfo) => concreteId(model.resolvedModel ?? model.value)

function fableLabel(id: string): string {
  const version = /^claude-fable-(\d+(?:-\d{1,2})*)(?:-\d{8})?$/i.exec(id)?.[1]
  return version ? `Fable ${version.replaceAll('-', '.')}` : 'Fable'
}

export async function resolveFableCatalog(
  models: ModelInfo[], query: Pick<Query, 'setModel' | 'getContextUsage'>
): Promise<ModelInfo[]> {
  const aliasIndex = models.findIndex(m => m.value === 'fable')
  const index = aliasIndex >= 0 ? aliasIndex : models.findIndex(m => m.value !== 'default' && isFableId(modelId(m)))
  if (index < 0) return models

  // The SDK's advertised row can lag behind the alias used by the CLI.
  let resolved: string
  try {
    await query.setModel('fable')
    resolved = concreteId((await query.getContextUsage({ detail: 'summary' })).model)
  } catch {
    console.warn('无法核对 CLI 的 Fable 别名，保留 CLI 返回的模型目录')
    return models
  }
  const previous = models[index]
  if (!isFableId(resolved) || modelId(previous) === resolved) return models

  const target = models.find(m => m.value !== 'default' && modelId(m) === resolved)
  const current = { description: '', ...target, value: 'fable', resolvedModel: resolved, displayName: fableLabel(resolved) }
  return models.flatMap((model, i) => {
    if (i === index) return [current]
    return model === target ? [] : [model]
  })
}
