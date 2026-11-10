// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useCliConnection } from '../src/renderer/components/connection/useCliConnection'
import { useDesk } from '../src/renderer/store'
import type { ClaudeConfigChange } from '../src/shared/claudeConfig'
import type { ConnectionStatus } from '../src/shared/connection'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('refreshes for matching configuration changes and ignores an older response', async () => {
  useDesk.setState({ settings: { theme: 'light', defaultModel: 'opus', defaultPermissionMode: 'default', defaultEffort: null, claudePath: null, allowBypass: false } })
  const old = deferred<ConnectionStatus>()
  const current = deferred<ConnectionStatus>()
  const status = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  let changed!: (change: ClaudeConfigChange) => void
  const unsubscribe = vi.fn()
  window.desk = {
    connection: { status, onChanged: vi.fn(() => () => {}) },
    meta: { onConfigChanged: vi.fn((callback: typeof changed) => { changed = callback; return unsubscribe }) }
  } as unknown as Window['desk']

  const { result, unmount } = renderHook(() => useCliConnection('C:\\project'))
  await waitFor(() => expect(status).toHaveBeenCalledTimes(1))
  act(() => changed({ scope: 'project', cwd: 'C:\\other' }))
  expect(status).toHaveBeenCalledTimes(1)
  act(() => changed({ scope: 'project', cwd: 'C:\\project' }))
  await waitFor(() => expect(status).toHaveBeenCalledTimes(2))

  const latest: ConnectionStatus = { state: 'ready', executable: 'C:\\claude.exe', source: 'installed', version: '2.1.322', configDirectory: null, loggedIn: true, authMethod: 'api_key', provider: 'gateway', error: null }
  await act(async () => current.resolve(latest))
  await act(async () => old.resolve({ ...latest, provider: 'firstParty' }))
  expect(result.current.status?.provider).toBe('gateway')
  expect(result.current.checking).toBe(false)
  unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})
