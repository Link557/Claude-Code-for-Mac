import { useEffect, useState } from 'react'
import type { ConnectionStatus } from '@shared/connection'
import { useDesk } from '../../store'
import { errorText } from '../../ipcError'
import { isWindows } from '../../platform'
import { Row, Section, settingsButtonClass } from './SettingsControls'

function statusLabel(status: ConnectionStatus): string {
  if (status.error) return '需要检查接入'
  if (!status.loggedIn) return '尚未登录'
  if (status.provider === 'firstParty') return '已检测到官方认证'
  if (status.provider) return '正在使用其他供应商配置'
  return '已检测到认证，供应商尚未确认'
}

export function ConnectionSettings({ cwd }: { cwd?: string }) {
  const windows = isWindows()
  const { settings, updateSettings } = useDesk()
  const [status, setStatus] = useState<ConnectionStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    setBusy(true); setStatus(null); setError(null)
    void window.desk.connection.status(cwd).then(value => { if (active) setStatus(value) }, failure => {
      if (active) { setStatus(null); setError(errorText(failure)) }
    }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [cwd, settings?.claudePath, revision])
  const action = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null); setNotice(null)
    try { await fn() } catch (failure) { setError(errorText(failure)) }
    finally { setBusy(false) }
  }
  return <Section title="Claude Code 接入">
    <Row label="接入状态"><span role="status">{busy ? '正在检测…' : status ? statusLabel(status) : '尚未取得状态'}</span></Row>
    <Row label="运行引擎"><span className="text-fg2">{status?.source === 'installed' ? '本机已安装' : status?.source === 'custom' ? '手动选择' : status?.source === 'bundled' ? '应用内置' : '未找到'}</span></Row>
    {status?.authMethod && <Row label="认证方式"><span>{status.authMethod === 'claude.ai' ? 'Claude 账号登录' : status.authMethod === 'api_key' ? 'API 密钥' : status.authMethod}</span></Row>}
    {status?.loggedIn && status.provider === 'firstParty' && <p className="px-4 py-2 text-[12px] text-fg2">已读取本机认证；实际网络连通性和模型可用性以发送消息后的结果为准。</p>}
    {status?.provider && status.provider !== 'firstParty' && <p className="px-4 py-2 text-[12px] text-fg2">正在沿用其他供应商配置。模型权限、额度和计费由该供应商决定；Claude 官方登录不代表这些模型可用。</p>}
    <div className="flex flex-wrap gap-2 px-4 py-3">
      <button disabled={busy} className={settingsButtonClass} onClick={() => setRevision(value => value + 1)}>重新检测</button>
      <button disabled={busy || !status?.executable} className={settingsButtonClass} onClick={() => void action(async () => {
        await window.desk.connection.login()
        setNotice(windows ? '已打开官方登录终端。请完成浏览器授权，返回这里点击“重新检测”。登录会更新 CLI 共用的认证。' : '登录命令已复制。请粘贴到终端执行并完成浏览器授权，返回这里点击“重新检测”。登录会更新 CLI 共用的认证。')
      })}>{windows ? '打开官方登录终端' : '复制官方登录命令'}</button>
      <button disabled={busy} className={settingsButtonClass} onClick={() => void action(async () => {
        const path = await window.desk.connection.pickExecutable()
        if (path) await updateSettings({ claudePath: path })
      })}>选择 CLI 文件</button>
      {settings?.claudePath && <button disabled={busy} className={settingsButtonClass} onClick={() => void action(async () => { await updateSettings({ claudePath: null }) })}>恢复自动检测</button>}
      <button disabled={busy} className={settingsButtonClass} onClick={() => void action(() => window.desk.connection.installationHelp())}>官方安装说明</button>
    </div>
    {(error || status?.error) && <p role="alert" className="px-4 py-2 text-[13px] text-danger">{error || status?.error}</p>}
    {notice && <p role="status" className="px-4 py-2 text-[13px] text-fg2">{notice}</p>}
    {status && <details>
      <summary className="cursor-pointer px-4 py-3 text-[13px] text-fg2">接入详情</summary>
      {status.version && <Row label="CLI 版本"><span>{status.version}</span></Row>}
      {status.executable && <Row label="CLI 路径"><span className="max-w-[460px] break-all text-fg2">{status.executable}</span></Row>}
      {status.configDirectory && <Row label="共享配置与历史"><span className="max-w-[460px] break-all text-fg2">{status.configDirectory}</span></Row>}
      <p className="px-4 pb-3 text-fg2">CLI 完成后，再在桌面端继续同一会话。</p>
    </details>}
  </Section>
}
