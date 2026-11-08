import { afterAll, expect, it, vi } from 'vitest'
import { contract, invokeChannels, type DeskApi } from '../src/shared/ipc/contract'
import { validators } from '../src/main/ipc/validators'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, unknown>(),
  exposed: undefined as unknown,
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/claude-desk-test', getVersion: () => '0', focus: vi.fn(), dock: undefined },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  ipcMain: { handle: (channel: string, fn: unknown) => {
    if (electron.handlers.has(channel)) throw new Error(`重复注册 ${channel}`)
    electron.handlers.set(channel, fn)
  } },
  nativeTheme: {},
  shell: {},
  Notification: class {},
  WebContentsView: class {},
  contextBridge: { exposeInMainWorld: (_key: string, api: unknown) => { electron.exposed = api } },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
  webUtils: { getPathForFile: () => '/from/webUtils' }
}))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('../src/main/usageWorkerClient', () => ({ UsageWorkerClient: class {} }))

afterAll(async () => { (await import('../src/main/ipc')).chats.closeAll() })
it('validates local names and retention limits before persisting settings', () => {
  expect(() => validators['settings:set']([{ retainedSessions: 0 }])).toThrow()
  expect(() => validators['settings:set']([{ sessionIdleMinutes: 121 }])).toThrow()
  expect(() => validators['settings:set']([{ retainedSessions: 1.5 }])).toThrow()
  expect(() => validators['settings:set']([{ displayName: '\u0001bad' }])).toThrow()
  expect(validators['settings:set']([{ retainedSessions: 4, sessionIdleMinutes: 15, displayName: '小林' }])).toEqual([{ retainedSessions: 4, sessionIdleMinutes: 15, displayName: '小林' }])
})

it('registers every invoke channel in the contract exactly once', async () => {
  const { registerIpc } = await import('../src/main/ipc')
  const { registerWorkspaceIpc } = await import('../src/main/workspace')
  registerIpc(null)
  registerWorkspaceIpc()
  expect([...electron.handlers.keys()].sort()).toEqual(invokeChannels().sort())
})

it('builds the preload api from the contract', async () => {
  await import('../src/preload/index')
  const api = electron.exposed as DeskApi
  for (const [namespace, members] of Object.entries(contract)) {
    expect(Object.keys((api as unknown as Record<string, object>)[namespace]).sort()).toEqual(Object.keys(members).sort())
  }

  void api.chat.send('s', '/p', 'hi', { model: null, mode: 'default', effort: null })
  expect(electron.invoke).toHaveBeenCalledWith('chat:send', 's', '/p', 'hi', { model: null, mode: 'default', effort: null })

  const listener = vi.fn()
  const off = api.chat.onEvent(listener)
  const [route, handler] = electron.on.mock.calls[0]
  expect(route).toBe('chat:onEvent')
  handler({}, 's', { kind: 'state' })
  expect(listener).toHaveBeenCalledWith('s', { kind: 'state' })
  off()
  expect(electron.removeListener).toHaveBeenCalledWith('chat:onEvent', handler)

  expect(api.files.pathFor({} as File)).toBe('/from/webUtils')
})

it('keeps the existing error messages for rejected arguments', () => {
  expect(() => validators['chat:interrupt']([''])).toThrow('参数 id 无效')
  expect(() => validators['chat:setFastMode'](['s', 'yes'])).toThrow('无效开关值')
  expect(() => validators['chat:mcpAction'](['/p', 'drop', 'x'])).toThrow('无效的 MCP 操作')
  expect(() => validators['terminal:open'](['bad', '/p'])).toThrow('页面标识无效')
  expect(() => validators['terminal:write'](['page:a', 'x'.repeat(1_000_001)])).toThrow('终端输入无效')
  expect(() => validators['app:setDockBadge']([-1])).toThrow('无效未读数量')
})

it('rejects malformed structured arguments', () => {
  const options = { model: null, mode: 'default', effort: null }
  expect(() => validators['chat:start'](['/p', 'hi', { ...options, mode: 'root' }])).toThrow('参数 options 无效')
  expect(() => validators['chat:respond'](['s', 'r', { type: 'allow-all' }])).toThrow('参数 decision 无效')
  expect(() => validators['chat:queue'](['s', '/p', { type: 'move', id: 'a' }])).toThrow('参数 action 无效')
  expect(() => validators['chat:changeRule'](['s', '/p', { source: 'policySettings', behavior: 'allow', rule: 'Read' }])).toThrow('参数 change 无效')
  expect(() => validators['chat:changeRule'](['s', '/p', { source: 'localSettings', behavior: 'allow', rule: 'Read\nBash' }])).toThrow('参数 change 无效')
  expect(() => validators['chat:applySetting'](['s', '/p', 'unknown', 'true'])).toThrow('参数 key 无效')
  expect(() => validators['chat:stopTask'](['s', '/p', ''])).toThrow('参数 taskId 无效')
  expect(() => validators['settings:set']([{ executionLanguage: 'fr' }])).toThrow('参数 patch 无效')
  expect(() => validators['schedules:create']([{ name: 'n', projectPath: '/p', prompt: 'x', schedule: { kind: 'yearly' }, mode: 'default', enabled: true }])).toThrow('参数 task 无效')
})

it('normalizes optional and loose arguments the way handlers used to', () => {
  const options = { model: null, mode: 'default', effort: null, extra: 1 }
  expect(validators['chat:send'](['s', '/p', 'hi', options])).toEqual(['s', '/p', 'hi', { model: null, mode: 'default', effort: null }, []])
  expect(validators['meta:get']([null])).toEqual([undefined])
  expect(validators['skills:list']([''])).toEqual([null])
  expect(validators['chat:mcp'](['', '/p'])).toEqual([null, '/p'])
  expect(validators['chat:setModel'](['s'])).toEqual(['s', null])
  expect(validators['chat:btw'](['s', '/p', 'q', undefined, options])[3]).toEqual([])
  expect(validators['files:stat']([['/a', 1, '/b']])).toEqual([['/a', '/b']])
  expect(validators['projects:setCollapsed'](['p', 'yes'])).toEqual(['p', false])
  const change = { source: 'localSettings', behavior: 'allow', rule: ' Read ', remove: true }
  expect(validators['chat:changeRule'](['s', '/p', change])).toEqual(['s', '/p', change])
  expect(validators['terminal:resize'](['page:a', Number.NaN, 10])).toEqual(['page:a', Number.NaN, 10])
})
