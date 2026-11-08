import { useEffect, useState } from 'react'
import type { ConnectionStatus } from '@shared/connection'
import { useDesk } from '../../store'
import { errorText } from '../../ipcError'
import { Row, Section, settingsButtonClass } from './SettingsControls'

function statusLabel(status: ConnectionStatus): string {
  if (status.error) return '需要检查接入'
  if (!status.loggedIn) return '尚未登录'
  if (status.provider === 'firstParty') return '已检测到官方认证'
  if (status.provider) return '正在使用其他供应商配置'
  return '已检测到认证，供应商尚未确认'
}

export function ConnectionSettings({ cwd }: { cwd?: string }) {
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
    <p className="px-4 py-3 text-[13px] text-fg2">沿用本机 Claude Code 的登录和配置。检测不会发送对话，也不会修改 CLI 配置。默认使用应用内置引擎，也可选择自定义 CLI。</p>
    <Row label="接入状态"><span role="status">{busy ? '正在检测…' : status ? statusLabel(status) : '尚未取得状态'}</span></Row>
    <Row label="运行引擎"><span className="text-fg2">{status?.source === 'installed' ? '本机已安装' : status?.source === 'custom' ? '手动选择' : status?.source === 'bundled' ? '应用内置' : '未找到'}</span></Row>
    {status?.version && <Row label="CLI 版本"><span>{status.version}</span></Row>}
    {status?.executable && <p className="break-all px-4 py-2 text-[12px] text-fg2">{status.executable}</p>}
    {status?.configDirectory && <Row label="共享配置与历史"><span className="max-w-[460px] break-all text-[12px] text-fg2">{status.configDirectory}</span></Row>}
    {status?.authMethod && <Row label="认证方式"><span>{status.authMethod === 'claude.ai' ? 'Claude 账号登录' : status.authMethod === 'api_key' ? 'API 密钥' : status.authMethod}</span></Row>}
    {status?.loggedIn && status.provider === 'firstParty' && <p className="px-4 py-2 text-[12px] text-fg2">已读取本机认证；实际网络连通性和模型可用性以发送消息后的结果为准。</p>}
    {status?.provider && status.provider !== 'firstParty' && <p className="px-4 py-2 text-[12px] text-fg2">检测到其他供应商配置，本次没有覆盖它。官方账号登录不等于当前请求走官方服务，模型权限和账单以实际供应商为准。</p>}
    <div className="flex flex-wrap gap-2 px-4 py-3">
      <button disabled={busy} className={settingsButtonClass} onClick={() => setRevision(value => value + 1)}>重新检测</button>
      <button disabled={busy || !status?.executable} className={settingsButtonClass} onClick={() => void action(async () => {
        await window.desk.connection.login()
        setNotice('登录命令已复制。请粘贴到终端执行并完成浏览器授权，返回这里点击“重新检测”。登录会更新 CLI 共用的认证。')
      })}>复制官方登录命令</button>
      <button disabled={busy} className={settingsButtonClass} onClick={() => void action(async () => {
        const path = await window.desk.connection.pickExecutable()
        if (path) await updateSettings({ claudePath: path })
      })}>选择 CLI 文件</button>
      {settings?.claudePath && <button disabled={busy} className={settingsButtonClass} onClick={() => void action(async () => { await updateSettings({ claudePath: null }) })}>恢复内置引擎</button>}
      <button disabled={busy} className={settingsButtonClass} onClick={() => void action(() => window.desk.connection.installationHelp())}>官方安装说明</button>
    </div>
    {(error || status?.error) && <p role="alert" className="px-4 py-2 text-[13px] text-danger">{error || status?.error}</p>}
    {notice && <p role="status" className="px-4 py-2 text-[13px] text-fg2">{notice}</p>}
    <p className="px-4 py-3 text-[12px] text-fg2">在 CLI 完成当前一轮后，再从桌面端打开相同项目和历史会话继续。不要同时在两端发送同一会话。若 CLI 仅在某个终端临时设置环境变量，请从该终端启动桌面端以继承它们。目前不支持执行中接管，也没有跨进程写入锁。</p>
  </Section>
}
