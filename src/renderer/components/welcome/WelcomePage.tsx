import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, RefreshCw } from 'lucide-react'
import type { EffortLevel, Settings, Theme } from '@shared/types'
import { EFFORT_LEVELS } from '@shared/format'
import { useDesk } from '../../store'
import { useModalLayer } from '../../modalStore'
import { errorText } from '../../ipcError'
import { useModelCatalog } from '../newSession/useModelCatalog'
import { Crab } from '../newSession/Crab'
import { WindowPin } from '../ui/WindowPin'
import '../../styles/welcome.css'

/** A local draft: neither theme previews nor model choices write CLI or app settings. */
export function WelcomePage({ showWindowPin = false }: { showWindowPin?: boolean }) {
  useModalLayer()
  const { settings, home, updateSettings, setWelcomeOpen } = useDesk()
  const [step, setStep] = useState(1)
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

  function goTo(next: number) {
    setStep(next)
    dialog.current?.focus()
  }

  function dismiss() {
    if (!locked.current) setWelcomeOpen(false)
  }

  async function finish() {
    if (locked.current || (confirmed && models.length > 0 && !model)) return
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
      {showWindowPin && <WindowPin />}
      <div className="welcome-progress" role="progressbar" aria-label="欢迎流程进度"
        aria-valuemin={0} aria-valuemax={3} aria-valuenow={step} aria-valuetext={`第 ${step} 步，共 3 步`}>
        <span className="welcome-track" aria-hidden="true">
          {[1, 2, 3].map(index => <i key={index} data-filled={index <= step} />)}
        </span>
        <span aria-hidden="true">{step} / 3</span>
      </div>

      <main className="welcome-content">
        {step === 1 && <div className="welcome-intro">
          <Crab />
          <h1 id="welcome-title">欢迎来到 Claude Code</h1>
        </div>}
        {step === 2 && <section className="welcome-appearance">
          <h1 id="welcome-title">选择外观</h1>
          <fieldset className="welcome-theme-grid" aria-labelledby="welcome-title">
            {(['light', 'dark', 'system'] as const).map((value, index) => {
              const label = ['浅色', '深色', '跟随系统'][index]
              return <label key={value} className="welcome-theme-card" data-look={value} data-selected={theme === value}>
                <input type="radio" name="welcome-theme" aria-label={label} checked={theme === value} onChange={() => setTheme(value)} />
                <span className="welcome-mini" aria-hidden="true"><i /><b /></span>
                <span>{label}</span>
                {theme === value && <Check className="welcome-check" size={17} aria-hidden="true" />}
              </label>
            })}
          </fieldset>
        </section>}
        {step === 3 && <section className="welcome-defaults">
          <h1 id="welcome-title">对话偏好</h1>
          <div className="welcome-default-grid">
            <div className="welcome-control">
              <label htmlFor="welcome-model">默认模型</label>
              <div className="welcome-select">
                <select id="welcome-model" disabled={saving || !confirmed || !models.length} value={model?.value ?? ''}
                  onChange={event => { setModelValue(event.target.value); setEffort(null) }}>
                  {!model && <option value="" disabled>选择模型</option>}
                  {models.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
                <ChevronDown size={16} aria-hidden="true" />
              </div>
              {model?.resolvedModel && model.resolvedModel !== model.label &&
                <p className="welcome-model-target" title={model.resolvedModel}>实际模型：{model.resolvedModel}</p>}
            </div>
            <div className="welcome-control">
              <label htmlFor="welcome-effort">思考程度</label>
              <div className="welcome-select">
                <select id="welcome-effort" value={supportedEffort ?? ''} disabled={saving || !confirmed || !model?.efforts.length}
                  onChange={event => setEffort(event.target.value ? event.target.value as EffortLevel : null)}>
                  <option value="">自动</option>
                  {EFFORT_LEVELS.filter(item => model?.efforts.includes(item.value)).map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
                <ChevronDown size={16} aria-hidden="true" />
              </div>
            </div>
          </div>
          {(loading || error || !models.length) && <div className="welcome-catalog-status" role="status">
            <span>{loading ? '正在读取 CLI 模型…' : error ? '模型读取失败。' : '当前 CLI 未提供可用模型。'}</span>
            {!loading && <button type="button" aria-label="刷新欢迎页模型" title={error ?? undefined} disabled={saving} onClick={retry}>
              <RefreshCw size={14} aria-hidden="true" />重试
            </button>}
          </div>}
          {saveError && <p className="welcome-save-error" role="alert">保存失败：{saveError}。请重试。</p>}
        </section>}
      </main>

      <footer className="welcome-actions">
        <button className="welcome-later" type="button" disabled={saving}
          onClick={() => step === 1 ? dismiss() : goTo(step - 1)}>
          {step === 1 ? settings?.welcomeCompleted ? '取消' : '稍后设置' : '上一步'}
        </button>
        {step < 3 ? <button className="welcome-finish" type="button" onClick={() => goTo(step + 1)}>继续</button> :
          <button className="welcome-finish" type="button" disabled={saving || loading || (confirmed && models.length > 0 && !model)}
            onClick={() => void finish()}>{saving ? '正在保存…' : '开始使用'}</button>}
      </footer>
    </div>
  </div>
}
