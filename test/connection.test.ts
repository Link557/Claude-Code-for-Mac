import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ dialog: {}, clipboard: {}, shell: {} }))
vi.mock('../src/main/sdk', () => ({ claudeRuntime: vi.fn(), withIdleQuery: vi.fn() }))
import { parseAuthentication, posixLoginCommand, posixResumeCommand } from '../src/main/connection'
it('quotes executable, project and session literally for POSIX shells', () => {
  expect(posixLoginCommand("/Users/O'Brien/$(bad)/claude")).toBe("'/Users/O'\\''Brien/$(bad)/claude' auth login")
  expect(posixResumeCommand('/cli', "/中文 project's", 'session')).toBe("cd -- '/中文 project'\\''s' && '/cli' --resume 'session'")
})
it('exposes only safe metadata from authentication status', () => {
  expect(parseAuthentication(JSON.stringify({ loggedIn: true, apiProvider: 'firstParty', authMethod: 'claude.ai', apiKey: 'secret' }))).toEqual({ loggedIn: true, provider: 'firstParty', authMethod: 'claude.ai', configDirectory: null })
  expect(parseAuthentication('{"loggedIn":false}').loggedIn).toBe(false)
  expect(() => parseAuthentication('{}')).toThrow('有效的登录状态')
})
