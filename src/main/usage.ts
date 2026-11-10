// 套餐用量：和终端里 /usage 看到的一样。SDK 的这个接口还标着「实验性」，以后版本可能会改名。
import { homedir } from 'node:os'
import type { AccountInfo, Query, SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import type { PlanUsage, UsageWindow } from '../shared/types'
import { withIdleQuery } from './sdk'
import { isConfigRecord, readConfigState } from './claudeConfigProtocol'
import { providerRoute } from './providerRoute'

/** Gateway/cloud quota is not the signed-in Claude account's subscription quota. */
export function hasOfficialQuotaRoute(account: AccountInfo, env: Record<string, unknown>): boolean {
  return providerRoute(account, env) === 'firstParty'
}

export async function readPlanUsage(q: Query, account: AccountInfo): Promise<PlanUsage> {
  if (account.apiProvider && account.apiProvider !== 'firstParty') return { subscriptionType: null, available: false, windows: [] }
  const config = await readConfigState(q)
  const env = { ...process.env, ...(isConfigRecord(config.effective.env) ? config.effective.env : {}) }
  if (!hasOfficialQuotaRoute(account, env)) return { subscriptionType: null, available: false, windows: [] }
  for (let attempt = 0; attempt < 2; attempt++) {
    const usage = toPlanUsage(await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }))
    if (!usage.available || usage.windows.length) return usage
    if (attempt === 0) await new Promise<void>(resolve => setTimeout(resolve, 2000))
  }
  throw new Error('额度接口未返回数据')
}

type Window = { utilization: number | null; resets_at: string | null } | null | undefined

export function toPlanUsage(r: SDKControlGetUsageResponse): PlanUsage {
  const rl = r.rate_limits
  const windows: UsageWindow[] = []
  const add = (kind: UsageWindow['kind'], label: string, w: Window): void => {
    if (w && typeof w.utilization === 'number' && Number.isFinite(w.utilization)) windows.push({ kind, label, percent: w.utilization, resetsAt: w.resets_at })
  }
  if (rl) {
    add('five_hour', '5 小时内', rl.five_hour)
    add('seven_day', '本周（所有模型）', rl.seven_day)
    add('model_week', '本周（Opus）', rl.seven_day_opus)
    add('model_week', '本周（Sonnet）', rl.seven_day_sonnet)
    for (const m of rl.model_scoped ?? []) add('model_week', `本周（${m.display_name}）`, m)
  }
  return { subscriptionType: r.subscription_type, available: r.rate_limits_available, windows }
}

/** A read-only quota query needs the official usage endpoint, even when normal
 * CLI sessions disable nonessential traffic. Keep this override inside the
 * short-lived query, with telemetry, hooks and tool/MCP execution disabled.
 * The CLI treats even the string "0" as enabled: use an empty string. */
export function withUsageQuery<T>(fn: (q: Query) => Promise<T>, cwd = homedir()): Promise<T> {
  return withIdleQuery({
    cwd, tools: [], mcpServers: {}, strictMcpConfig: true,
    settings: { disableAllHooks: true, env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '',
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1'
    } }
  }, fn)
}

export function planUsage(): Promise<PlanUsage> {
  return withUsageQuery(async q => readPlanUsage(q, await q.accountInfo()))
}
