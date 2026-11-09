import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { UiMessage } from '@shared/chat'

function excerpt(messages: UiMessage[], role: 'user' | 'assistant'): string {
  let connectionInterrupted = false
  for (const message of messages) {
    if (message.role !== role || message.parentToolUseId) continue
    for (const block of message.blocks) {
      if (block?.kind !== 'text') continue
      const text = block.text.trim()
      if (role === 'assistant' && /^API Error:\s*Connection dropped \(ECONNRESET\)$/i.test(text)) {
        connectionInterrupted = true
        continue
      }
      if (text) return text.slice(0, 480).replace(/\s+/g, ' ')
    }
  }
  return connectionInterrupted ? '连接中断' : ''
}

export function ChatHistoryRail({ turns, activeIndex, onJump }: { turns: UiMessage[][]; activeIndex: number; onJump(index: number): void }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const [focused, setFocused] = useState<number | null>(null)
  const [settled, setSettled] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [previewTop, setPreviewTop] = useState(0)
  const rail = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()
  const validFocused = focused !== null && focused < turns.length ? focused : null
  const validHovered = hovered !== null && hovered < turns.length ? hovered : null
  const selected = validHovered ?? validFocused
  const previewIndex = !dismissed && (selected === validFocused || selected === settled) ? selected : null
  const turn = previewIndex === null ? undefined : turns[previewIndex]

  useEffect(() => {
    if (hovered === null) return
    const timer = window.setTimeout(() => setSettled(hovered), 180)
    return () => window.clearTimeout(timer)
  }, [hovered])

  useLayoutEffect(() => {
    const strip = list.current
    const dot = strip?.children[activeIndex] as HTMLElement | undefined
    if (!strip || !dot || selected !== null) return
    if (dot.offsetTop < strip.scrollTop || dot.offsetTop + dot.offsetHeight > strip.scrollTop + strip.clientHeight) {
      strip.scrollTop = dot.offsetTop - (strip.clientHeight - dot.offsetHeight) / 2
    }
  }, [activeIndex, selected, turns.length])

  const positionPreview = useCallback(() => {
    if (previewIndex === null || !rail.current) return
    const dot = list.current?.children[previewIndex]?.getBoundingClientRect()
    if (dot) setPreviewTop(dot.top + dot.height / 2 - rail.current.getBoundingClientRect().top)
  }, [previewIndex])
  useLayoutEffect(positionPreview, [positionPreview])

  const userText = turn && excerpt(turn, 'user')
  const answer = turn && excerpt([...turn].reverse(), 'assistant')
  return (
    <nav ref={rail} className="chat-history-rail" aria-label="聊天记录定位" onMouseLeave={() => { setHovered(null); setSettled(null) }}>
      <div ref={list} className="chat-history-strip" onScroll={positionPreview}>
        {turns.map((messages, index) => (
          <button
            key={messages[0]!.id}
            type="button"
            className="chat-history-dot"
            aria-label={`跳到第 ${index + 1} 轮`}
            aria-current={activeIndex === index ? 'location' : undefined}
            aria-describedby={previewIndex === index ? id : undefined}
            tabIndex={index === (validFocused ?? Math.min(activeIndex, turns.length - 1)) ? 0 : -1}
            data-distance={selected === null ? undefined : Math.abs(selected - index)}
            onMouseEnter={() => { setHovered(index); setSettled(null); setDismissed(false) }}
            onFocus={() => { setFocused(index); setDismissed(false) }}
            onBlur={() => setFocused(null)}
            onClick={() => { setDismissed(true); onJump(index) }}
            onKeyDown={event => {
              if (event.key === 'Escape') { setDismissed(true); return }
              const next = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1
                : event.key === 'Home' ? 0 : event.key === 'End' ? turns.length - 1 : null
              if (next === null) return
              event.preventDefault()
              const target = list.current?.children[next] as HTMLButtonElement | undefined
              target?.focus()
            }}
          ><span /></button>
        ))}
      </div>
      {turn && (
        <div id={id} role="tooltip" className="chat-history-preview chat-navigation-glass" style={{ top: `clamp(56px, ${previewTop}px, calc(100% - 56px))` }}>
          <div className="truncate font-medium">{userText || '这轮没有文字输入'}</div>
          <div className="mt-1 line-clamp-3 text-fg2">{answer || '暂无文字回复'}</div>
        </div>
      )}
    </nav>
  )
}

export function JumpToLatest({ working, status, activityTextRef, onJump }: { working: boolean; status?: string; activityTextRef: RefObject<string>; onJump(): void }) {
  const [hint, setHint] = useState<string | null>(null)
  const id = useId()
  const label = '回到最新消息'
  const snapshot = (): void => {
    const text = working ? activityTextRef.current : ''
    setHint(previous => previous ?? text)
  }
  useEffect(() => {
    if (working && hint === '') setHint(activityTextRef.current)
  }, [activityTextRef, hint, working])
  const activityHint = status ?? (working ? hint : null)
  return (
    <div className="chat-jump-latest" onMouseEnter={snapshot} onMouseLeave={() => setHint(null)}>
      <button
        type="button"
        className="chat-jump-button chat-navigation-glass"
        data-busy={working || !!status}
        data-working={working}
        aria-label={label}
        aria-describedby={hint === null ? undefined : id}
        onFocus={snapshot}
        onBlur={() => setHint(null)}
        onKeyDown={event => { if (event.key === 'Escape') setHint(null) }}
        onClick={onJump}
      >
        {working || status ? (
          <span className="chat-jump-dots" aria-hidden="true"><i /><i /><i /></span>
        ) : (
          <svg width="19" height="19" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M9.7 3.3c.5 4.1.2 8.1.3 12.6m-5-5.2c1.9 1.4 3.3 3.2 5 5.2 1.7-2 3.6-3.7 5.4-5.3" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      {hint !== null && (
        <div id={id} role="tooltip" className="chat-jump-tooltip chat-navigation-glass">
          {activityHint && <div className="chat-jump-activity">{activityHint}</div>}
          <div className={activityHint ? 'text-fg2' : undefined}>{label}</div>
        </div>
      )}
    </div>
  )
}
