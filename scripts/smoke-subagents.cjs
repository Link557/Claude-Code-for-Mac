// 真实应用渲染器 + 合成会话数据；独立 userData，不调用模型或改动用户会话。
const { app, ipcMain, nativeTheme } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const scratch = mkdtempSync(join(tmpdir(), 'claude-subagents-'))
const project = join(scratch, 'project')
const userdata = join(scratch, 'userdata')
mkdirSync(project); mkdirSync(userdata)
writeFileSync(join(userdata, 'claude-desk.json'), JSON.stringify({ version: 1, projects: [{ id: 'p', name: '示例项目', path: project, addedAt: 0, collapsed: false }], archived: {}, settings: { theme: 'light', welcomeCompleted: true }, seededFromHistory: true }))
process.env.CLAUDE_DESK_USERDATA = userdata
const labels = ['撰写一篇短篇小说', '构思故事结构', '核对情节与措辞']
const calls = labels.map((description, i) => ({ kind: 'tool', id: `tool-${i}`, name: 'Agent', input: { description, prompt: `实际派发任务 ${i + 1}：${description}`, subagent_type: 'general-purpose' } }))
const messages = [{ id: 'human', role: 'user', source: 'human', parentToolUseId: null, blocks: [{ kind: 'text', text: '你调用子AGENT写一个小说，我看一下。' }] }, { id: 'parent', role: 'assistant', parentToolUseId: null, blocks: [{ kind: 'text', text: '我会让三个子 Agent 分别完成写作、构思和核对。' }, ...calls] }]
const summary = { revision: 1, historyIncomplete: false, sections: { changes: [], sources: [], tasks: [], projects: [{ id: project, path: project, title: '示例项目', description: '会话工作目录' }], agents: calls.map(call => ({ id: call.id, title: call.input.description, description: 'general-purpose', status: 'running' })) } }
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (name, handler) => {
  const stubs = {
    'sessions:list': () => [{ id: 'subagent-test', title: '你调用子AGENT写一个小说，我看一下。', cwd: project, lastModified: Date.now(), archived: false }],
    'chat:open': () => ({ messages, state: 'running', approvals: [], live: true, summary }),
    'chat:subagentMessages': (_event, _session, _path, id) => [{ id: `${id}-history`, role: 'assistant', parentToolUseId: null, blocks: [{ kind: 'text', text: `${id} 的内部会话正文` }] }],
    'chat:context': () => null, 'chat:checkExternal': () => false,
    'usage:overview': () => ({ account: { key: 'fixture', email: null, organization: null, subscriptionType: null }, profile: { name: '', avatar: null }, usage: { available: false, windows: [] }, updatedAt: Date.now() }),
    'meta:get': () => ({ models: [{ value: 'haiku', label: 'Haiku', efforts: [] }], subscriptionType: null, claudeVersion: 'fixture' }),
    'meta:commands': (_event, cwd) => ({ cwd, revision: 1, commands: [], status: 'ready', updatedAt: Date.now() })
  }
  handle(name, stubs[name] || handler)
}
const output = resolve('dist/build-check/subagents')
mkdirSync(output, { recursive: true })
const timeout = setTimeout(() => { console.error('Subagent smoke timeout'); app.exit(1) }, 45000)
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code, true)
    const wait = async code => { for (let i = 0; i < 100; i++) { if (await js(code)) return; await new Promise(r => setTimeout(r, 80)) } throw new Error('Condition failed: ' + code) }
    const click = label => js(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)} && b.getClientRects().length); if(!b) throw new Error('Missing button: '+${JSON.stringify(label)}); b.click() })()`)
    const shot = async name => writeFileSync(join(output, name), (await win.capturePage()).toPNG())
    try {
      await wait(`document.body.innerText.includes('你调用子AGENT写一个小说')`)
      await js(`([...document.querySelectorAll('[role="button"]')].find(e=>e.innerText.includes('你调用子AGENT写一个小说'))).click()`)
      await wait(`document.querySelector('[aria-label="会话摘要"]')?.innerText.includes('3 位进行中')`)
      await wait(`document.querySelectorAll('[aria-label="子 Agent 小螃蟹"] .agent-crab[data-working="true"]').length===3`)
      const identities = await js(`JSON.stringify([...document.querySelectorAll('[aria-label="子 Agent 小螃蟹"] .agent-crab')].map(e=>[e.dataset.accessory,e.querySelector('svg > g').getAttribute('fill')]))`)
      if (new Set(JSON.parse(identities).map(x=>x[1])).size !== 3 || identities.includes('#d97757') || identities.includes('#8e55ce')) throw new Error('Agent identity palette is incorrect')
      await new Promise(r => setTimeout(r, 1200))
      if (!await js(`document.querySelector('[aria-label="子 Agent 小螃蟹"]').getAnimations({subtree:true}).some(a=>a.playState==='running')`)) throw new Error('Working agents are not animated')
      await shot('summary-working.png')
      await click('查看撰写一篇短篇小说的会话')
      await wait(`document.querySelector('[aria-label="子 Agent 会话"]')?.innerText.includes('tool-0 的内部会话正文')`)
      if (await js(`!!document.querySelector('[aria-label="会话摘要"]')`)) throw new Error('Summary did not close after opening child')
      if (!await js(`(() => { const pane = document.querySelector('[aria-label="子 Agent 会话"]'); return pane.querySelector('h2')?.textContent === '撰写一篇短篇小说' && pane.querySelectorAll('.agent-crab').length === 1 && pane.querySelector('details:not([open])')?.textContent.includes('实际派发任务 1') })()`)) throw new Error('Single-agent header or collapsed task prompt missing')
      await click('切换摘要面板状态')
      await wait(`document.querySelector('[aria-label="会话摘要"]')?.innerText.includes('3 位进行中')`)
      await click('查看构思故事结构的会话')
      await wait(`document.querySelector('[aria-label="子 Agent 会话"]')?.innerText.includes('tool-1 的内部会话正文')`)
      if (!await js(`document.querySelector('[aria-label="子 Agent 会话"] h2')?.textContent === '构思故事结构'`)) throw new Error('Agent header did not switch')
      if (await js(`document.querySelector('[aria-label="子 Agent 会话"]').innerText.includes('tool-0 的内部会话正文')`)) throw new Error('Messages leaked across agents')
      if (await js(`document.querySelectorAll('[role="tab"][title="子 Agent"]').length`) !== 1) throw new Error('Agent tabs were duplicated')
      await new Promise(r => setTimeout(r, 350))
      await shot('conversation.png')
      win.webContents.send('chat:onEvent', 'subagent-test', { kind: 'upsert', messages: [{ id: 'child-live', role: 'assistant', parentToolUseId: 'tool-1', blocks: [{ kind: 'text', text: '刚收到的子会话正文' }] }] })
      await wait(`document.querySelector('[aria-label="子 Agent 会话"]')?.innerText.includes('刚收到的子会话正文')`)
      summary.revision++
      summary.sections.agents[1].status = 'completed'
      win.webContents.send('chat:onEvent', 'subagent-test', { kind: 'summary', summary })
      await click('切换摘要面板状态')
      await wait(`document.querySelector('[aria-label="会话摘要"]')?.innerText.includes('2 位进行中')`)
      if (!await js(`document.querySelector('[aria-label="会话摘要"]').innerText.includes('子 Agent · 3')`)) throw new Error('Completed child changed total count')
      if (await js(`document.querySelectorAll('[aria-label="子 Agent 小螃蟹"] .agent-crab[data-working="true"]').length`) !== 2) throw new Error('Completed child kept animating')
      if (await js(`JSON.stringify([...document.querySelectorAll('[aria-label="子 Agent 小螃蟹"] .agent-crab')].map(e=>[e.dataset.accessory,e.querySelector('svg > g').getAttribute('fill')]))`) !== identities) throw new Error('Identity changed on completion')
      await js(`document.documentElement.dataset.reduceMotion='true'`)
      if (!await js(`[...document.querySelectorAll('[aria-label="子 Agent 小螃蟹"] .crab-body')].every(e=>parseFloat(getComputedStyle(e).animationDuration)<0.001)`)) throw new Error('Reduced motion preference ignored')
      await js(`delete document.documentElement.dataset.reduceMotion`)
      nativeTheme.themeSource = 'dark'
      await new Promise(r => setTimeout(r, 100))
      await shot('summary-dark.png')
      if (await js(`document.documentElement.scrollWidth>innerWidth`)) throw new Error('Horizontal overflow')
      console.log('PASS: real renderer auto-open; 3 children/3 running; colors/accessories; live animations; sidebar drilldown and switching; streamed updates; completion 3/2; reduced motion; dark theme.')
      clearTimeout(timeout); app.quit()
    } catch (error) { console.error(error); await shot('failure.png'); clearTimeout(timeout); app.exit(1) }
  })
})
require(process.env.CLAUDE_DESK_SMOKE_ENTRY || '../out/main/index.js')
