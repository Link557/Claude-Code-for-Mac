import { useEffect, useRef, useState } from 'react'
import { ArrowRight, ArrowUp, Check, ChevronDown, Monitor, Moon, Plus, RefreshCw, Sun, X } from 'lucide-react'
import type { EffortLevel, Settings, Theme } from '@shared/types'
import { EFFORT_LEVELS } from '@shared/format'
import { useDesk } from '../../store'
import { useModalLayer } from '../../modalStore'
import { errorText } from '../../ipcError'
import { useModelCatalog } from '../newSession/useModelCatalog'
import { ActivitySpark } from '../ui/ActivityIndicator'
import '../../styles/welcome.css'

/** A local draft: neither theme previews nor model choices write CLI or app settings. */
export function WelcomePage() {
  useModalLayer()
  const { settings, home, updateSettings, setWelcomeOpen } = useDesk()
  const [theme, setTheme] = useState<Theme>(settings?.theme ?? 'system')
  const [modelValue, setModelValue] = useState(settings?.defaultModel ?? '')
  const [effort, setEffort] = useState<EffortLevel | null>(settings?.defaultEffort ?? null)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const locked = useRef(false)
  const dialog = useRef<HTMLDivElement>(null)
  // Defaults are global. Read the user-directory catalog, not a project's overrides.
  const { models, loading, error, cached, retry } = useModelCatalog(home || undefined)
  const model = models.find(item => item.value === modelValue || item.resolvedModel === modelValue)
  const confirmed = !loading && !error && !cached
  const supportedEffort = effort && model?.efforts.includes(effort) ? effort : null
  const preview = theme === 'system' ? systemDark ? 'dark' : 'light' : theme

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    const change = () => setSystemDark(media?.matches ?? false)
    media?.addEventListener('change', change)
    return () => media?.removeEventListener('change', change)
  }, [])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])

  function dismiss() {
    if (!locked.current) setWelcomeOpen(false)
  }

  async function finish() {
    if (locked.current) return
    locked.current = true
    setSaving(true)
    setSaveError(null)
    const patch: Partial<Settings> = { welcomeCompleted: true, theme }
    // Stale or unavailable catalogs must never replace a saved model with a guess.
    if (confirmed && model) {
      patch.defaultModel = model.value
      patch.defaultEffort = supportedEffort
    }
    try {
      await updateSettings(patch)
      setWelcomeOpen(false)
    } catch (failure) {
      setSaveError(errorText(failure))
    } finally {
      locked.current = false
      setSaving(false)
    }
  }

  return <div className="welcome-page" data-welcome-page data-preview={preview}>
    <div className="welcome-drag drag" aria-hidden="true" />
    <div ref={dialog} className="welcome-glass no-drag" role="dialog" aria-modal="true" aria-labelledby="welcome-title" tabIndex={-1}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss() }
        if (event.key !== 'Tab') return
        const targets = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)') ?? [])
        const first = targets[0], last = targets[targets.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus() }
      }}>
      <button className="welcome-close" type="button" aria-label="关闭欢迎页" disabled={saving} onClick={dismiss}><X size={18} /></button>
      <header className="welcome-header">
        <div className="welcome-brand"><ActivitySpark active={false} /><span>CLAUDE CODE</span><span className="welcome-brand-line" /><span>为你而设</span></div>
        <h1 id="welcome-title">让灵感，有个舒服的起点。</h1>
        <p>欢迎来到 Claude Code。选一个喜欢的外观，<br className="welcome-mobile-break" />再让每一次对话更合你心意。</p>
      </header>

      <fieldset className="welcome-themes" disabled={saving}>
        <legend><span className="welcome-step">01</span>选择你的空间<span className="welcome-legend-note">即刻预览，随时可改</span></legend>
        <div className="welcome-theme-grid">
          {(['light', 'dark'] as const).map(value => <label key={value} className="welcome-theme-card" data-theme={value} data-selected={theme === value}>
            <input type="radio" name="welcome-theme" aria-label={value === 'light' ? '浅色外观' : '深色外观'} checked={theme === value} onChange={() => setTheme(value)} />
            <MiniWorkspace model={model?.label} effort={EFFORT_LEVELS.find(item => item.value === supportedEffort)?.label} />
            <div className="welcome-theme-caption"><span>{value === 'light' ? <Sun size={16} /> : <Moon size={16} />}<strong>{value === 'light' ? '浅色' : '深色'}</strong><span>{value === 'light' ? '明亮，留白，专注' : '温润，安静，沉浸'}</span></span><span className="welcome-check">{theme === value && <Check size={13} strokeWidth={3} />}</span></div>
          </label>)}
        </div>
        <button type="button" className="welcome-system" aria-pressed={theme === 'system'} onClick={() => setTheme(theme === 'system' ? preview : 'system')}><Monitor size={13} /><span>跟随系统外观</span><span className="welcome-system-check">{theme === 'system' && <Check size={10} strokeWidth={3} />}</span></button>
      </fieldset>

      <section className="welcome-defaults" aria-labelledby="welcome-defaults-title">
        <h2 id="welcome-defaults-title"><span className="welcome-step">02</span>对话，从你的偏好开始<span className="welcome-legend-note">新对话默认值</span></h2>
        <div className="welcome-default-grid">
          <div className="welcome-control">
            <label htmlFor="welcome-model">常用模型 <span>MODEL</span></label>
            <div className="welcome-select"><select id="welcome-model" disabled={saving || !confirmed || !models.length} value={model?.value ?? ''} onChange={event => { setModelValue(event.target.value); setEffort(null) }}>
              {!model && <option value="">{loading ? '正在读取真实模型…' : '保留当前默认模型'}</option>}
              {models.map(item => <option key={item.value} value={item.value}>{item.label}{item.resolvedModel && item.resolvedModel !== item.label ? ` · ${item.resolvedModel}` : ''}</option>)}
            </select><ChevronDown size={14} /></div>
            <p className="welcome-model-target" title={model?.resolvedModel ?? model?.value}>{model ? `实际模型：${model.resolvedModel ?? model.value}` : `当前默认：${settings?.defaultModel ?? '未设置'}`}</p>
          </div>
          <div className="welcome-control">
            <label htmlFor="welcome-effort">思考程度 <span>THINKING</span></label>
            <div className="welcome-select"><select id="welcome-effort" value={supportedEffort ?? ''} disabled={saving || !confirmed || !model?.efforts.length} onChange={event => setEffort(event.target.value ? event.target.value as EffortLevel : null)}>
              <option value="">自动 · 跟随模型</option>
              {EFFORT_LEVELS.filter(item => model?.efforts.includes(item.value)).map(item => <option key={item.value} value={item.value}>{item.label} · {item.description}</option>)}
            </select><ChevronDown size={14} /></div>
            <p>{model && !model.efforts.length ? '当前模型未提供可调节的思考档位' : '仅显示当前模型支持的档位'}</p>
          </div>
        </div>
        <div className="welcome-catalog-status" role="status" aria-live="polite">
          <span className="welcome-status-dot" data-ready={confirmed && models.length > 0} />
          <span>{loading ? cached ? '正在核对 CLI，暂时显示已缓存目录…' : '正在从 Claude Code CLI 读取模型…' : error ? '模型读取失败，保留现有默认值。' : !models.length ? '当前 CLI 未提供可用模型，保留现有默认值。' : !model ? '请选择目录中的模型，或保留现有默认值。' : '已同步当前 CLI · 支持 CC Switch 接入映射'}</span>
          <button type="button" aria-label="刷新欢迎页模型" title={error ?? '重新读取 CLI 模型目录'} disabled={saving || loading} onClick={retry}><RefreshCw size={12} />{error || !models.length ? '重试' : '刷新'}</button>
        </div>
      </section>

      {saveError && <p className="welcome-save-error" role="alert">保存失败：{saveError}。已保留本页选择，请重试。</p>}
      <footer className="welcome-footer"><div><strong>准备好，一起创造。</strong><p>这些偏好只影响桌面端，可在设置中随时调整。</p></div><div className="welcome-actions"><button className="welcome-later" type="button" disabled={saving} onClick={dismiss}>{settings?.welcomeCompleted ? '取消' : '稍后设置'}</button><button className="welcome-finish" type="button" disabled={saving} onClick={() => void finish()}>{saving ? '正在保存…' : '开始使用'}<ArrowRight size={16} /></button></div></footer>
    </div>
    <p className="welcome-bottom-note">你的工作方式，你来定义。</p>
  </div>
}

function MiniWorkspace({ model, effort }: { model?: string; effort?: string }) {
  return <div className="welcome-mini" aria-hidden="true">
    <aside className="welcome-mini-sidebar"><div className="welcome-mini-dots"><i /><i /><i /></div><span className="welcome-mini-new"><Plus size={10} />新对话</span><span className="welcome-mini-line" /><span className="welcome-mini-line short" /><span className="welcome-mini-line" /><div className="welcome-mini-profile"><i /><span /></div></aside>
    <div className="welcome-mini-main"><div className="welcome-mini-greeting"><ActivitySpark active={false} /><span>有什么新想法？</span></div><div className="welcome-mini-composer"><span>一起把想法变成现实…</span><div><span>{model ?? '当前模型'}<ChevronDown size={7} /></span><span>{effort ?? '自动'}</span><i><ArrowUp size={9} /></i></div></div><div className="welcome-mini-chips"><span>探索项目</span><span>构建新想法</span><span>整理思路</span></div></div>
  </div>
}
