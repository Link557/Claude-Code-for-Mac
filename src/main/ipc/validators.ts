// 渲染进程传来的参数在这里校验；每个通道都必须有一项，参数类型和契约不一致时编译失败。
import { z } from 'zod'
import type { ArgsOf, InvokeChannel } from '../../shared/ipc/contract'
import type { SessionOptions } from '../../shared/chat'
import type { ScheduledTaskInput } from '../../shared/schedules'
import type { Settings } from '../../shared/types'
import type { RuleChange } from '../../shared/sessionControl'

export type Validator<A extends unknown[]> = (raw: unknown[]) => A
/** 对象的每个字段都要有 schema；类型新增字段而这里没跟上时编译失败，避免被 zod 悄悄剥掉 */
type Shape<T> = { [K in keyof T]-?: z.ZodType<T[K]> }

const messages = new WeakMap<z.ZodType, string>()

/** 给参数起名；校验失败时提示「参数 name 无效」或指定的文案 */
function arg<T extends z.ZodType>(name: string, schema: T, message = `参数 ${name} 无效`): T {
  messages.set(schema, message)
  return schema
}

function args<S extends z.ZodType[]>(...schemas: S): Validator<{ [K in keyof S]: z.output<S[K]> }> {
  return (raw) => schemas.map((schema, index) => {
    const result = schema.safeParse(raw[index])
    if (!result.success) throw new Error(messages.get(schema) ?? '参数无效')
    return result.data
  }) as { [K in keyof S]: z.output<S[K]> }
}

const text = (name: string, message?: string) => arg(name, z.string().min(1), message)
const switchValue = (name: string) => arg(name, z.boolean(), '无效开关值')
/** 只有 true 算开启，其余一律按关闭处理 */
const looseFlag = (name: string) => arg(name, z.unknown().transform(value => value === true))
/** 缺省、空串或非字符串都视为未提供 */
const optionalText = (name: string) => arg(name, z.unknown().transform(value => typeof value === 'string' && value !== '' ? value : undefined))
const nullableText = (name: string) => arg(name, z.unknown().transform(value => typeof value === 'string' && value !== '' ? value : null))
/** 尺寸类数值由处理函数自己判断是否有效，无效时静默忽略 */
const looseNumber = z.custom<number>(value => typeof value === 'number')

const pageId = arg('id', z.string().regex(/^page:[\w-]+$/), '页面标识无效')
const permissionMode = z.enum(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
const effortLevel = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])

const sessionOptions = () => arg('options', z.object({
  model: z.string().nullable(),
  mode: permissionMode,
  effort: effortLevel.nullable(),
  ultracode: z.boolean().optional(),
  workflows: z.boolean().optional(),
  fastMode: z.boolean().optional()
} satisfies Shape<SessionOptions>))

const queueAction = arg('action', z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), id: z.string(), targetId: z.string(), position: z.enum(['before', 'after']) }),
  z.object({ type: z.literal('edit'), id: z.string(), text: z.string(), attachments: z.array(z.string()).optional() }),
  z.object({ type: z.enum(['insert', 'delete', 'forget', 'beginEdit', 'cancelEdit']), id: z.string() }),
  z.object({ type: z.enum(['pause', 'resume', 'clear']) })
]))

const decision = arg('decision', z.discriminatedUnion('type', [
  z.object({ type: z.literal('allow') }),
  z.object({ type: z.literal('allowAlways') }),
  z.object({ type: z.literal('deny'), message: z.string().optional() }),
  z.object({ type: z.literal('answers'), answers: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal('planApprove'), mode: permissionMode }),
  z.object({ type: z.literal('planRevise'), feedback: z.string() })
]))

const settingsPatch = arg('patch', z.object({
  displayName: z.string().trim().min(1).max(20).regex(/^[^\p{Cc}\p{Cf}]+$/u).nullable(),
  retainedSessions: z.number().int().min(1).max(16),
  sessionIdleMinutes: z.number().int().min(1).max(120),
  theme: z.enum(['system', 'light', 'dark']),
  defaultModel: z.string(),
  defaultPermissionMode: permissionMode,
  defaultEffort: effortLevel.nullable(),
  claudePath: z.string().nullable(),
  allowBypass: z.boolean(),
  autoScroll: z.boolean(),
  reduceMotion: z.boolean(),
  executionLanguage: z.enum(['zh', 'en']),
  notifyCompletion: z.boolean(),
  notifyApproval: z.boolean(),
  notificationSound: z.boolean()
} satisfies Shape<Settings>).partial())

const scheduledTask = () => arg('task', z.object({
  name: z.string(),
  projectPath: z.string(),
  prompt: z.string(),
  schedule: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('interval'), minutes: z.number() }),
    z.object({ kind: z.literal('daily'), time: z.string() }),
    z.object({ kind: z.literal('weekly'), days: z.array(z.number()), time: z.string() }),
    z.object({ kind: z.literal('cron'), expression: z.string() })
  ]),
  mode: permissionMode,
  enabled: z.boolean()
} satisfies Shape<ScheduledTaskInput>))

const nullableModel = () => arg('model', z.string().nullish().transform(value => value ?? null))

export const validators: { [C in InvokeChannel]: Validator<ArgsOf<C>> } = {
  'files:diff': args(text('path'), arg('source', z.enum(['working', 'branch']))),
  'usage:overview': args(),
  'usage:stats': args(looseFlag('refresh')),
  'usage:saveProfile': args(text('accountKey'), arg('profile', z.object({ name: z.string(), avatar: z.string().nullable() }))),

  'workspace:closePage': args(pageId),
  'terminal:open': args(pageId, arg('cwd', z.string(), '项目文件夹不存在')),
  'terminal:write': args(pageId, arg('data', z.string().max(1_000_000), '终端输入无效')),
  'terminal:resize': args(pageId, looseNumber, looseNumber),
  'terminal:close': args(pageId),
  'browser:open': args(pageId),
  'browser:navigate': args(pageId, arg('url', z.string())),
  'browser:bounds': args(pageId, arg('bounds', z.object({ x: looseNumber, y: looseNumber, width: looseNumber, height: looseNumber }).nullable())),
  'browser:action': args(pageId, arg('action', z.enum(['back', 'forward', 'reload', 'stop']))),
  'browser:close': args(pageId),

  'app:notify': args(
    text('title'),
    arg('body', z.unknown().transform(value => typeof value === 'string' ? value : '')),
    looseFlag('silent'),
    optionalText('sessionId')
  ),
  'app:setDockBadge': args(arg('count', z.number().int().min(0), '无效未读数量')),
  'app:openNotificationSettings': args(),
  'app:state': args(),
  'app:splashFinished': args(),
  'app:focus': args(),
  'connection:status': args(optionalText('path')),
  'connection:pickExecutable': args(),
  'connection:login': args(),
  'connection:installationHelp': args(),

  'projects:list': args(),
  'projects:pickFolder': args(),
  'projects:add': args(text('path')),
  'projects:remove': args(text('id')),
  'projects:setCollapsed': args(text('id'), looseFlag('collapsed')),
  'projects:detectFromHistory': args(),
  'projects:markSeeded': args(),
  'projects:revealInFinder': args(text('path')),

  'sessions:list': args(text('path')),
  'sessions:rename': args(text('id'), text('title'), text('path')),
  'sessions:setArchived': args(text('id'), looseFlag('archived')),

  'settings:get': args(),
  'settings:set': args(settingsPatch),

  'skills:list': args(nullableText('path')),
  'skills:read': args(text('path')),
  'skills:setPluginEnabled': args(text('id'), looseFlag('enabled')),

  'schedules:list': args(),
  'schedules:create': args(scheduledTask()),
  'schedules:update': args(text('id'), scheduledTask()),
  'schedules:setEnabled': args(text('id'), looseFlag('enabled')),
  'schedules:remove': args(text('id')),
  'schedules:runNow': args(text('id')),

  'meta:get': args(optionalText('path')),
  'meta:cachedModels': args(optionalText('path')),
  'meta:commands': args(text('path'), looseFlag('force')),
  'meta:usage': args(),
  'meta:config': args(text('path'), optionalText('setting')),
  'meta:configSnapshot': args(text('path')),

  'files:saveImage': args(arg('bytes', z.instanceof(Uint8Array), '图片格式不支持或超过 25 MB'), arg('mime', z.string(), '图片格式不支持或超过 25 MB')),
  'files:describe': args(arg('paths', z.array(z.string().min(1)))),
  'files:search': args(text('path'), arg('query', z.unknown().transform(value => typeof value === 'string' ? value : ''))),
  'files:list': args(text('projectPath'), text('directory')),
  'files:create': args(text('projectPath'), text('directory'), arg('kind', z.enum(['file', 'dir'])), text('name')),
  'files:open': args(text('path')),
  'files:contextMenu': args(text('path'), arg('kind', z.enum(['file', 'dir']))),
  'files:read': args(text('path')),
  'files:watch': args(text('path')),
  'files:unwatch': args(text('path')),
  'files:stat': args(arg('paths', z.unknown().transform(value => Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string') : []))),

  'chat:open': args(text('id'), text('path')),
  'chat:start': args(text('path'), text('text'), sessionOptions()),
  'chat:send': args(text('id'), text('path'), text('text'), sessionOptions(), arg('attachment', z.array(z.string().min(1)).nullish().transform(value => value ?? []))),
  'chat:edit': args(text('id'), text('path'), text('messageId'), text('text')),
  'chat:queue': args(text('id'), text('path'), queueAction),
  'chat:interrupt': args(text('id')),
  'chat:setMode': args(text('id'), arg('mode', permissionMode)),
  'chat:setModel': args(text('id'), nullableModel()),
  'chat:rules': args(text('id'), text('path')),
  'chat:changeRule': args(text('id'), text('path'), arg('change', z.object({
    source: z.enum(['userSettings', 'projectSettings', 'localSettings']),
    behavior: z.enum(['allow', 'ask', 'deny']), rule: z.string().min(1).refine(value => Boolean(value.trim()) && !/[\r\n\0]/.test(value)), remove: z.boolean().optional()
  } satisfies Shape<RuleChange>))),
  'chat:applySetting': args(text('id'), text('path'), arg('key', z.enum(['outputStyle', 'language', 'thinking'])), text('value')),
  'chat:reloadConfiguration': args(text('id'), text('path')),
  'chat:taskOutput': args(text('id'), text('path'), text('taskId')),
  'chat:stopTask': args(text('id'), text('path'), text('taskId')),
  'chat:rewindPreview': args(text('id'), text('path'), text('target')),
  'chat:rewindFiles': args(text('id'), text('path'), text('target')),
  'chat:restoreConversation': args(text('id'), text('path'), text('messageId')),
  'chat:setWorkflows': args(text('id'), switchValue('workflows')),
  'chat:prepareControls': args(text('id'), text('path')),
  'chat:setFastMode': args(text('id'), switchValue('fastMode')),
  'chat:setUltracode': args(text('id'), switchValue('ultracode')),
  'chat:refreshRuntime': args(text('id')),
  'chat:setEffort': args(text('id'), arg('effort', effortLevel.nullish().transform(value => value ?? null))),
  'chat:respond': args(text('id'), text('requestId'), decision),
  'chat:checkExternal': args(text('id'), text('path')),
  'chat:handoffToCli': args(text('id'), text('path')),
  'chat:reload': args(text('id'), text('path')),
  'chat:context': args(text('id'), text('path'), nullableModel()),
  'chat:mcp': args(nullableText('id'), text('path')),
  'chat:mcpAction': args(text('path'), arg('operation', z.enum(['enable', 'disable', 'reconnect']), '无效的 MCP 操作'), text('name')),
  'chat:btw': args(
    text('id'), text('path'), text('question'),
    arg('history', z.array(z.object({ question: z.string(), response: z.string() })).nullish().transform(value => value ?? [])),
    sessionOptions()
  )
}
