import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { send, type Handlers } from './ipc/register'

/** Only the owning window's top-level renderer may control its pin state. */
export function windowForControls(event: IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (process.platform !== 'win32' || !win || win.isDestroyed() || event.senderFrame !== event.sender.mainFrame || win.webContents !== event.sender) {
    throw new Error('窗口控制不可用')
  }
  return win
}

export const windowControlHandlers: Handlers<'window'> = {
  alwaysOnTop: event => windowForControls(event).isAlwaysOnTop(),
  toggleAlwaysOnTop: event => {
    const win = windowForControls(event)
    const enabled = !win.isAlwaysOnTop()
    // Electron 44's default floating level can report non-topmost on Windows.
    win.setAlwaysOnTop(enabled, 'normal')
    const actual = win.isAlwaysOnTop()
    if (actual !== enabled) throw new Error('系统未能更改窗口置顶状态，请重试')
    return actual
  }
}

export function syncWindowControls(win: BrowserWindow): void {
  // The event can precede the native flag update, or report an unsuccessful request.
  win.on('always-on-top-changed', () => queueMicrotask(() => {
    if (!win.isDestroyed()) send(win.webContents, 'window:onAlwaysOnTopChanged', win.isAlwaysOnTop())
  }))
}
