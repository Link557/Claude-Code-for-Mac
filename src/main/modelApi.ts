import { net } from 'electron'
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { isConfigRecord } from './claudeConfigProtocol'

const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export async function listApiModels(
  env: Record<string, unknown>,
  signal: AbortSignal
): Promise<ModelInfo[]> {
  const setting = (key: string): string | undefined => {
    const value = env[key]
    return typeof value === 'string' ? value.trim() || undefined : undefined
  }
  const configuredBase = setting('ANTHROPIC_BASE_URL')
  if (!configuredBase) {
    throw new Error('当前网关未提供可查询的模型接口地址。')
  }
  const base = new URL(configuredBase)
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('模型接口地址格式无效，请检查 ANTHROPIC_BASE_URL。')
  }
  const headers = new Headers({ 'anthropic-version': '2023-06-01', accept: 'application/json' })
  const token = setting('ANTHROPIC_AUTH_TOKEN')
  const key = setting('ANTHROPIC_API_KEY')
  try {
    if (token) headers.set('authorization', `Bearer ${token}`)
    if (key) headers.set('x-api-key', key)
    for (const line of setting('ANTHROPIC_CUSTOM_HEADERS')?.split('\n') ?? []) {
      const colon = line.indexOf(':')
      if (colon > 0) headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
    }
  } catch {
    throw new Error('模型接口的请求头格式无效，请检查接入配置。')
  }

  base.pathname = base.pathname.replace(/\/+$/, '') + '/v1/models'
  const models = new Map<string, ModelInfo>()
  const cursors = new Set<string>()
  for (;;) {
    let response: Response
    try {
      response = await net.fetch(base.toString(), { headers, signal, redirect: 'error', credentials: 'omit' })
    } catch {
      throw new Error('无法连接模型列表接口，请检查网络和接入地址。')
    }
    if (!response.ok) throw new Error(`模型列表接口返回 HTTP ${response.status}。`)
    const page: unknown = await response.json().catch(() => null)
    if (!isConfigRecord(page) || !Array.isArray(page.data)) throw new Error('模型列表接口返回了无法识别的数据。')
    for (const row of page.data) {
      if (!isConfigRecord(row) || typeof row.id !== 'string' || !row.id.trim()) continue
      const effort = isConfigRecord(row.capabilities) ? row.capabilities.effort : undefined
      const levels = isConfigRecord(effort) && effort.supported === true
        ? effortLevels.filter(level => {
          const capability = effort[level]
          return isConfigRecord(capability) && capability.supported === true
        }) : []
      models.set(row.id, {
        value: row.id,
        resolvedModel: row.id,
        displayName: typeof row.display_name === 'string' ? row.display_name : row.id,
        description: '',
        supportsEffort: levels.length > 0,
        supportedEffortLevels: levels
      })
    }
    if (page.has_more !== true) return [...models.values()]
    if (typeof page.last_id !== 'string' || !page.last_id || cursors.has(page.last_id)) {
      throw new Error('模型列表接口返回了无效的分页游标。')
    }
    cursors.add(page.last_id)
    base.searchParams.set('after_id', page.last_id)
  }
}
