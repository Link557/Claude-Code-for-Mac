import { useEffect, useRef, useState } from 'react'
import type { ConnectionStatus } from '@shared/connection'
import { useDesk } from '../../store'
import { errorText } from '../../ipcError'

export function useCliConnection(cwd?: string) {
  const executable = useDesk(s => s.settings?.claudePath)
  const [status, setStatus] = useState<ConnectionStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const refresh = () => { generation.current++; setRevision(value => value + 1) }

  useEffect(() => {
    const invalidate = () => { generation.current++; setRevision(value => value + 1) }
    const offConnection = window.desk?.connection?.onChanged?.(invalidate)
    const offConfig = window.desk?.meta?.onConfigChanged?.(change => {
      if (change.scope !== 'project' || change.cwd === cwd) invalidate()
    })
    return () => { offConnection?.(); offConfig?.() }
  }, [cwd])
  useEffect(() => {
    let active = true
    const request = ++generation.current
    setChecking(true)
    setError(null)
    if (!window.desk?.connection?.status) {
      setError('CLI 接入接口不可用')
      setChecking(false)
      return () => { active = false }
    }
    void window.desk.connection.status(cwd).then(value => {
      if (active && generation.current === request) setStatus(value)
    }, failure => {
      if (active && generation.current === request) { setStatus(null); setError(errorText(failure)) }
    }).finally(() => { if (active && generation.current === request) setChecking(false) })
    return () => { active = false }
  }, [cwd, executable, revision])

  return { status, checking, error, refresh }
}
