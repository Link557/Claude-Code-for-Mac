// Offline native UI check: synthetic SDK image events, real transcript and local file preview.
// Run after building: env -u ELECTRON_RUN_AS_NODE electron scripts/smoke-tool-images.cjs
const { app, ipcMain } = require('electron')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { buildSync } = require('esbuild')
const root = mkdtempSync(join(tmpdir(), 'desk-image-preview-'))
const project = join(root, 'project'), data = join(root, 'data'), config = join(root, 'config')
for (const path of [project, data, config]) mkdirSync(path)
process.env.CLAUDE_DESK_USERDATA = data
process.env.CLAUDE_CONFIG_DIR = config
writeFileSync(join(config, 'settings.json'), JSON.stringify({ disableAllHooks: true, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', DISABLE_TELEMETRY: '1' } }))
writeFileSync(join(data, 'claude-desk.json'), JSON.stringify({ version: 1, projects: [{ id: 'p', name: '图片预览', path: project, addedAt: 0 }], archived: {}, settings: { theme: 'light' }, seededFromHistory: true }))
buildSync({ entryPoints: [resolve('src/main/transcript.ts')], outfile: join(root, 'transcript.cjs'), bundle: true, platform: 'node', format: 'cjs' })
const { Transcript } = require(join(root, 'transcript.cjs'))
const transcript = new Transcript(project)
const png = readFileSync(resolve('docs/images/quota-crab.png'))
writeFileSync(join(project, 'current.png'), png)
transcript.addUser('查看这两张图片。')
for (const id of ['snapshot', 'current']) {
  transcript.apply({ type: 'assistant', message: { id, content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: join(project, id + '.png') } }] } })
  transcript.apply({ type: 'user', isMeta: true, message: { content: [
    { type: 'tool_result', tool_use_id: id, content: id === 'snapshot' ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }] : '[image]' },
    { type: 'text', text: '[Image: original 2400x540, displayed at 2000x450. Multiply coordinates by 1.20 to map to original image.]' }
  ] } })
}
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => handle(channel, ({
  'sessions:list': () => [{ id: 'images', title: '图片预览验收', cwd: project, lastModified: 0, archived: false }],
  'chat:open': () => ({ messages: transcript.messages, state: 'idle', approvals: [], live: false }),
  'chat:context': () => null, 'chat:checkExternal': () => false,
  'chat:send': () => { throw Error('Preview must not send a model message') },
  'meta:get': () => ({ models: [], subscriptionType: null, claudeVersion: 'fixture' }),
  'meta:commands': (_e, cwd) => ({ cwd, commands: [], status: 'ready', revision: 1, updatedAt: 0 }),
  'usage:overview': () => { throw Error('Offline fixture') }
})[channel] || listener)
const output = resolve('dist/build-check')
mkdirSync(output, { recursive: true })
const timer = setTimeout(() => { console.error('Image preview timed out'); app.exit(1) }, 35000)
app.once('browser-window-created', (_event, win) => {
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }))
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code, true)
    const wait = async condition => {
      for (let i = 0; i < 200; i++) { if (await js(condition)) return; await new Promise(resolve => setTimeout(resolve, 50)) }
      throw Error('Condition failed: ' + condition)
    }
    const shot = async name => { await new Promise(resolve => setTimeout(resolve, 150)); writeFileSync(join(output, name + '.png'), (await win.capturePage()).toPNG()) }
    try {
      await wait(`!document.getElementById('splash') && [...document.querySelectorAll('[role="button"]')].some(e => e.textContent.includes('图片预览验收'))`)
      await js(`[...document.querySelectorAll('[role="button"]')].find(e => e.textContent.includes('图片预览验收')).click()`)
      await wait(`document.querySelectorAll('button[aria-label^="放大图片"] img').length === 2 && [...document.querySelectorAll('button[aria-label^="放大图片"] img')].every(e => e.complete && e.naturalWidth > 0)`)
      await wait(`document.body.innerText.includes('原文件预览 · 当前内容')`)
      await shot('tool-image-thumbnails')
      await js(`document.querySelector('button[aria-label="放大图片 snapshot.png"]').click()`)
      await wait(`document.querySelector('[role="dialog"] img')?.naturalWidth > 0`)
      await shot('tool-image-expanded')
      await js(`[...document.querySelectorAll('[role="dialog"] button')].find(e => e.textContent === '关闭').click()`)
      await js(`[...document.querySelectorAll('summary')].find(e => e.textContent.includes('技术记录')).click()`)
      await wait(`document.body.innerText.includes('Multiply coordinates')`)
      console.log('PASS: embedded image, current local file, zoom, close, preserved technical record')
      clearTimeout(timer); app.quit()
    } catch (error) { console.error(error); await shot('tool-image-failure'); clearTimeout(timer); app.exit(1) }
  })
})
require(resolve('out/main/index.js'))
