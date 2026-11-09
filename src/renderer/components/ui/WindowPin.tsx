import { useEffect, useRef, useState } from 'react'
import { Pin, PinOff } from 'lucide-react'
import { errorText } from '../../ipcError'
import '../../styles/windowControls.css'

/** Keep native pin state separate from whether the chat page exposes its control. */
export function WindowPin({ visible = true }: { visible?: boolean }) {
  return visible ? <WindowPinControl /> : null
}

function WindowPinControl() {
  const [pinned, setPinned] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = useRef(false)
  const revision = useRef(0)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    let active = true
    const off = window.desk.window.onAlwaysOnTopChanged(enabled => {
      revision.current++
      if (active) setPinned(enabled)
    })
    const requested = revision.current
    void window.desk.window.alwaysOnTop().then(enabled => {
      if (active && revision.current === requested) setPinned(enabled)
    }).catch(reason => { if (active) setError(errorText(reason)) })
    return () => { active = false; mounted.current = false; off() }
  }, [])

  const toggle = async () => {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError(null)
    const requested = revision.current
    try {
      const enabled = await window.desk.window.toggleAlwaysOnTop()
      if (mounted.current && revision.current === requested) setPinned(enabled)
    } catch (reason) {
      if (mounted.current) setError(errorText(reason))
    } finally {
      locked.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const label = pinned ? '取消窗口置顶' : '窗口置顶'
  return <div className="window-pin-slot" data-window-pin>
    <button type="button" className="window-pin no-drag" aria-label={label} title={error ?? label}
      aria-pressed={pinned === true} aria-busy={busy} disabled={busy || (pinned === null && !error)}
      onClick={() => void toggle()}>
      {pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}
    </button>
    {error && <span role="status" className="window-pin-error">{error}</span>}
  </div>
}
