import { Bot, CheckCheck, FileDiff, FileText, FolderOpen, Globe, Link2, ListTodo } from 'lucide-react'
import { ACTIVITY_LABELS, SUMMARY_LABELS, type SummaryItem, type SummarySection } from '@shared/sessionSummary'
import { useLayout } from '../../layoutStore'

export const SUMMARY_ICONS = { changes: FileDiff, sources: Link2, projects: FolderOpen, tasks: ListTodo, agents: Bot }
export function SummaryRows({ section, items, compact = false }: { section: SummarySection; items: SummaryItem[]; compact?: boolean }) {
  if (!items.length) return <p className="py-2 text-[12px] text-fg3">暂无{SUMMARY_LABELS[section]}记录</p>
  return <div className={compact ? 'space-y-1' : 'divide-y divide-line'}>{items.map((item) => (
    <SummaryRow key={item.id} section={section} item={item} compact={compact} />
  ))}</div>
}
function SummaryRow({ section, item, compact }: { section: SummarySection; item: SummaryItem; compact: boolean }) {
  const Icon = item.url || item.id === 'web' ? Globe : item.path && section !== 'projects' ? FileText : SUMMARY_ICONS[section]
  const label = <><Icon size={compact ? 15 : 19} className="mt-0.5 shrink-0 text-fg2" /><span className={compact ? 'min-w-0 flex-1 truncate' : 'min-w-0 flex-1 break-words'}>{item.title}</span>{compact && item.status && <span className="shrink-0 text-[10.5px] text-fg3">{ACTIVITY_LABELS[item.status]}</span>}{compact && section === 'changes' && <span className="shrink-0 text-[11px]"><ChangeCounts items={[item]} /></span>}</>
  const open = (): void => {
    if (!item.path) return
    if (section === 'projects') useLayout.getState().newPage(item.path, 'files')
    else useLayout.getState().openFile(item.path)
  }
  return (
    <div className={compact ? 'rounded-lg px-1 py-0.5' : 'py-5'}>
      {item.path ? <button type="button" title={item.path} onClick={open} className="flex w-full items-start gap-2.5 text-left text-[13px] hover:text-accent">{label}</button>
        : item.url && /^https?:\/\//i.test(item.url) ? <a href={item.url} target="_blank" rel="noreferrer" className="flex items-start gap-2.5 text-[13px] hover:text-accent">{label}</a>
        : <div className="flex items-start gap-2.5 text-[13px]">{label}</div>}
      {!compact && <div className="ml-6 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-fg3">
        {item.status && <span className={item.status === 'failed' ? 'text-danger' : item.status === 'running' ? 'text-accent' : ''}>{item.status === 'completed' && <CheckCheck size={12} className="mr-1 inline" />}{ACTIVITY_LABELS[item.status]}</span>}
        {section === 'changes' ? <ChangeCounts items={[item]} /> : <span className={compact ? 'truncate' : 'break-words'}>{item.description}</span>}
      </div>}
      {!compact && <>
        {(item.path || item.url) && <p className="mt-2 select-text break-all font-mono text-[11px] text-fg3">{item.path || item.url}</p>}
        {item.links?.map((link) => /^https?:\/\//i.test(link.url) && <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="mt-2 block break-words text-[12px] text-accent underline">{link.title}</a>)}
        {item.details?.length ? <ul className="mt-3 space-y-2 text-[12px] leading-relaxed text-fg2">{item.details.filter((detail) => detail !== item.description).map((detail, index) => <li key={index} className="break-words">{detail}</li>)}</ul> : null}
      </>}
    </div>
  )
}
export function ChangeCounts({ items }: { items: SummaryItem[] }) {
  const known = items.filter((item) => item.added != null && item.removed != null)
  if (!known.length) return null
  return <span className="whitespace-nowrap tabular-nums">
    <span className="text-green-600 dark:text-green-400">+{known.reduce((n, item) => n + item.added!, 0)}</span>{' '}<span className="text-danger">−{known.reduce((n, item) => n + item.removed!, 0)}</span>
    {known.length < items.length && <span className="ml-1 text-[11px] text-fg3">已统计 {known.length}/{items.length} 个文件</span>}
  </span>
}
