import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ dialog: {}, shell: {} }))
const sdk = vi.hoisted(() => ({ claudeRuntime: vi.fn(), withIdleQuery: vi.fn() }))
const execution = vi.hoisted(() => ({ auth: '{"loggedIn":true,"apiProvider":"firstParty"}', failAuth: false }))
vi.mock('../src/main/sdk', () => sdk)
vi.mock('../src/main/systemProxy', () => ({ readSystemProxy: async () => ({}), proxyEnvironment: (_proxy: unknown, env: unknown) => env }))
vi.mock('../src/main/env', () => ({ adoptLoginShellEnv: async () => {} }))
vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], _options: unknown, done: (error: Error | null, output: { stdout: string }) => void) => {
    if (args[0] !== '--version' && execution.failAuth) return done(new Error('auth timeout'), { stdout: '' })
    done(null, { stdout: args[0] === '--version' ? '2.1.301' : execution.auth })
  }
}))
import { connectionStatus, parseAuthentication, posixLoginCommand, powershellLoginCommand } from '../src/main/connection'

beforeEach(() => { execution.auth = '{"loggedIn":true,"apiProvider":"firstParty"}'; execution.failAuth = false; vi.clearAllMocks() })

it('leaves authentication unknown when the CLI auth status check fails', async () => {
  sdk.claudeRuntime.mockReturnValue({ path: 'claude.exe', source: 'installed' })
  execution.failAuth = true
  const status = await connectionStatus('/test-project')
  expect(status).toMatchObject({ state: 'ready', loggedIn: null, provider: null })
  expect(status.error).toContain('登录状态检测失败')
  expect(sdk.withIdleQuery).not.toHaveBeenCalled()
})

it('preserves signed-out authentication if the later provider probe fails', async () => {
  sdk.claudeRuntime.mockReturnValue({ path: 'claude.exe', source: 'installed' })
  execution.auth = '{"loggedIn":false,"authMethod":"none"}'
  sdk.withIdleQuery.mockRejectedValueOnce(new Error('provider failed'))
  const status = await connectionStatus('/test-project')
  expect(status).toMatchObject({ state: 'ready', loggedIn: false, provider: null })
  expect(status.error).toContain('检查项目配置')
})

it('reports a project probe failure without returning SDK credentials or a stale provider', async () => {
  sdk.claudeRuntime.mockReturnValue({ path: 'claude.exe', source: 'installed' })
  sdk.withIdleQuery.mockRejectedValueOnce(new Error('gateway https://user:fixture-secret@example.invalid'))
  const status = await connectionStatus('/test-project')
  expect(status).toMatchObject({ loggedIn: true, provider: null, version: '2.1.301' })
  expect(status.error).toContain('检查项目配置')
  expect(JSON.stringify(status)).not.toContain('fixture-secret')
  expect(sdk.withIdleQuery).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/test-project', tools: [], mcpServers: {} }), expect.any(Function))
})

it('quotes a macOS executable without evaluating shell expressions', () => {
  expect(posixLoginCommand("/Users/O'Brien/$(bad)/claude")).toBe("'/Users/O'\\''Brien/$(bad)/claude' auth login")
})

it('only exposes safe metadata from official authentication status', () => {
  const parsed = parseAuthentication(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', configDirectory: 'C:\\Users\\name\\.claude', apiKey: 'secret', accessToken: 'secret', email: 'private@example.com' }))
  expect(parsed).toEqual({ loggedIn: true, authMethod: 'claude.ai', provider: 'firstParty', configDirectory: 'C:\\Users\\name\\.claude' })
  expect(JSON.stringify(parsed)).not.toContain('secret')
})
it('distinguishes signed out, third-party and invalid responses', () => {
  expect(parseAuthentication('{"loggedIn":false,"authMethod":"none"}').loggedIn).toBe(false)
  expect(parseAuthentication('{"loggedIn":true,"apiProvider":"bedrock"}').provider).toBe('bedrock')
  expect(() => parseAuthentication('{}')).toThrow('有效的登录状态')
})
it('quotes the chosen executable as a literal PowerShell argument', () => {
  expect(powershellLoginCommand("C:\\O'Brien $(bad)\\claude.exe")).toBe("& 'C:\\O''Brien $(bad)\\claude.exe' auth login")
})
