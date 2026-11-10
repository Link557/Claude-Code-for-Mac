import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import * as openpgp from 'openpgp'
import type { CliInstallProgress } from '../shared/connection'

const REPOSITORY = 'https://downloads.claude.ai/claude-code-releases'
const KEY = 'https://downloads.claude.ai/keys/claude-code.asc'
const FINGERPRINT = '31ddde24ddfab679f42d7bd2baa929ff1a7ecace'
const exec = promisify(execFile)
type Progress = (progress: CliInstallProgress) => void
type Dependencies = {
  fetch: typeof fetch
  fingerprint: string
  platform: NodeJS.Platform
  arch: string
  installedPath: string
  authentic(path: string): Promise<void>
  run(path: string, args: string[]): Promise<string>
}

async function authenticode(path: string): Promise<void> {
  const script = "$s=Get-AuthenticodeSignature -LiteralPath $env:CLAUDE_DESK_INSTALL_BINARY; if ($s.Status -ne 'Valid' -or !$s.SignerCertificate -or $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -ne 'Anthropic, PBC') { throw ('签名无效或签名者不匹配: ' + $s.Status) }"
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, CLAUDE_DESK_INSTALL_BINARY: path }, windowsHide: true, timeout: 60_000
  })
}
async function run(path: string, args: string[]): Promise<string> {
  const { stdout } = await exec(path, args, { windowsHide: true, timeout: 600_000, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}
async function response(url: string, fetcher: typeof fetch): Promise<Response> {
  const value = await fetcher(url, { signal: AbortSignal.timeout(600_000) })
  if (!value.ok || !value.body) throw new Error(`下载失败 (${value.status}): ${url}`)
  return value
}
async function small(url: string, fetcher: typeof fetch): Promise<Uint8Array> {
  const reader = (await response(url, fetcher)).body!.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error('发布信息过大') }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, size)
}

export function createCliInstaller(deps: Dependencies): (onProgress: Progress) => Promise<string> {
  let pending: Promise<string> | undefined
  const listeners = new Set<Progress>()
  let current: CliInstallProgress | undefined
  const emit = (progress: CliInstallProgress) => {
    current = progress
    for (const listener of listeners) { try { listener(progress) } catch { /* UI listener must not interrupt installation */ } }
  }
  async function install(): Promise<string> {
    if (deps.platform !== 'win32' || !['x64', 'arm64'].includes(deps.arch)) throw new Error('当前系统不支持 Windows 原生安装')
    emit({ stage: 'manifest' })
    const version = new TextDecoder().decode(await small(`${REPOSITORY}/latest`, deps.fetch)).trim()
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('官方最新版本号无效')
    const [manifest, signature, armoredKey] = await Promise.all([
      small(`${REPOSITORY}/${version}/manifest.json`, deps.fetch),
      small(`${REPOSITORY}/${version}/manifest.json.sig`, deps.fetch),
      small(KEY, deps.fetch)
    ])
    const key = await openpgp.readKey({ armoredKey: new TextDecoder().decode(armoredKey) })
    if (key.getFingerprint().toLowerCase() !== deps.fingerprint.toLowerCase()) throw new Error('官方发布密钥指纹不匹配')
    const verified = await openpgp.verify({
      message: await openpgp.createMessage({ binary: manifest }),
      signature: await openpgp.readSignature({ armoredSignature: new TextDecoder().decode(signature) }), verificationKeys: key
    })
    if (!verified.signatures.length) throw new Error('发布清单缺少签名')
    await verified.signatures[0].verified
    const info = JSON.parse(new TextDecoder().decode(manifest))
    const platform = `win32-${deps.arch}`
    const entry = info.platforms?.[platform]
    if (info.version !== version || entry?.binary !== 'claude.exe' || !/^[a-f0-9]{64}$/i.test(entry?.checksum ?? '') || !Number.isSafeInteger(entry?.size) || entry.size <= 0) throw new Error('官方发布清单内容无效')
    const directory = await mkdtemp(join(tmpdir(), 'claude-desk-install-'))
    try {
      const binary = join(directory, 'claude.exe')
      emit({ stage: 'downloading', percent: 0 })
      const download = await response(`${REPOSITORY}/${version}/${platform}/claude.exe`, deps.fetch)
      const reader = download.body!.getReader()
      const file = await open(binary, 'wx')
      const hash = createHash('sha256')
      let bytes = 0, percent = 0
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          bytes += part.value.length
          if (bytes > entry.size) throw new Error('下载文件大小与发布清单不一致')
          hash.update(part.value)
          await file.writeFile(part.value)
          const nextPercent = Math.floor(bytes / entry.size * 100)
          if (nextPercent !== percent) { percent = nextPercent; emit({ stage: 'downloading', percent }) }
        }
      } finally { await file.close(); reader.releaseLock() }
      emit({ stage: 'verifying' })
      if (bytes !== entry.size || hash.digest('hex') !== entry.checksum.toLowerCase()) throw new Error('下载文件的 SHA-256 或大小与发布清单不一致')
      await deps.authentic(binary)
      emit({ stage: 'installing' })
      await deps.run(binary, ['install', version])
      emit({ stage: 'version' })
      const installedHash = createHash('sha256')
      for await (const chunk of createReadStream(deps.installedPath)) installedHash.update(chunk as Buffer)
      if (installedHash.digest('hex') !== entry.checksum.toLowerCase()) throw new Error('安装后的 CLI 与已验证的发布清单不一致')
      await deps.authentic(deps.installedPath)
      const installedVersion = await deps.run(deps.installedPath, ['--version'])
      if (!installedVersion) throw new Error('安装后 CLI 未返回版本号')
      emit({ stage: 'complete' })
      return deps.installedPath
    } finally {
      const target = resolve(directory)
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('claude-desk-install-')) throw new Error('临时目录路径无效，未执行清理')
      await rm(target, { recursive: true, force: true })
    }
  }
  return (onProgress) => {
    listeners.add(onProgress)
    if (pending) { if (current) { try { onProgress(current) } catch { /* isolate UI listeners */ } }; return pending.finally(() => listeners.delete(onProgress)) }
    emit({ stage: 'checking' })
    pending = install().finally(() => { pending = undefined; current = undefined })
    return pending.finally(() => listeners.delete(onProgress))
  }
}

const architecture = process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE || process.arch
export const installNativeClaude = createCliInstaller({
  fetch: (url, init) => import('electron').then(({ net }) => net.fetch(url instanceof URL ? url.toString() : url, init)),
  fingerprint: FINGERPRINT, platform: process.platform,
  arch: /arm64/i.test(architecture) ? 'arm64' : process.arch,
  installedPath: join(homedir(), '.local', 'bin', 'claude.exe'), authentic: authenticode, run
})
