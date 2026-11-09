// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WindowPin } from '../src/renderer/components/ui/WindowPin'

let publish: (enabled: boolean) => void
let off: ReturnType<typeof vi.fn>
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { resolve, reject, promise }
}
beforeEach(() => {
  off = vi.fn()
  window.desk = { window: {
    alwaysOnTop: vi.fn().mockResolvedValue(false),
    toggleAlwaysOnTop: vi.fn().mockResolvedValue(true),
    onAlwaysOnTopChanged: vi.fn(listener => { publish = listener; return off })
  } } as unknown as Window['desk']
})
afterEach(cleanup)

it('reads native state, toggles both ways and exposes an accessible pressed state', async () => {
  render(<WindowPin />)
  const button = await screen.findByRole('button', { name: '窗口置顶' })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(button)
  await screen.findByRole('button', { name: '取消窗口置顶', pressed: true })
  vi.mocked(window.desk.window.toggleAlwaysOnTop).mockResolvedValue(false)
  fireEvent.click(button)
  await screen.findByRole('button', { name: '窗口置顶', pressed: false })
  expect(window.desk.window.toggleAlwaysOnTop).toHaveBeenCalledTimes(2)
  expect(button.classList.contains('no-drag')).toBe(true)
})

it('prevents repeated pending requests and accepts external native changes', async () => {
  const pending = deferred<boolean>()
  vi.mocked(window.desk.window.toggleAlwaysOnTop).mockReturnValue(pending.promise)
  render(<WindowPin />)
  const button = screen.getByRole('button') as HTMLButtonElement
  await waitFor(() => expect(button.disabled).toBe(false))
  fireEvent.click(button); fireEvent.click(button)
  expect(window.desk.window.toggleAlwaysOnTop).toHaveBeenCalledTimes(1)
  act(() => { publish(true); publish(false) })
  await act(async () => pending.resolve(true))
  expect(button.getAttribute('aria-pressed')).toBe('false')
  expect(button.disabled).toBe(false)
  act(() => publish(true))
  expect(button.getAttribute('aria-pressed')).toBe('true')
})

it('does not let a stale initial read overwrite a newer native event and unsubscribes', async () => {
  const initial = deferred<boolean>()
  vi.mocked(window.desk.window.alwaysOnTop).mockReturnValue(initial.promise)
  const { unmount } = render(<WindowPin />)
  act(() => publish(true))
  await act(async () => initial.resolve(false))
  expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true')
  unmount()
  expect(off).toHaveBeenCalledTimes(1)
})

it('reports errors without inventing a state and allows retrying', async () => {
  vi.mocked(window.desk.window.alwaysOnTop).mockRejectedValue(Error('读取失败'))
  render(<WindowPin />)
  await screen.findByRole('status')
  const button = screen.getByRole('button') as HTMLButtonElement
  expect(button.disabled).toBe(false)
  vi.mocked(window.desk.window.toggleAlwaysOnTop).mockRejectedValueOnce(Error('切换失败'))
  fireEvent.click(button)
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('切换失败'))
  expect(button.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(button)
  await screen.findByRole('button', { name: '取消窗口置顶', pressed: true })
  expect(screen.queryByRole('status')).toBeNull()
})

it('hides on welcome or non-chat pages and reloads real state when chat returns', async () => {
  const { rerender } = render(<WindowPin visible={false} />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(window.desk.window.alwaysOnTop).not.toHaveBeenCalled()
  rerender(<WindowPin visible />)
  await waitFor(() => expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false))
  rerender(<WindowPin visible={false} />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(off).toHaveBeenCalledTimes(1)
  vi.mocked(window.desk.window.alwaysOnTop).mockResolvedValue(true)
  rerender(<WindowPin visible />)
  await screen.findByRole('button', { name: '取消窗口置顶', pressed: true })
  expect(window.desk.window.toggleAlwaysOnTop).not.toHaveBeenCalled()
})
