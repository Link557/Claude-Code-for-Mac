import { useEffect, useState } from 'react'
import type { ModelOption } from '@shared/types'
import { useDesk } from '../../store'

interface Catalog {
  scope: string
  models: ModelOption[] | null
  loading: boolean
  error: string | null
  cached: boolean
}

export function useModelCatalog(cwd?: string) {
  const executable = useDesk(s => s.settings?.claudePath)
  const scope = JSON.stringify([cwd ?? null, executable ?? null])
  const [catalog, setCatalog] = useState<Catalog>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => window.desk.meta.onConfigChanged?.(change => {
    if (change.scope !== 'project' || change.cwd === cwd) setAttempt(value => value + 1)
  }), [cwd])
  useEffect(() => {
    let active = true
    let freshSucceeded = false
    setCatalog(previous => previous?.scope === scope
      ? { ...previous, loading: true, error: null, cached: previous.models !== null }
      : { scope, models: null, loading: true, error: null, cached: false })
    void window.desk.meta.cachedModels(cwd).then(models => {
      if (active && !freshSucceeded && models) setCatalog(previous => ({
        scope, models, loading: previous?.scope === scope ? previous.loading : true,
        error: previous?.scope === scope ? previous.error : null, cached: true
      }))
    }, () => { /* The live query can still succeed. */ })
    void window.desk.meta.get(cwd).then(result => {
      if (!active) return
      if (result.modelCatalogError) {
        setCatalog(previous => ({
          scope, models: previous?.scope === scope ? previous.models : null, loading: false,
          error: result.modelCatalogError ?? null, cached: previous?.scope === scope && previous.cached
        }))
        return
      }
      freshSucceeded = true
      setCatalog({ scope, models: result.models, loading: false, error: null, cached: false })
    }, error => {
      if (active) setCatalog(previous => ({
        scope, models: previous?.scope === scope ? previous.models : null, loading: false,
        error: error instanceof Error ? error.message : String(error), cached: previous?.scope === scope && previous.cached
      }))
    })
    return () => { active = false }
  }, [cwd, scope, attempt])
  const current = catalog?.scope === scope ? catalog : undefined
  return {
    models: current?.models ?? [], loading: current?.loading ?? true,
    error: current?.error ?? null, cached: current?.cached ?? false,
    retry: () => setAttempt(value => value + 1)
  }
}
