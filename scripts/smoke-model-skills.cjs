// Native macOS UI check with the real CLI and isolated configuration. Sends no model prompt.
// Run after npm run build: env -u ELECTRON_RUN_AS_NODE electron scripts/smoke-model-skills.cjs
const { app } = require('electron')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const root = mkdtempSync(join(tmpdir(), 'desk-model-skills-'))
const config = join(root, 'config'), data = join(root, 'data'), project = join(root, 'project')
const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
mkdirSync(project, { recursive: true })
for (const key of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$)/.test(key)) delete process.env[key]
}
process.env.CLAUDE_CONFIG_DIR = config
process.env.CLAUDE_DESK_USERDATA = data
const cliSettings = {
  env: { ANTHROPIC_API_KEY: 'fixture-not-a-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-chat', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' },
  disableAllHooks: true
}
write(join(config, 'settings.json'), JSON.stringify(cliSettings))
const plugin = join(config, 'plugins/fixture')
write(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'Nested skills', skills: ['./skills/engineering/tdd', './skills/productivity'] }))
write(join(plugin, 'skills/engineering/tdd/SKILL.md'), '---\nname: tdd\ndescription: Test-first development\n---\n# Fixture lesson\nWrite a failing test first.')
write(join(plugin, 'skills/productivity/research/SKILL.md'), '---\nname: research\ndescription: Research sources\n---\n# Research\nRead primary sources.')
write(join(config, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'fixture@local': [{ scope: 'user', installPath: plugin, version: '1' }] } }))
write(join(data, 'claude-desk.json'), JSON.stringify({ version: 1, projects: [{ id: 'p', name: 'Model test', path: project, addedAt: 0 }], archived: {}, settings: { theme: 'light', defaultModel: 'sonnet' }, seededFromHistory: true }))
const output = resolve('dist/build-check')
mkdirSync(output, { recursive: true })
const timer = setTimeout(() => { console.error('Model/skills smoke timed out'); app.exit(1) }, 55000)
app.once('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = async code => {
      try { return await win.webContents.executeJavaScript(code, true) }
      catch (error) { throw new Error(`${error.message}\nExpression: ${code}`) }
    }
    const wait = async condition => {
      const until = Date.now() + 20000
      while (Date.now() < until) {
        if (await js(condition)) return
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw Error('Timed out: ' + condition)
    }
    const shot = async name => {
      await new Promise(resolve => setTimeout(resolve, 150))
      writeFileSync(join(output, name + '.png'), (await win.capturePage()).toPNG())
    }
    try {
      await wait(`!!document.querySelector('button[aria-label="选择模型"]')`)
      await wait(`!document.getElementById('splash')`)
      const models = (await js(`window.desk.meta.get(${JSON.stringify(project)})`)).models
      console.log(JSON.stringify({ models, isolatedData: root }))
      assert.ok(models.some(m => m.value === 'sonnet' && m.resolvedModel === 'deepseek-chat'))
      await js(`document.querySelector('button[aria-label="选择模型"]').click()`)
      await wait(`!!document.querySelector('[aria-label="模型列表"] button[aria-label="deepseek-chat"]')`)
      const opus = models.find(m => m.value === 'opus')
      const opusSelector = `[aria-label="模型列表"] button[aria-label=${JSON.stringify(opus.label)}] small`
      assert.equal(await js(`document.querySelector(${JSON.stringify(opusSelector)})?.textContent`), opus.resolvedModel)
      await shot('model-cli-mapping')
      // Verify the filesystem watcher refreshes the open picker with project overrides.
      write(join(project, '.claude/settings.local.json'), JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'vendor/project-model' } }))
      await wait(`!!document.querySelector('[aria-label="模型列表"] button[aria-label="vendor/project-model"]')`)
      await shot('model-cli-refreshed')
      write(join(config, 'settings.json'), JSON.stringify({ ...cliSettings, availableModels: ['sonnet'] }))
      await wait(`!!document.querySelector('[aria-label="模型列表"] button[aria-pressed]') && !document.querySelector('[aria-label="模型列表"] button[aria-label="Fable"]')`)
      const catalog = await js('window.desk.skills.list(null)')
      assert.equal(catalog.plugins.length, 1)
      assert.equal(catalog.skills.length, 2)
      assert.ok((await js(`window.desk.skills.read(${JSON.stringify(catalog.skills.find(s => s.name.endsWith(':tdd')).path)})`)).includes('Write a failing test'))
      await js(`document.querySelector('button[aria-label="选择模型"]').click()`)
      await js(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='技能与插件');if(!b)throw Error('Missing skills navigation');b.click()})()`)
      await wait(`document.body.innerText.includes('Nested skills')`)
      await js(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Nested skills')&&e.textContent.includes('2 个技能'));if(!b)throw Error('Missing plugin card');b.click()})()`)
      await wait(`document.body.innerText.includes('Test-first development')`)
      await shot('plugin-nested-skills')
      await js(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Test-first development'));b.click()})()`)
      await wait(`!!document.querySelector('[role="dialog"]') && document.body.innerText.includes('Write a failing test first.')`)
      await shot('plugin-skill-body')
      console.log(JSON.stringify({ passed: true, models, pluginCount: catalog.plugins.length, skillCount: catalog.skills.length, screenshots: output, isolatedData: root }))
      clearTimeout(timer); app.quit()
    } catch (error) {
      console.error(error)
      await shot('model-skills-failure')
      clearTimeout(timer); app.exit(1)
    }
  })
})
require(resolve('out/main/index.js'))
