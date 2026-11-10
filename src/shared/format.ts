import type { DetectedFolder, EffortLevel, PermissionMode } from './types'

const DAY = 86_400_000

export function relativeTimeZh(ts: number, now = Date.now()): string {
  const minutes = Math.floor((now - ts) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const n = new Date(now)
  const startOfToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
  if (ts >= startOfToday) return `${Math.floor(minutes / 60)} 小时前`
  if (ts >= startOfToday - DAY) return '昨天'
  const days = Math.floor((startOfToday - ts) / DAY) + 1
  if (days < 7) return `${days} 天前`
  const d = new Date(ts)
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

const MAX_TITLE = 80

/** Composer prepends one file reference per line; prefer the task over those paths. */
export function promptTitle(prompt: string): string {
  let remaining = prompt.trim()
  const paths: string[] = []
  while (remaining) {
    const match = /^@("(?:[^"\\]|\\.)*"|\S+)(?:\s+|$)/.exec(remaining)
    if (!match) break
    let path = match[1]
    if (path.startsWith('"')) { try { path = JSON.parse(path) as string } catch { /* preserve the reference */ } }
    // CLI flattening makes arbitrary bare @mentions indistinguishable from
    // extensionless paths, so only recognize these common filenames here.
    if (!/[\\/]/.test(path) && !/\.[a-zA-Z][a-zA-Z0-9]{0,10}$/.test(path) && !/^(?:Dockerfile|Makefile)$/i.test(path)) break
    paths.push(path.split(/[\\/]/).filter(Boolean).at(-1) ?? path)
    remaining = remaining.slice(match[0].length).trimStart()
  }
  return remaining.trim() || paths.join('、')
}

export function sessionTitle(info: { customTitle?: string; summary?: string; firstPrompt?: string }): string {
  const normalized = (s?: string): string => s?.replace(/\s+/g, ' ').trim() ?? ''
  // SDK uses the flattened first prompt as its summary until a title exists.
  const summary = normalized(info.summary) === normalized(info.firstPrompt) ? undefined : info.summary
  for (const raw of [info.customTitle, summary, info.firstPrompt && promptTitle(info.firstPrompt)]) {
    const text = raw?.replace(/\s+/g, ' ').trim()
    if (text) return text.length > MAX_TITLE ? text.slice(0, MAX_TITLE) + '…' : text
  }
  return '未命名会话'
}

/** 从历史会话的 cwd 里找出可以导入为项目的文件夹 */
export function detectFolders(
  sessions: { cwd?: string }[],
  home: string,
  exists: (path: string) => boolean
): DetectedFolder[] {
  const ignored = [`${home}/.claude`, '/tmp', '/private/tmp', '/private/var/folders', '/var/folders']
  const counts = new Map<string, number>()
  for (const { cwd } of sessions) {
    if (!cwd || ignored.some((p) => cwd === p || cwd.startsWith(p + '/'))) continue
    counts.set(cwd, (counts.get(cwd) ?? 0) + 1)
  }
  return [...counts]
    .filter(([path]) => exists(path))
    .map(([path, sessionCount]) => ({ path, sessionCount }))
    .sort((a, b) => b.sessionCount - a.sessionCount)
}

export const PERMISSION_MODES: { value: PermissionMode; label: string; description: string }[] = [
  { value: 'default', label: '默认', description: '每次修改文件或运行命令前询问' },
  { value: 'acceptEdits', label: '自动接受编辑', description: '文件修改自动通过，命令仍需确认' },
  { value: 'plan', label: '计划模式', description: '先制定计划，确认后再动手' },
  { value: 'auto', label: '自动', description: '由模型审核风险，安全的操作自动执行' },
  { value: 'bypassPermissions', label: '跳过所有权限', description: '危险：所有操作都不再询问' }
]

export const EFFORT_LEVELS: { value: EffortLevel; label: string; description: string }[] = [
  { value: 'low', label: '低', description: '回答更快，适合简单任务' },
  { value: 'medium', label: '中', description: '速度和质量兼顾' },
  { value: 'high', label: '高', description: '更深入地思考' },
  { value: 'xhigh', label: '超高', description: '适合复杂问题，耗时更长' },
  { value: 'max', label: '最高', description: '最难的问题，最慢、用量最多' }
]

/** 把路径里的用户主目录缩写成 ~ */
export function shortenPath(path: string, home: string): string {
  return path === home || path.startsWith(home + '/') ? '~' + path.slice(home.length) : path
}

const TOOL_NAMES: Record<string, string> = {
  Bash: '运行命令',
  Read: '读取文件',
  Edit: '编辑文件',
  MultiEdit: '编辑文件',
  Write: '写入文件',
  Glob: '查找文件',
  Grep: '搜索内容',
  WebFetch: '获取网页',
  WebSearch: '网络搜索',
  Task: '子代理',
  Agent: '子代理',
  TodoWrite: '更新待办',
  NotebookEdit: '编辑笔记本',
  Skill: '使用技能',
  AskUserQuestion: '提问',
  ExitPlanMode: '提交计划',
  ToolSearch: '加载工具'
}

export function toolNameZh(name: string): string {
  if (name.startsWith('mcp__')) return 'MCP · ' + name.slice(5).split('__').join(' · ')
  return TOOL_NAMES[name] ?? name
}

/** 工具调用的一行摘要；项目文件夹内的路径显示为相对路径 */
export function toolSummary(name: string, input: Record<string, unknown>, cwd?: string): string {
  const pick = (...keys: string[]): string => {
    for (const k of keys) if (typeof input[k] === 'string' && input[k]) return input[k] as string
    return ''
  }
  if (name === 'Bash') return pick('description', 'command')
  if (name === 'Task' || name === 'Agent') return pick('description')
  const value = pick('file_path', 'notebook_path', 'pattern', 'query', 'url', 'skill', 'path')
  return cwd && value.startsWith(cwd + '/') ? value.slice(cwd.length + 1) : value
}

export interface Trigger {
  kind: '/' | '@'
  /** 触发符号所在位置 */
  start: number
  query: string
}

/** 光标前是否正在输入斜杠命令（只在开头）或 @ 文件引用（开头或空白之后） */
export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret)
  const cmd = /^\/(\S*)$/.exec(before)
  if (cmd) return { kind: '/', start: 0, query: cmd[1] }
  const at = /(?:^|\s)@(\S*)$/.exec(before)
  if (at) return { kind: '@', start: caret - at[1].length - 1, query: at[1] }
  return null
}

/** token 数：一万以下带千分位，以上用「万」 */
export function formatTokens(n: number): string {
  if (n < 10_000) return n.toLocaleString('en-US')
  return `${Number((n / 10_000).toFixed(1))} 万`
}

const CONTEXT_PARTS: Record<string, string> = {
  'System prompt': '系统提示词',
  'System tools': '系统工具',
  'MCP tools': 'MCP 工具',
  'Custom agents': '自定义子代理',
  'Memory files': '记忆文件（CLAUDE.md）',
  Skills: '技能',
  Messages: '对话消息'
}

export function contextPartZh(name: string): string {
  return CONTEXT_PARTS[name] ?? name
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/** 用量窗口的重置时间：一天内说「还有多久」，更远的说日期 */
export function resetTimeZh(iso: string | null, now = Date.now()): string {
  if (!iso) return ''
  const at = new Date(iso)
  const mins = Math.round((at.getTime() - now) / 60_000)
  if (mins <= 0) return '即将重置'
  if (mins < 60) return `${mins} 分钟后重置`
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return `${h} 小时${m ? ` ${m} 分钟` : ''}后重置`
  }
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  return `${at.getMonth() + 1}月${at.getDate()}日（周${WEEKDAYS[at.getDay()]}）${hh}:${mm} 重置`
}

/** 文件大小：B / KB / MB */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 时长：45 秒、3 分 12 秒、1 小时 5 分 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60
  if (h) return `${h} 小时${m ? ` ${m} 分` : ''}`
  if (m) return `${m} 分${s ? ` ${s} 秒` : ''}`
  return `${s} 秒`
}

/** 消息时间：今天的只显示时分，更早的带上日期 */
export function formatClock(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const today = new Date(now)
  if (d.toDateString() === today.toDateString()) return hm
  const year = d.getFullYear() === today.getFullYear() ? '' : `${d.getFullYear()}年`
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

/** Markdown 转纯文本（复制为纯文本、朗读用）：去掉标记，保留文字和换行 */
export function markdownToPlain(md: string): string {
  return md
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1') // 代码块只留代码
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*(\n|$)/gm, '') // 表格分隔行
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) => row.split('|').map((c) => c.trim()).join('\t'))
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
