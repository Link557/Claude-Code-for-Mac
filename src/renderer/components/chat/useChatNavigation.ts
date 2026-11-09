import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ChatState, UiMessage } from '@shared/chat'

function nearLatest(el: HTMLDivElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

function readingTop(el: HTMLDivElement): number {
  return el.getBoundingClientRect().top + (parseFloat(getComputedStyle(el).scrollPaddingTop) || 0)
}

export function useChatNavigation(
  messages: UiMessage[] | undefined,
  approvalCount: number | undefined,
  state: ChatState | undefined,
  loaded: boolean | undefined,
  autoScroll: boolean
) {
  const scroller = useRef<HTMLDivElement>(null)
  const turnList = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [navigation, setNavigation] = useState({ away: false, activeIndex: 0 })
  const followLatest = useCallback(() => { stick.current = true }, [])

  const updateNavigation = useCallback(() => {
    const el = scroller.current
    const turns = turnList.current?.children
    if (!el || !turns) return
    const away = !nearLatest(el)
    let activeIndex = Math.max(0, turns.length - 1)
    if (away && turns.length > 1) {
      const top = readingTop(el) + 2
      let start = 0
      let end = turns.length
      while (start < end) {
        const middle = Math.floor((start + end) / 2)
        if (turns[middle]!.getBoundingClientRect().top <= top) start = middle + 1
        else end = middle
      }
      activeIndex = Math.max(0, start - 1)
    }
    setNavigation(previous => previous.away === away && previous.activeIndex === activeIndex ? previous : { away, activeIndex })
  }, [])

  // 停在底部时，新内容到来自动滚动；用户往上翻时不打扰
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current && autoScroll) el.scrollTop = el.scrollHeight
    updateNavigation()
  }, [messages, approvalCount, state, autoScroll, updateNavigation])

  useLayoutEffect(() => {
    const el = scroller.current
    const content = turnList.current?.parentElement
    if (!el || !content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (stick.current && autoScroll) el.scrollTop = el.scrollHeight
      updateNavigation()
    })
    observer.observe(el)
    observer.observe(content)
    return () => observer.disconnect()
  }, [loaded, autoScroll, updateNavigation])

  const jumpToTurn = (index: number): void => {
    const el = scroller.current
    const target = turnList.current?.children[index]
    if (!el || !target) return
    el.scrollTop += target.getBoundingClientRect().top - readingTop(el)
    stick.current = nearLatest(el)
    updateNavigation()
  }

  const jumpToLatest = (): void => {
    const el = scroller.current
    if (!el) return
    stick.current = true
    el.scrollTop = el.scrollHeight
    updateNavigation()
  }

  return {
    scroller,
    turnList,
    ...navigation,
    followLatest,
    jumpToTurn,
    jumpToLatest,
    onScroll: () => {
      if (scroller.current) stick.current = nearLatest(scroller.current)
      updateNavigation()
    }
  }
}
