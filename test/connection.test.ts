import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ dialog: {}, clipboard: {}, shell: {} }))
vi.mock('../src/main/sdk', () => ({ claudeRuntime: vi.fn(), withIdleQuery: vi.fn() }))
import { parseAuthentication, posixLoginCommand } from '../src/main/connection'
it('quotes the login executable literally for POSIX shells', () => {
  expect(posixLoginCommand("/Users/O'Brien/$(bad)/claude")).toBe("'/Users/O'\\''Brien/$(bad)/claude' auth login")
})
it('exposes only safe metadata from authentication status', () => {
  expect(parseAuthentication(JSON.stringify({ loggedIn: true, apiProvider: 'firstParty', authMethod: 'claude.ai', apiKey: 'secret' }))).toEqual({ loggedIn: true, provider: 'firstParty', authMethod: 'claude.ai', configDirectory: null })
  expect(parseAuthentication('{"loggedIn":false}').loggedIn).toBe(false)
  expect(() => parseAuthentication('{}')).toThrow('有效的登录状态')
})
