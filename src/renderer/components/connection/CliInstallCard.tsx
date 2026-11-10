import { useEffect, useState } from 'react'
import type { CliInstallProgress, ConnectionStatus } from '@shared/connection'
import { useDesk } from '../../store'
import { errorText } from '../../ipcError'
import { isWindows } from '../../platform'

const PROGRESS_LABEL: Record<CliInstallProgress['stage'], string> = {
  checking: '正在重新检测本机 CLI…',
  manifest: '正在验证官方发布清单…',
  downloading: '正在下载 Claude Code…',
  verifying: '正在校验文件哈希和签名…',
  installing: '正在安装到当前用户环境…',
  version: '正在验证 CLI 版本…',
  complete: '安装完成，正在刷新模型和命令…'
}

export function CliInstallCard({ status, checking, loadError, onRefresh }: {
  status: ConnectionStatus | null
  checking: boolean
  loadError?: string | null
  onRefresh(): void
}) {
  const updateSettings = useDesk(s => s.updateSettings)
  const manualPath = useDesk(s => s.settings?.claudePath)
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<CliInstallProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => window.desk?.connection?.onInstallProgress?.(setProgress), [])
  if (dismissed || (status?.state === 'ready' && status.loggedIn === true && !busy)) return null
  if (!status && checking) return <div role="status" className="rounded-xl border border-line p-4 text-[13px] text-fg2">正在检测 Claude Code CLI…</div>
  if (!status) return loadError ? <p role="alert" className="rounded-xl border border-line p-4 text-[13px] text-danger">{loadError}</p> : null

  const missing = status.state === 'missing'
  const invalid = status.state === 'invalidPath'
  const authUnknown = status.state === 'ready' && status.loggedIn === null
  const signedOut = status.state === 'ready' && status.loggedIn === false
  const title = authUnknown ? 'Claude Code 已安装，认证状态未知' : signedOut ? 'Claude Code 已安装，尚未登录' : invalid ? '所选 Claude Code CLI 文件已失效' : status.state === 'unusable' ? 'Claude Code CLI 无法运行' : '未检测到 Claude Code CLI'
  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (failure) { setError(errorText(failure)) }
    finally { setBusy(false) }
  }
  return <section aria-label="Claude Code CLI 接入" className="rounded-xl border border-line bg-card p-4 text-[13px]">
    <h2 className="font-medium text-fg">{title}</h2>
    <p className="mt-1 text-fg2">{authUnknown ? '无法确认登录状态，请重试检测。' : signedOut ? '使用本机 CLI 的官方登录流程，完成后返回这里重新检测。' : invalid ? '重新选择文件，或恢复自动检测。' : status.state === 'unusable' ? '请检查所选文件是否可以运行，或重新选择。' : '安装后，桌面端和终端将共用同一份本机 CLI。'}</p>
    {progress && busy && <div role="status" className="mt-3 text-fg2">
      <span>{PROGRESS_LABEL[progress.stage]}{progress.percent !== undefined ? ` ${Math.round(progress.percent)}%` : ''}</span>
      {progress.percent !== undefined && <progress className="mt-2 block w-full" max={100} value={progress.percent} />}
    </div>}
    {(error || loadError || status.error) && <p role="alert" className="mt-3 break-words text-danger">{error || loadError || status.error}</p>}
    {notice && <p role="status" className="mt-3 text-fg2">{notice}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      {signedOut && <button type="button" disabled={busy || checking} className="rounded-lg bg-accent px-3 py-1.5 text-white disabled:opacity-50" onClick={() => void action(async () => {
        await window.desk.connection.login()
        setNotice(isWindows() ? '已打开官方登录终端。完成浏览器授权后，请重新检测。' : '官方登录命令已复制。完成授权后，请重新检测。')
      })}>登录 Claude</button>}
      {isWindows() && missing && <button type="button" disabled={busy || checking} className="rounded-lg bg-accent px-3 py-1.5 text-white disabled:opacity-50" onClick={() => void action(async () => {
        setProgress({ stage: 'checking' })
        await window.desk.connection.install()
        onRefresh()
      })}>{busy ? '安装中…' : error ? '重试安装' : '一键安装'}</button>}
      <button type="button" disabled={busy || checking} className="rounded-lg border border-line px-3 py-1.5 hover:bg-hover disabled:opacity-50" onClick={() => void action(async () => {
        const path = await window.desk.connection.pickExecutable()
        if (path) { await updateSettings({ claudePath: path }); onRefresh() }
      })}>{invalid ? '重新选择 CLI' : '选择已有 CLI'}</button>
      {manualPath && <button type="button" disabled={busy || checking} className="rounded-lg border border-line px-3 py-1.5 hover:bg-hover disabled:opacity-50" onClick={() => void action(async () => { await updateSettings({ claudePath: null }); onRefresh() })}>恢复自动检测</button>}
      <button type="button" disabled={busy || checking} className="rounded-lg border border-line px-3 py-1.5 hover:bg-hover disabled:opacity-50" onClick={onRefresh}>{authUnknown ? '重试检测' : '重新检测'}</button>
      <button type="button" disabled={busy} className="rounded-lg px-3 py-1.5 text-fg2 hover:bg-hover disabled:opacity-50" onClick={() => setDismissed(true)}>稍后</button>
      <button type="button" disabled={busy} className="rounded-lg px-3 py-1.5 text-accent hover:bg-hover disabled:opacity-50" onClick={() => void action(() => window.desk.connection.installationHelp())}>官方安装说明</button>
    </div>
  </section>
}
