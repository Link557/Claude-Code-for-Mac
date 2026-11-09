import { expect, it } from 'vitest'
import { resolveConfigValues } from '../src/main/claudeConfigValues'
const keys = ['autoCompact','editor','theme','language','permissionMode','workflows','workflowSizeGuideline','tips','copyFullResponse','remoteControl','switchModelsOnFlag']
const catalog = keys.map(key => ({ key, values: [] }))
const values = (snapshot: ReturnType<typeof resolveConfigValues>) => Object.fromEntries(snapshot.items.map(i => [i.key, i.value]))
it('uses verified CLI defaults only for the audited version', () => {
  expect(values(resolveConfigValues(catalog, '2.1.301', {}, {}, 'Claude Pro'))).toMatchObject({ autoCompact: 'true', editor: 'normal', theme: 'dark', language: 'default', permissionMode: 'default', workflows: 'false', workflowSizeGuideline: 'small', tips: 'true', copyFullResponse: 'false', remoteControl: 'default' })
  expect(resolveConfigValues(catalog, 'unknown', {}, {}, undefined).items.every(i => i.value === null)).toBe(true)
})
it('preserves explicit false and empty strings and prefers merged settings over legacy prefs', () => {
  expect(values(resolveConfigValues(catalog, '2.1.301', { autoCompactEnabled: false, language: '简体中文', permissions: { defaultMode: 'plan' }, spinnerTipsEnabled: false }, { autoCompactEnabled: true, theme: 'light', editorMode: 'vim' }, 'Claude Pro'))).toMatchObject({ autoCompact: 'false', language: '简体中文', permissionMode: 'plan', theme: 'light', editor: 'vim', tips: 'false' })
  expect(values(resolveConfigValues([{ key: 'language', values: [] }], '2.1.301', { language: '' }, {}, 'pro')).language).toBe('')
})
it('handles account-dependent defaults, managed policies and unknown new keys without leaking extra fields', () => {
  const result = resolveConfigValues([...catalog, { key: 'future', values: [] }], '2.1.301', { autoCompactEnabled: false, env: { SECRET: 'do-not-expose' } }, { cachedGrowthBookFeatures: { tengu_jazzy_goblet: true } }, 'max', [{ source: 'policySettings', settings: { autoCompactEnabled: false } }])
  expect(values(result)).toMatchObject({ workflows: 'true', workflowSizeGuideline: 'medium', switchModelsOnFlag: 'Not asked yet', future: null })
  expect(result.items.find(i => i.key === 'autoCompact')?.locked).toBeTruthy()
  expect(JSON.stringify(result)).not.toContain('do-not-expose')
})
it('repository settings may disable remote control but cannot enable it', () => {
  expect(values(resolveConfigValues(catalog, '2.1.301', { remoteControlAtStartup: true }, {}, 'pro', [{ source: 'projectSettings', settings: { remoteControlAtStartup: true } }])).remoteControl).toBe('default')
  expect(values(resolveConfigValues(catalog, '2.1.301', {}, { remoteControlAtStartup: true }, 'pro', [{ source: 'localSettings', settings: { remoteControlAtStartup: false } }])).remoteControl).toBe('false')
})

it('resolves audited visible defaults on installed native CLI 2.1.299, preserving explicit overrides', () => {
 const shown=['autoCompact','language','outputStyle','useAutoModeDuringPlan','workflowKeywordTriggerEnabled','worktreeBaseRef','workflowSizeGuideline','switchModelsOnFlag'].map(key=>({key,values:[]}))
 expect(values(resolveConfigValues(shown,'2.1.299',{}, {},'Claude Pro'))).toMatchObject({autoCompact:'true',language:'default',outputStyle:'default',useAutoModeDuringPlan:'true',workflowKeywordTriggerEnabled:'true',worktreeBaseRef:'fresh',workflowSizeGuideline:'small',switchModelsOnFlag:'Switch automatically'})
 expect(values(resolveConfigValues(shown,'2.1.299',{autoCompactEnabled:false,worktree:{baseRef:'head'}},{},'Claude Pro'))).toMatchObject({autoCompact:'false',worktreeBaseRef:'head'})
 expect(resolveConfigValues([{key:'future',values:[]}],'2.1.299',{}, {},undefined).items[0].value).toBeNull()
})
