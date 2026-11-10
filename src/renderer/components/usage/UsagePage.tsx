import { useEffect, useRef, useState } from 'react'
import { Pencil, RefreshCw, Upload } from 'lucide-react'
import { EMPTY_ANALYTICS, type UsageProfile } from '@shared/usageAnalytics'
import { resetTimeZh } from '@shared/format'
import { formatUsageTokens as formatTokens } from '@shared/usageAnalytics'
import { useUsage, useUsageStats } from '../../usageStore'
import { UsageBar } from '../ui/UsageBar'
import { Button, Dialog } from '../ui/Dialog'
import { UsageCharts } from './UsageCharts'
import { DisplayNameEditor, useDisplayName } from '../settings/DisplayNameEditor'

function duration(ms: number | null): string {
  if (ms === null) return '记录不足'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return `${Math.round(ms / 1000)} 秒`
  return minutes < 60 ? `${minutes} 分` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}
export function UsagePage() {
  const displayName = useDisplayName()
  const { overview, loading, error, refresh } = useUsage()
  const { stats: lastStats, error: statsError, loading: statsLoading, refresh: refreshStats } = useUsageStats()
  const stats = lastStats ?? EMPTY_ANALYTICS
  const [editing, setEditing] = useState(false)
  const request = useRef<(force?: boolean) => void>(() => {})
  useEffect(() => {
    if (!useUsage.getState().lastAttempt) void refresh()
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined
    const read = async (): Promise<void> => {
      if (disposed) return
      clearTimeout(timer)
      await refreshStats()
      if (!disposed) { clearTimeout(timer); timer = setTimeout(() => { if (!document.hidden) void read(); else timer = setTimeout(() => void read(), 60000) }, 60000) }
    }
    request.current = () => { void read() }
    void read()
    let afterResult: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = window.desk.chat.onEvent((_id, event) => { if (event.kind === 'result') { clearTimeout(afterResult); afterResult = setTimeout(() => void read(), 2000) } })
    const onFocus = (): void => { void read() }
    window.addEventListener('focus', onFocus)
    return () => { disposed = true; clearTimeout(timer); clearTimeout(afterResult); unsubscribe(); window.removeEventListener('focus', onFocus) }
  }, [refresh, refreshStats])
  const quota = overview?.usage
  const metrics = [
    [formatTokens(stats.total), '累计 Token', '输入、输出、缓存读取和缓存写入之和'],
    [formatTokens(stats.peak), '单日 Token 峰值', '按本地自然日汇总的最高值'],
    [duration(stats.longestTaskMs), '最长任务用时', '已记录任务的经过时间，含等待确认，不含发送前排队'],
    [`${stats.longestStreak} 天`, '最长连续天数', '连续有 Token 使用记录的历史最长天数'],
    [`${stats.currentStreak} 天`, '当前连续天数', '从今天或昨天向前计算连续使用天数']
  ]
  return <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-12 sm:px-10">
    <div className="mx-auto max-w-[1000px]">
      <div className="flex items-center justify-between pt-4"><h1 className="font-serif text-[24px]">使用情况</h1><button type="button" aria-label="刷新使用情况" disabled={loading || statsLoading} onClick={() => { void refresh(); request.current(true) }} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-fg3 hover:bg-hover"><RefreshCw size={13} className={loading || statsLoading ? 'animate-spin' : ''} />刷新</button></div>
      <div className="flex flex-col items-center pb-8 pt-7">
        <button type="button" aria-label="编辑个人展示资料" disabled={!overview} onClick={() => setEditing(true)} className="group relative mb-3 flex size-20 items-center justify-center overflow-hidden rounded-full bg-chip text-[28px] text-accent">
          {overview?.profile.avatar ? <img src={overview.profile.avatar} alt="个人头像" className="size-full object-cover" /> : <span>{displayName.slice(0, 1).toUpperCase()}</span>}
          <span className="absolute inset-0 hidden items-center justify-center bg-black/30 text-white group-hover:flex"><Pencil size={20} /></span>
        </button>
        <DisplayNameEditor />
        <div className="mt-1 text-[13px] text-fg3">{overview?.account.email || (overview ? '未提供账户邮箱' : '')}</div>
        {quota?.available && overview?.account.subscriptionType && <div className="mt-2 rounded-full bg-chip px-2.5 py-0.5 text-[11px] text-fg2">{overview.account.subscriptionType} 套餐</div>}
      </div>
      <h2 className="mb-2 text-[12px] text-fg3" title="统计本机可读取的 App、CLI 与子代理历史，包含输入、输出及缓存用量。">本机使用统计</h2>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line min-[1100px]:grid-cols-5">
        {metrics.map(([value, label, hint]) => <div key={label} title={hint} className="last:col-span-2 min-[1100px]:last:col-span-1 flex min-h-[88px] flex-col items-center justify-center bg-bg px-2 py-4"><span className="text-center font-serif text-[21px] tabular-nums">{!stats.updatedAt || stats.scanning && !stats.firstDate ? '—' : value}</span><span className="mt-1 flex items-center gap-1.5 text-[12px] text-fg3">{label}</span></div>)}
      </div>
      {statsLoading && <p role="status" className="mt-2 text-[12px] text-fg3">正在读取…</p>}
      {(statsError || stats.issues > 0) && <p role="status" className="mt-2 text-[12px] text-danger">{statsError ? `统计刷新失败：${statsError}` : `有 ${stats.issues} 处记录不完整或无法读取，当前统计可能不完整。`}</p>}
      {quota?.available !== false && <section className="mt-7" aria-label="套餐额度">
        <h2 className="mb-2 font-serif text-[20px] font-normal" title={overview ? `更新于 ${new Date(overview.updatedAt).toLocaleString()}` : undefined}>套餐额度</h2>
        {error && <p role="status" className="mb-2 text-[12px] text-danger">读取失败，已有数据为上次结果。{error}</p>}
        <div className="divide-y divide-line rounded-xl border border-line">
          {!quota ? <p className="p-4 text-[13px] text-fg3">{error ? '暂时无法读取额度，请稍后刷新。' : '正在读取额度…'}</p> : !quota.available ? <p className="p-4 text-[13px] text-fg3">当前登录方式不适用套餐额度。</p> : !quota.windows.length ? <p className="p-4 text-[13px] text-fg3">暂时没有额度数据。</p> : quota.windows.map((w, i) => <div className="px-4 py-3 text-[13px]" key={`${w.kind}-${w.label}-${i}`}><UsageBar label={w.label} percent={w.percent} reset={w.resetsAt ? resetTimeZh(w.resetsAt) : '重置时间未知'} /></div>)}
        </div>
      </section>}
      {lastStats && <UsageCharts days={stats.days} />}
      {editing && overview && <ProfileEditor key={overview.account.key} profile={overview.profile} onClose={() => setEditing(false)} />}
    </div>
  </div>
}
async function avatarThumbnail(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片')
  const url = URL.createObjectURL(file)
  try {
    const image = new Image(); image.src = url; await image.decode()
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256
    const side = Math.min(image.naturalWidth, image.naturalHeight)
    const context = canvas.getContext('2d')
    if (!context || !side) throw new Error('无法读取图片')
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 256, 256)
    return canvas.toDataURL('image/png')
  } finally { URL.revokeObjectURL(url) }
}
function ProfileEditor({ profile, onClose }: { profile: UsageProfile; onClose(): void }) {
  const name = profile.name
  const [avatar, setAvatar] = useState(profile.avatar)
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  return <Dialog title="个人头像" onClose={onClose} footer={<><Button onClick={onClose}>取消</Button><Button disabled={busy || !name.trim()} onClick={() => { setBusy(true); setError(null); void useUsage.getState().saveProfile({ name, avatar }).then(onClose, e => setError(String(e.message ?? e))).finally(() => setBusy(false)) }}>保存</Button></>}>
    <div className="flex items-center gap-4"><div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-full bg-chip text-[26px] text-accent">{avatar ? <img src={avatar} alt="头像预览" className="size-full object-cover" /> : name.slice(0, 1).toUpperCase()}</div><div className="space-y-2"><button type="button" disabled={busy} className="flex items-center gap-2 text-[13px]" onClick={() => picker.current?.click()}><Upload size={14} />上传头像</button><button type="button" disabled={busy} className="text-[12px] text-fg3" onClick={() => setAvatar(null)}>恢复默认头像</button></div></div>
    <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" aria-label="选择头像图片" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; setBusy(true); setError(null); void avatarThumbnail(file).then(setAvatar, err => setError(String(err.message ?? err))).finally(() => setBusy(false)) }} />
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
  </Dialog>
}
