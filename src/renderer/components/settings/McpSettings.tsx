import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { McpStatus } from '@shared/chat'
import { Row, Section, settingsButtonClass } from './SettingsControls'
import { errorText } from '../../ipcError'
const SCOPES: Record<string, string> = { user: '所有项目', project: '当前项目', local: '本地项目', managed: '组织管理' }
const STATUS: Record<McpStatus['status'], string> = { connected: '已连接', pending: '连接中', 'needs-auth': '需要授权', failed: '连接失败', disabled: '已停用' }
export function McpSettings({ sessionId, cwd }: { sessionId: string | null; cwd: string }) {
  const [list, setList] = useState<McpStatus[] | null>(null), [error, setError] = useState<string | null>(null), [revision, setRevision] = useState(0)
  useEffect(() => {
    let cancelled = false; setList(null); setError(null)
    window.desk.chat.mcp(sessionId, cwd).then(value => { if (!cancelled) setList(value) }, e => { if (!cancelled) setError(errorText(e)) })
    return () => { cancelled = true }
  }, [sessionId, cwd, revision])
  return <Section title="MCP 服务" action={<button type="button" onClick={() => setRevision(n => n + 1)} aria-label="刷新 MCP" className={`${settingsButtonClass} flex items-center gap-2`}><RefreshCw size={14} />刷新</button>}>
    {error ? <p role="alert" className="px-4 py-3 text-danger">{error}</p> : !list ? <p role="status" className="px-4 py-3 text-fg3">读取中…</p> : !list.length ? <p className="px-4 py-3 text-fg3">没有配置 MCP 服务器。</p> : list.map(server => <div key={server.name}>
      <Row label={server.name} hint={`${server.tools} 个工具${server.scope ? ` · ${SCOPES[server.scope] ?? server.scope}` : ''}`}>
        <span className={`text-[12px] ${server.status === 'failed' ? 'text-danger' : 'text-fg2'}`}>{STATUS[server.status] ?? server.status}</span>
      </Row>
      {server.error && <p className="px-4 pb-3 break-words text-[12px] text-danger">{server.error}</p>}
    </div>)}
  </Section>
}
