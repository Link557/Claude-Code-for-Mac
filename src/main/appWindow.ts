import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron'

/** 窗口的隐藏、唤回和应用退出由同一个所有者控制；渲染层不管理进程生命周期。 */
export class AppWindow {
  private window: BrowserWindow | null = null
  private quitting = false
  private cleaned = false
  private visibleWanted = true
  constructor(private cleanup: () => void) {
    app.on('activate', () => this.open())
    app.on('second-instance', () => this.open())
    app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
    app.on('before-quit', () => {
      this.quitting = true
      if (this.cleaned) return
      this.cleaned = true
      try { this.cleanup() } catch (error) { console.error('退出清理失败', error) }
    })
  }
  installMenu(): void {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [
        { role: 'about' as const }, { type: 'separator' as const }, { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const }, { type: 'separator' as const },
        { id: 'quit-app', label: '退出 Claude Code', accelerator: 'Command+Q', click: () => app.quit() }
      ] }] : []),
      { label: '文件', submenu: [{ id: 'close-window', label: '关闭窗口', accelerator: 'CommandOrControl+W', click: () => this.window?.close() }] },
      { role: 'editMenu', label: '编辑' }, { role: 'viewMenu', label: '显示' }, { role: 'windowMenu', label: '窗口' }
    ]))
  }
  open(): void {
    if (this.quitting || !app.isReady()) return
    this.visibleWanted = true
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore()
      this.window.show(); this.window.focus()
      return
    }
    const win = this.create()
    this.window = win
    win.on('close', (event) => {
      if (process.platform === 'darwin' && !this.quitting) { event.preventDefault(); this.visibleWanted = false; win.hide() }
    })
    win.on('closed', () => { if (this.window === win) this.window = null })
  }
  private create(): BrowserWindow {
    const titleBarColors = () => ({ color: nativeTheme.shouldUseDarkColors ? '#1f1e1d' : '#f8f8f7', symbolColor: nativeTheme.shouldUseDarkColors ? '#f5f4ee' : '#37352f', height: 40 })
    const win = new BrowserWindow({
      width: 1280, height: 820, minWidth: 960, minHeight: 600,
      ...(process.platform === 'win32' ? { icon: app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(__dirname, '../../build/icon.ico') } : {}),
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } } : process.platform === 'win32' ? { titleBarStyle: 'hidden' as const, titleBarOverlay: titleBarColors(), autoHideMenuBar: true } : { autoHideMenuBar: true }),
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#ffffff', show: false,
      webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
    })
    if (process.platform === 'win32') {
      // Give the shell the full ICO resource instead of relying on the window's
      // small-icon fallback, which renders undersized in the Windows 11 taskbar.
      if (app.isPackaged) win.setAppDetails({
        appId: 'local.nature.claude-desk.windows',
        appIconPath: join(process.resourcesPath, 'icon.ico'),
        appIconIndex: 0,
        relaunchCommand: `"${process.execPath}"`,
        relaunchDisplayName: 'Claude Code'
      })
      const updateTitleBar = () => { if (!win.isDestroyed()) win.setTitleBarOverlay(titleBarColors()) }
      nativeTheme.on('updated', updateTitleBar)
      win.once('closed', () => nativeTheme.removeListener('updated', updateTitleBar))
    }
    const shotPath = process.env.CLAUDE_DESK_SHOT
    win.once('ready-to-show', () => {
      if (this.quitting || !this.visibleWanted || win.isDestroyed()) return
      if (shotPath) win.showInactive()
      else win.show()
      if (shotPath) setTimeout(async () => {
        if (win.isDestroyed()) return
        writeFileSync(shotPath, (await win.capturePage()).toPNG())
        app.exit(0)
      }, Number(process.env.CLAUDE_DESK_SHOT_DELAY ?? 2500))
    })
    const devServer = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    const entry = devServer ? new URL(devServer) : pathToFileURL(join(__dirname, '../renderer/index.html'))
    const allowed = (url: string): boolean => {
      try {
        const target = new URL(url)
        return target.protocol === entry.protocol && target.host === entry.host && target.pathname === entry.pathname
      } catch { return false }
    }
    win.webContents.on('will-navigate', (event) => {
      if (!allowed(event.url)) event.preventDefault()
    })
    win.webContents.on('will-redirect', (event) => {
      if (event.isMainFrame && !allowed(event.url)) event.preventDefault()
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    void win.loadURL(entry.href)
    return win
  }
}
