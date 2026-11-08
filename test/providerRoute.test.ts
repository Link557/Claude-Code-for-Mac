import { afterEach, expect, it, vi } from 'vitest'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { providerRoute } from '../src/main/providerRoute'
import { readRoutedUsage, withUsageQuery } from '../src/main/usage'
const mocks = vi.hoisted(() => ({ config: vi.fn(), idle: vi.fn() }))
vi.mock('../src/main/claudeConfigProtocol', () => ({ readConfigState: mocks.config, isConfigRecord: (v: unknown) => !!v && typeof v === 'object' }))
vi.mock('../src/main/sdk', () => ({ withIdleQuery: mocks.idle }))
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

it('distinguishes official, gateway, cloud and malformed routes without trusting subscription identity', () => {
  expect(providerRoute({ apiProvider: 'firstParty' }, {})).toBe('firstParty')
  expect(providerRoute({ apiProvider: 'firstParty' }, { ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' })).toBe('firstParty')
  expect(providerRoute({ apiProvider: 'firstParty' }, { ANTHROPIC_BASE_URL: 'https://gateway.example/v1' })).toBe('gateway')
  expect(providerRoute({ apiProvider: 'bedrock' }, {})).toBe('bedrock')
  expect(() => providerRoute({}, { ANTHROPIC_BASE_URL: 'bad-url' })).toThrow('接入地址无效')
})
it('never queries official quota for a gateway even with an OAuth subscription', async () => {
  const read = vi.fn()
  mocks.config.mockResolvedValue({ effective: { env: { ANTHROPIC_BASE_URL: 'https://gateway.example' } } })
  expect(await readRoutedUsage({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: read } as unknown as Query, { apiProvider: 'firstParty', subscriptionType: 'pro' })).toEqual({ available: false, subscriptionType: null, windows: [] })
  expect(read).not.toHaveBeenCalled()
})
it('keeps configuration failures visible instead of treating them as third-party accounts', async () => {
  mocks.config.mockRejectedValue(new Error('unreadable configuration'))
  await expect(readRoutedUsage({} as Query, { apiProvider: 'firstParty' })).rejects.toThrow('unreadable configuration')
})
it('confines the nonessential-traffic override to a tool-free query in the selected project', async () => {
  vi.stubEnv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1')
  mocks.idle.mockResolvedValue('result')
  await withUsageQuery(async () => true, '/project')
  expect(mocks.idle.mock.calls[0][0]).toMatchObject({ cwd: '/project', tools: [], strictMcpConfig: true, settings: { disableAllHooks: true, env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' } } })
  expect(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
})
