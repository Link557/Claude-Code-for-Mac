import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
export async function gitDiff(cwd: string, source: string): Promise<string | null> {
  if (source !== 'working' && source !== 'branch') throw new Error('无效比较来源')
  const run = async (args: string[]) => (await exec('git', ['-c', 'core.quotepath=false', ...args], {
    cwd, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' }
  })).stdout
  try {
    if ((await run(['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') return null
  } catch (error) {
    if (error instanceof Error && 'stderr' in error && /^fatal: not a git repository\b/i.test(String(error.stderr))) return null
    throw error
  }
  if (source === 'working') return run(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'])
  let base: string
  try { base = (await run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim() }
  catch { base = (await run(['show-ref', '--verify', '--quiet', 'refs/heads/main']).then(() => 'main').catch(() => 'master')) }
  return run(['diff', '--no-ext-diff', '--no-textconv', base + '...HEAD', '--'])
}
