import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CommandInfo } from '@shared/types'
import type { Trigger } from '@shared/format'
import { APP_COMMANDS, BASE_COMMANDS, mergeCommands, type CommandCatalogSnapshot } from '@shared/commandCatalog'
import { useDesk } from '../../store'
import { errorText } from '../../ipcError'

export interface Suggestion { key: string; label: string; hint?: string; detail?: string; insert: string }
const NO_COMMANDS: CommandInfo[] = []
function useCommandCatalog(cwd: string | undefined, active: boolean) {
  const executable = useDesk((state) => state.settings?.claudePath)
  const scope = JSON.stringify([cwd, executable])
  const currentScope = useRef(scope)
  const mounted = useRef(true)
  currentScope.current = scope
  const [result, setResult] = useState<{ scope: string; snapshot: CommandCatalogSnapshot } | null>(null)
  const accept = useCallback((snapshot: CommandCatalogSnapshot) => {
    if (!mounted.current || currentScope.current !== scope || !cwd || snapshot.cwd !== cwd) return
    setResult((previous) => previous?.scope === scope && previous.snapshot.revision > snapshot.revision ? previous : { scope, snapshot })
  }, [cwd, scope])
  const request = useCallback(async (force = false) => {
    if (!cwd || !window.desk?.meta?.commands) return
    try { accept(await window.desk.meta.commands(cwd, force)) }
    catch (error) {
      if (!mounted.current || currentScope.current !== scope) return
      setResult((previous) => ({ scope, snapshot: { cwd, commands: previous?.scope === scope ? previous.snapshot.commands : BASE_COMMANDS, updatedAt: previous?.snapshot.updatedAt ?? 0, revision: previous?.scope === scope ? previous.snapshot.revision : 0, status: 'error', error: errorText(error) } }))
    }
  }, [cwd, scope, accept])
  useEffect(() => {
    mounted.current = true
    if (!cwd || !active) return () => { mounted.current = false }
    let live = true
    const off = window.desk?.meta?.onCommands?.((snapshot) => { if (live) accept(snapshot) })
    const offConfig = window.desk?.meta?.onConfigChanged?.((change) => {
      if (change.scope !== 'project' || change.cwd === cwd) void request(true)
    })
    const refresh = (): void => { void request() }
    refresh()
    window.addEventListener('focus', refresh)
    return () => { live = false; mounted.current = false; off?.(); offConfig?.(); window.removeEventListener('focus', refresh) }
  }, [cwd, active, accept, request])
  return {
    snapshot: result?.scope === scope ? result.snapshot : { cwd: cwd ?? '', revision: 0, commands: BASE_COMMANDS, status: 'loading' as const, updatedAt: 0 },
    request
  }
}
export function matchCommands(commands: CommandInfo[], query: string): Suggestion[] {
  const q = query.toLowerCase()
  return commands.filter((c) => c.name.toLowerCase().includes(q))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
    .map((c) => ({ key: c.name, label: '/' + c.name, hint: c.argumentHint || undefined, detail: c.description, insert: '/' + c.name }))
}
export function useSuggestions(trigger: Trigger | null, cwd: string | undefined, extra: CommandInfo[] = NO_COMMANDS) {
  const { snapshot, request } = useCommandCatalog(cwd, trigger?.kind === '/')
  const [files, setFiles] = useState<{ context: string; items: Suggestion[] }>({ context: '', items: [] })
  const [selection, setSelection] = useState<{ context: string; key: string } | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const context = JSON.stringify([cwd, trigger?.kind, trigger?.start, trigger?.query])
  const kind = trigger?.kind, query = trigger?.query
  useEffect(() => { if (!kind) setDismissed(null) }, [kind])
  useEffect(() => {
    if (kind !== '@' || query === undefined || !cwd) return
    let stale = false
    void window.desk.files.search(cwd, query).then((names) => {
      if (!stale) setFiles({ context, items: names.map((name) => ({ key: name, label: name, insert: '@' + name })) })
    }, () => { if (!stale) setFiles({ context, items: [] }) })
    return () => { stale = true }
  }, [kind, query, cwd, context])
  const items = useMemo(() => {
    if (!cwd || !kind || query === undefined) return []
    return kind === '/' ? matchCommands(mergeCommands(snapshot.commands, APP_COMMANDS, extra), query) : files.context === context ? files.items : []
  }, [cwd, kind, query, snapshot.commands, extra, files, context])
  const selected = selection?.context === context ? items.findIndex((item) => item.key === selection.key) : -1
  const selectionRemoved = selection?.context === context && selected < 0
  const active = selectionRemoved ? -1 : Math.max(0, selected)
  useLayoutEffect(() => {
    if (items.length && selected < 0 && !selectionRemoved) setSelection({ context, key: items[0].key })
  }, [items, selected, selectionRemoved, context])
  return {
    items, active,
    setActive: (index: number): void => { if (items[index]) setSelection({ context, key: items[index].key }) },
    open: Boolean(cwd && kind && dismissed !== context && (kind === '/' || items.length)),
    dismiss: (): void => setDismissed(context),
    status: kind === '/' ? snapshot.status : 'ready' as const,
    error: kind === '/' ? snapshot.error : undefined,
    retry: (): void => { void request(true) }
  }
}
