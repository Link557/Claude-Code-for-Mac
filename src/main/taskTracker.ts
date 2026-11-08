import type { BackgroundTask } from '../shared/chat'
import { backgroundTaskList, isBackgroundTask } from './backgroundTasks'
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export interface TrackedTask extends Record<string, unknown> {
  task_id: string
  run_id?: string
  status: string
  startedAt: number
  endedAt?: number
}
const terminal = (status: string): boolean => ['completed', 'failed', 'stopped', 'killed', 'ended'].includes(status)
const active = (status: string): boolean => ['running', 'pending'].includes(status)

/** Owns run ordering and lifecycle facts. Membership snapshots are independent of edge ordering. */
export class TaskTracker {
  private records = new Map<string, TrackedTask>()
  private latest = new Map<string, TrackedTask>()
  private membership: Map<string, string | undefined> | undefined

  constructor(private now: () => number = Date.now) {}

  get tasks(): ReadonlyMap<string, TrackedTask> { return this.records }
  list(): BackgroundTask[] { return backgroundTaskList(this.records.values()) }
  hasBackgroundWork(): boolean {
    if (this.membership) return [...this.membership.keys()].some(id => {
      const task = this.records.get(id)
      return task && isBackgroundTask(task)
    })
    return [...this.records.values()].some(task => active(task.status) && isBackgroundTask(task))
  }

  /** Saved agent versions prevent old runs from replacing history after a restart. */
  remember(taskId: string, runId: string | undefined, status: string): void {
    const previous = this.latest.get(taskId)?.run_id
    if (previous && (!runId || runId < previous)) return
    this.latest.set(taskId, { task_id: taskId, run_id: runId, status, startedAt: 0 })
  }

  reset(): void { this.records.clear(); this.membership = undefined }

  apply(raw: unknown): TrackedTask[] {
    if (!isRecord(raw) || raw.type !== 'system') return []
    if (raw.subtype === 'background_tasks_changed') {
      if (!Array.isArray(raw.tasks) || !raw.tasks.every(task => isRecord(task) && typeof task.task_id === 'string')) return []
      const next = new Map<string, string | undefined>()
      const changed: TrackedTask[] = []
      for (const value of raw.tasks) {
        const task = value as Record<string, unknown> & { task_id: string }
        const run = typeof task.run_id === 'string' ? task.run_id : undefined
        const previous = this.latest.get(task.task_id)
        if (previous?.run_id && run && run < previous.run_id) {
          if (active(previous.status) && isBackgroundTask(previous)) next.set(task.task_id, previous.run_id)
          continue
        }
        next.set(task.task_id, run)
        const update = this.update(task.task_id, { ...task, backgrounded: true, ambient: task.ambient === true, skip_transcript: task.skip_transcript === true }, 'level')
        if (update) changed.push(update)
      }
      // A level says nothing about foreground tasks. Only tasks previously in the background set leave it.
      for (const [id, task] of this.records) {
        if (!next.has(id) && active(task.status) && isBackgroundTask(task)) {
          const update = this.update(id, { status: 'ended' }, 'level')
          if (update) changed.push(update)
        }
      }
      this.membership = next
      return changed
    }
    if (!['task_started', 'task_progress', 'task_updated', 'task_notification'].includes(String(raw.subtype)) || typeof raw.task_id !== 'string') return []
    const patch = isRecord(raw.patch) ? { ...raw.patch } : {}
    if (typeof patch.is_backgrounded === 'boolean') patch.backgrounded = patch.is_backgrounded
    const update = this.update(raw.task_id, { ...raw, ...patch }, String(raw.subtype))
    return update ? [update] : []
  }

  private update(id: string, patch: Record<string, unknown>, source: string): TrackedTask | undefined {
    const previous = this.latest.get(id)
    const run = typeof patch.run_id === 'string' ? patch.run_id : undefined
    if (previous?.run_id && run && run < previous.run_id) return
    const newRun = Boolean(run && previous?.run_id !== run)
    if (!newRun && previous && terminal(previous.status) && source !== 'task_notification') {
      if (source !== 'level') return
      // Levels can update metadata after a terminal edge, but cannot undo it.
      // An 'ended' membership fallback has no terminal evidence and may rejoin.
      if (previous.status !== 'ended') patch = { ...patch, status: previous.status }
    }
    const base = newRun ? undefined : previous
    const state = typeof patch.status === 'string' ? patch.status : source === 'level' || source === 'task_started' ? 'running' : base?.status ?? 'running'
    const task: TrackedTask = {
      ...base, ...patch, task_id: id, run_id: run ?? base?.run_id,
      status: state, startedAt: base?.startedAt || this.now()
    }
    if (active(state)) delete task.endedAt
    else task.endedAt = base?.endedAt ?? this.now()
    this.latest.set(id, task)
    this.records.set(id, task)
    return task
  }
}
