import { readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { LEGACY_CONFIG_KEYS } from './claudeConfigValues'
import { shouldAdopt } from './env'
import type { ClaudeConfigChange } from '../shared/claudeConfig'

const listeners = new Set<(change: ClaudeConfigChange) => void>()
export function onClaudeConfigChanged(listener: (change: ClaudeConfigChange) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Only file metadata is inspected; settings and credentials never enter the event. */
function stamp(path: string): string {
  try {
    if (basename(path) === '.claude.json') {
      try {
        const data = JSON.parse(readFileSync(path, 'utf8'))
        return JSON.stringify(LEGACY_CONFIG_KEYS.map(key => [key, data?.[key] ?? null]))
      } catch { /* Invalid files still invalidate by metadata so the view can show the read error. */ }
    }
    const s = statSync(path, { bigint: true })
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
  } catch { return 'unavailable' }
}

const watchers = new Map<string, { close(): void }>()

function configFiles(cwd: string) {
  cwd = resolve(cwd)
  const configDir = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
  const legacy = process.env.CLAUDE_CONFIG_DIR ? join(configDir, '.claude.json') : join(homedir(), '.claude.json')
  return [
    { path: join(configDir, 'settings.json'), scope: 'user' as const },
    { path: legacy, scope: 'user' as const },
    { path: join(cwd, '.claude', 'settings.json'), scope: 'project' as const },
    { path: join(cwd, '.claude', 'settings.local.json'), scope: 'project' as const }
  ]
}

/** Stable cache identity, with configuration and environment values kept out of persisted keys. */
export function claudeConfigIdentity(cwd: string): string {
  const files = configFiles(cwd).map(file => [file.path, stamp(file.path)])
  const env = Object.entries(process.env).filter(([name]) => shouldAdopt(name)).sort(([a], [b]) => a.localeCompare(b))
  return createHash('sha256').update(JSON.stringify([files, env])).digest('hex')
}

/** Watch only configuration directories and their parents; never recursively watch the project. */
export function watchClaudeConfig(cwd: string): void {
  cwd = resolve(cwd)
  const configDir = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
  const key = JSON.stringify([cwd, configDir])
  if (watchers.has(key)) return
  const files = configFiles(cwd)
  const directories = new Map<string, Set<string>>()
  const add = (dir: string, name: string) => {
    let names = directories.get(dir)
    if (!names) directories.set(dir, names = new Set())
    names.add(name)
  }
  for (const file of files) {
    const dir = dirname(file.path)
    add(dir, basename(file.path))
    add(dirname(dir), basename(dir))
  }
  let previous = files.map(file => stamp(file.path))
  let handles: FSWatcher[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  function bind(): void {
    for (const handle of handles) handle.close()
    handles = []
    if (closed) return
    for (const [directory, names] of directories) {
      try {
        const handle = watch(directory, (_event, filename) => {
          if (filename && !names.has(filename.toString())) return
          clearTimeout(timer)
          timer = setTimeout(() => {
            const next = files.map(file => stamp(file.path))
            const changed = files.filter((_, index) => previous[index] !== next[index])
            previous = next
            bind() // Reattach after directory replacement or creation.
            if (changed.length) {
              const scope = changed.some(file => file.scope === 'user') ? 'user' : 'project'
              for (const listener of listeners) {
                try { listener({ cwd, scope }) } catch (error) { console.error('刷新配置通知失败', error) }
              }
            }
          }, 40)
          timer.unref?.()
        })
        handle.on('error', () => { /* Parent watcher can reattach when a directory returns. */ })
        handle.unref()
        handles.push(handle)
      } catch { /* Missing directories are picked up by their parent watcher. */ }
    }
  }
  bind()
  watchers.set(key, { close() { closed = true; clearTimeout(timer); for (const handle of handles) handle.close() } })
}

export function closeClaudeConfigWatchers(): void {
  for (const watcher of watchers.values()) watcher.close()
  watchers.clear()
}

export function observeClaudeConfig(cwd: string): (fallback?: boolean) => void {
  const files = configFiles(cwd)
  let previous = files.map(file => stamp(file.path))
  return (fallback = false) => {
    const next = files.map(file => stamp(file.path))
    const changed = files.filter((_, index) => previous[index] !== next[index])
    previous = next
    if (!changed.length && !fallback) return
    const scope = changed.some(file => file.scope === 'user') ? 'user' : changed.length ? 'project' : 'unknown'
    for (const listener of listeners) {
      try { listener({ cwd: resolve(cwd), scope }) }
      catch (error) { console.error('刷新配置通知失败', error) }
    }
  }
}

export function isConfigMutation(text: string): boolean {
  return /^\/(?:config\s+[A-Za-z][\w.-]*=\S|(?:output-style|autocompact)\s+\S)/.test(text.trim())
}
