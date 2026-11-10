// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionControlsPane } from '../src/renderer/components/right/SessionControlsPane'
afterEach(cleanup)

it('uses normalized rules and targets the typed removal endpoint', async () => {
  const rules = vi.fn().mockResolvedValue({ managedOnly: false, rules: [{ rule: 'Read', source: 'localSettings', behavior: 'allow', editability: 'persistent' }] })
  const changeRule = vi.fn().mockResolvedValue(undefined)
  window.desk = { chat: { rules, changeRule } } as unknown as Window['desk']
  render(<SessionControlsPane sessionId="s" cwd="/project" active initialTab="rules" />)
  fireEvent.click(await screen.findByRole('button', { name: '撤销规则 Read' }))
  await waitFor(() => expect(changeRule).toHaveBeenCalledWith('s', '/project', { source: 'localSettings', behavior: 'allow', rule: 'Read', remove: true }))
})

it('reads git differences without starting or controlling a chat runtime', async () => {
  const diff = vi.fn().mockResolvedValue('+changed')
  window.desk = { files: { diff } } as unknown as Window['desk']
  render(<SessionControlsPane sessionId="s" cwd="/project" active />)
  expect(await screen.findByText('+changed')).toBeTruthy()
  expect(diff).toHaveBeenCalledWith('/project', 'working')
  fireEvent.change(screen.getByLabelText('比较来源'), { target: { value: 'branch' } })
  await waitFor(() => expect(diff).toHaveBeenCalledWith('/project', 'branch'))
})

it('shows a quiet Git notice without comparison controls outside a repository', async () => {
  window.desk = { files: { diff: vi.fn().mockResolvedValue(null) } } as unknown as Window['desk']
  render(<SessionControlsPane sessionId="s" cwd="/project" active />)
  expect(await screen.findByText('当前目录未使用 Git')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('button', { name: '刷新' })).toBeNull()
  expect(screen.queryByLabelText('比较来源')).toBeNull()
})

it('collapses command errors and can retry into the empty state', async () => {
  const diff = vi.fn().mockRejectedValueOnce(new Error('Git command details')).mockResolvedValue('')
  window.desk = { files: { diff } } as unknown as Window['desk']
  render(<SessionControlsPane sessionId="s" cwd="/project" active />)
  expect((await screen.findByRole('alert')).textContent).toBe('无法读取改动')
  expect(screen.getByText('查看详情').closest('details')?.open).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText('暂无改动')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})
