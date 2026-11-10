import { create } from 'zustand'
import type { UsageOverview, UsageProfile } from '@shared/usageAnalytics'

interface State {
  overview: UsageOverview | null
  loading: boolean
  error: string | null
  failures: number
  lastAttempt: number
  scope: string
  setScope(scope: string): void
  refresh(): Promise<void>
  saveProfile(profile: UsageProfile): Promise<void>
}
let pending: { scope: string; task: Promise<void> } | null = null
let profileRevision = 0
export const useUsage = create<State>((set, get) => ({
  overview: null, loading: false, error: null, failures: 0, lastAttempt: 0, scope: '',
  setScope(scope) {
    if (get().scope === scope) return
    pending = null
    set({ scope, overview: null, loading: false, error: null, failures: 0, lastAttempt: 0 })
  },
  refresh() {
    const scope = get().scope
    if (pending?.scope === scope) return pending.task
    set({ loading: true, lastAttempt: Date.now() })
    const revision = profileRevision
    const task = window.desk.usage.overview(scope || undefined).then(overview => {
      if (pending?.task !== task) return
      const previous = get().overview
      const sameAccount = previous?.account.key === overview.account.key
      if (sameAccount && revision !== profileRevision) overview.profile = previous!.profile
      if (overview.usageError && sameAccount) { overview.usage = previous!.usage; overview.updatedAt = previous!.updatedAt }
      set({ overview, error: overview.usageError ?? null, failures: overview.usageError ? get().failures + 1 : 0 })
    }, error => { if (pending?.task === task) set({ error: String(error.message ?? error), failures: get().failures + 1 }) }).finally(() => {
      if (pending?.task === task) { pending = null; set({ loading: false }) }
    })
    pending = { scope, task }
    return task
  },
  async saveProfile(profile) {
    const { scope, overview: previous } = get()
    if (!previous) throw new Error('账户信息已变化，请刷新后重试')
    const saved = await window.desk.usage.saveProfile(previous.account.key, profile, scope || undefined)
    profileRevision++
    const current = get().overview
    if (get().scope === scope && current?.account.key === previous.account.key) set({ overview: { ...current, profile: saved } })
  }
}))
