import type { SDKControlInitializeResponse } from '@anthropic-ai/claude-agent-sdk'
import { loadSdk, claudeExecutable } from './sdk'
import { temporaryQuery } from './temporaryQuery'
import { isConfigRecord, readConfigState } from './claudeConfigProtocol'
import { listApiModels } from './modelApi'
import { modelChoices } from './modelChoices'
import { providerRoute } from './providerRoute'
export { closeTemporaryQueries as closeMetadataQueries } from './temporaryQuery'

export function readMetadata(cwd: string, signal?: AbortSignal, includeModels = false): Promise<SDKControlInitializeResponse & { modelCatalogError?: string }> {
  return temporaryQuery(async (abortController, input) => {
    const sdk = await loadSdk()
    if (abortController.signal.aborted) throw new Error('临时查询已取消')
    return sdk.query({ prompt: input, options: { cwd, persistSession: false, pathToClaudeCodeExecutable: claudeExecutable(), abortController } })
  }, async (query, querySignal) => {
    const init = await query.initializationResult()
    if (!includeModels) return init
    try {
      const config = await readConfigState(query)
      const env = { ...process.env, ...(isConfigRecord(config.effective.env) ? config.effective.env : {}) }
      const gateway = providerRoute(init.account ?? {}, env) === 'gateway'
        ? await listApiModels(env, querySignal)
        : undefined
      return { ...init, models: modelChoices(init.models, gateway, env) }
    } catch (error) {
      return {
        ...init,
        models: [],
        modelCatalogError: error instanceof Error ? error.message : '无法读取当前连接的模型。'
      }
    }
  }, signal)
}
