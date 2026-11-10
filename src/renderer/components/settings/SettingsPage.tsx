import { ModePicker } from '../newSession/ModePicker'
import { SessionControlsPane } from '../right/SessionControlsPane'
import { ClaudeConfigSettings } from './ClaudeConfigSettings'
import { ConnectionSettings } from './ConnectionSettings'
import { DisplayNameEditor } from './DisplayNameEditor'
import { Row, Section, Toggle, settingsInputClass, settingsButtonClass } from './SettingsControls'
import { useEffect, useState } from 'react'
import type { MetaInfo, Settings, Theme } from '@shared/types'
import { errorText } from '../../ipcError'
import { PERMISSION_MODES } from '@shared/format'
import { useDesk } from '../../store'

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }
]
// Only expose settings used by desktop sessions. Unknown native options stay hidden.
export const CONFIG_GROUPS = {
  context: ['autoCompact', 'language', 'outputStyle'],
  workflows: ['workflows', 'workflowKeywordTriggerEnabled', 'workflowSizeGuideline', 'worktreeBaseRef'],
  execution: ['useAutoModeDuringPlan', 'switchModelsOnFlag']
} as const

export function SettingsPage() {
  const { settings, updateSettings, view, projects, home, setView } = useDesk()
  const [languageSaving, setLanguageSaving] = useState(false)
  const [languageError, setLanguageError] = useState<string | null>(null)
  const [notificationError, setNotificationError] = useState<string | null>(null)
  const [notificationSending, setNotificationSending] = useState(false)
  const [notificationResult, setNotificationResult] = useState<string | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [environment, setEnvironment] = useState<{ path: string | null; meta: MetaInfo | null; error: string | null } | null>(null)
  const advanced = view.kind === 'settings' && view.tab === 'advanced'
  const executable = settings?.claudePath ?? null
  useEffect(() => {
    if (!advanced) return
    let active = true
    setEnvironment(null)
    void window.desk.meta.get().then(meta => {
      if (active) setEnvironment({ path: executable, meta, error: null })
    }, error => {
      if (active) setEnvironment({ path: executable, meta: null, error: errorText(error) })
    })
    return () => { active = false }
  }, [advanced, executable])
  const saveSettings = (patch: Partial<Settings>): void => {
    setSettingsError(null)
    void updateSettings(patch).catch(error => setSettingsError(errorText(error)))
  }
  if (!settings) return null
  const route = view.kind === 'settings' ? view : { kind: 'settings' as const }
  // Existing /config links open the unified settings, without a second full catalog.
  const tab = route.tab === 'claude' ? 'models' : route.tab ?? 'general'
  const project = projects.find(p => p.id === route.projectId)
  const cwd = project?.path ?? home
  const projectSettings = tab === 'context' || tab === 'advanced' || tab === 'connection'
  return <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-16"><div className="mx-auto max-w-[760px]">
    <h1 className="pt-6 font-serif text-[24px] font-normal">设置</h1>
    <nav className="mt-5 flex flex-wrap gap-1 border-b border-line pb-3" aria-label="设置分类">
      {([['general', '外观与交互'], ['connection', '账号与接入'], ['models', '模型与权限'], ['context', '上下文'], ['notifications', '通知'], ['advanced', '高级设置']] as const).map(([value, label]) => <button key={value} type="button" aria-current={tab === value ? 'page' : undefined} onClick={() => setView({ ...route, tab: value })} className={`rounded-lg px-3 py-1.5 text-[13px] ${tab === value ? 'bg-active' : 'text-fg2 hover:bg-hover'}`}>{label}</button>)}
    </nav>
    {settingsError && <p role="alert" className="mt-3 text-danger">设置保存失败：{settingsError}</p>}
    {projectSettings && <Section title="项目上下文">
      <Row label={<label htmlFor="settings-project">项目</label>}><select id="settings-project" value={project?.id ?? ''} onChange={e => setView({ ...route, projectId: e.target.value || null, sessionId: null })} className={settingsInputClass}><option value="">用户目录</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Row>
    </Section>}
    {tab === 'general' && <Section title="会话与内存">
      <Row label="驻留会话保留数量">
        <select aria-label="驻留会话保留数量" className={settingsInputClass} value={settings.retainedSessions ?? 4} onChange={e => saveSettings({ retainedSessions: Number(e.target.value) })}>
          {Array.from({ length: 16 }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n} 个{n === 4 ? '（默认）' : ''}</option>)}
        </select>
      </Row>
      <Row label="超额会话闲置回收时间">
        <select aria-label="超额会话闲置回收时间" className={settingsInputClass} value={settings.sessionIdleMinutes ?? 15} onChange={e => saveSettings({ sessionIdleMinutes: Number(e.target.value) })}>
          {[...new Set([1, 5, 10, 15, 30, 60, 120, settings.sessionIdleMinutes ?? 15])].sort((a, b) => a - b).map(n => <option key={n} value={n}>{n} 分钟{n === 15 ? '（默认）' : ''}</option>)}
        </select>
      </Row>
    </Section>}
    {(tab === 'general' || tab === 'connection') && <Section title="个人展示"><Row label="显示名称"><DisplayNameEditor compact /></Row></Section>}
    {tab === 'connection' && <ConnectionSettings cwd={cwd} />}
    {tab === 'general' && <Section title="界面与交互">
      <Row label="欢迎与个性化" hint="重新选择外观、新对话模型和思考程度。"><button className={settingsButtonClass} onClick={() => useDesk.getState().setWelcomeOpen(true)}>打开欢迎页</button></Row>
      <Row label="主题"><Segmented options={THEMES} value={settings.theme} onChange={theme => saveSettings({ theme })} /></Row>
      <Row label="自动跟随最新回复"><Toggle label="自动跟随最新回复" value={settings.autoScroll ?? true} onChange={autoScroll => saveSettings({ autoScroll })} /></Row>
      <Row label="减少动效"><Toggle label="减少动效" value={settings.reduceMotion ?? false} onChange={reduceMotion => saveSettings({ reduceMotion })} /></Row>
      <Row label="执行提示语言">
        <select aria-label="执行提示语言" disabled={languageSaving} value={settings.executionLanguage ?? 'zh'} className={settingsInputClass} onChange={async e => {
          const executionLanguage = e.target.value === 'en' ? 'en' : 'zh'
          setLanguageSaving(true); setLanguageError(null)
          try { await updateSettings({ executionLanguage }) }
          catch (error) { setLanguageError(error instanceof Error ? error.message : String(error)) }
          finally { setLanguageSaving(false) }
        }}><option value="zh">中文</option><option value="en">English</option></select>
      </Row>
      {languageError && <p role="alert" className="px-4 py-2 text-danger">{languageError}</p>}
    </Section>}
    {tab === 'models' && <Section title="新对话默认值">
        <Row label="模型"><ModePicker inline="defaultModel" options={{ model: settings.defaultModel === 'default' ? null : settings.defaultModel, effort: settings.defaultEffort, mode: settings.defaultPermissionMode }} onChange={patch => { if (patch.model !== undefined) saveSettings({ defaultModel: patch.model ?? 'default' }) }} /></Row>
        <Row label="思考程度"><ModePicker inline="defaults" options={{ model: settings.defaultModel, effort: settings.defaultEffort, mode: settings.defaultPermissionMode }}
          onChange={patch => { if (patch.effort !== undefined) saveSettings({defaultEffort:patch.effort}) }} /></Row>
        <Row label="权限模式"><Select value={settings.defaultPermissionMode} options={PERMISSION_MODES.filter(m => m.value !== 'bypassPermissions' || settings.allowBypass)} onChange={v => saveSettings({ defaultPermissionMode: v as typeof settings.defaultPermissionMode })} /></Row>
        <Row label="允许选择跳过权限模式"><Toggle label="允许选择跳过权限模式" value={settings.allowBypass} onChange={allowBypass => saveSettings({ allowBypass, ...(!allowBypass && settings.defaultPermissionMode === 'bypassPermissions' ? { defaultPermissionMode: 'default' as const } : {}) })} /></Row>
      </Section>}
    {tab === 'models' && route.sessionId && <Section title="当前对话">
      <SessionControlsPane sessionId={route.sessionId} cwd={cwd} active initialTab="rules" />
    </Section>}
    {tab === 'context' && <>
      <Section title="下一条输入建议" description="会增加模型用量。新会话或重载后生效，受 CLI 设置限制。">
        <Row label="请求输入建议">
          <Toggle label="请求输入建议" value={settings.promptSuggestions ?? true} onChange={promptSuggestions => saveSettings({ promptSuggestions })} />
        </Row>
      </Section>
      <ClaudeConfigSettings key={cwd} cwd={cwd} groups={[{ title: '对话与回复', keys: CONFIG_GROUPS.context }]} searchable={false} />
    </>}
    {tab === 'notifications' && <>
      <Section title="系统通知">
        <Row label="任务结束"><Toggle label="任务结束" value={settings.notifyCompletion ?? true} onChange={notifyCompletion => saveSettings({ notifyCompletion })} /></Row>
        <Row label="等待确认"><Toggle label="等待确认" value={settings.notifyApproval ?? true} onChange={notifyApproval => saveSettings({ notifyApproval })} /></Row>
        <Row label="通知声音"><Toggle label="通知声音" value={settings.notificationSound ?? true} onChange={notificationSound => saveSettings({ notificationSound })} /></Row>
        <Row label="测试通知"><button disabled={notificationSending} className={settingsButtonClass} onClick={async () => {
          setNotificationError(null); setNotificationResult(null); setNotificationSending(true)
          try {
            await window.desk.app.notify('Claude Code', '通知测试', settings.notificationSound === false)
            setNotificationResult('已发送测试通知。')
          } catch (e) { setNotificationError(e instanceof Error ? e.message : String(e)) }
          finally { setNotificationSending(false) }
        }}>{notificationSending ? '正在发送…' : '发送测试通知'}</button></Row>
        <Row label="系统通知设置"><button className={settingsButtonClass} onClick={async () => {
          setNotificationError(null)
          try { await window.desk.app.openNotificationSettings() }
          catch (error) { setNotificationError(errorText(error)) }
        }}>打开系统设置</button></Row>
      </Section>
      {notificationResult && <p role="status" className="mt-3 text-[12px] text-fg2">{notificationResult}</p>}
      {notificationError && <p role="alert" className="mt-3 text-danger">{notificationError}</p>}
    </>}
    {tab === 'advanced' && <>
      <ClaudeConfigSettings key={cwd} cwd={cwd} searchable={false} groups={[
        { title: '执行行为', keys: CONFIG_GROUPS.execution },
        { title: '工作流', keys: CONFIG_GROUPS.workflows }
      ]} />
      <Section title="运行环境">
        <Row label="运行引擎"><button className="text-fg2 hover:underline" onClick={() => setView({ ...route, tab: 'connection' })} title={settings.claudePath ?? undefined}>{settings.claudePath ? '自定义路径' : `自动检测${environment?.path === executable && environment.meta?.claudeVersion ? ` v${environment.meta.claudeVersion}` : ''}`} · 查看接入状态</button></Row>
      </Section>
    </>}
  </div></div>
}
function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange(v: T): void }) {
  return (
    <div className="flex rounded-lg bg-chip p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`h-7 rounded-md px-3 text-[12.5px] ${value === o.value ? 'bg-card text-fg shadow-sm' : 'text-fg2 hover:text-fg'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Select({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange(v: string): void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="权限模式"
      className={settingsInputClass}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
