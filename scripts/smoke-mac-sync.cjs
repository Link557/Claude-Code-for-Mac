// Real Mac CLI reads + native UI checks in isolated directories. No model request is sent.
const { app, ipcMain, nativeTheme } = require('electron')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const root = mkdtempSync(join(tmpdir(), 'desk-mac-sync-'))
const config = join(root, 'config'), data = join(root, 'data'), project = join(root, 'project')
for (const dir of [config, data, project]) mkdirSync(dir)
for (const key of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$)/.test(key)) delete process.env[key]
process.env.CLAUDE_CONFIG_DIR = config; process.env.CLAUDE_DESK_USERDATA = data
writeFileSync(join(config, 'settings.json'), JSON.stringify({ disableAllHooks: true, env: { ANTHROPIC_API_KEY: 'fixture-not-a-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-chat', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' } }))
writeFileSync(join(data, 'claude-desk.json'), JSON.stringify({ version: 1, projects: [{ id: 'p', name: 'Mac 验收', path: project, addedAt: 0 }], archived: {}, settings: { theme: 'light', defaultModel: 'sonnet' }, seededFromHistory: true }))
const original = ipcMain.handle.bind(ipcMain)
let sent = 0
ipcMain.handle = (channel, handler) => original(channel, ({
  'sessions:list': () => [{ id: 'fixture', title: '交互验收', cwd: project, lastModified: Date.now(), archived: false }],
  'chat:open': () => ({ live: false, state: 'idle', approvals: [], revision: 1, promptSuggestion: { id: 'suggestion', text: '核对本轮修改并运行测试' }, messages: [
    { id: 'u', role: 'user', source: 'human', startsTurn: true, parentToolUseId: null, blocks: [{ kind: 'text', text: '切换模型后继续。' }] },
    { id: 'a', role: 'assistant', parentToolUseId: null, blocks: [{ kind: 'command', name: 'model', args: 'sonnet', output: 'Set model to sonnet (deepseek-chat)' }] }
  ] }),
  'chat:context': () => null, 'chat:checkExternal': () => false,
  'chat:send': () => { sent++ }
})[channel] || handler)
const output = resolve('dist/build-check')
mkdirSync(output, { recursive: true })
const timeout = setTimeout(() => { console.error('Mac sync smoke timed out'); app.exit(1) }, 90000)
app.once('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = async code => {
      try { return await win.webContents.executeJavaScript(code, true) }
      catch (error) { throw Error(`${error.message}\nExpression: ${code}`) }
    }
    const wait = async condition => {
      const deadline = Date.now() + 25000
      while (Date.now() < deadline) { if (await js(condition)) return; await new Promise(resolve => setTimeout(resolve, 50)) }
      throw Error(condition)
    }
    const click = text => js(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(text)}||e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing button');e.click()})()`)
    const shot = async name => { await new Promise(resolve => setTimeout(resolve, 150)); writeFileSync(join(output, name + '.png'), (await win.capturePage()).toPNG()) }
    try {
      await wait(`!document.getElementById('splash') && [...document.querySelectorAll('button')].some(e=>e.textContent==='设置')`)
      const connection = await js(`window.desk.connection.status(${JSON.stringify(project)})`)
      assert.equal(connection.provider, 'gateway'); assert.equal(connection.error, null)
      const quota = await js(`window.desk.usage.overview(${JSON.stringify(project)})`)
      assert.equal(quota.usage.available, false); assert.equal(quota.usage.windows.length, 0)
      await click('设置')
      await click('修改显示名称')
      await js(`(()=>{const e=document.querySelector('input[maxlength="20"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'本机测试名');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
      await click('保存'); await wait(`!document.querySelector('[role="dialog"]') && document.body.innerText.includes('本机测试名')`)
      await js(`(()=>{const e=document.querySelector('[aria-label="驻留会话保留数量"]');e.value='2';e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
      await wait(`document.querySelector('[aria-label="驻留会话保留数量"]').value==='2'`)
      await shot('mac-local-preferences')
      assert.equal(JSON.parse(readFileSync(join(data, 'claude-desk.json'), 'utf8')).settings.displayName, '本机测试名')
      assert.equal((await js('window.desk.settings.get()')).retainedSessions, 2)
      await click('账号与接入'); await wait(`document.body.innerText.includes('正在使用其他供应商配置')`)
      await shot('mac-connection')
      await click('上下文'); await wait(`!!document.querySelector('[aria-label="Claude Code 共享配置"] label[title="引擎默认"]') && !!document.querySelector('[aria-label="请求输入建议"]')`)
      await shot('mac-config-defaults')
      await wait(`!!document.querySelector('button[aria-label="使用情况"]')`)
      await click('使用情况'); await wait(`!!document.querySelector('[aria-label="修改显示名称"]')`)
      assert.equal(await js(`!!document.querySelector('[aria-label="套餐额度"]')`), false)
      await wait(`document.body.innerText.includes('本机测试名')`)
      await js(`[...document.querySelectorAll('[role="button"]')].find(e=>e.textContent.includes('交互验收')).click()`)
      await wait(`!!document.querySelector('[data-prompt-suggestion]') && document.body.innerText.includes('模型已切换为 Sonnet（deepseek-chat）')`)
      await shot('mac-command-suggestion')
      await js(`document.querySelector('[role="textbox"]').focus()`)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
      await wait(`document.querySelector('[role="textbox"]').textContent==='核对本轮修改并运行测试'`)
      assert.equal(sent, 0)
      assert.equal(await js(`!!document.querySelector('[aria-label="在 CLI 继续"]')`), false)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
      for (let i = 0; !sent && i < 40; i++) await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(sent, 1)
      await click('切换摘要面板状态')
      const animation = await js(`getComputedStyle(document.querySelector('[aria-label="会话摘要"]')).animationName`)
      assert.equal(animation, 'summary-in')
      await shot('mac-summary')
      nativeTheme.themeSource = 'dark'; await shot('mac-summary-dark')
      console.log(JSON.stringify({ passed: true, cli: connection.version, provider: connection.provider, localPreferencesPersisted: true, quota: quota.usage.available, syntheticSuggestionSentOnlyOnEnter: true, output, isolatedData: root }))
      clearTimeout(timeout); app.quit()
    } catch (error) { console.error(error); await shot('mac-sync-failure'); clearTimeout(timeout); app.exit(1) }
  })
})
require(resolve('out/main/index.js'))
