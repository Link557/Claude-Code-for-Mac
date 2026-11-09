import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk'

/** Auth identity and the request destination are independent. Do not expose endpoint credentials. */
export function providerRoute(account: Pick<AccountInfo, 'apiProvider'>, env: Record<string, unknown>): string {
  if (account.apiProvider && account.apiProvider !== 'firstParty') return account.apiProvider
  const base = env.ANTHROPIC_BASE_URL
  if (typeof base === 'string' && base.trim()) {
    let url: URL
    try { url = new URL(base) } catch { throw new Error('模型接入地址无效，请检查 Claude Code 配置') }
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('模型接入地址无效，请检查 Claude Code 配置')
    if (url.origin !== 'https://api.anthropic.com') return 'gateway'
  }
  return account.apiProvider ?? 'firstParty'
}
