import { useChat } from './chatStore'
import { notifyIfAway } from './notify'
import { useSessionMarks } from './sessionMarks'
import { refreshSessionsInBackground, useDesk } from './store'

/** Connect session state to desktop notifications and the Dock for the lifetime of the renderer. */
export function connectSessionSignals(): () => void {
  const { app, chat } = window.desk
  let lastBadge: number | undefined
  const titleChecks = new Set<string>()
  const titleTimers = new Set<ReturnType<typeof setTimeout>>()
  const syncBadge = (): void => {
    const { projects, sessions } = useDesk.getState()
    const { unread } = useSessionMarks.getState()
    const count = projects.reduce((total, project) =>
      total + (sessions[project.id]?.filter(session => !session.archived && unread[session.id]).length ?? 0), 0)
    if (lastBadge === count) return
    lastBadge = count
    void app.setDockBadge(count).catch(error => console.error('[dock badge]', error))
  }

  const stopDesk = useDesk.subscribe((state, previous) => {
    if (state.projects !== previous.projects || state.sessions !== previous.sessions) syncBadge()
  })
  const stopMarks = useSessionMarks.subscribe((state, previous) => {
    if (state.unread !== previous.unread) syncBadge()
  })
  const stopClick = app.onNotificationClick(sessionId => {
    const { projects, sessions, setView } = useDesk.getState()
    const cached = useChat.getState().chats[sessionId]?.projectId
    const project = projects.find(project => project.id === cached)
      ?? projects.find(project => sessions[project.id]?.some(session => session.id === sessionId))
    if (project) setView({ kind: 'session', sessionId, projectId: project.id })
  })
  const stopScheduled = window.desk.schedules.onStarted(({ sessionId, projectPath, taskName }) => {
    const project = useDesk.getState().projects.find(project => project.path === projectPath)
    if (!project) return
    useChat.getState().adopt(sessionId, project.id)
    useDesk.getState().addPendingSession(project.id, sessionId, taskName)
  })
  const stopEvents = chat.onEvent((sessionId, event) => {
    if (!useChat.getState().handle(sessionId, event)) return
    if (event.kind === 'state' && event.state === 'running') {
      const projectId = useChat.getState().chats[sessionId]?.projectId
      if (projectId) useDesk.getState().touchSession(projectId, sessionId)
    }
    if (event.kind === 'result') {
      const projectId = useChat.getState().chats[sessionId]?.projectId
      if (projectId) {
        refreshSessionsInBackground(projectId)
        // CLI can append its generated title after emitting the first result.
        if (!titleChecks.has(sessionId)) {
          titleChecks.add(sessionId)
          const timer = setTimeout(() => { titleTimers.delete(timer); refreshSessionsInBackground(projectId) }, 3000)
          titleTimers.add(timer)
        }
      }
    }
    notifyIfAway(sessionId, event)
  })
  syncBadge()
  return () => {
    for (const timer of titleTimers) clearTimeout(timer)
    stopEvents()
    stopScheduled()
    stopClick()
    stopMarks()
    stopDesk()
  }
}
