import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { syncWindowControls, windowControlHandlers, windowForControls } from '../src/main/windowControls'
import { validators } from '../src/main/ipc/validators'

const native = vi.hoisted(() => ({ fromWebContents: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: native.fromWebContents } }))
afterEach(() => vi.restoreAllMocks())
function fixture() {
  const frame = {}
  const sender = { mainFrame: frame, send: vi.fn(), isDestroyed: () => false }
  let pinned = false
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, webContents: sender,
    isAlwaysOnTop: () => pinned,
    setAlwaysOnTop: vi.fn((value: boolean) => { pinned = value; win.emit('always-on-top-changed', {}, value) })
  }) as unknown as BrowserWindow
  native.fromWebContents.mockReturnValue(win)
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
  return { win, sender, event }
}

it('toggles the owning window from its native state and publishes both transitions', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const { win, sender, event } = fixture()
  syncWindowControls(win)
  expect(windowControlHandlers.alwaysOnTop(event)).toBe(false)
  expect(windowControlHandlers.toggleAlwaysOnTop(event)).toBe(true)
  expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'normal')
  await Promise.resolve()
  expect(windowControlHandlers.toggleAlwaysOnTop(event)).toBe(false)
  await Promise.resolve()
  expect(sender.send.mock.calls).toEqual([
    ['window:onAlwaysOnTopChanged', true], ['window:onAlwaysOnTopChanged', false]
  ])
  expect(validators['window:alwaysOnTop']([])).toEqual([])
  expect(validators['window:toggleAlwaysOnTop']([])).toEqual([])
})

it('rejects subframes, detached senders and destroyed windows', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const { win, event } = fixture()
  expect(() => windowForControls({ ...event, senderFrame: {} } as IpcMainInvokeEvent)).toThrow()
  native.fromWebContents.mockReturnValue(null)
  expect(() => windowForControls(event)).toThrow()
  native.fromWebContents.mockReturnValue({ ...win, isDestroyed: () => true })
  expect(() => windowForControls(event)).toThrow()
})

it('does not change macOS or Linux window behavior', () => {
  const { win, event } = fixture()
  for (const platform of ['darwin', 'linux'] as const) {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    expect(() => windowControlHandlers.toggleAlwaysOnTop(event)).toThrow()
  }
  expect(win.setAlwaysOnTop).not.toHaveBeenCalled()
})

it('reports a failed native request and never publishes an unverified enabled state', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const { win, sender, event } = fixture()
  vi.mocked(win.setAlwaysOnTop).mockImplementation(() => { (win as unknown as EventEmitter).emit('always-on-top-changed', {}, true) })
  syncWindowControls(win)
  expect(() => windowControlHandlers.toggleAlwaysOnTop(event)).toThrow('系统未能更改窗口置顶状态')
  await Promise.resolve()
  expect(sender.send).toHaveBeenCalledWith('window:onAlwaysOnTopChanged', false)
})
