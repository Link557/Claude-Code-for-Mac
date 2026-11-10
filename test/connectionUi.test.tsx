// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConnectionSettings } from '../src/renderer/components/settings/ConnectionSettings'
import { CliInstallCard } from '../src/renderer/components/connection/CliInstallCard'
import { useDesk } from '../src/renderer/store'
import type { CliInstallProgress, ConnectionStatus } from '../src/shared/connection'
const official: ConnectionStatus = { state: 'ready', executable: 'C:\\Users\\name\\.local\\bin\\claude.exe', source: 'installed', version: '2.1.299', configDirectory: 'C:\\Users\\name\\.claude', loggedIn: true, authMethod: 'claude.ai', provider: 'firstParty', error: null }
beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows')
  useDesk.setState({ settings: { theme: 'light', defaultModel: 'sonnet', defaultEffort: null, defaultPermissionMode: 'default', claudePath: null, allowBypass: false } })
  window.desk = { connection: { status: vi.fn().mockResolvedValue(official), login: vi.fn().mockResolvedValue(undefined), pickExecutable: vi.fn(), installationHelp: vi.fn(), install: vi.fn(), onInstallProgress: vi.fn(() => () => {}) } } as unknown as Window['desk']
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('offers a terminal command on Mac instead of a Windows-only launcher', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
  render(<ConnectionSettings />)
  await screen.findByText('已检测到官方认证')
  expect(screen.queryByText('打开官方登录终端')).toBeNull()
  fireEvent.click(screen.getByText('复制官方登录命令'))
  await screen.findByText(/登录命令已复制/)
  expect(window.desk.connection.login).toHaveBeenCalledOnce()
})
it('shows detected official authentication without claiming a network check or starting login', async () => {
  render(<ConnectionSettings cwd={'C:\\Project'} />)
  await screen.findByText('已检测到官方认证')
  expect(screen.getByText(/实际网络连通性和模型可用性/)).toBeTruthy()
  expect(window.desk.connection.status).toHaveBeenCalledWith('C:\\Project')
  expect(window.desk.connection.login).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('打开官方登录终端'))
  await screen.findByText(/请完成浏览器授权/)
  expect(window.desk.connection.login).toHaveBeenCalledOnce()
})
it('reports a failed status check and lets the user retry', async () => {
  vi.mocked(window.desk.connection.status).mockRejectedValueOnce(new Error('检测超时'))
  render(<ConnectionSettings />)
  await screen.findByRole('alert')
  await waitFor(() => expect((screen.getByText('重新检测') as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByText('重新检测'))
  await screen.findByText('已检测到官方认证')
  expect(screen.queryByRole('alert')).toBeNull()
})
it('does not mislabel a third-party configuration as official', async () => {
  vi.mocked(window.desk.connection.status).mockResolvedValue({ ...official, source: 'installed', provider: 'bedrock' })
  render(<ConnectionSettings />)
  await screen.findByText('正在使用其他供应商配置')
  expect(screen.queryByText('已检测到官方认证')).toBeNull()
})

it('installs a missing Windows CLI, shows progress, then offers login', async () => {
  const missing = { ...official, state: 'missing' as const, executable: null, source: null, version: null, loggedIn: null, error: '未找到本机 CLI' }
  vi.mocked(window.desk.connection.status).mockResolvedValueOnce(missing).mockResolvedValueOnce({ ...official, loggedIn: false })
  let finish!: (value: ConnectionStatus) => void
  vi.mocked(window.desk.connection.install).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  let progress!: (value: CliInstallProgress) => void
  vi.mocked(window.desk.connection.onInstallProgress).mockImplementation(callback => { progress = callback; return () => {} })
  render(<ConnectionSettings />)
  fireEvent.click(await screen.findByRole('button', { name: '一键安装' }))
  progress({ stage: 'downloading', percent: 50 })
  await screen.findByText(/正在下载 Claude Code… 50%/)
  finish(official)
  fireEvent.click(await screen.findByRole('button', { name: '登录 Claude' }))
  expect(window.desk.connection.install).toHaveBeenCalledOnce()
  expect(window.desk.connection.login).toHaveBeenCalledOnce()
})

it('offers reselect and automatic detection for an invalid manual CLI path', async () => {
  useDesk.setState({ settings: { ...useDesk.getState().settings!, claudePath: 'C:\\old\\claude.exe' } })
  vi.mocked(window.desk.connection.status).mockResolvedValue({ ...official, state: 'invalidPath', executable: null, source: null, version: null, loggedIn: null, error: '文件不存在' })
  window.desk.settings = { get: vi.fn(async () => useDesk.getState().settings!), set: vi.fn(async patch => ({ ...useDesk.getState().settings!, ...patch })) }
  vi.mocked(window.desk.connection.pickExecutable).mockResolvedValue('C:\\new\\claude.exe')
  render(<ConnectionSettings />)
  fireEvent.click(await screen.findByRole('button', { name: '重新选择 CLI' }))
  await waitFor(() => expect(window.desk.settings.set).toHaveBeenCalledWith({ claudePath: 'C:\\new\\claude.exe' }))
  expect(screen.queryByRole('button', { name: '一键安装' })).toBeNull()
  expect(screen.getByRole('button', { name: '恢复自动检测' })).toBeTruthy()
})

it('shows authentication as unknown on a failed check and offers a retry', () => {
  const refresh = vi.fn()
  render(<CliInstallCard status={{ ...official, loggedIn: null, error: '认证查询超时' }} checking={false} onRefresh={refresh} />)
  expect(screen.getByText('Claude Code 已安装，认证状态未知')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('认证查询超时')
  expect(screen.queryByText('Claude Code 已安装，尚未登录')).toBeNull()
  expect(screen.queryByRole('button', { name: '登录 Claude' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重试检测' }))
  expect(refresh).toHaveBeenCalledOnce()
})

it('retains login when authentication succeeded as signed out but the provider probe failed', () => {
  render(<CliInstallCard status={{ ...official, loggedIn: false, provider: null, error: '无法确认当前项目接入' }} checking={false} onRefresh={vi.fn()} />)
  expect(screen.getByText('Claude Code 已安装，尚未登录')).toBeTruthy()
  expect(screen.getByRole('button', { name: '登录 Claude' })).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('无法确认当前项目接入')
  expect(screen.queryByText('Claude Code 已安装，认证状态未知')).toBeNull()
})

it('shows an unknown authentication result once in settings', async () => {
  vi.mocked(window.desk.connection.status).mockResolvedValue({ ...official, loggedIn: null, provider: null, error: '认证查询超时' })
  render(<ConnectionSettings />)
  expect((await screen.findByRole('alert')).textContent).toContain('认证查询超时')
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(screen.getByRole('button', { name: '重试检测' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '登录 Claude' })).toBeNull()
})

it('shows a provider probe failure once in settings when already signed in', async () => {
  vi.mocked(window.desk.connection.status).mockResolvedValue({ ...official, provider: null, error: '无法确认当前项目接入' })
  render(<ConnectionSettings />)
  expect((await screen.findByRole('alert')).textContent).toContain('无法确认当前项目接入')
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(screen.queryByText('Claude Code 已安装，认证状态未知')).toBeNull()
})
