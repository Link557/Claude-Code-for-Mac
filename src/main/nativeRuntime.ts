import { statSync } from 'node:fs'
import { isAbsolute, join, win32 } from 'node:path'
import { homedir } from 'node:os'

export interface NativeRuntime {
  path: string
  source: 'custom' | 'installed' | 'bundled'
}

const MISSING_RUNTIME = '未找到本机 Claude Code CLI。请安装官方原生 CLI，或在接入设置中选择已有文件。'

function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

/** Windows uses a native executable, never a .cmd shim or a WSL launcher. */
export function resolveNativeRuntime(options: {
  custom?: string | null
  modules: string
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  home?: string
}): NativeRuntime {
  const { custom, modules, platform = process.platform, arch = process.arch, env = process.env, home = homedir() } = options
  if (custom) {
    if (!isAbsolute(custom) || !isFile(custom)) throw new Error('指定的 Claude Code 文件不存在，请在接入设置中重新选择。')
    if (platform === 'win32' && !custom.toLowerCase().endsWith('.exe')) throw new Error('Windows 原生接入需要 claude.exe，请选择原生安装文件。')
    return { path: custom, source: 'custom' }
  }
  if (platform === 'win32') {
    const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
    const directories = pathValue.split(';').map(p => p.replace(/^"|"$/g, '')).filter(p => win32.isAbsolute(p))
    const installed = [...directories.map(p => join(p, 'claude.exe')), join(home, '.local', 'bin', 'claude.exe')].find(isFile)
    if (installed) return { path: installed, source: 'installed' }
    throw new Error(MISSING_RUNTIME)
  }
  const bundled = join(modules, `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`, 'claude')
  if (!isFile(bundled)) throw new Error(MISSING_RUNTIME)
  return { path: bundled, source: 'bundled' }
}

export function terminalCommand(platform = process.platform, env = process.env): { file: string; args: string[] } {
  if (platform === 'win32') return { file: join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] }
  return { file: env.SHELL || '/bin/zsh', args: ['-l'] }
}
