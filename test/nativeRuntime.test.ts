import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolveNativeRuntime, terminalCommand } from '../src/main/nativeRuntime'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-runtime-')); roots.push(root)
  return { modules: join(root, 'modules'), home: join(root, 'home'), env: {}, platform: 'win32' as const, arch: 'x64' }
}
function file(path: string): string { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'fixture'); return path }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('reuses the native installation even when Explorer PATH omits it', () => {
  const options = fixture()
  const installed = file(join(options.home, '.local', 'bin', 'claude.exe'))
  file(join(options.modules, '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'))
  expect(resolveNativeRuntime(options)).toEqual({ path: installed, source: 'installed' })
})
it('requires an installed Windows CLI even if a bundled executable exists', () => {
  const options = { ...fixture(), arch: 'arm64' }
  file(join(options.modules, '@anthropic-ai/claude-agent-sdk-win32-arm64/claude.exe'))
  expect(() => resolveNativeRuntime(options)).toThrow('未找到本机 Claude Code CLI')
})
it('honors a custom file and reports a missing or non-native custom file rather than silently changing engines', () => {
  const options = fixture()
  const custom = file(join(options.home, 'space and 中文', 'claude.exe'))
  expect(resolveNativeRuntime({ ...options, custom })).toEqual({ path: custom, source: 'custom' })
  expect(() => resolveNativeRuntime({ ...options, custom: custom + '.missing' })).toThrow('不存在')
  expect(() => resolveNativeRuntime({ ...options, custom: file(join(options.home, 'claude.cmd')) })).toThrow('claude.exe')
})
it('does not use a Unix shell inherited into a native Windows process', () => {
  expect(terminalCommand('win32', { SHELL: '/bin/bash', SystemRoot: 'C:\\Windows' })).toMatchObject({ args: ['-NoLogo'] })
  expect(terminalCommand('win32', { SHELL: '/bin/bash' }).file).toContain('powershell.exe')
  expect(terminalCommand('darwin', { SHELL: '/bin/zsh' })).toEqual({ file: '/bin/zsh', args: ['-l'] })
})
