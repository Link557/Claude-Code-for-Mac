import type { ChatEvent, ChatSnapshot, SessionOptions } from '@shared/chat'

interface Version { received: number; revision?: number }
type ApprovalEvent = Extract<ChatEvent, { kind: 'approval' | 'approvalDone' }>
type Field = 'options' | 'runtime' | 'queue' | 'activity' | 'summary' | 'tasks' | 'state' | 'error' | 'lastResult' | 'promptSuggestion'
interface SyncState {
  fields: Partial<Record<Field, Version>>
  messages: Record<string, Version>
  approvals: { event: ApprovalEvent; version: Version }[]
  snapshotRevision?: number
  eventRevision?: number
}

export interface ChatProjection extends Omit<ChatSnapshot, 'live' | 'options'> {
  options: SessionOptions
  error: string | null
  lastResult?: Extract<ChatEvent, { kind: 'result' }>
  sync?: SyncState
}

const emptySync = (): SyncState => ({ fields: {}, messages: {}, approvals: [] })

export function staleChatEvent(current: ChatProjection, event: ChatEvent): boolean {
  // 快照不含结果和错误；它不能替代这些事件的交付。
  const snapshotRevision = event.kind === 'result' || event.kind === 'notice' ? -1 : current.sync?.snapshotRevision ?? -1
  return event.revision !== undefined && event.revision <= Math.max(snapshotRevision, current.sync?.eventRevision ?? -1)
}

/** 只归约会话数据；导航、未读标记和列表刷新由调用方负责。 */
export function applyChatEvent(current: ChatProjection, event: ChatEvent, received: number): Partial<ChatProjection> {
  if (staleChatEvent(current, event)) return {}
  const previous = current.sync ?? emptySync()
  const sync = { ...previous, fields: { ...previous.fields }, eventRevision: event.revision ?? previous.eventRevision }
  const version = { received, revision: event.revision }
  const fields = (names: Field[], patch: Partial<ChatProjection>): Partial<ChatProjection> => {
    for (const name of names) sync.fields[name] = version
    return { ...patch, sync }
  }
  switch (event.kind) {
    case 'promptSuggestion': return fields(['promptSuggestion'], { promptSuggestion: event.suggestion })
    case 'options': return fields(['options'], { options: event.options, optionsSaved: event.optionsSaved ?? true, optionsSaveError: event.optionsSaveError ?? null })
    case 'runtime': return fields(['runtime'], { runtime: event.runtime })
    case 'queue': return fields(['queue'], { queue: event.queue })
    case 'activity': return fields(['activity'], (current.activity?.revision ?? 0) <= event.activity.revision ? { activity: event.activity } : {})
    case 'summary': return fields(['summary'], { summary: event.summary })
    case 'tasks': return fields(['tasks'], { tasks: event.tasks })
    case 'state': return fields(['state'], { state: event.state })
    case 'notice': return fields(['error'], { error: event.text })
    case 'result': return fields(['error', 'lastResult'], { error: event.error, lastResult: event })
    case 'replaceHistory': {
      const history = mergeChatSnapshot({ ...current, sync: undefined }, { ...event.snapshot, revision: event.revision }, received, true)
      return { ...history, lastResult: undefined, sync: { ...emptySync(), snapshotRevision: event.revision, eventRevision: event.revision } }
    }
    case 'upsert': {
      const messages = [...current.messages]
      sync.messages = { ...previous.messages }
      for (const message of event.messages) {
        sync.messages[message.id] = version
        const index = messages.findIndex(m => m.id === message.id)
        if (index < 0) messages.push(message)
        else messages[index] = message
      }
      return { messages, sync }
    }
    case 'approval':
    case 'approvalDone': {
      sync.approvals = [...previous.approvals, { event, version }]
      const approvals = current.approvals.filter(a => a.requestId !== (event.kind === 'approval' ? event.request.requestId : event.requestId))
      if (event.kind === 'approval') approvals.push(event.request)
      return { approvals, sync }
    }
  }
}

/** 所有快照入口共用版本规则；旧测试数据无服务端版本时按本地接收时间兼容。 */
export function mergeChatSnapshot(current: ChatProjection, snapshot: ChatSnapshot, requestedAt: number, clearError = false): Partial<ChatProjection> {
  const sync = current.sync ?? emptySync()
  if (snapshot.revision !== undefined && snapshot.revision < (sync.snapshotRevision ?? -1)) return {}
  const newer = (version?: Version): boolean => Boolean(version && (
    snapshot.revision !== undefined && version.revision !== undefined
      ? version.revision > snapshot.revision
      : version.received > requestedAt
  ))
  const updates = current.messages.filter(m => newer(sync.messages[m.id]))
  const byId = new Map(updates.map(m => [m.id, m]))
  const known = new Set(snapshot.messages.map(m => m.id))
  const approvalChanges = sync.approvals.filter(change => newer(change.version))
  let approvals = [...snapshot.approvals]
  for (const { event } of approvalChanges) {
    approvals = approvals.filter(a => a.requestId !== (event.kind === 'approval' ? event.request.requestId : event.requestId))
    if (event.kind === 'approval') approvals.push(event.request)
  }
  const activityNewer = newer(sync.fields.activity) || (snapshot.revision === undefined && (current.activity?.revision ?? 0) > (snapshot.activity?.revision ?? 0))
  return {
    ...snapshot,
    options: newer(sync.fields.options) ? current.options : snapshot.options ?? current.options,
    optionsSaved: newer(sync.fields.options) ? current.optionsSaved : snapshot.optionsSaved,
    optionsSaveError: newer(sync.fields.options) ? current.optionsSaveError : snapshot.optionsSaveError,
    runtime: newer(sync.fields.runtime) ? current.runtime : snapshot.runtime,
    promptSuggestion: newer(sync.fields.promptSuggestion) ? current.promptSuggestion : snapshot.promptSuggestion ?? null,
    queue: newer(sync.fields.queue) ? current.queue : snapshot.queue,
    state: newer(sync.fields.state) || (snapshot.revision === undefined && activityNewer) ? current.state : snapshot.state,
    activity: activityNewer ? current.activity : snapshot.activity,
    summary: newer(sync.fields.summary) ? current.summary : snapshot.summary,
    tasks: newer(sync.fields.tasks) ? current.tasks : snapshot.tasks ?? [],
    messages: [...snapshot.messages.map(m => byId.get(m.id) ?? m), ...updates.filter(m => !known.has(m.id))],
    approvals,
    error: clearError && !newer(sync.fields.error) ? null : current.error,
    sync: { ...sync, approvals: approvalChanges, snapshotRevision: snapshot.revision ?? sync.snapshotRevision }
  }
}
