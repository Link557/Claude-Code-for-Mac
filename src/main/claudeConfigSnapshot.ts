import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseCommandOutput } from '../shared/commands'
import { runLocalCommand } from './localCommand'
import { withIdleQuery } from './sdk'
import { resolveConfigValues } from './claudeConfigValues'
import { withClaudeConfig } from './claudeConfigAccess'
import { isConfigRecord, readConfigState } from './claudeConfigProtocol'
import { providerRoute } from './providerRoute'
import type { ClaudeConfigSnapshot } from '../shared/claudeConfig'

export function readClaudeConfig(cwd: string): Promise<ClaudeConfigSnapshot> {
  return withClaudeConfig(() => readSnapshot(cwd))
}

async function readSnapshot(cwd: string): Promise<ClaudeConfigSnapshot> {
  const [text, state] = await Promise.all([
    runLocalCommand(cwd, '/config'),
    withIdleQuery({ cwd, settingSources: ['user', 'project', 'local'] }, async q => {
      const init = await q.initializationResult()
      const state = await readConfigState(q)
      const env = { ...process.env, ...(isConfigRecord(state.effective.env) ? state.effective.env : {}) }
      return { ...state, version: init.claude_code_version ?? '', subscription: providerRoute(init.account ?? {}, env) === 'firstParty' ? init.account?.subscriptionType : undefined }
    })
  ])
  const parsed = parseCommandOutput('config', text)
  if (parsed.kind !== 'config') throw new Error('无法读取 Claude Code 设置目录')
  const configEnv = isConfigRecord(state.effective.env)
    ? Object.fromEntries(Object.entries(state.effective.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}
  const configuredDir = configEnv.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR
  let legacy: Record<string, unknown> = {}
  try {
    legacy = JSON.parse(await readFile(join(typeof configuredDir === 'string' && configuredDir ? configuredDir : homedir(), '.claude.json'), 'utf8'))
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new Error('配置格式无效')
  } catch (e: any) { if (e.code !== 'ENOENT') throw new Error('无法读取 Claude Code 用户偏好，请检查配置文件') }
  // Only the enumerated scalar settings cross IPC. Credentials, env, policy and feature caches stay in main.
  return resolveConfigValues(parsed.items, state.version, state.effective, legacy, state.subscription, state.sources, { ...process.env, ...configEnv })
}
