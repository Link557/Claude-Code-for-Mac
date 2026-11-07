// 模型信息来自 CLI 初始化。磁盘缓存只用于启动时展示，权威结果仍由 get 查询。
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { CommandInfo, MetaInfo, ModelOption } from '../shared/types'
import { readMetadata } from './metadataQuery'
import { claudeExecutable } from './sdk'

const TTL = 5 * 60_000
const DISK_TTL = 7 * 24 * 60 * 60_000
const diskWrites = new Map<string, Promise<void>>()
const metaCache = new Map<string, { promise: Promise<MetaInfo>; expires: number }>()

async function configuration(): Promise<string> {
  const executable = claudeExecutable()
  let fingerprint: string | null = null
  if (executable) {
    try { const info = await stat(executable); fingerprint = `${info.size}:${info.mtimeMs}` } catch { fingerprint = 'missing' }
  }
  return JSON.stringify([app.getVersion(), executable ?? null, fingerprint, process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')])
}
async function key(cwd: string): Promise<string> {
  const directory = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const settings = await Promise.all([
    join(directory, 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')
  ].map(async path => {
    try { return await readFile(path, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
  }))
  const env = Object.entries(process.env).filter(([name]) => /^(ANTHROPIC_|CLAUDE_CODE_USE_|AWS_PROFILE$|CLOUD_ML_REGION$|ANTHROPIC_VERTEX_PROJECT_ID$)/.test(name)).sort(([a], [b]) => a.localeCompare(b))
  // Configuration can contain secrets: only its digest may be persisted in a cache key.
  const fingerprint = createHash('sha256').update(JSON.stringify([settings, env])).digest('hex')
  return JSON.stringify([cwd, await configuration(), fingerprint])
}
function filename(cacheKey: string): string {
  return join(app.getPath('userData'), 'model-catalog', createHash('sha256').update(cacheKey).digest('hex') + '.json')
}
function validModels(value: unknown): value is ModelOption[] {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max']
  return Array.isArray(value) && value.length > 0 && value.every(m => m && typeof m.value === 'string' && m.value.trim().length > 0 && typeof m.label === 'string' && (m.resolvedModel === undefined || typeof m.resolvedModel === 'string') && Array.isArray(m.efforts) && m.efforts.every((level: unknown) => typeof level === 'string' && levels.includes(level)))
}
export async function cachedModels(cwd = homedir()): Promise<ModelOption[] | null> {
  try {
    const cacheKey = await key(cwd)
    const saved = JSON.parse(await readFile(filename(cacheKey), 'utf8'))
    if (saved.version !== 2 || saved.key !== cacheKey || !Number.isFinite(saved.updatedAt) || saved.updatedAt > Date.now() || Date.now() - saved.updatedAt >= DISK_TTL || !validModels(saved.models)) return null
    return saved.models
  } catch { return null }
}
async function saveModels(cacheKey: string, models: ModelOption[], current: () => boolean): Promise<void> {
  if (!validModels(models)) return
  const file = filename(cacheKey), temporary = `${file}.${randomUUID()}.tmp`
  try {
    await mkdir(join(app.getPath('userData'), 'model-catalog'), { recursive: true })
    await writeFile(temporary, JSON.stringify({ version: 2, key: cacheKey, updatedAt: Date.now(), models }), { mode: 0o600 })
    if (current()) await rename(temporary, file)
    else await rm(temporary, { force: true })
  } catch {
    try { await rm(temporary, { force: true }) } catch { /* 缓存写入失败不影响查询 */ }
  }
}
function updateDisk(cacheKey: string, models: ModelOption[], current: () => boolean): Promise<void> {
  const previous = diskWrites.get(cacheKey) ?? Promise.resolve()
  const task = previous.then(async () => {
    if (!current()) return
    if (models.length) await saveModels(cacheKey, models, current)
    else {
      try { await rm(filename(cacheKey), { force: true }) } catch { /* 缓存删除失败不影响查询 */ }
    }
  })
  diskWrites.set(cacheKey, task)
  void task.finally(() => { if (diskWrites.get(cacheKey) === task) diskWrites.delete(cacheKey) })
  return task
}
export function invalidate(): void { metaCache.clear() }
export async function get(cwd = homedir(), onCommands?: (commands: CommandInfo[]) => void): Promise<MetaInfo> {
  const cacheKey = await key(cwd)
  const existing = metaCache.get(cacheKey)
  if (existing && existing.expires > Date.now()) return existing.promise
  const promise = readMetadata(cwd).then(async init => {
    const result: MetaInfo = {
      models: init.models.map(m => ({ value: m.value, resolvedModel: m.resolvedModel, label: m.displayName || m.resolvedModel || m.value, efforts: m.supportsEffort ? (m.supportedEffortLevels ?? []) : [] })),
      subscriptionType: init.account?.subscriptionType ?? null,
      email: init.account?.email ?? null,
      organization: init.account?.organization ?? null,
      claudeVersion: init.claude_code_version ?? null
    }
    const current = () => metaCache.get(cacheKey) === entry
    if (current() && cacheKey === await key(cwd) && current()) {
      try { if (Array.isArray(init.commands)) onCommands?.(init.commands) } catch { /* 命令目录失败不影响模型查询 */ }
      await updateDisk(cacheKey, result.models, current)
      if (current()) {
        if (result.models.length === 0) metaCache.delete(cacheKey)
        else entry.expires = Date.now() + TTL
      }
    } else if (current()) {
      metaCache.delete(cacheKey)
    }
    return result
  }).catch(error => {
    if (metaCache.get(cacheKey) === entry) metaCache.delete(cacheKey)
    throw error
  })
  const entry = { expires: Number.POSITIVE_INFINITY, promise }
  metaCache.set(cacheKey, entry)
  return promise
}
