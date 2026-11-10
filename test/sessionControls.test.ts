import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitDiff } from '../src/main/gitDiff'
import { changeRule } from '../src/main/permissionRules'
const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function scratch() { const root = await mkdtemp(join(tmpdir(), 'session-controls-')); roots.push(root); return root }
it('distinguishes a non-Git directory from a failed Git invocation', async () => {
  const cwd = await scratch()
  expect(await gitDiff(cwd, 'working')).toBeNull()
  await expect(gitDiff(join(cwd, 'missing'), 'working')).rejects.toThrow()
})
it('reports clean and staged changes before the first commit', async () => {
  const cwd = await scratch()
  await exec('git', ['init'], { cwd })
  expect(await gitDiff(cwd, 'working')).toBe('')
  await writeFile(join(cwd, 'new.txt'), 'staged content\n')
  await exec('git', ['add', 'new.txt'], { cwd })
  expect(await gitDiff(cwd, 'working')).toContain('+staged content')
})
it('shows working tree changes separately from committed branch changes', async () => {
  const cwd = await scratch()
  const git = (args: string[]) => exec('git', args, { cwd })
  await git(['init', '-b', 'main'])
  await git(['config', 'user.name', 'test'])
  await git(['config', 'user.email', 'test@example.invalid'])
  await writeFile(join(cwd, 'a.txt'), 'before\n')
  await git(['add', '.']); await git(['commit', '-m', 'initial'])
  await git(['checkout', '-b', 'change'])
  await writeFile(join(cwd, 'a.txt'), 'committed\n')
  await git(['commit', '-am', 'change'])
  await writeFile(join(cwd, 'a.txt'), 'working\n')
  expect(await gitDiff(cwd, 'working')).toContain('+working')
  const branch = await gitDiff(cwd, 'branch')
  expect(branch).toContain('+committed')
  expect(branch).not.toContain('+working')
})
it('adds and revokes a project rule without losing unrelated settings', async () => {
  const cwd = await scratch()
  const change = { source: 'localSettings', behavior: 'allow', rule: 'Bash(npm run *)' }
  await changeRule(cwd, change)
  const path = join(cwd, '.claude/settings.local.json')
  const settings = JSON.parse(await readFile(path, 'utf8'))
  settings.language = 'Chinese'
  await writeFile(path, JSON.stringify(settings))
  await changeRule(cwd, change)
  expect(JSON.parse(await readFile(path, 'utf8')).permissions.allow).toEqual([change.rule])
  await changeRule(cwd, { ...change, remove: true })
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ language: 'Chinese', permissions: { allow: [] } })
  await expect(changeRule(cwd, { ...change, source: 'policySettings' })).rejects.toThrow()
})
