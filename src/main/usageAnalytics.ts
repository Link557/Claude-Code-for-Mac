import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setImmediate } from 'node:timers/promises'
import type { TokenUsage } from '../shared/chat'
import { dateKey, EMPTY_ANALYTICS, streaks, usageModel, type DailyUsage, type UsageAnalytics, type UsageModel } from '../shared/usageAnalytics'

type RecordUsage = { id: string; time: number; model: UsageModel | null; usage: TokenUsage }
type FileIndex = { size: number; mtime: number; records: RecordUsage[]; longestTaskMs: number | null; issues: number }
type Cache = { version: 2; root: string; files: Record<string, FileIndex>; longestRecordedTaskMs: number | null }
const validNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

/** Version-bound JSONL adapter. Only extract usage metadata; never retain conversation text. */
export function extractUsage(entry: any): { record?: RecordUsage; duration?: number; invalid?: boolean } {
  if (!entry || typeof entry !== 'object') return {}
  if (entry.type === 'system' && entry.subtype === 'turn_duration' && validNumber(entry.durationMs)) return { duration: entry.durationMs }
  if (entry.type !== 'assistant' || entry.isApiErrorMessage || !entry.message?.usage) return {}
  const raw = entry.message.usage
  const id = typeof entry.message.id === 'string' && entry.message.id ? `response:${entry.message.id}` : typeof entry.uuid === 'string' && entry.uuid ? `uuid:${entry.uuid}` : null
  const time = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  const fields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
  if (!id || !Number.isFinite(time) || fields.some(k => raw[k] !== undefined && !validNumber(raw[k]))) return { invalid: true }
  const [input, output, cacheRead, cacheWrite] = fields.map(k => raw[k] ?? 0)
  return { record: { id, time, model: usageModel(entry.message.model), usage: { input, output, cacheRead, cacheWrite } } }
}
export function aggregateUsage(files: FileIndex[], now = new Date()): UsageAnalytics {
  const unique = new Map<string, RecordUsage>()
  let longestTaskMs: number | null = null, issues = 0
  for (const file of files) {
    issues += file.issues
    if (file.longestTaskMs !== null) longestTaskMs = Math.max(longestTaskMs ?? 0, file.longestTaskMs)
    for (const record of file.records) {
      const previous = unique.get(record.id)
      if (!previous) unique.set(record.id, { ...record, usage: { ...record.usage } })
      else {
        previous.time = Math.min(previous.time, record.time)
        previous.model ??= record.model
        for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) previous.usage[k] = Math.max(previous.usage[k], record.usage[k])
      }
    }
  }
  const daily = new Map<string, DailyUsage>()
  for (const { time, usage, model } of unique.values()) {
    const date = dateKey(new Date(time))
    if (date > dateKey(now)) { issues++; continue }
    const day: DailyUsage = daily.get(date) ?? { date, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, byModel: {} }
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) { day[k] += usage[k]; day.total += usage[k] }
    if (model) {
      const counters = day.byModel![model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) counters[k] += usage[k]
    }
    daily.set(date, day)
  }
  const days = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date))
  return { ...EMPTY_ANALYTICS, days, total: days.reduce((sum, d) => sum + d.total, 0), peak: Math.max(0, ...days.map(d => d.total)), longestTaskMs, issues, firstDate: days[0]?.date ?? null, ...streaks(days, dateKey(now)), updatedAt: now.getTime() }
}
export class UsageIndexer {
  private cache: Cache
  private loaded = false
  private pending: Promise<UsageAnalytics> | null = null
  private snapshot: UsageAnalytics = { ...EMPTY_ANALYTICS }
  constructor(private root: string, private cachePath: string) { this.cache = { version: 2, root, files: {}, longestRecordedTaskMs: null } }
  async recordDuration(duration: number): Promise<void> {
    if (!validNumber(duration)) return
    await this.load()
    this.cache.longestRecordedTaskMs = Math.max(this.cache.longestRecordedTaskMs ?? 0, duration)
    await this.refresh()
  }
  private loadPromise: Promise<void> | null = null
  private load(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    return this.loadPromise ??= (async () => {
      try {
        const c = JSON.parse(await readFile(this.cachePath, 'utf8'))
        if (c.root === this.root) {
          if (c.version === 2 && c.files && typeof c.files === 'object') this.cache = c
          // Re-read transcripts from the old index to recover model metadata.
          else if (c.version === 1 && validNumber(c.longestRecordedTaskMs)) this.cache.longestRecordedTaskMs = c.longestRecordedTaskMs
        }
      } catch { /* Derived cache can always be rebuilt. */ }
      this.loaded = true
    })()
  }
  async get(): Promise<UsageAnalytics> {
    await this.load()
    if (!this.snapshot.updatedAt) {
      try { this.snapshot = aggregateUsage(Object.values(this.cache.files)) } catch { this.cache.files = {}; this.snapshot = { ...EMPTY_ANALYTICS } }
      void this.refresh()
    }
    return { ...this.snapshot, scanning: this.pending !== null }
  }
  refresh(): Promise<UsageAnalytics> {
    if (this.pending) return this.pending
    this.pending = this.scan().catch(error => ({ ...this.snapshot, scanning: false, error: String(error.message ?? error) })).then(value => { this.snapshot = value; return value }).finally(() => { this.pending = null })
    return this.pending
  }
  private async scan(): Promise<UsageAnalytics> {
    await this.load()
    const next: Record<string, FileIndex> = {}
    const walk = async (dir: string): Promise<void> => {
      let entries
      try { entries = await readdir(dir, { withFileTypes: true }) }
      catch (error: any) {
        if (error.code !== 'ENOENT') throw error
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) { await walk(path); continue }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const info = await stat(path), old = this.cache.files[path]
        if (old && old.size === info.size && old.mtime === info.mtimeMs) { next[path] = old; continue }
        const file: FileIndex = { size: info.size, mtime: info.mtimeMs, records: [], longestTaskMs: null, issues: 0 }
        const stream = createReadStream(path, { encoding: 'utf8' })
        const lines = createInterface({ input: stream, crlfDelay: Infinity })
        let count = 0
        for await (const line of lines) {
          if (!line.trim()) continue
          try {
            const parsed = extractUsage(JSON.parse(line))
            if (parsed.record) file.records.push(parsed.record)
            if (parsed.duration !== undefined) file.longestTaskMs = Math.max(file.longestTaskMs ?? 0, parsed.duration)
            if (parsed.invalid) file.issues++
          } catch { file.issues++ }
          if (++count % 300 === 0) await setImmediate()
        }
        next[path] = file
      }
    }
    await walk(join(this.root, 'projects'))
    this.cache.files = next
    const value = aggregateUsage(Object.values(next))
    if (this.cache.longestRecordedTaskMs !== null) value.longestTaskMs = Math.max(value.longestTaskMs ?? 0, this.cache.longestRecordedTaskMs)
    await mkdir(join(this.cachePath, '..'), { recursive: true })
    await writeFile(this.cachePath + '.tmp', JSON.stringify(this.cache))
    await rename(this.cachePath + '.tmp', this.cachePath)
    return value
  }
}
