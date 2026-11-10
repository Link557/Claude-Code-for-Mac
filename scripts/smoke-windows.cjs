// Windows integration smoke: real native CLI auth + SDK initialization + ConPTY.
// No model prompt, login, user config mutation or real conversation is performed.
const { app } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')
if (process.platform !== 'win32') throw new Error('This smoke requires native Windows')
const root = mkdtempSync(join(tmpdir(), 'claude-windows-smoke-'))
const data = join(root, 'data'), project = join(root, '中文 project')
mkdirSync(data); mkdirSync(project)
writeFileSync(join(project, 'hello.md'), '# Windows preview')
writeFileSync(join(data, 'claude-desk.json'), JSON.stringify({ version: 1, projects: [{ id: 'p', name: 'Windows test', path: project, addedAt: 0, collapsed: false }], archived: {}, settings: { theme: 'light' }, seededFromHistory: true }))
process.env.CLAUDE_DESK_USERDATA = data
process.env.CLAUDE_DESK_DEMO = JSON.stringify({ route: 'settings' })
const timeout = setTimeout(() => { console.error('FAIL Windows smoke timed out'); app.exit(1) }, 60000)
app.once('browser-window-created', (_event, win) => {
  // Keep automated verification in the background.
  win.show = () => {}
  win.showInactive = () => {}
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code, true)
    const wait = async condition => {
      const end = Date.now() + 35000
      while (Date.now() < end) {
        if (await js(condition)) return
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('Timed out waiting for ' + condition)
    }
    try {
      await wait("[...document.querySelectorAll('button')].some(b => b.textContent === '账号与接入')")
      await js("[...document.querySelectorAll('button')].find(b => b.textContent === '账号与接入').click()")
      await wait("[...document.querySelectorAll('button')].some(b => b.textContent === '重新检测' && !b.disabled)")
      const projects = await js('window.desk.projects.list()')
      assert.deepEqual(projects.map(item => item.path), [project], 'isolated userData project was not loaded')
      const status = await js(`window.desk.connection.status(${JSON.stringify(project)})`)
      assert.equal(status.error, null)
      assert.ok(status.executable.endsWith('.exe'))
      const preview = await js(`window.desk.files.read(${JSON.stringify(join(project, 'hello.md'))})`)
      assert.equal(preview.kind, 'text')
      const metadata = await js(`window.desk.meta.get(${JSON.stringify(project)})`)
      assert.ok(metadata.claudeVersion)
      assert.ok(metadata.models.length > 0)
      const terminal = await js(`new Promise(async (resolve, reject) => {
        let output = ''; const timer = setTimeout(() => { off(); reject(new Error('PTY timeout')) }, 12000);
        const off = window.desk.terminal.onData((id, chunk) => {
          if (id !== 'page:smoke') return; output += chunk;
          if (output.includes('NATIVE_PTY_42')) { clearTimeout(timer); off(); resolve(true) }
        });
        try {
          await window.desk.terminal.open('page:smoke', ${JSON.stringify(project)});
          await window.desk.terminal.write('page:smoke', "Write-Output ('NATIVE_' + 'PTY_' + (6*7)); exit\\r");
        } catch (error) { clearTimeout(timer); off(); reject(error) }
      })`)
      await js("window.desk.terminal.close('page:smoke')")
      writeFileSync(resolve('.local/windows-connection.png'), (await win.capturePage()).toPNG())
      console.log(JSON.stringify({ nativeCli: true, source: status.source, version: status.version, loggedIn: status.loggedIn, provider: status.provider, sdkInitialized: true, modelCount: metadata.models.length, preview: preview.kind, terminal, screenshot: '.local/windows-connection.png', modelRequestSent: false }))
      clearTimeout(timeout); app.quit()
    } catch (error) { console.error('FAIL', error.message); clearTimeout(timeout); app.exit(1) }
  })
})
require(process.env.CLAUDE_DESK_SMOKE_MAIN || resolve('out/main/index.js'))
