import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { clipboard, dialog, shell } from 'electron'
import type { ConnectionStatus } from '../shared/connection'
import { claudeRuntime, withIdleQuery } from './sdk'
import { proxyEnvironment, readSystemProxy } from './systemProxy'
import { adoptLoginShellEnv } from './env'
import { isConfigRecord, readConfigState } from './claudeConfigProtocol'
import { providerRoute } from './providerRoute'

const run = promisify(execFile)
export function parseAuthentication(stdout: string): Pick<ConnectionStatus, 'loggedIn' | 'authMethod' | 'provider' | 'configDirectory'> {
  const value = JSON.parse(stdout)
  if (!value || typeof value.loggedIn !== 'boolean') throw new Error('Claude Code 未返回有效的登录状态，请更新 CLI 后重试。')
  return {
    loggedIn: value.loggedIn,
    authMethod: typeof value.authMethod === 'string' ? value.authMethod : null,
    provider: typeof value.apiProvider === 'string' ? value.apiProvider : null,
    configDirectory: typeof value.configDirectory === 'string' ? value.configDirectory : null
  }
}

export async function connectionStatus(cwd = homedir()): Promise<ConnectionStatus> {
  const result: ConnectionStatus = { executable: null, source: null, version: null, configDirectory: null, loggedIn: false, authMethod: null, provider: null, error: null }
  try {
    await adoptLoginShellEnv()
    const runtime = claudeRuntime()
    result.executable = runtime.path; result.source = runtime.source
    const env = proxyEnvironment(await readSystemProxy(), process.env)
    const options = { cwd, env, timeout: 15000, maxBuffer: 256 * 1024 }
    result.version = (await run(runtime.path, ['--version'], options)).stdout.trim()
    let stdout: string
    try { stdout = (await run(runtime.path, ['auth', 'status', '--json'], options)).stdout }
    catch (error) {
      const failure = error as { code?: number; stdout?: string }
      if (failure.code !== 1 || !failure.stdout) throw new Error('登录状态检测失败或超时，请确认 CLI 可用后重新检测。')
      stdout = failure.stdout
    }
    Object.assign(result, parseAuthentication(stdout))
    result.configDirectory ??= process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    // Use the selected project's settings too: OAuth can remain present behind a gateway.
    result.provider = await withIdleQuery({ cwd, tools: [], strictMcpConfig: true, settings: { disableAllHooks: true } }, async q => {
      const account = await q.accountInfo()
      const config = await readConfigState(q)
      return providerRoute(account, { ...env, ...(isConfigRecord(config.effective.env) ? config.effective.env : {}) })
    })
  } catch {
    // Raw CLI failures can include credentials, so never forward their output.
    result.error = '无法确认 Claude Code 接入状态，请检查运行文件、认证和项目配置后重试。'
  }
  return result
}

export async function pickClaudeExecutable(): Promise<string | null> {
  const result = await dialog.showOpenDialog({ title: '选择 Claude Code 运行文件', properties: ['openFile'] })
  return result.canceled ? null : result.filePaths[0] ?? null
}
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
const invocation = (executable: string, configDirectory?: string): string => `${configDirectory ? `env CLAUDE_CONFIG_DIR=${quote(configDirectory)} ` : ''}${quote(executable)}`
export const posixLoginCommand = (executable: string, configDirectory?: string): string => `${invocation(executable, configDirectory)} auth login`
export async function openOfficialLogin(): Promise<void> {
  await adoptLoginShellEnv()
  clipboard.writeText(posixLoginCommand(claudeRuntime().path, process.env.CLAUDE_CONFIG_DIR))
}
export async function openInstallationHelp(): Promise<void> { await shell.openExternal('https://code.claude.com/docs/en/setup') }
