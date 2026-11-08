// node scripts/launch.cjs electron scripts/install-windows-shortcuts.cjs <packaged exe>
const { app, shell } = require('electron')
const { existsSync } = require('node:fs')
const { resolve, dirname, join } = require('node:path')
const { build, version } = require('../package.json')
app.whenReady().then(() => {
  const target = process.argv[2] && resolve(process.argv[2])
  if (process.platform !== 'win32' || !target || !existsSync(target)) throw Error('Supply an existing Windows app executable')
  // Both locations must use the same identity and icon. An old Start-menu link
  // can make the taskbar keep the early preview's padded icon after an update.
  for (const path of [join(app.getPath('desktop'), 'Claude Code.lnk'), join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs/Claude Code.lnk')]) {
    if (!shell.writeShortcutLink(path, existsSync(path) ? 'update' : 'create', {
      target, cwd: dirname(target), icon: target, iconIndex: 0,
      appUserModelId: build.appId, description: `Claude Code for Windows ${version}`
    })) throw Error(`Could not update shortcut: ${path}`)
  }
  console.log('Updated desktop and Start-menu shortcuts.')
  app.quit()
}).catch(error => { console.error(error.message); app.exit(1) })
