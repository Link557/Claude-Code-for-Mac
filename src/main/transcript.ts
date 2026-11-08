// 把 SDK 消息（实时流或历史记录）整理成界面用的 UiMessage 列表。纯逻辑，不依赖 Electron。
import { randomUUID } from 'node:crypto'
import { SessionActivity, type ActivityState } from './sessionActivity'
import { sdkMessageSource, sdkOriginKind } from './sdkMessageSource'
import type { HumanSubmission } from './humanSubmissionRepository'
import type { TokenUsage, UiBlock, UiMessage } from '../shared/chat'

type ToolBlock = Extract<UiBlock, { kind: 'tool' }>
type Json = Record<string, unknown>

const MAX_RESULT = 20_000
/** 历史记录里的斜杠命令：<command-name>/model</command-name> … <command-args>sonnet</command-args> */
const COMMAND_NAME = /<command-name>\/?([^<]*)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/
/** 本地命令的输出（历史记录里存成用户消息） */
const COMMAND_OUTPUT = /^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/
/** 实时输入的斜杠命令 */
const TYPED_COMMAND = /^\/(\S+)\s*([\s\S]*)$/
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g
function resultText(content: unknown): string {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((c: Json) => (c.type === 'text' ? String(c.text) : `[${String(c.type)}]`)).join('\n')
        : ''
  return text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + '\n…（已截断）' : text
}

function toUsage(raw: unknown, prev?: TokenUsage): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return prev
  const u = raw as Json
  const n = (key: string, fallback = 0): number => (typeof u[key] === 'number' ? (u[key] as number) : fallback)
  const usage: TokenUsage = {
    input: n('input_tokens', prev?.input),
    output: n('output_tokens', prev?.output),
    cacheRead: n('cache_read_input_tokens', prev?.cacheRead),
    cacheWrite: n('cache_creation_input_tokens', prev?.cacheWrite)
  }
  const cacheTtl = toCacheTtl(u.cache_creation) ?? prev?.cacheTtl
  if (cacheTtl) usage.cacheTtl = cacheTtl
  return usage
}

/** usage.cache_creation 里哪一档有写入；两档都有时以 1 小时为准 */
function toCacheTtl(raw: unknown): TokenUsage['cacheTtl'] {
  if (!raw || typeof raw !== 'object') return undefined
  const c = raw as Json
  if (typeof c.ephemeral_1h_input_tokens === 'number' && c.ephemeral_1h_input_tokens > 0) return '1h'
  if (typeof c.ephemeral_5m_input_tokens === 'number' && c.ephemeral_5m_input_tokens > 0) return '5m'
}

function toBlock(raw: Json): UiBlock | null {
  if (raw.type === 'text') return { kind: 'text', text: String(raw.text ?? '') }
  if (raw.type === 'thinking') return { kind: 'thinking', text: String(raw.thinking ?? '') }
  if (raw.type === 'tool_use')
    return { kind: 'tool', id: String(raw.id), name: String(raw.name), input: (raw.input as Json) ?? {} }
  return null
}

export class Transcript {
  readonly activity: SessionActivity
  constructor(cwd?: string, savedActivity?: ActivityState, submissions: HumanSubmission[] = []) {
    this.activity = new SessionActivity(cwd, savedActivity)
    this.submissions = new Map(submissions.map(s => [s.uuid, s]))
  }
  private submissions: Map<string, HumanSubmission>
  private seenUserEvents = new Set<string>()
  private seenChainEntries = new Set<string>()
  readonly messages: UiMessage[] = []
  private byId = new Map<string, UiMessage>()
  private streams = new Map<string | null, UiMessage>()
  private streamed = new Set<string>()
  private finalized = new Map<string, Set<number>>()
  private finalPositions = new Map<string, number[]>()
  private partialJson = new Map<ToolBlock, string>()
  private tools = new Map<string, ToolBlock>()
  private changed = new Set<UiMessage>()

  /** 取出自上次调用以来有变化的消息 */
  takeChanged(): UiMessage[] {
    const list = [...this.changed]
    this.changed.clear()
    return list
  }

  addUser(text: string, uuid: string = randomUUID(), time = Date.now()): string {
    this.submissions.set(uuid, { uuid, text, time })
    this.activity.reference(text)
    this.time = time
    this.addTyped(text, uuid)
    return uuid
  }

  /** 只复制分叉点之前实际出现的本应用提交，不把后面的输入带到新会话。 */
  humanSubmissions(): HumanSubmission[] {
    return [...this.submissions.values()].filter(s => this.byId.has(s.uuid))
  }

  private addTyped(text: string, uuid: string): void {
    if (this.byId.has(uuid)) return
    this.flushCommand()
    this.addUserMessage(text, uuid)
    const cmd = TYPED_COMMAND.exec(text.trim())
    this.pendingCommand = cmd ? { name: cmd[1], args: cmd[2].trim() } : null
  }

  /** 历史记录读完后调用：最后一条命令如果没有输出，也要显示出来 */
  finish(): void {
    this.flushCommand()
  }

  apply(raw: unknown, mode: 'live' | 'history' = 'history'): void {
    this.activity.apply(raw)
    const m = raw as Json
    const parent = (m.parent_tool_use_id as string | null) ?? null
    // 历史消息带时间戳；实时消息就用收到的时间
    this.time = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) || Date.now() : Date.now()
    if (m.type === 'stream_event') this.applyStream(m.event as Json, parent)
    else if (m.type === 'assistant') this.applyAssistant(m.message as Json, parent, m.uuid)
    else if (m.type === 'user') this.applyUser(m, parent, mode)
    // 主链上的条目（助手消息、用户消息、工具结果）：编辑之后的用户消息时从这里分叉
    if ((m.type === 'assistant' || m.type === 'user') && !parent && typeof m.uuid === 'string' && !this.seenChainEntries.has(m.uuid)) {
      this.lastUuid = m.uuid
      this.seenChainEntries.add(m.uuid)
    }
  }

  /** 用户消息：记下分叉点（它前面最后一个主链条目） */
  private addUserMessage(text: string, uuid: string): void {
    const msg = this.ensure(uuid, 'user', null)
    msg.uuid = uuid
    msg.source = 'human'
    msg.startsTurn = true
    msg.blocks.push({ kind: 'text', text })
    msg.forkFrom = this.lastUuid
  }

  private ensure(id: string, role: UiMessage['role'], parent: string | null): UiMessage {
    const scopedId = parent ? JSON.stringify([parent, id]) : id
    let msg = this.byId.get(scopedId)
    if (!msg) {
      msg = { id: scopedId, role, blocks: [], parentToolUseId: parent, time: this.time }
      this.byId.set(scopedId, msg)
      this.messages.push(msg)
    }
    this.changed.add(msg)
    return msg
  }

  /** 正在处理的消息的时间 */
  private time = Date.now()
  /** 最近一个主链条目的 uuid */
  private lastUuid: string | null = null
  /** 刚发出、还没等到输出的斜杠命令。本地命令的输出会紧跟着到来；模型处理的命令（技能等）则接着是正常回复 */
  private pendingCommand: { name: string; args: string } | null = null

  private addCommand(output: string | null): void {
    const { name, args } = this.pendingCommand ?? { name: '', args: '' }
    this.pendingCommand = null
    const text = output === null ? null : output.replace(ANSI, '').trim()
    this.ensure(randomUUID(), 'assistant', null).blocks.push({ kind: 'command', name, args, output: text })
  }

  /** 上一条命令没等到输出就有了新的用户消息：说明输出没有保存在记录里 */
  private flushCommand(): void {
    if (this.pendingCommand) this.addCommand(null)
  }

  private applyStream(e: Json, parent: string | null): void {
    if (e.type === 'message_start') {
      if (!parent) this.pendingCommand = null
      const msg = this.ensure(String((e.message as Json).id), 'assistant', parent)
      msg.usage = toUsage((e.message as Json).usage, msg.usage)
      this.streams.set(parent, msg)
      this.streamed.add(msg.id)
      return
    }
    const msg = this.streams.get(parent)
    if (!msg) return
    if (e.type === 'message_stop') { this.streams.delete(parent); return }
    this.changed.add(msg)
    // 流式结束前的 message_delta 带着最终的输出 token 数
    if (e.type === 'message_delta') msg.usage = toUsage(e.usage, msg.usage)
    const index = Number(e.index)
    if (!Number.isInteger(index) || index < 0) return
    if (e.type === 'content_block_start') {
      const block = toBlock(e.content_block as Json)
      if (!block) return
      if (msg.blocks[index]) return // 重放 start 不清空已经收到的增量
      if (block.kind === 'tool') this.tools.set(JSON.stringify([parent, block.id]), block)
      msg.blocks[index] = block
    } else if (e.type === 'content_block_delta') {
      if (this.finalized.get(msg.id)?.has(index)) return
      const block = msg.blocks[index]
      const d = e.delta as Json
      if (block?.kind === 'text' && d.type === 'text_delta') block.text += typeof d.text === 'string' ? d.text : ''
      else if (block?.kind === 'thinking' && d.type === 'thinking_delta') block.text += typeof d.thinking === 'string' ? d.thinking : ''
      else if (block?.kind === 'tool' && d.type === 'input_json_delta') {
        const json = (this.partialJson.get(block) ?? '') + String(d.partial_json)
        this.partialJson.set(block, json)
        try {
          block.input = JSON.parse(json)
        } catch {
          // 片段还不完整，等后续 delta
        }
      }
    }
  }

  private applyAssistant(message: Json, parent: string | null, uuid?: unknown): void {
    // 本地命令的输出是一条不经过模型的合成消息
    if (!parent && message.model === '<synthetic>' && this.pendingCommand) {
      const content = Array.isArray(message.content) ? (message.content as Json[]) : []
      return this.addCommand(content.map((c) => (c.type === 'text' ? String(c.text) : '')).join('\n'))
    }
    if (!parent) this.pendingCommand = null
    const msg = this.ensure(String(message.id ?? randomUUID()), 'assistant', parent)
    msg.usage = toUsage(message.usage, msg.usage)
    if (typeof uuid === 'string') msg.uuid = uuid
    const content = Array.isArray(message.content) ? (message.content as Json[]) : []
    const finalKey = typeof uuid === 'string' ? JSON.stringify([parent, uuid]) : null
    const positions = finalKey ? this.finalPositions.get(finalKey) : undefined
    const finalized = this.finalized.get(msg.id) ?? new Set<number>()
    const nextPositions: number[] = []
    content.forEach((raw, offset) => {
      const block = toBlock(raw)
      if (!block) return
      let index = positions?.[offset]
      if (index === undefined && content.length > 1) index = offset
      if (index === undefined && block.kind === 'tool') {
        const match = msg.blocks.findIndex((existing) => existing?.kind === 'tool' && existing.id === block.id)
        if (match >= 0) index = match
      }
      if (index === undefined && this.streamed.has(msg.id)) {
        // SDK 逐块发送 assistant 完整消息，按同类尚未确认的流式槽位回填。
        const match = msg.blocks.findIndex((existing, i) => existing?.kind === block.kind && !finalized.has(i))
        if (match >= 0) index = match
      }
      if (index === undefined) {
        const match = !finalKey || this.streamed.has(msg.id) ? msg.blocks.findIndex((existing) => JSON.stringify(existing) === JSON.stringify(block)) : -1
        index = match >= 0 ? match : msg.blocks.length
      }
      const previous = msg.blocks[index]
      // 空的最终摘要不能抹掉此前公开返回的正文。
      if ((block.kind === 'thinking' || block.kind === 'text') && !block.text && previous?.kind === block.kind) block.text = previous.text
      if (block.kind === 'tool') {
        const key = JSON.stringify([parent, block.id])
        const existing = this.tools.get(key)
        if (existing?.result) block.result = existing.result
        this.tools.set(key, block)
      }
      msg.blocks[index] = block
      finalized.add(index)
      nextPositions[offset] = index
    })
    this.finalized.set(msg.id, finalized)
    if (finalKey) this.finalPositions.set(finalKey, nextPositions)
  }

  private applyUser(raw: Json, parent: string | null, mode: 'live' | 'history'): void {
    const content = (raw.message as Json)?.content
    const texts: string[] = []
    if (typeof content === 'string') texts.push(content)
    else if (Array.isArray(content)) {
      // 工具结果独立处理，不因来源判断或消息去重而丢掉结果。
      for (const c of content as Json[]) {
        if (c.type === 'tool_result') {
          const tool = this.tools.get(JSON.stringify([parent, String(c.tool_use_id)]))
          if (!tool) continue
          tool.result = { text: resultText(c.content), isError: c.is_error === true }
          for (const msg of this.messages) if (msg.blocks.includes(tool)) this.changed.add(msg)
        } else if (c.type === 'text' && typeof c.text === 'string') texts.push(c.text)
      }
    }
    if (parent) {
      if (texts.length) {
        const msg = this.ensure(String(raw.uuid ?? randomUUID()), 'user', parent)
        msg.source = 'internal'
        msg.blocks = [{ kind: 'text', text: texts.join('\n') }]
        if (typeof raw.uuid === 'string') msg.uuid = raw.uuid
      }
      return
    }
    const uuid = typeof raw.uuid === 'string' ? raw.uuid : randomUUID()
    const submitted = this.submissions.get(uuid)
    if (this.seenUserEvents.has(uuid)) return
    this.seenUserEvents.add(uuid)
    // 本地提交原文优先于回声正文，包括 CLI 添加的包装标签。
    const source = submitted ? 'human' : sdkMessageSource(raw)
    const text = submitted?.text ?? texts.join('\n')
    if (!text) return
    if (source === 'human') {
      if (submitted) this.time = submitted.time
      this.addTyped(text, uuid)
      return
    }
    // 只有已确认的内部消息才解释内部文本格式。未知来源始终原样保留。
    if (source === 'internal' && raw.isCompactSummary !== true) {
      const output = COMMAND_OUTPUT.exec(text.trim())
      if (output) { this.addCommand(output[2]); return }
      const command = COMMAND_NAME.exec(text)
      if (command) {
        this.flushCommand()
        this.pendingCommand = { name: command[1], args: COMMAND_ARGS.exec(text)?.[1].trim() ?? '' }
      }
    }
    const msg = this.ensure(uuid, 'notice', null)
    msg.uuid = uuid
    msg.source = source
    if (source === 'internal') {
      msg.internalKind = raw.isCompactSummary === true ? 'compact'
        : COMMAND_NAME.test(text) ? 'command'
        : raw.isSynthetic === true || raw.is_error === true || raw.error != null ? 'notification'
        : raw.isMeta === true || raw.is_meta === true || raw.isVisibleInTranscriptOnly === true ? 'technical'
        : 'notification'
    }
    msg.originKind = sdkOriginKind(raw)
    // 未知旧历史保留推定分组；实时未知事件不凭空开启真人轮次。
    msg.startsTurn = source === 'unknown' && mode === 'history'
    msg.blocks = [{ kind: 'text', text }]
  }
}
