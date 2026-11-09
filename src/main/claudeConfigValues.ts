import type { ClaudeConfigItem, ClaudeConfigSnapshot } from '../shared/claudeConfig'

// CLI defaults are version-bound. The visible settings below were also audited
// against native CLI 2.1.299's /config descriptors and global defaults.
const AUDITED_299_DEFAULTS = new Set(['autoCompact', 'language', 'outputStyle', 'useAutoModeDuringPlan', 'workflowKeywordTriggerEnabled', 'worktreeBaseRef', 'workflowSizeGuideline', 'switchModelsOnFlag'])
const LEGACY: Record<string, [string, string | boolean, boolean?]> = {
  agentPushNotifEnabled: ['agentPushNotifEnabled', false, true],
  autoCompact: ['autoCompactEnabled', true, true], autoConnectIde: ['autoConnectIde', false],
  autoScroll: ['autoScrollEnabled', true, true], checkpoints: ['fileCheckpointingEnabled', true, true],
  copyFullResponse: ['copyFullResponse', false], copyOnSelect: ['copyOnSelect', true],
  defaultToAgentsView: ['defaultToAgentsView', false], editor: ['editorMode', 'normal', true],
  externalEditorContext: ['externalEditorContext', false], gitignore: ['respectGitignore', true],
  inputNeededNotifEnabled: ['inputNeededNotifEnabled', false, true], leftArrowOpensAgents: ['leftArrowOpensAgents', true],
  notifChannel: ['preferredNotifChannel', 'auto', true], prStatus: ['prStatusFooterEnabled', true],
  progressBar: ['terminalProgressBarEnabled', true, true], theme: ['theme', 'dark', true],
  turnDuration: ['showTurnDuration', true, true], verbose: ['verbose', false, true]
}
// Only these legacy preferences may invalidate a settings view; counters and auth caches must not.
export const LEGACY_CONFIG_KEYS = [...Object.values(LEGACY).map(rule => rule[0]), 'remoteControlAtStartup', 'workflowSizeGuideline']

const SETTINGS: Record<string, [string, string | boolean]> = {
  language: ['language', 'default'], outputStyle: ['outputStyle', 'default'],
  permissionMode: ['permissions.defaultMode', 'default'], promptSuggestionEnabled: ['promptSuggestionEnabled', true],
  recap: ['awaySummaryEnabled', true], reduceMotion: ['prefersReducedMotion', false],
  thinking: ['alwaysThinkingEnabled', true], timeFormat: ['timeFormat', 'auto'],
  tips: ['spinnerTipsEnabled', true], useAutoModeDuringPlan: ['useAutoModeDuringPlan', true],
  workflowKeywordTriggerEnabled: ['workflowKeywordTriggerEnabled', true], worktreeBaseRef: ['worktree.baseRef', 'fresh']
}
type Dict = Record<string, any>
const get = (data: Dict, path: string): unknown => path.split('.').reduce<any>((value, key) => value && typeof value === 'object' ? value[key] : undefined, data)
const scalar = (value: unknown): value is string | boolean | number => typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
export function resolveConfigValues(catalog: { key: string; values: string[] }[], cliVersion: string, effective: Dict, legacy: Dict, subscription: string | undefined, sources: { source: string; settings: Dict }[] = [], env: Record<string, string | undefined> = {}): ClaudeConfigSnapshot {
  const pro = subscription?.toLowerCase().includes('pro')
  const flag = (key: string, fallback: boolean): boolean => {
    const v = legacy.cachedGrowthBookFeatures?.[key]
    return typeof v === 'boolean' ? v : typeof v?.value === 'boolean' ? v.value : fallback
  }
  const items: ClaudeConfigItem[] = catalog.map(item => {
    const compatible = cliVersion === '2.1.301' || cliVersion === '2.1.299' && AUDITED_299_DEFAULTS.has(item.key)
    let value: unknown, settingPath: string | undefined, source: ClaudeConfigItem['source'] = 'unknown'
    const globalRule = LEGACY[item.key], rule = SETTINGS[item.key]
    if (globalRule) {
      const [key, fallback, modern] = globalRule; settingPath = modern ? key : undefined
      value = modern ? effective[key] ?? legacy[key] : legacy[key]
      if (value !== undefined) source = 'saved'
      else if (compatible) { value = fallback; source = 'default' }
      if (item.key === 'editor' && value === 'emacs') value = 'normal'
    } else if (rule) {
      settingPath = rule[0]; value = get(effective, settingPath)
      if (value !== undefined) source = 'saved'
      else if (compatible) { value = rule[1]; source = 'default' }
    } else if (item.key === 'model') {
      settingPath = 'model'; value = env.ANTHROPIC_MODEL ?? effective.model
      source = env.ANTHROPIC_MODEL ? 'environment' : value !== undefined ? 'saved' : 'unknown'
      if (value === undefined && compatible) { value = 'default'; source = 'default' }
    } else if (item.key === 'workflowSizeGuideline') {
      settingPath = 'workflowSizeGuideline'; value = effective.workflowSizeGuideline ?? legacy.workflowSizeGuideline
      if (value !== undefined) source = 'saved'
      else if (compatible && subscription) { value = pro ? 'small' : 'medium'; source = 'default' }
    } else if (item.key === 'workflows') {
      settingPath = effective.disableWorkflows === true ? 'disableWorkflows' : 'enableWorkflows'
      value = effective.disableWorkflows === true ? false : effective.enableWorkflows
      if (value !== undefined) source = 'saved'
      else if (compatible && subscription) {
        value = env.CLAUDE_CODE_WORKFLOWS === '0' || env.CLAUDE_CODE_WORKFLOWS === 'false' ? false : flag('tengu_workflows_enabled', true) && (env.CLAUDE_CODE_WORKFLOWS === '1' || env.CLAUDE_CODE_WORKFLOWS === 'true' || !pro)
        source = env.CLAUDE_CODE_WORKFLOWS ? 'environment' : 'default'
      }
    } else if (item.key === 'switchModelsOnFlag') {
      settingPath = 'switchModelsOnFlag'
      if (typeof effective.switchModelsOnFlag === 'boolean') { value = effective.switchModelsOnFlag ? 'Switch automatically' : 'Ask each time'; source = 'saved' }
      else if (compatible) { value = flag('tengu_jazzy_goblet', false) ? 'Not asked yet' : 'Switch automatically'; source = 'default' }
    } else if (item.key === 'remoteControl') {
      settingPath = 'remoteControlAtStartup'
      const projectFalse = sources.some(s => ['projectSettings', 'localSettings'].includes(s.source) && s.settings.remoteControlAtStartup === false)
      const trusted = [...sources].reverse().find(s => ['policySettings', 'flagSettings', 'userSettings'].includes(s.source) && typeof s.settings.remoteControlAtStartup === 'boolean')
      value = projectFalse ? false : trusted?.settings.remoteControlAtStartup ?? legacy.remoteControlAtStartup
      if (value !== undefined) source = 'saved'
      else if (compatible) { value = 'default'; source = 'default' }
    } else if (scalar(effective[item.key])) { settingPath = item.key; value = effective[item.key]; source = 'saved' }
    if (item.key === 'thinking' && env.MAX_THINKING_TOKENS && Number.isFinite(Number(env.MAX_THINKING_TOKENS))) { value = Number(env.MAX_THINKING_TOKENS) > 0; source = 'environment' }
    if (!scalar(value)) { value = null; source = 'unknown' }
    const managed = settingPath && sources.find(s => ['policySettings', 'managedSettings'].includes(s.source) && get(s.settings, settingPath!) !== undefined)
    return { ...item, value: value === null ? null : String(value), source, ...(managed ? { locked: '由组织策略管理' } : source === 'environment' ? { locked: '由环境变量控制' } : {}) }
  })
  return { items, cliVersion }
}
