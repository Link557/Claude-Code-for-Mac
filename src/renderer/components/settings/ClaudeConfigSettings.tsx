import { ReplyLanguagePicker } from './ReplyLanguagePicker'
import { useDesk } from '../../store'
import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { CONFIG_LABELS, VALUE_LABELS } from '@shared/commands'
import { useClaudeConfig } from '../../hooks/useClaudeConfig'
import { Row, Section, Toggle, settingsInputClass, settingsButtonClass } from './SettingsControls'

type ConfigGroup = { title: string; keys?: readonly string[]; excludeKeys?: readonly string[] }
export function ClaudeConfigSettings({ cwd, keys, excludeKeys, searchable = true, groups }: { cwd: string; keys?: readonly string[]; excludeKeys?: readonly string[]; searchable?: boolean; groups?: ConfigGroup[] }) {
  const { snapshot, error, saving, results, save, refresh } = useClaudeConfig(cwd)
  const [query, setQuery] = useState('')
  const [reloadResult, setReloadResult] = useState('')
  const [reloading, setReloading] = useState(false)
  const [reloadError, setReloadError] = useState(false)
  const route = useDesk(s => s.view)
  const sessionId = route.kind === 'settings' ? route.sessionId : undefined
  const items = snapshot?.items.filter(i => (!keys || keys.includes(i.key)) && !excludeKeys?.includes(i.key)).filter(i => `${i.key} ${CONFIG_LABELS[i.key] ?? ''}`.toLowerCase().includes(query.toLowerCase().trim())) ?? []
  const sections = (groups ?? [{ title: '对话设置' }]).map(group => ({ ...group, items: items.filter(item => (!group.keys || group.keys.includes(item.key)) && !group.excludeKeys?.includes(item.key)) })).filter(group => group.items.length)
  return <section aria-label="Claude Code 配置" className="mt-5">
    <div className="mb-3 flex items-center gap-3">
      {searchable && <input aria-label="搜索 Claude Code 设置" placeholder="搜索设置" value={query} onChange={e => setQuery(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 outline-none focus:border-accent" />}
      <button type="button" aria-label="刷新 Claude Code 设置" disabled={!!saving || reloading} onClick={refresh} className={`${settingsButtonClass} flex items-center gap-2`}><RefreshCw size={14} />刷新</button>
    </div>
    {sessionId && <button type="button" disabled={reloading || !!saving} className={`mb-3 ${settingsButtonClass}`} onClick={async () => {
      setReloading(true); setReloadResult(''); setReloadError(false)
      try { await window.desk.chat.reloadConfiguration(sessionId, cwd); setReloadResult('已重载当前会话') }
      catch (e) { setReloadError(true); setReloadResult(String(e)) }
      finally { setReloading(false) }
    }}>{reloading ? '正在应用…' : '重新加载当前对话设置'}</button>}
    {reloadResult && <p role={reloadError ? "alert" : "status"} className={`mb-3 text-[12px] ${reloadError ? "text-danger" : "text-fg3"}`}>{reloadResult}</p>}
    {error ? <p role="alert" className="text-danger">{error}</p> : !snapshot ? <p className="text-fg3">读取中…</p> : <>
      {sections.map(group => <Section key={group.title} title={group.title}>
      {group.items.map(item => {
        const boolean = item.values.length === 2 && item.values.includes('true') && item.values.includes('false') && (item.value === 'true' || item.value === 'false')
        const disabled = !!saving || reloading || !!item.locked
        const label = CONFIG_LABELS[item.key] ?? item.key
        return <div key={item.key}>
          <Row label={<label htmlFor={`config-${item.key}`}>{label}</label>} hint={item.locked ?? (item.source === 'default' ? '引擎默认 · 未单独设置' : item.source === 'unknown' ? `CLI ${snapshot.cliVersion || '版本未知'} 未提供可确认的生效值` : undefined)}>
            {item.key === 'language' ? <ReplyLanguagePicker key={`${cwd}:${item.value}`} id={`config-${item.key}`} value={item.value} disabled={disabled} onSave={value => void save(item.key, value)} />
            : boolean ? <Toggle id={`config-${item.key}`} label={label} value={item.value === 'true'} disabled={disabled} title={item.locked} onChange={value => void save(item.key, String(value))} />
            : item.values.length ? <select id={`config-${item.key}`} disabled={disabled} value={item.value ?? ''} title={item.locked} onChange={e => void save(item.key, e.target.value)} className={settingsInputClass}>
              {item.value === null && <option value="" disabled>无法确认当前值</option>}
              {item.value !== null && !item.values.includes(item.value) && <option value={item.value}>{VALUE_LABELS[item.value] ?? item.value}</option>}
              {item.values.map(v => <option key={v} value={v}>{VALUE_LABELS[v] ?? v}</option>)}
            </select> : <ConfigInput key={`${item.key}:${item.value}`} id={`config-${item.key}`} initialValue={item.value} disabled={disabled} onSave={value => void save(item.key, value)} />}
          </Row>
          {item.key === 'promptSuggestionEnabled' && <p className="px-4 pb-3 text-[12px] text-fg3">回复后可能提供下一条输入建议，会产生额外模型用量；Tab 填入草稿，Enter 才发送。是否返回建议取决于 CLI 与当前服务。</p>}
          {saving === item.key ? <p role="status" className="px-4 pb-3 text-[12px] text-fg3">保存中…</p> : results[item.key] && <p role={results[item.key].error ? 'alert' : 'status'} className={`px-4 pb-3 text-[12px] ${results[item.key].error ? 'text-danger' : 'text-fg3'}`}>{results[item.key].error ?? results[item.key].status ?? '已保存'}</p>}
        </div>
      })}
      </Section>)}
      {!sections.length && <p className="p-4 text-fg3">没有可用的设置</p>}
    </>}
  </section>
}
function ConfigInput({ id, initialValue, disabled, onSave }: { id: string; initialValue: string | null; disabled: boolean; onSave(value: string): void }) {
  const [value, setValue] = useState(initialValue ?? '')
  return <form onSubmit={e => { e.preventDefault(); if (!disabled && value.trim() && value !== initialValue) onSave(value.trim()) }} className="flex max-w-full gap-2">
    <input id={id} value={value} disabled={disabled} onChange={e => setValue(e.target.value)} placeholder={initialValue === null ? '无法确认当前值' : undefined} onKeyDown={e => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault() }} className={`${settingsInputClass} min-w-0 w-40 focus:border-accent`} />
    <button type="submit" disabled={disabled || !value.trim() || value === initialValue} className={settingsButtonClass}>保存</button>
  </form>
}
