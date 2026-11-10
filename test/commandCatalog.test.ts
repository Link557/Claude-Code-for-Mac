import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CommandCatalog } from '../src/main/commandCatalog'
import { cliFileIdentity } from '../src/main/cliIdentity'
import { claudeConfigIdentity } from '../src/main/claudeConfigChanges'
import type { CommandInfo } from '../src/shared/types'
const command = (name: string): CommandInfo => ({ name, description: name, argumentHint: '' })
let directory: string, configuration: string, now: number, catalog: CommandCatalog
const load = vi.fn(), publish = vi.fn()
beforeEach(() => {
  vi.clearAllMocks(); directory = mkdtempSync(join(tmpdir(), 'claude-command-catalog-')); configuration = 'bundled'; now = 1_000_000
  catalog = new CommandCatalog({ directory: () => directory, configuration: () => configuration, now: () => now, load, publish })
})
afterEach(() => { catalog.close(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }) })
it('returns init immediately, coalesces concurrent queries and replaces fallback with the real list', async () => {
  let done!: (commands: CommandInfo[]) => void
  load.mockImplementation(() => new Promise((resolve) => { done = resolve }))
  expect(catalog.get('/a').commands.map(c=>c.name)).toContain('init')
  catalog.get('/a'); catalog.get('/a', true)
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
  done([command('custom')])
  await vi.waitFor(() => expect(catalog.get('/a').status).toBe('ready'))
  expect(catalog.get('/a').commands).toEqual([command('custom')])
})
it('reuses disk snapshots and refreshes stale entries without hiding cached commands', async () => {
  catalog.publisher('/a')([command('cached')]); catalog.close()
  catalog = new CommandCatalog({ directory: () => directory, configuration: () => configuration, now: () => now, load, publish })
  expect(catalog.get('/a').commands[0].name).toBe('cached'); expect(load).not.toHaveBeenCalled()
  now += 300001; load.mockResolvedValue([command('fresh')])
  expect(catalog.get('/a')).toMatchObject({ status: 'loading', commands: [command('cached')] })
  await vi.waitFor(() => expect(catalog.get('/a').commands[0].name).toBe('fresh'))
})
it('isolates projects and executable configurations and rejects late old-query results', async () => {
  let done!: (commands: CommandInfo[]) => void
  load.mockImplementation(() => new Promise((resolve) => { done = resolve }))
  catalog.get('/a'); await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(1))
  const oldPublish = catalog.publisher('/a')
  configuration = 'custom'; catalog.invalidate()
  const lateRegistration = catalog.publisher('/a', 'bundled')
  catalog.publisher('/a')([command('new-executable')]); catalog.publisher('/b')([command('project-b')])
  oldPublish([command('old-executable')]); lateRegistration([command('old-late-registration')]); done([command('late-old-query')]); await Promise.resolve()
  expect(catalog.get('/a').commands[0].name).toBe('new-executable')
  expect(catalog.get('/b').commands[0].name).toBe('project-b')
})
it('isolates a CLI replaced at the same path and rejects commands from its old process', async () => {
  const executable = join(directory, 'claude.exe')
  writeFileSync(executable, 'old')
  catalog.close()
  catalog = new CommandCatalog({ directory: () => directory, configuration: () => cliFileIdentity(executable), now: () => now, load, publish })
  const oldPublisher = catalog.publisher('/a')
  oldPublisher([command('old')])
  writeFileSync(executable, 'replacement')
  oldPublisher([command('late-old')])
  load.mockResolvedValue([command('new')])
  expect(catalog.get('/a').commands.some(c => c.name === 'old' || c.name === 'late-old')).toBe(false)
  await vi.waitFor(() => expect(catalog.get('/a').commands).toEqual([command('new')]))
})
it('isolates cached commands and old publishers when user or project configuration changes', async () => {
  const user = join(directory, 'user'), project = join(directory, 'project')
  mkdirSync(user); mkdirSync(join(project, '.claude'), { recursive: true })
  vi.stubEnv('CLAUDE_CONFIG_DIR', user)
  const userFile = join(user, 'settings.json'), projectFile = join(project, '.claude', 'settings.json')
  writeFileSync(userFile, '{"enabledPlugins":{}}')
  writeFileSync(projectFile, '{}')
  catalog.close()
  const config = (cwd: string) => claudeConfigIdentity(cwd)
  catalog = new CommandCatalog({ directory: () => directory, configuration: config, now: () => now, load, publish })
  const oldPublisher = catalog.publisher(project)
  oldPublisher([command('old')])
  writeFileSync(projectFile, '{"enabledPlugins":{"new":true}}')
  oldPublisher([command('late-old')])
  catalog.invalidate()
  load.mockResolvedValue([command('project-new')])
  expect(catalog.get(project).commands.some(c => c.name === 'old' || c.name === 'late-old')).toBe(false)
  await vi.waitFor(() => expect(catalog.get(project).commands).toEqual([command('project-new')]))
  const projectPublisher = catalog.publisher(project)
  writeFileSync(userFile, '{"enabledPlugins":{"user-new":true}}')
  projectPublisher([command('late-project')])
  catalog.invalidate()
  load.mockResolvedValue([command('user-new')])
  expect(catalog.get(project).commands.some(c => c.name === 'project-new' || c.name === 'late-project')).toBe(false)
  await vi.waitFor(() => expect(catalog.get(project).commands).toEqual([command('user-new')]))
})
it('lets an existing session update win over a slower temporary query', async () => {
  let done!: (commands: CommandInfo[])=>void
  load.mockImplementation(()=>new Promise(resolve=>{done=resolve}))
  catalog.get('/a'); await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(1))
  const signal = load.mock.calls[0][1] as AbortSignal
  catalog.publisher('/a')([command('live-skill')]); done([command('outdated')]); await Promise.resolve()
  expect(signal.aborted).toBe(true)
  expect(catalog.get('/a').commands[0].name).toBe('live-skill')
})
it('retains useful commands on failure and permits a manual retry', async () => {
  catalog.publisher('/a')([command('cached')]); now += 300001
  load.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([command('recovered')])
  catalog.get('/a')
  await vi.waitFor(()=>expect(catalog.get('/a').status).toBe('error'))
  expect(catalog.get('/a').commands).toEqual([command('cached')])
  expect(load).toHaveBeenCalledTimes(1)
  catalog.get('/a',true)
  await vi.waitFor(()=>expect(catalog.get('/a').commands[0].name).toBe('recovered'))
})
it('times out after fifteen seconds and aborts owned requests on close', async () => {
  vi.useFakeTimers(); load.mockImplementation(()=>new Promise(()=>{}))
  catalog.get('/a'); await Promise.resolve()
  await vi.advanceTimersByTimeAsync(15000)
  expect(catalog.get('/a')).toMatchObject({status:'error', error:expect.stringContaining('超时')})
  expect(load.mock.calls[0][1].aborted).toBe(true)
  catalog.get('/b'); await Promise.resolve(); catalog.close()
  expect(load.mock.calls[1][1].aborted).toBe(true)
  await vi.runAllTimersAsync()
})
it('accepts metadata seeds only while their scope and generation remain current', () => {
  const seed = catalog.seedFromMetadata('/a')
  seed([command('metadata')])
  expect(catalog.get('/a').commands).toEqual([command('metadata')])
  now += 300001
  const stale = catalog.seedFromMetadata('/a')
  catalog.publisher('/a')([command('live')])
  stale([command('late')])
  expect(catalog.get('/a').commands).toEqual([command('live')])
  const oldConfiguration = catalog.seedFromMetadata('/b')
  configuration = 'custom'
  oldConfiguration([command('wrong')])
  expect(publish.mock.calls.flat().some(snapshot => snapshot.commands?.some((c: CommandInfo) => c.name === 'wrong'))).toBe(false)
})
