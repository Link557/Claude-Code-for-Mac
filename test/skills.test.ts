import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { parseFrontmatter, readSkillBody, readSkillCatalog, setPluginEnabled } from '../src/main/skills'

let root: string, config: string, project: string
const previous = process.env.CLAUDE_CONFIG_DIR
const write = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-skills-')); config = join(root, 'config'); project = join(root, 'project')
  process.env.CLAUDE_CONFIG_DIR = config
})
afterEach(() => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous
  rmSync(root, { recursive: true, force: true })
})

it('parses quoted and folded frontmatter fields', () => {
  expect(parseFrontmatter('---\nname: pdf\ndescription: "Use for PDFs"\n---\nbody')).toEqual({ name: 'pdf', description: 'Use for PDFs' })
  expect(parseFrontmatter('---\ndescription: >\n  first line\n  second line\nname: x\n---')).toEqual({ description: 'first line second line', name: 'x' })
  expect(parseFrontmatter('no frontmatter')).toEqual({})
  expect(parseFrontmatter('---\ndescription: "say \\"hi\\" now"\nname: \'it\'\'s\'\n---')).toEqual({ description: 'say "hi" now', name: "it's" })
})

it('includes nested manifest skill directories and deduplicates default entries', async () => {
  const install = join(config, 'plugins', 'kit')
  write(join(install, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit', skills: ['./skills/engineering/tdd', './skills/direct'] }))
  write(join(install, 'skills/engineering/tdd/SKILL.md'), '---\nname: tdd\ndescription: test first\n---\nBody')
  write(join(install, 'skills/direct/SKILL.md'), '---\nname: direct\n---\nBody')
  write(join(config, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'kit@m': [{ scope: 'user', installPath: install }] } }))
  const catalog = await readSkillCatalog(null)
  expect(catalog.skills.map(s => s.name)).toEqual(['kit:direct', 'kit:tdd'])
  expect(await readSkillBody(catalog.skills[1].path)).toBe('Body')
})

it.each(['./categories/engineering', ['./categories/engineering', './categories/engineering/tdd', './categories/engineering']])('reads declared containers without counting their skills as separate plugins', async declaration => {
  const install = join(config, 'plugins', 'kit')
  write(join(install, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'kit', skills: declaration }))
  write(join(install, 'categories/engineering/tdd/SKILL.md'), '# TDD\nTest first')
  write(join(install, 'categories/engineering/review/SKILL.md'), '# Review\nReview changes')
  write(join(install, 'unlisted/deep/hidden/SKILL.md'), '# Hidden')
  write(join(install, 'commands/ship.md'), '# Ship\nShip it')
  write(join(config, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'kit@m': [{ scope: 'user', installPath: install }] } }))
  const catalog = await readSkillCatalog(null)
  expect(catalog.plugins).toHaveLength(1)
  expect(catalog.skills.map(s => s.name)).toEqual(['kit:review', 'kit:ship', 'kit:tdd'])
  expect(catalog.skills.find(s => s.name === 'kit:ship')?.kind).toBe('command')
})

it('rejects declarations and symlinks outside the plugin and deduplicates paths inside it', async () => {
  const install = join(config, 'plugins', 'kit'), outside = join(config, 'plugins', 'kit-other')
  write(join(outside, 'SKILL.md'), '# Outside')
  write(join(install, 'skills/direct/SKILL.md'), '# Direct')
  symlinkSync(outside, join(install, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  symlinkSync(outside, join(install, 'skills/escape'), process.platform === 'win32' ? 'junction' : 'dir')
  symlinkSync(join(install, 'skills/direct'), join(install, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  write(join(install, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'kit', skills: ['../kit-other', outside, './escape', './alias', './skills/direct', 123] }))
  write(join(config, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'kit@m': [{ scope: 'user', installPath: install }] } }))
  const catalog = await readSkillCatalog(null)
  expect(catalog.skills).toHaveLength(1)
  expect(await readSkillBody(catalog.skills[0].path)).toBe('# Direct')
  await expect(readSkillBody(join(outside, 'SKILL.md'))).rejects.toThrow('只能读取')
})

it('collects user, project, synced and plugin skills with plugin enablement', async () => {
  write(join(config, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: personal\n---')
  write(join(config, 'commands', 'git', 'ship.md'), '# Ship\nShip the branch')
  write(join(config, 'skills', 'synced', 'org_user', 'docx', 'SKILL.md'), '---\nname: docx\ndescription: word\n---')
  write(join(project, '.claude', 'skills', 'local', 'SKILL.md'), '---\ndescription: project only\n---')
  const install = join(config, 'plugins', 'cache', 'm', 'tools', '1.0.0')
  write(join(install, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tools', description: 'Tool kit' }))
  write(join(install, 'skills', 'lint', 'SKILL.md'), '---\nname: lint\ndescription: lint code\n---')
  write(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'tools@m': [{ scope: 'user', installPath: install, version: '1.0.0' }], 'empty@m': [{ scope: 'user', installPath: join(root, 'missing') }] } }))
  write(join(config, 'settings.json'), JSON.stringify({ enabledPlugins: { 'tools@m': false } }))
  write(join(project, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'tools@m': true } }))

  const catalog = await readSkillCatalog(project)
  expect(catalog.skills.map(s => [s.name, s.source, s.kind])).toEqual([
    ['anthropic-skills:docx', 'synced', 'skill'],
    ['git:ship', 'user', 'command'],
    ['local', 'project', 'skill'],
    ['mine', 'user', 'skill'],
    ['tools:lint', 'plugin', 'skill']
  ])
  expect(catalog.skills.find(s => s.name === 'git:ship')?.description).toBe('Ship the branch')
  expect(catalog.plugins.map(p => [p.id, p.enabled, p.projectOverride, p.version])).toEqual([['empty@m', false, false, undefined], ['tools@m', true, true, '1.0.0']])

  const userOnly = await readSkillCatalog(null)
  expect(userOnly.skills.some(s => s.source === 'project')).toBe(false)
  expect(userOnly.plugins.find(p => p.id === 'tools@m')?.enabled).toBe(false)
})

it('reads only scanned skill bodies and toggles plugins without losing other settings', async () => {
  const skill = join(config, 'skills', 'mine', 'SKILL.md')
  write(skill, '---\nname: mine\n---\n# Body\ntext')
  write(join(config, 'secret.md'), 'nope')
  const install = join(config, 'plugins', 'cache', 'tools')
  write(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'tools@m': [{ scope: 'user', installPath: install }] } }))
  write(join(config, 'settings.json'), JSON.stringify({ model: 'opus', enabledPlugins: { 'other@m': true } }))

  await readSkillCatalog(null)
  expect(await readSkillBody(skill)).toBe('# Body\ntext')
  await expect(readSkillBody(join(config, 'secret.md'))).rejects.toThrow()

  await setPluginEnabled('tools@m', true)
  expect(JSON.parse(readFileSync(join(config, 'settings.json'), 'utf8'))).toEqual({ model: 'opus', enabledPlugins: { 'other@m': true, 'tools@m': true } })
  expect((await readSkillCatalog(null)).plugins[0].enabled).toBe(true)
  await expect(setPluginEnabled('missing@m', true)).rejects.toThrow('未安装')

  write(join(config, 'settings.json'), '{ broken')
  await expect(setPluginEnabled('tools@m', false)).rejects.toThrow('格式有误')
  expect(readFileSync(join(config, 'settings.json'), 'utf8')).toBe('{ broken')
})
