import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandInfo } from '../shared/types'
import { BASE_COMMANDS, type CommandCatalogSnapshot } from '../shared/commandCatalog'

const TTL = 5 * 60_000
const TIMEOUT = 15_000
interface Entry { cwd: string; configuration: string; snapshot: CommandCatalogSnapshot; attempt: number; generation: number; controller?: AbortController }
interface Dependencies {
  directory(): string
  configuration(cwd: string): string
  load(cwd: string, signal: AbortSignal, configuration: string): Promise<CommandInfo[]>
  publish(snapshot: CommandCatalogSnapshot): void
  now?(): number
}
function validCommands(value: unknown): value is CommandInfo[] {
  return Array.isArray(value) && value.every((c) => c && typeof c.name === 'string' && typeof c.description === 'string' && typeof c.argumentHint === 'string')
}

/** 唯一的命令目录所有者。调用 get 立即取得快照，查询、去重和持久化均在主进程完成。 */
export class CommandCatalog {
  private entries = new Map<string, Entry>()
  private revision = 0
  private disposed = false
  constructor(private deps: Dependencies) {}
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private key(cwd: string, configuration: string): string { return JSON.stringify([cwd, configuration]) }
  private filename(key: string): string { return join(this.deps.directory(), createHash('sha256').update(key).digest('hex') + '.json') }
  private entry(cwd: string, configuration = this.deps.configuration(cwd)): Entry {
    const key = this.key(cwd, configuration)
    let entry = this.entries.get(key)
    if (entry) return entry
    let commands = BASE_COMMANDS, updatedAt = 0, ready = false
    try {
      const saved = JSON.parse(readFileSync(this.filename(key), 'utf8'))
      if (saved.version === 1 && saved.cwd === cwd && saved.configuration === configuration && validCommands(saved.commands) && typeof saved.updatedAt === 'number' && Number.isFinite(saved.updatedAt)) {
        commands = saved.commands; updatedAt = saved.updatedAt; ready = true
      }
    } catch { /* 缓存缺失或损坏时使用本地常用命令 */ }
    entry = { cwd, configuration, generation: 0, attempt: 0, snapshot: { cwd, commands, updatedAt, revision: ++this.revision, status: ready ? 'ready' : 'loading' } }
    this.entries.set(key, entry)
    return entry
  }
  private emit(entry: Entry, patch: Partial<CommandCatalogSnapshot>): void {
    entry.snapshot = { ...entry.snapshot, ...patch, revision: ++this.revision }
    if (!this.disposed && entry.configuration === this.deps.configuration(entry.cwd)) this.deps.publish(structuredClone(entry.snapshot))
  }
  get(cwd: string, force = false): CommandCatalogSnapshot {
    const entry = this.entry(cwd)
    const fresh = entry.snapshot.status === 'ready' && entry.snapshot.updatedAt <= this.now() && this.now() - entry.snapshot.updatedAt < TTL
    const failedRecently = entry.snapshot.status === 'error' && this.now() - entry.attempt < TTL
    if (!this.disposed && !entry.controller && (force || (!fresh && !failedRecently))) this.refresh(entry)
    return structuredClone(entry.snapshot)
  }
  /** 元信息查询启动时捕获版本，避免迟到结果覆盖会话或新配置。 */
  seedFromMetadata(cwd: string): (commands: CommandInfo[]) => void {
    const entry = this.entry(cwd)
    const generation = entry.generation
    return (commands) => {
      const current = this.entries.get(this.key(cwd, entry.configuration))
      const fresh = entry.snapshot.status === 'ready' && entry.snapshot.updatedAt <= this.now() && this.now() - entry.snapshot.updatedAt < TTL
      if (this.disposed || current !== entry || entry.configuration !== this.deps.configuration(cwd) || entry.generation !== generation || entry.controller || fresh) return
      this.accept(entry, commands)
    }
  }
  /** 会话在创建时捕获配置，防止旧可执行文件的迟到事件污染新目录。 */
  publisher(cwd: string, configuration = this.deps.configuration(cwd)): (commands: CommandInfo[]) => void {
    return (commands) => {
      if (this.disposed || configuration !== this.deps.configuration(cwd)) return
      const entry = this.entry(cwd, configuration)
      entry.generation++
      entry.controller?.abort(); entry.controller = undefined
      this.accept(entry, commands)
    }
  }
  private accept(entry: Entry, commands: CommandInfo[]): void {
    if (!validCommands(commands)) throw new Error('命令目录格式无效')
    const clean = [...new Map(commands.map((command) => [command.name, { name: command.name, description: command.description, argumentHint: command.argumentHint }])).values()]
    this.emit(entry, { commands: clean, updatedAt: this.now(), status: 'ready', error: undefined })
    const file = this.filename(this.key(entry.cwd, entry.configuration)), temporary = `${file}.${randomUUID()}.tmp`
    try {
      mkdirSync(this.deps.directory(), { recursive: true })
      writeFileSync(temporary, JSON.stringify({ version: 1, cwd: entry.cwd, configuration: entry.configuration, commands: clean, updatedAt: entry.snapshot.updatedAt }))
      renameSync(temporary, file)
    } catch (error) {
      try { rmSync(temporary, { force: true }) } catch { /* 不影响内存目录使用 */ }
      console.error('保存命令目录缓存失败', error)
    }
  }
  private refresh(entry: Entry): void {
    const generation = ++entry.generation
    const controller = new AbortController()
    entry.controller = controller; entry.attempt = this.now()
    this.emit(entry, { status: 'loading', error: undefined })
    let timer: ReturnType<typeof setTimeout>
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('命令目录查询已取消')), { once: true })
      timer = setTimeout(() => { reject(new Error('项目命令加载超时，请重试')); controller.abort() }, TIMEOUT)
    })
    const current = (): boolean => !this.disposed && entry.generation === generation && entry.configuration === this.deps.configuration(entry.cwd)
    void Promise.race([Promise.resolve().then(() => { if (controller.signal.aborted) throw new Error('查询已取消'); return this.deps.load(entry.cwd, controller.signal, entry.configuration) }), cancelled]).then(
      (commands) => { if (current()) this.accept(entry, commands) },
      (error) => { if (current()) this.emit(entry, { status: 'error', error: error instanceof Error ? error.message : String(error) }) }
    ).catch((error) => { if (current()) this.emit(entry, { status: 'error', error: String(error) }) }).finally(() => {
      clearTimeout(timer)
      if (entry.generation === generation) entry.controller = undefined
    })
  }
  invalidate(): void {
    for (const entry of this.entries.values()) { entry.generation++; entry.controller?.abort() }
    this.entries.clear()
  }
  close(): void { this.disposed = true; this.invalidate() }
}
