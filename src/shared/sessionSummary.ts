export const SUMMARY_SECTIONS = ['changes', 'sources', 'projects', 'tasks', 'agents'] as const
export type SummarySection = typeof SUMMARY_SECTIONS[number]
export type SummaryView = SummarySection | 'all'
export const SUMMARY_LABELS: Record<SummarySection, string> = {
  changes: '变更', sources: '来源', projects: '项目', tasks: '任务', agents: '子 Agent'
}
export type ActivityStatus = 'running' | 'pending' | 'completed' | 'failed' | 'stopped' | 'unknown'
export const ACTIVITY_LABELS: Record<ActivityStatus, string> = {
  running: '进行中', pending: '待办', completed: '已完成', failed: '失败', stopped: '已停止', unknown: '状态未知'
}
export interface SummaryItem {
  id: string
  title: string
  description: string
  details?: string[]
  links?: { title: string; url: string }[]
  path?: string
  url?: string
  status?: ActivityStatus
  /** SDK 返回的子 Agent ID；id 仍是创建它的工具调用 ID。 */
  agentId?: string
  /** 结构化 SDK 结果确认的身份；文本尾注仍需核对子记录的父工具 ID。 */
  agentIdVerified?: boolean
  appearanceIndex?: number
  taskId?: string
  added?: number | null
  removed?: number | null
}
export interface SessionSummaryData {
  revision: number
  historyIncomplete: boolean
  agentsIncomplete?: boolean
  unlinkedAgentTaskIds?: string[]
  sections: Record<SummarySection, SummaryItem[]>
}
export function emptySessionSummary(): SessionSummaryData {
  return { revision: 0, historyIncomplete: false, sections: { changes: [], sources: [], projects: [], tasks: [], agents: [] } }
}
