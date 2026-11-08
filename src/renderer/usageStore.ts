import { create } from 'zustand'
import type { UsageOverview, UsageProfile } from '@shared/usageAnalytics'
import { useDesk } from './store'

function usageScope(): string {
  const state = useDesk.getState()
  const projectId = state.view.kind === 'session' ? state.view.projectId : state.selectedProjectId
  return state.projects.find(project => project.id === projectId)?.path ?? state.home ?? ''
}

interface State {
  overview: UsageOverview | null
  loading: boolean
  error: string | null
  failures: number
  lastAttempt: number
  scope: string
  refresh(): Promise<void>
  saveProfile(profile: UsageProfile): Promise<void>
}
let pending: { scope: string; task: Promise<void> } | null = null
let profileRevision = 0
export const useUsage = create<State>((set, get) => ({
  overview: null, loading: false, error: null, failures: 0, lastAttempt: 0, scope: '',
  refresh() {
    const scope = usageScope()
    if (pending?.scope === scope) return pending.task
    if (get().scope !== scope) set({ scope, overview: null, error: null, failures: 0 })
    set({ loading: true, lastAttempt: Date.now() })
    const revision = profileRevision
    const task = window.desk.usage.overview(scope || undefined).then(overview => {
      if (get().scope !== scope) return
      const previous = get().overview
      const sameAccount = previous?.account.key === overview.account.key
      if (sameAccount && revision !== profileRevision) overview.profile = previous!.profile
      if (overview.usageError && sameAccount) { overview.usage = previous!.usage; overview.updatedAt = previous!.updatedAt }
      set({ overview, error: overview.usageError ?? null, failures: overview.usageError ? get().failures + 1 : 0 })
    }, error => { if (get().scope === scope) set({ error: String(error.message ?? error), failures: get().failures + 1 }) }).finally(() => {
      if (pending?.task === task) { pending = null; set({ loading: false }) }
    })
    pending = { scope, task }
    return task
  },
  async saveProfile(profile) {
    const previous = get().overview
    if (!previous) return
    const saved = await window.desk.usage.saveProfile(previous.account.key, profile)
    profileRevision++
    const current = get().overview
    if (current?.account.key === previous.account.key) set({ overview: { ...current, profile: saved } })
  }
}))

/** One shared poll for sidebar and page while the window is visible (focus not required). Focus checks do not bypass backoff; coming back online does. */
export function startUsagePolling(): () => void {
  let stopped = false
  // Let the model handshake start before the sidebar opens another CLI to fetch quota.
  const firstPoll = Date.now() + 5000
  const tick = (): void => {
    if (stopped || document.hidden || Date.now() < firstPoll) return
    const state = useUsage.getState()
    const interval = Math.min(300000, 60000 * 2 ** Math.min(state.failures, 3))
    if (!state.lastAttempt || Date.now() - state.lastAttempt >= interval) void state.refresh()
  }
  // Waking from sleep usually means the network was just restored: refresh right away instead of waiting out the backoff.
  const online = (): void => { if (!stopped && !document.hidden && Date.now() >= firstPoll) void useUsage.getState().refresh() }
  const timer = window.setInterval(tick, 5000)
  let scope = usageScope()
  const off = useDesk.subscribe(() => {
    const next = usageScope()
    if (next !== scope) {
      scope = next
      useUsage.setState({ scope: next, overview: null, error: null, failures: 0, lastAttempt: 0 })
      tick()
    }
  })
  window.addEventListener('focus', tick)
  window.addEventListener('online', online)
  document.addEventListener('visibilitychange', tick)
  return () => { stopped = true; off(); clearInterval(timer); window.removeEventListener('focus', tick); window.removeEventListener('online', online); document.removeEventListener('visibilitychange', tick) }
}
