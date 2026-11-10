import type { TokenUsage } from './chat'
import type { PlanUsage } from './types'

export const USAGE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const
export type UsageModel = typeof USAGE_MODELS[number]
export type UsageModelFilter = 'total' | UsageModel
export interface DailyUsage extends TokenUsage {
  date: string
  total: number
  byModel?: Partial<Record<UsageModel, TokenUsage>>
}
export function usageModel(model: unknown): UsageModel | null {
  if (typeof model !== 'string') return null
  return USAGE_MODELS.find(name => new RegExp(`(?:^|[^a-z])${name}(?:$|[^a-z])`, 'i').test(model)) ?? null
}
export interface UsageAnalytics {
  days: DailyUsage[]
  total: number
  peak: number
  longestTaskMs: number | null
  longestStreak: number
  currentStreak: number
  updatedAt: number | null
  firstDate: string | null
  issues: number
  scanning: boolean
  error?: string
}
export interface UsageProfile { name: string; avatar: string | null }
export interface UsageAccount { key: string; email: string | null; organization: string | null; subscriptionType: string | null }
export interface UsageOverview { account: UsageAccount; profile: UsageProfile; usage: PlanUsage | null; usageError?: string; updatedAt: number }
export const EMPTY_ANALYTICS: UsageAnalytics = { days: [], total: 0, peak: 0, longestTaskMs: null, longestStreak: 0, currentStreak: 0, updatedAt: null, firstDate: null, issues: 0, scanning: false }
export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function parseDay(key: string): Date { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d, 12) }
export function shiftDay(key: string, amount: number): string { const d = parseDay(key); d.setDate(d.getDate() + amount); return dateKey(d) }
export function dayRange(start: string, end: string): string[] {
  const dates: string[] = []
  for (let day = start; day <= end; day = shiftDay(day, 1)) dates.push(day)
  return dates
}
export function streaks(days: DailyUsage[], today: string): { longestStreak: number; currentStreak: number } {
  const active = new Set(days.filter(d => d.total > 0 && d.date <= today).map(d => d.date))
  let longestStreak = 0, run = 0, previous = ''
  for (const date of [...active].sort()) { run = previous && shiftDay(previous, 1) === date ? run + 1 : 1; longestStreak = Math.max(run, longestStreak); previous = date }
  let currentStreak = 0, cursor = active.has(today) ? today : shiftDay(today, -1)
  while (active.has(cursor)) { currentStreak++; cursor = shiftDay(cursor, -1) }
  return { longestStreak, currentStreak }
}
export interface ChartDay { date: string; total: number; cumulative: number; usage?: DailyUsage }
export function chartDays(days: DailyUsage[], start: string, end: string): ChartDay[] {
  const byDay = new Map(days.map(d => [d.date, d]))
  let cumulative = days.filter(d => d.date < start).reduce((sum, d) => sum + d.total, 0)
  return dayRange(start, end).map(date => { const usage = byDay.get(date), total = usage?.total ?? 0; cumulative += total; return { date, total, cumulative, usage } })
}
export function chartWeeks(days: ChartDay[]): { start: string; end: string; total: number; partial: boolean }[] {
  const weeks: { start: string; end: string; total: number; partial: boolean }[] = []
  for (const day of days) {
    const weekday = (parseDay(day.date).getDay() + 6) % 7
    const monday = shiftDay(day.date, -weekday)
    let week = weeks.at(-1)
    if (!week || shiftDay(week.start, -((parseDay(week.start).getDay() + 6) % 7)) !== monday) {
      week = { start: day.date, end: day.date, total: 0, partial: false }; weeks.push(week)
    }
    week.end = day.date; week.total += day.total
  }
  for (const week of weeks) week.partial = parseDay(week.start).getDay() !== 1 || parseDay(week.end).getDay() !== 0
  return weeks
}
export function remaining(percent: number): number { return Math.round(Math.min(100, Math.max(0, 100 - percent))) }

export function formatUsageTokens(n: number): string {
  if (n >= 100_000_000) return `${Number((n / 100_000_000).toFixed(1))} 亿`
  if (n >= 10_000) return `${Number((n / 10_000).toFixed(1))} 万`
  return n.toLocaleString('zh-CN')
}

/** Aggregate raw counters first so cache hit rate is token-weighted. */
export function usageInRange(days: DailyUsage[], start?: string, end?: string, model: UsageModelFilter = 'total') {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const day of days) {
    if (start && day.date < start || end && day.date > end) continue
    const counters = model === 'total' ? day : day.byModel?.[model]
    if (!counters) continue
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) usage[key] += counters[key]
  }
  const input = usage.input + usage.cacheRead + usage.cacheWrite
  return { ...usage, total: input + usage.output, hitRate: input ? Math.round(usage.cacheRead / input * 1000) / 10 : null }
}
