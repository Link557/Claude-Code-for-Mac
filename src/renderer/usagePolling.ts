import { useDesk } from './store'
import { useUsage } from './usageStore'

function usageScope(): string {
  const state = useDesk.getState()
  const projectId = state.view.kind === 'session' ? state.view.projectId : state.selectedProjectId
  return state.projects.find(project => project.id === projectId)?.path ?? state.home ?? ''
}

/** One shared poll for sidebar and page while the window is visible. */
export function startUsagePolling(): () => void {
  let stopped = false
  // Let the model handshake start before fetching quota.
  const firstPoll = Date.now() + 5000
  const tick = (): void => {
    if (stopped || document.hidden || Date.now() < firstPoll) return
    const state = useUsage.getState()
    const interval = Math.min(300000, 60000 * 2 ** Math.min(state.failures, 3))
    if (!state.lastAttempt || Date.now() - state.lastAttempt >= interval) void state.refresh()
  }
  const online = (): void => { if (!stopped && !document.hidden && Date.now() >= firstPoll) void useUsage.getState().refresh() }
  const timer = window.setInterval(tick, 5000)
  let scope = usageScope()
  useUsage.getState().setScope(scope)
  const off = useDesk.subscribe(() => {
    const next = usageScope()
    if (next !== scope) {
      scope = next
      useUsage.getState().setScope(next)
      tick()
    }
  })
  window.addEventListener('focus', tick)
  window.addEventListener('online', online)
  document.addEventListener('visibilitychange', tick)
  return () => { stopped = true; off(); clearInterval(timer); window.removeEventListener('focus', tick); window.removeEventListener('online', online); document.removeEventListener('visibilitychange', tick) }
}
