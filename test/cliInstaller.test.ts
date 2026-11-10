import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as openpgp from 'openpgp'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createCliInstaller } from '../src/main/cliInstaller'

const binary = new TextEncoder().encode('isolated mock executable')
let publicKey: string, privateKey: string, fingerprint: string
const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
beforeAll(async () => {
  const keys = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 'Test' }] })
  publicKey = keys.publicKey; privateKey = keys.privateKey
  fingerprint = (await openpgp.readKey({ armoredKey: publicKey })).getFingerprint()
})
async function fixture(options: { badHash?: boolean; badSignature?: boolean; badFingerprint?: boolean; authFails?: boolean; wrongInstalled?: boolean } = {}) {
  const checksum = options.badHash ? '0'.repeat(64) : createHash('sha256').update(binary).digest('hex')
  const manifest = JSON.stringify({ version: '2.1.322', platforms: { 'win32-x64': { binary: 'claude.exe', size: binary.length, checksum } } })
  const signature = await openpgp.sign({ message: await openpgp.createMessage({ binary: new TextEncoder().encode(options.badSignature ? 'different' : manifest) }), signingKeys: await openpgp.readPrivateKey({ armoredKey: privateKey }), detached: true })
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const address = String(url)
    return new Response(address.endsWith('/latest') ? '2.1.322' : address.endsWith('manifest.json.sig') ? signature : address.endsWith('manifest.json') ? manifest : address.endsWith('.asc') ? publicKey : binary)
  }) as unknown as typeof fetch
  const authentic = vi.fn(async () => { if (options.authFails) throw new Error('签名无效') })
  const run = vi.fn(async (_path: string, args: string[]) => args[0] === '--version' ? '2.1.322' : '')
  const directory = mkdtempSync(join(tmpdir(), 'cli-installer-test-')); directories.push(directory)
  const installedPath = join(directory, 'claude.exe')
  writeFileSync(installedPath, options.wrongInstalled ? 'wrong' : binary)
  const install = createCliInstaller({ fetch: fetcher, fingerprint: options.badFingerprint ? 'bad' : fingerprint, platform: 'win32', arch: 'x64', installedPath, authentic, run })
  return { install, fetcher, authentic, run, installedPath }
}
it('verifies a signed manifest, binary and Authenticode before installing and checking the installed version', async () => {
  const { install, authentic, run, installedPath } = await fixture()
  const stages: string[] = []
  await expect(install(p => stages.push(p.stage))).resolves.toBe(installedPath)
  expect(stages).toEqual(expect.arrayContaining(['checking', 'manifest', 'downloading', 'verifying', 'installing', 'version', 'complete']))
  expect(authentic).toHaveBeenCalledTimes(2)
  expect(run.mock.calls.map(call => call[1])).toEqual([['install', '2.1.322'], ['--version']])
})
it('rejects an installed executable that differs from the verified manifest', async () => {
  const { install, run } = await fixture({ wrongInstalled: true })
  await expect(install(() => {})).rejects.toThrow('安装后的 CLI')
  expect(run.mock.calls.map(call => call[1])).toEqual([['install', '2.1.322']])
})
it.each(['badFingerprint', 'badSignature', 'badHash', 'authFails'] as const)('refuses installation on %s', async reason => {
  const { install, run } = await fixture({ [reason]: true })
  await expect(install(() => {})).rejects.toThrow()
  expect(run).not.toHaveBeenCalled()
})
it('coalesces concurrent installs and reports progress to both callers', async () => {
  const { install, fetcher, run } = await fixture()
  const a = vi.fn(), b = vi.fn()
  const [first, second] = await Promise.all([install(a), install(b)])
  expect(first).toBe(second)
  expect(run).toHaveBeenCalledTimes(2)
  expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(5)
  expect(a).toHaveBeenCalledWith({ stage: 'complete' })
  expect(b).toHaveBeenCalledWith({ stage: 'complete' })
})
