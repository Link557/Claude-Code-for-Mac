import { readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import type { PluginInfo, SkillCatalog, SkillInfo, SkillSource } from '../shared/skills'

const configDir = (): string => resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))

/** 只取 frontmatter 里的标量字段，支持引号和 >、| 多行写法；不引入 YAML 依赖。 */
export function parseFrontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return {}
  const fields: Record<string, string> = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i])
    if (!field) continue
    let value = field[2].trim()
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim())
      value = block.join(value.startsWith('|') ? '\n' : ' ').trim()
    } else if (/^".*"$/.test(value)) value = value.slice(1, -1).replace(/\\(["\\/nt])/g, (_, c: string) => c === 'n' ? '\n' : c === 't' ? '\t' : c)
    else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'")
    fields[field[1]] = value
  }
  return fields
}

/** 没有 frontmatter 描述时，用正文第一行非标题文字兜底 */
function describe(text: string, fields: Record<string, string>): string {
  if (fields.description) return fields.description
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '')
  return body.split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#')) ?? ''
}

async function directories(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => join(path, e.name)) } catch { return [] }
}

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch { return null }
}

async function readJson(path: string): Promise<any> {
  const text = await readText(path)
  if (text === null) return null
  try { return JSON.parse(text) } catch { return null }
}

/** skills/<name>/SKILL.md */
async function containedPath(path: string, root: string): Promise<string | null> {
  try {
    const actual = await realpath(path)
    return actual === root || actual.startsWith(root + sep) ? actual : null
  } catch { return null }
}

async function scanSkills(root: string, source: SkillSource, prefix = '', plugin?: string, boundary?: string): Promise<SkillInfo[]> {
  const found = await Promise.all((await directories(root)).map(async (dir): Promise<SkillInfo | null> => {
    const path = boundary ? await containedPath(join(dir, 'SKILL.md'), boundary) : join(dir, 'SKILL.md')
    if (!path) return null
    const text = await readText(path)
    if (text === null) return null
    const fields = parseFrontmatter(text)
    return { name: prefix + (fields.name || basename(dir)), description: describe(text, fields), kind: 'skill', source, path, plugin }
  }))
  return found.filter((s): s is SkillInfo => s !== null)
}

/** commands/**\/*.md，子目录用冒号连接（与 Claude Code 的命名一致） */
async function scanCommands(root: string, source: SkillSource, prefix = '', plugin?: string): Promise<SkillInfo[]> {
  let entries: string[]
  try { entries = (await readdir(root, { recursive: true })).map(String).filter(name => name.endsWith('.md')) } catch { return [] }
  return Promise.all(entries.map(async (name): Promise<SkillInfo> => {
    const path = join(root, name), text = (await readText(path)) ?? ''
    return { name: prefix + name.slice(0, -3).split(sep).join(':'), description: describe(text, parseFrontmatter(text)), kind: 'command', source, path, plugin }
  }))
}

/** 用户级在前，项目级覆盖在后；project 记录被项目设置决定的插件 */
async function enabledPlugins(cwd: string | null): Promise<{ merged: Record<string, boolean>; project: Set<string> }> {
  const files = [join(configDir(), 'settings.json')]
  if (cwd) files.push(join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'))
  const merged: Record<string, boolean> = {}, project = new Set<string>()
  for (const [index, settings] of (await Promise.all(files.map(readJson))).entries()) {
    const value = settings?.enabledPlugins
    if (value && typeof value === 'object') for (const [id, on] of Object.entries(value)) { merged[id] = on === true; if (index > 0) project.add(id) }
  }
  return { merged, project }
}

async function scanPlugins(cwd: string | null): Promise<{ plugins: PluginInfo[]; skills: SkillInfo[] }> {
  const [installed, enabled] = await Promise.all([readJson(join(configDir(), 'plugins', 'installed_plugins.json')), enabledPlugins(cwd)])
  const records = installed?.plugins && typeof installed.plugins === 'object' ? Object.entries(installed.plugins as Record<string, any[]>) : []
  const results = await Promise.all(records.map(async ([id, installs]) => {
    // 同一插件可能装在多个作用域，优先当前项目，其次用户级
    const list = Array.isArray(installs) ? installs.filter(i => i && typeof i.installPath === 'string') : []
    const install = list.find(i => cwd && i.projectPath && resolve(i.projectPath) === cwd) ?? list.find(i => i.scope === 'user') ?? list[0]
    if (!install) return null
    const root: string = install.installPath
    const manifest = (await readJson(join(root, '.claude-plugin', 'plugin.json'))) ?? {}
    const [name, marketplace] = id.split('@')
    const prefix = `${typeof manifest.name === 'string' ? manifest.name : name}:`
    const plugin: PluginInfo = {
      id, name: typeof manifest.name === 'string' ? manifest.name : name, marketplace, path: root,
      version: install.version ?? manifest.version, description: typeof manifest.description === 'string' ? manifest.description : undefined,
      enabled: enabled.merged[id] === true, projectOverride: enabled.project.has(id)
    }
    const declared = typeof manifest.skills === 'string' ? [manifest.skills] : Array.isArray(manifest.skills) ? manifest.skills.filter((p: unknown): p is string => typeof p === 'string') : []
    const boundary = await realpath(root).catch(() => null)
    const customSkills = await Promise.all(declared.map(async (relative: string): Promise<SkillInfo[]> => {
      const directory = resolve(root, relative)
      if (!boundary || (directory !== resolve(root) && !directory.startsWith(resolve(root) + sep)) || !await containedPath(directory, boundary)) return []
      const path = await containedPath(join(directory, 'SKILL.md'), boundary)
      const text = path ? await readText(path) : null
      if (text === null || !path) return scanSkills(directory, 'plugin', prefix, id, boundary)
      const fields = parseFrontmatter(text)
      return [{ name: prefix + (fields.name || basename(directory)), description: describe(text, fields), kind: 'skill', source: 'plugin', path, plugin: id }]
    }))
    const [defaults, commands] = await Promise.all([boundary ? scanSkills(join(root, 'skills'), 'plugin', prefix, id, boundary) : [], scanCommands(join(root, 'commands'), 'plugin', prefix, id)])
    const skills = [...new Map([...defaults, ...customSkills.flat()].map(skill => [skill.path, skill])).values()]
    return { plugin, skills: [...skills, ...commands] }
  }))
  const ok = results.filter(r => r !== null)
  return { plugins: ok.map(r => r.plugin).sort((a, b) => a.name.localeCompare(b.name)), skills: ok.flatMap(r => r.skills) }
}

/** claude.ai 账号同步的技能：skills/synced/<org_user>/<name>/SKILL.md，以 anthropic-skills: 前缀调用 */
async function scanSynced(): Promise<SkillInfo[]> {
  const roots = await directories(join(configDir(), 'skills', 'synced'))
  return (await Promise.all(roots.map(root => scanSkills(root, 'synced', 'anthropic-skills:')))).flat()
}

/** 最近一次扫描到的文件，读取正文只允许这些路径，避免渲染进程借此读任意文件。 */
const knownFiles = new Set<string>()

/** 整理 Claude Code 可用的技能与插件。cwd 为 null 或用户目录时不读取项目级内容。 */
export async function readSkillCatalog(projectPath: string | null): Promise<SkillCatalog> {
  const user = configDir()
  const cwd = projectPath ? resolve(projectPath) : null
  const project = cwd && join(cwd, '.claude') !== user ? cwd : null
  const [userSkills, userCommands, projectSkills, projectCommands, synced, plugins] = await Promise.all([
    scanSkills(join(user, 'skills'), 'user'),
    scanCommands(join(user, 'commands'), 'user'),
    project ? scanSkills(join(project, '.claude', 'skills'), 'project') : [],
    project ? scanCommands(join(project, '.claude', 'commands'), 'project') : [],
    scanSynced(),
    scanPlugins(project)
  ])
  const skills = [...userSkills, ...userCommands, ...projectSkills, ...projectCommands, ...synced, ...plugins.skills]
  for (const skill of skills) knownFiles.add(skill.path)
  return { skills: skills.sort((a, b) => a.name.localeCompare(b.name)), plugins: plugins.plugins }
}

/** 读取技能正文（去掉 frontmatter），过长时截断 */
export async function readSkillBody(path: string): Promise<string> {
  if (!knownFiles.has(path)) throw new Error('只能读取已扫描到的技能文件')
  const text = await readFile(path, 'utf8')
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
  return body.length > 60_000 ? body.slice(0, 60_000) + '\n\n…（内容过长，已截断）' : body
}

/** 在用户级 settings.json 里开关插件。保留其余字段，解析失败时拒绝写入，先写临时文件再替换。 */
export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  const installed = await readJson(join(configDir(), 'plugins', 'installed_plugins.json'))
  if (!installed?.plugins || !Object.hasOwn(installed.plugins, id)) throw new Error(`未安装插件 ${id}`)
  const file = join(configDir(), 'settings.json')
  const text = await readText(file)
  let settings: Record<string, any> = {}
  if (text !== null && text.trim()) {
    try { settings = JSON.parse(text) } catch { throw new Error('settings.json 格式有误，未做修改') }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings.json 格式有误，未做修改')
  }
  const current = settings.enabledPlugins && typeof settings.enabledPlugins === 'object' && !Array.isArray(settings.enabledPlugins) ? settings.enabledPlugins : {}
  settings.enabledPlugins = { ...current, [id]: enabled }
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
