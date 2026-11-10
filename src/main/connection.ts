import { execFile, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { clipboard, dialog, shell } from 'electron'
import type { ConnectionStatus } from '../shared/connection'
import { claudeRuntime, withIdleQuery } from './sdk'
import { isConfigRecord, readConfigState } from './claudeConfigProtocol'
import { providerRoute } from './providerRoute'
import { terminalCommand } from './nativeRuntime'
import { proxyEnvironment, readSystemProxy } from './systemProxy'
import { adoptLoginShellEnv } from './env'

const run = promisify(execFile)

/** Only return non-secret authentication metadata, never raw CLI output. */
export function parseAuthentication(stdout: string): Pick<ConnectionStatus, 'loggedIn' | 'authMethod' | 'provider' | 'configDirectory'> {
  const value = JSON.parse(stdout)
  if (typeof value.loggedIn !== 'boolean') throw new Error('Claude Code 未返回有效的登录状态，请更新官方 CLI 后重试。')
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
    result.executable = runtime.path
    result.source = runtime.source
    const env = proxyEnvironment(await readSystemProxy(), process.env)
    const options = { cwd, env, windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024 }
    const version = await run(runtime.path, ['--version'], options)
    result.version = version.stdout.trim()
    let stdout: string
    try { stdout = (await run(runtime.path, ['auth', 'status', '--json'], options)).stdout }
    catch (error) {
      const failure = error as { code?: number; stdout?: string }
      // auth status deliberately exits 1 when signed out; transport errors stay failures.
      if (failure.code !== 1 || !failure.stdout) throw new Error('登录状态检测失败或超时，请确认 CLI 可用后重新检测。')
      stdout = failure.stdout
    }
    Object.assign(result, parseAuthentication(stdout))
    result.configDirectory ??= process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    result.provider = null
    try {
      result.provider = await withIdleQuery({ cwd, tools: [], mcpServers: {}, strictMcpConfig: true, settings: { disableAllHooks: true } }, async query => {
        const account = await query.accountInfo()
        const config = await readConfigState(query)
        return providerRoute(account, { ...env, ...(isConfigRecord(config.effective.env) ? config.effective.env : {}) })
      })
    } catch {
      // Raw SDK errors can contain the configured gateway URL or credentials.
      result.error = '无法确认当前项目的 Claude Code 接入，请检查项目配置后重新检测。'
    }
  } catch (error) {
    // execFile errors include command output. Never forward that to the renderer.
    result.error = error instanceof Error && !('cmd' in error) && !(error instanceof SyntaxError)
      ? error.message : '无法读取 Claude Code 状态，请检查运行文件或更新官方 CLI 后重试。'
  }
  return result
}

export async function pickClaudeExecutable(): Promise<string | null> {
  const result = await dialog.showOpenDialog({ title: '选择 Claude Code 原生运行文件', properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: 'Claude Code', extensions: ['exe'] }] } : {}) })
  return result.canceled ? null : result.filePaths[0] ?? null
}

export function powershellLoginCommand(executable: string): string {
  return `& '${executable.replace(/'/g, "''")}' auth login`
}

export function posixLoginCommand(executable: string): string {
  return `'${executable.replace(/'/g, "'\\''")}' auth login`
}

export function powershellResumeCommand(executable: string, cwd: string, sessionId: string): string {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`
  return `Set-Location -LiteralPath ${quote(cwd)}\r\n& ${quote(executable)} --resume ${quote(sessionId)}`
}

/** The user explicitly opens this interactive terminal to complete official OAuth. */
export async function openOfficialLogin(): Promise<void> {
  await adoptLoginShellEnv()
  const runtime = claudeRuntime()
  if (process.platform !== 'win32') {
    clipboard.writeText(posixLoginCommand(runtime.path))
    return
  }
  const command = Buffer.from(powershellLoginCommand(runtime.path), 'utf16le').toString('base64')
  const env = proxyEnvironment(await readSystemProxy(), process.env)
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise<void>((resolve, reject) => {
    const child = spawn(terminalCommand().file, ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', command], { cwd: homedir(), env, detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', () => reject(new Error('无法打开登录终端，请在 PowerShell 中运行 claude auth login。')))
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

export async function openInstallationHelp(): Promise<void> {
  await shell.openExternal('https://code.claude.com/docs/en/setup')
}
