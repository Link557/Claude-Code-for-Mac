// Opt-in live integration: uses official authentication and small Haiku requests.
// All file changes belong to a new temporary project; no user project is used.
const { app, nativeTheme } = require('electron')
const { execFileSync, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { randomUUID } = require('node:crypto')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs')
const { tmpdir, homedir } = require('node:os')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')
if (process.platform !== 'win32') throw Error('Native Windows required')
if (!process.argv.includes('--live')) throw Error('Pass --live to authorize actual model requests')
const root = mkdtempSync(join(tmpdir(), 'claude-desktop-e2e-'))
const data = join(root, 'data'), project = join(root, '中文 project')
mkdirSync(data); mkdirSync(project); mkdirSync(join(project, '.claude'))
writeFileSync(join(project, '.claude/settings.json'), JSON.stringify({ disableAllHooks: true, permissions: { deny: ['Bash'] } }))
writeFileSync(join(project, 'input.txt'), 'NATIVE_WINDOWS_42')
const executable = process.env.CLAUDE_PROBE_EXECUTABLE || join(homedir(), '.local/bin/claude.exe')
const id = randomUUID(), marker = 'CONTEXT_' + randomUUID().slice(0, 8)
const cliOptions = { cwd: project, windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024 }
const cliArgs = ['-p', '--output-format', 'json', '--model', 'haiku', '--max-budget-usd', '0.15', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
const auth = JSON.parse(execFileSync(executable, ['auth', 'status', '--json'], { ...cliOptions, encoding: 'utf8' }))
assert.equal(auth.loggedIn, true); assert.equal(auth.apiProvider, 'firstParty')
const seed = JSON.parse(execFileSync(executable, [...cliArgs, '--session-id', id, `Remember this code for later turns: ${marker}. Reply only READY. Do not use tools.`], { ...cliOptions, encoding: 'utf8' }))
assert.equal(seed.is_error, false); assert.match(seed.result, /READY/)
console.log(JSON.stringify({ stage: 'cli-seed', sessionId: id, project, costUsd: seed.total_cost_usd }))
writeFileSync(join(data, 'claude-desk.json'), JSON.stringify({ version: 1, projects: [{ id: 'p', name: 'Windows CLI 实测', path: project, addedAt: 0, collapsed: false }], archived: {}, settings: { theme: 'light', defaultModel: 'haiku', defaultEffort: 'low', defaultPermissionMode: 'default', claudePath: executable }, seededFromHistory: true }))
process.env.CLAUDE_DESK_USERDATA = data
process.env.CLAUDE_DESK_DEMO = JSON.stringify({ openSession: 0 })
const timeout = setTimeout(() => { console.error('FAIL live desktop test timed out'); app.exit(1) }, 240000)
app.once('browser-window-created', (_event, win) => {
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') console.error('RENDERER', details.message) })
  win.webContents.once('did-finish-load', async () => {
    const js = async code => {
      try { return await win.webContents.executeJavaScript(code, true) }
      catch (error) { throw Error(error.message + '\nScript: ' + code) }
    }
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
    const wait = async (code, ms = 40000) => {
      const until = Date.now() + ms
      while (Date.now() < until) { if (await js(code)) return; await pause(100) }
      throw Error('Timed out: ' + code)
    }
    const q = JSON.stringify
    const snapshot = () => js(`window.desk.chat.open(${q(id)},${q(project)})`)
    const click = label => js(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.offsetParent&&(b.getAttribute('aria-label')===${q(label)}||b.innerText.trim()===${q(label)}));if(!button||button.disabled)throw Error('Button unavailable: '+${q(label)});button.click()})()`)
    const send = async text => {
      await js(`(()=>{const e=document.querySelector('[data-composer]');e.focus();document.execCommand('selectAll');document.execCommand('insertText',false,${q(text)})})()`)
      await wait(`document.querySelector('[data-composer]').innerText.includes(${q(text.slice(0, 20))})`)
      await click('发送')
    }
    const settle = async previousResults => {
      const until = Date.now() + 100000
      let approvals = 0
      while (Date.now() < until) {
        const state = await snapshot()
        for (const approval of state.approvals) {
          assert.ok(['Read', 'Write', 'Edit'].includes(approval.toolName), 'Unexpected tool ' + approval.toolName)
          const path = resolve(approval.input.file_path)
          assert.ok([join(project, 'input.txt'), join(project, 'output.txt')].includes(path), 'Unexpected target')
          await wait(`[...document.querySelectorAll('button')].some(b=>b.innerText.trim().startsWith('允许'))`)
          await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.offsetParent&&b.innerText.trim().startsWith('允许'));if(!b)throw Error('Approval button missing');b.click()})()`)
          approvals++
        }
        const results = await js('window.liveResults')
        if (results.length > previousResults && state.state === 'idle') {
          assert.equal(results.at(-1).error, null, JSON.stringify(results.at(-1)))
          return { state, approvals }
        }
        if (state.state === 'error') throw Error('Desktop entered error state')
        await pause(200)
      }
      throw Error('No successful desktop result')
    }
    try {
      await wait(`!!document.querySelector('[data-composer]')&&document.body.innerText.includes(${q(marker)})`)
      assert.equal(await js('document.getElementById("root").dataset.platform'), 'windows')
      await js(`window.liveResults=[];window.desk.chat.onEvent((id,event)=>{if(id===${q(id)}&&event.kind==='result')window.liveResults.push(event)});void 0`)
      const prompt = 'Use Read to read input.txt, then use Write to create output.txt with exactly the remembered code from our earlier conversation, a vertical bar, and the entire input.txt content. Do not use Bash or other tools. Reply DESKTOP_DONE after writing.'
      await send(prompt)
      const first = await settle(0)
      assert.equal(readFileSync(join(project, 'output.txt'), 'utf8').trim(), marker + '|NATIVE_WINDOWS_42')
      assert.ok(first.state.messages.some(m => m.blocks.some(b => b.kind === 'tool' && b.name === 'Write' && b.result && !b.result.isError)))
      assert.ok(first.approvals > 0, 'Expected explicit default-mode write approval')
      await wait("document.body.innerText.includes('DESKTOP_DONE')")
      assert.equal(await js("!!document.querySelector('[aria-label=\"在 CLI 继续\"]')"), false)
      writeFileSync(resolve('.local/windows-v1-live-light.png'), (await win.capturePage()).toPNG())
      console.log(JSON.stringify({ stage: 'desktop-read-write', approvals: first.approvals, genuineTools: true }))
      win.blur()
      const resume = JSON.parse((await promisify(execFile)(executable, [...cliArgs, '--resume', id, 'What exact content did you write to output.txt in the preceding desktop turn? Reply with that content followed by |CLI_BACK. Do not use tools.'], cliOptions)).stdout)
      assert.equal(resume.is_error, false); assert.ok(resume.result.includes(marker + '|NATIVE_WINDOWS_42|CLI_BACK'), resume.result)
      win.show(); win.focus()
      await wait(`document.body.innerText.includes(${q(marker + '|NATIVE_WINDOWS_42|CLI_BACK')})`)
      console.log(JSON.stringify({ stage: 'cli-resumed-desktop-history', costUsd: resume.total_cost_usd }))
      // Send through the composer without manually reloading: backend must merge external history.
      await send('Repeat your immediately preceding reply exactly, including its suffix. Do not use tools.')
      const second = await settle(1)
      const replies = second.state.messages.filter(m => m.role === 'assistant').flatMap(m => m.blocks.filter(b => b.kind === 'text').map(b => b.text))
      assert.ok(replies.at(-1).includes(marker + '|NATIVE_WINDOWS_42|CLI_BACK'), replies.at(-1))
      nativeTheme.themeSource = 'dark'; await pause(500)
      writeFileSync(resolve('.local/windows-v1-live-dark.png'), (await win.capturePage()).toPNG())
      const report = { passed: true, executable, sessionId: id, project, cliToDesktop: true, desktopToolsAndApproval: true, desktopToCli: true, cliBackToDesktop: true, lightAndDarkCaptured: true }
      writeFileSync(resolve('.local/windows-v1-e2e.json'), JSON.stringify(report, null, 2))
      console.log(JSON.stringify(report)); clearTimeout(timeout); app.quit()
    } catch (error) {
      writeFileSync(resolve('.local/windows-v1-failure.png'), (await win.capturePage()).toPNG())
      console.error('FAIL', error.stack); clearTimeout(timeout)
      app.once('will-quit', event => { event.preventDefault(); app.exit(1) })
      app.quit()
    }
  })
})
require(resolve('out/main/index.js'))
