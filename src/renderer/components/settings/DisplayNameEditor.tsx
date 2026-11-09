import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { useDesk } from '../../store'
import { useUsage } from '../../usageStore'
import { errorText } from '../../ipcError'
import { Button, Dialog } from '../ui/Dialog'

export function useDisplayName(): string {
  const name = useDesk(s => s.settings?.displayName)
  const username = useDesk(s => s.username)
  const profile = useUsage(s => s.overview?.profile.name)
  return name || profile || username || '本机用户'
}

/** The same local preference is edited from settings and the usage identity. */
export function DisplayNameEditor({ compact = false }: { compact?: boolean }) {
  const current = useDisplayName()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function save() {
    if (!name.trim() || busy) return
    setBusy(true); setError(null)
    try { await useDesk.getState().updateSettings({ displayName: name.trim() }); setEditing(false) }
    catch (failure) { setError(errorText(failure)) }
    finally { setBusy(false) }
  }
  return <>
    <button type="button" aria-label="修改显示名称" title="修改显示名称"
      onClick={() => { setName(current); setError(null); setEditing(true) }}
      className={`group relative rounded-lg border border-transparent px-4 py-2 pr-7 transition-colors hover:border-line hover:bg-hover/40 focus-visible:border-line focus-visible:outline-none ${compact ? 'text-[13px]' : 'font-serif text-[25px] font-normal'}`}>
      {current}<Pencil aria-hidden size={12} className="absolute bottom-1.5 right-1.5 text-fg3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
    {editing && <Dialog title="修改显示名称" onClose={() => { if (!busy) setEditing(false) }} footer={<>
      <Button disabled={busy} onClick={() => setEditing(false)}>取消</Button>
      <Button disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</Button>
    </>}>
      <label className="block text-[13px]">显示名称<input autoFocus maxLength={20} value={name} disabled={busy} onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void save() } }}
        className="mt-2 block w-full rounded-lg border border-line bg-bg px-3 py-2 outline-none focus:border-accent" /></label>
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </Dialog>}
  </>
}
