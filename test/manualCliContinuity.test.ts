import { it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { SessionManager } from '../src/main/live/SessionManager'

const cli = join(homedir(), '.local/bin/claude.exe')
vi.mock('../src/main/store', () => ({ read: () => ({ settings: { allowBypass: false }, archived: {}, sessionEdits: {} }), update: () => {} }))
vi.mock('../src/main/sdk', async () => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return { loadSdk: async () => sdk, claudeExecutable: () => cli, withIdleQuery: vi.fn() }
})

it.skipIf(process.env.CLAUDE_LOCAL_CONTINUITY !== '1')('real isolated CLI history is reloaded and resumed by the desktop manager', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-local-continuity-'))
  const config = join(root, 'config'), project = join(root, 'project')
  await mkdir(config); await mkdir(project)
  const requests: string[] = []
  const server = createServer((req, res) => {
    if (!req.url?.startsWith('/v1/messages')) { res.writeHead(403); res.end(); return }
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
      requests.push(body)
      const messages = JSON.parse(body).messages as unknown[]
      const last = JSON.stringify(messages.at(-1))
      const answer = last.includes('DESKTOP_PROMPT') ? 'DESKTOP_REPLY' : last.includes('CLI_PROMPT') ? 'CLI_REPLY' : 'FIRST_REPLY'
      const message = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }
      const events = [
        ['message_start', { type: 'message_start', message }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
        ['message_stop', { type: 'message_stop' }]
      ]
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      res.end()
    })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as any).port
  const proxy = `http://127.0.0.1:${port}`
  for (const [key, value] of Object.entries({ CLAUDE_CONFIG_DIR: config, HOME: root, USERPROFILE: root, ANTHROPIC_BASE_URL: proxy, ANTHROPIC_API_KEY: 'local-test', ANTHROPIC_AUTH_TOKEN: '', HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })) vi.stubEnv(key, value)
  const id = randomUUID(), events: any[] = []
  const manager = new SessionManager((_id, event) => events.push(event))
  const run = promisify(execFile)
  const args = ['-p', '--output-format', 'json', '--model', 'claude-sonnet-4-5', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
  try {
    const invoke = async (more: string[]) => JSON.parse((await run(cli, [...args, ...more], { cwd: project, timeout: 45000, windowsHide: true })).stdout)
    expect(await invoke(['--session-id', id, 'FIRST_PROMPT'])).toMatchObject({ is_error: false, result: 'FIRST_REPLY' })
    expect((await manager.open(id, project)).messages.some(m => JSON.stringify(m).includes('FIRST_REPLY'))).toBe(true)
    expect(await invoke(['--resume', id, 'CLI_PROMPT'])).toMatchObject({ is_error: false, result: 'CLI_REPLY' })
    expect(await manager.checkExternal(id, project)).toBe(true)
    expect(events.some(e => e.kind === 'replaceHistory' && JSON.stringify(e).includes('CLI_REPLY'))).toBe(true)
    await manager.send(id, project, 'DESKTOP_PROMPT', { model: 'claude-sonnet-4-5', mode: 'default', effort: null })
    await vi.waitFor(() => expect(events.some(e => e.kind === 'result' && e.error === null)).toBe(true), { timeout: 45000, interval: 100 })
    const request = requests.find(body => body.includes('DESKTOP_PROMPT'))!
    expect(request).toContain('FIRST_PROMPT'); expect(request).toContain('FIRST_REPLY')
    expect(request).toContain('CLI_PROMPT'); expect(request).toContain('CLI_REPLY')
    console.log('LOCAL_CLI_CONTINUITY_PASS: initial CLI, external CLI, desktop history reload and resumed model context')
  } finally {
    manager.closeAll(); vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
}, 150000)
