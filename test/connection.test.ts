import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ dialog: {}, shell: {} }))
const sdk = vi.hoisted(() => ({ claudeRuntime: vi.fn(), withIdleQuery: vi.fn() }))
vi.mock('../src/main/sdk', () => sdk)
vi.mock('../src/main/systemProxy', () => ({ readSystemProxy: async () => ({}), proxyEnvironment: (_proxy: unknown, env: unknown) => env }))
vi.mock('../src/main/env', () => ({ adoptLoginShellEnv: async () => {} }))
vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], _options: unknown, done: (error: null, output: { stdout: string }) => void) => {
    done(null, { stdout: args[0] === '--version' ? '2.1.301' : '{"loggedIn":true,"apiProvider":"firstParty"}' })
  }
}))
import { connectionStatus, parseAuthentication, posixLoginCommand, powershellLoginCommand, powershellResumeCommand } from '../src/main/connection'

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
it('quotes the project and session without PowerShell interpolation', () => {
  expect(powershellResumeCommand("C:\\O'Brien\\claude.exe", "C:\\中文 $(whoami)\\project's", 'session-id')).toBe("Set-Location -LiteralPath 'C:\\中文 $(whoami)\\project''s'\r\n& 'C:\\O''Brien\\claude.exe' --resume 'session-id'")
})
