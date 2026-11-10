import { useEffect, useRef, useState } from 'react'
import { useComposerDrafts } from '../../composerDraftStore'
import type { DiffSource, PermissionRule, PermissionRules, RuleChange } from '@shared/sessionControl'

import { Trash2 } from 'lucide-react'

const behaviors: Record<string, string> = { allow: '允许', ask: '询问', deny: '拒绝' }
const scopes: Record<string, string> = { userSettings: '用户', localSettings: '本地项目', projectSettings: '共享项目', policySettings: '组织策略', flagSettings: '启动参数' }


export function SessionControlsPane({ sessionId, cwd, active, turnDiff, initialTab = 'diff' }: {
  sessionId: string
  cwd: string
  active: boolean
  turnDiff?: string
  initialTab?: 'diff' | 'rules'
}) {
  const [addingRule, setAddingRule] = useState(false)
  const [tab, setTab] = useState(initialTab)
  const [source, setSource] = useState<DiffSource | 'turn'>(turnDiff ? 'turn' : 'working')
  const [data, setData] = useState<string | PermissionRules | null>(null)
  const [outsideRepository, setOutsideRepository] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const actionVersion = useRef(0)
  useEffect(() => { actionVersion.current++; setBusy(false) }, [sessionId, cwd, tab])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let loading = false
    setData(null)
    setError('')
    setOutsideRepository(false)
    async function load() {
      if (loading) return
      loading = true
      try {
        const value = tab === 'diff' && source === 'turn'
          ? turnDiff ?? ''
          : tab === 'diff'
            ? await window.desk.files.diff(cwd, source === 'turn' ? 'working' : source)
            : await window.desk.chat.rules(sessionId, cwd)
        if (!cancelled) {
          setOutsideRepository(tab === 'diff' && value === null)
          setData(value)
        }
      } catch (e) {
        if (!cancelled) setError(String(e))
      } finally { loading = false }
    }
    void load()
    return () => { cancelled = true }
  }, [sessionId, cwd, tab, source, revision, active, turnDiff])

  async function reloadConfiguration() {
    const version = ++actionVersion.current
    setBusy(true)
    setError('')
    try {
      await window.desk.chat.reloadConfiguration(sessionId, cwd)
      if (version !== actionVersion.current) return
      setRevision(r => r + 1)
    } catch (e) { if (version === actionVersion.current) setError(String(e)) }
    finally { if (version === actionVersion.current) setBusy(false) }
  }

  async function changeRule(change: RuleChange) {
    setBusy(true)
    setError('')
    try {
      await window.desk.chat.changeRule(sessionId, cwd, change)
      if (!change.remove) setAddingRule(false)
      setRevision(r => r + 1)
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }

  function attachDiff() {
    const drafts = useComposerDrafts.getState()
    const text = drafts.drafts[sessionId]?.text ?? ''
    drafts.updateDraft(sessionId, { text: text + '\n请审阅以下差异\n' + data })
  }

  const ruleState = data && typeof data !== 'string' ? data : null
  const rules: PermissionRule[] = ruleState?.rules ?? []
  const buttonStyle = 'rounded-lg bg-chip px-3 py-1.5 disabled:opacity-40'
  return <div className="h-full overflow-y-auto p-4 text-[13px]">
    <nav className="mb-4 flex flex-wrap gap-1 border-b border-line pb-3">
      {([['diff', '改动审阅'], ['rules', '权限规则']] as const).map(([value, label]) =>
        <button key={value} onClick={() => setTab(value)}
          className={`rounded-lg px-3 py-2 ${tab === value ? 'bg-active' : 'hover:bg-hover'}`}>{label}</button>)}
    </nav>
    {tab === 'rules' && <>
      <button onClick={() => setRevision(r => r + 1)} className={buttonStyle}>刷新</button>
      {error && <p role="alert" className="my-3 text-danger">{error}</p>}
    </>}
    {tab === 'diff' && outsideRepository && <>
      <p className="text-fg2">当前目录未使用 Git</p>
      {turnDiff && <button onClick={() => setSource('turn')} className={buttonStyle + ' mt-3'}>查看本轮工具修改片段</button>}
    </>}
    {tab === 'diff' && !outsideRepository && <>
      <button onClick={() => setRevision(r => r + 1)} className={buttonStyle}>{error ? '重试' : '刷新'}</button>
      <select aria-label="比较来源" value={source} onChange={e => setSource(e.target.value as DiffSource | 'turn')}
        className="mb-3 ml-2 max-w-full rounded-lg border border-line bg-bg p-1.5">
        {turnDiff && <option value="turn">本轮工具修改片段</option>}
        <option value="working">工作区相对 HEAD</option>
        <option value="branch">分支相对基准分支</option>
      </select>
      {error && <div className="my-3">
        <p role="alert" className="text-danger">无法读取改动</p>
        <details className="mt-2 text-fg2">
          <summary className="cursor-pointer">查看详情</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[12px]">{error}</pre>
        </details>
      </div>}
      {data === '' && <p className="mt-3 text-fg2" title="仅比较已跟踪文件">暂无改动</p>}
      {typeof data === 'string' && data && <>
        <button className={buttonStyle} onClick={attachDiff}>附到下一条提问</button>
        <pre className="mt-3 overflow-x-auto rounded-xl border border-line p-3 font-mono text-[12px]">
          {data.split('\n').map((line, index) => <div key={index}
            className={line.startsWith('+') ? 'text-green-600 dark:text-green-400' : line.startsWith('-') ? 'text-danger' : 'text-fg2'}>{line || ' '}</div>)}
        </pre>
      </>}
    </>}
    {tab === 'rules' && data && <>
      <button disabled={ruleState?.managedOnly} aria-expanded={addingRule} onClick={() => setAddingRule(!addingRule)} className={buttonStyle + ' ml-2'}>{addingRule ? '取消新增' : '新增规则'}</button>
      {addingRule && <form className="my-3 flex flex-wrap gap-2" onSubmit={event => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        void changeRule({ source: form.get('source') as RuleChange['source'], behavior: form.get('behavior') as RuleChange['behavior'], rule: String(form.get('rule') ?? '') })
      }}>
        <select name="source" aria-label="保存范围" className="rounded-lg border border-line bg-bg p-2">
          <option value="localSettings">本地项目</option><option value="projectSettings">共享项目</option><option value="userSettings">用户</option>
        </select>
        <select name="behavior" aria-label="权限行为" className="rounded-lg border border-line bg-bg p-2">
          {Object.entries(behaviors).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input required name="rule" aria-label="权限规则" placeholder="Bash(npm run *)" className="min-w-0 flex-1 rounded-lg border border-line bg-bg p-2" />
        <button disabled={busy} className={buttonStyle}>保存规则</button>
      </form>}
      <div className="mb-2 mt-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">生效规则</h3>
        {rules.some(rule => rule.editability === 'session') &&
          <button disabled={busy} title="重载配置并清除本会话临时授权" className="rounded-md px-2 py-1 text-fg2 hover:bg-hover disabled:opacity-40"
            onClick={() => void reloadConfiguration()}>清除本会话临时授权</button>}
      </div>
      <div className="divide-y divide-line rounded-xl border border-line">
        {!rules.length && <p className="p-3 text-fg3">没有规则</p>}
        {rules.map((rule, index) => <div key={index} className="flex items-center gap-2 px-3 py-2.5">
          <span className={`shrink-0 font-medium ${rule.behavior === 'deny' ? 'text-danger' : 'text-fg'}`}>{behaviors[rule.behavior] ?? rule.behavior}</span>
          <code className="min-w-0 flex-1 break-all">{rule.rule}</code>
          <span className="text-right text-fg2" title={rule.source}>{rule.editability === 'session' ? '本会话' : scopes[rule.source] ?? rule.source}{rule.editability === 'readonly' && '（只读）'}</span>
          {rule.editability === 'persistent' && <button disabled={busy} aria-label={`撤销规则 ${rule.rule}`} title="撤销规则"
            onClick={() => void changeRule({ source: rule.source as RuleChange['source'], behavior: rule.behavior, rule: rule.rule, remove: true })}
            className="shrink-0 rounded-md p-1.5 text-fg3 hover:bg-hover hover:text-danger"><Trash2 size={15} /></button>}
        </div>)}
      </div>
    </>}
  </div>
}
