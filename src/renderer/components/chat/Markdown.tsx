import { useModalLayer } from '../../modalStore'
import { memo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy, Maximize2, X } from 'lucide-react'
import { useDismiss } from '../../hooks/useDismiss'
import { findBarePaths, parsePathRef } from '@shared/fileLinks'
import { FileLink } from '../files/FileLink'

interface HNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HNode[]
}

/** 正文里的路径变成链接（交给下面的 a 处理）；行内代码做上标记，以便识别其中的路径 */
function rehypeFilePaths() {
  const walk = (node: HNode): void => {
    if (!node.children) return
    const out: HNode[] = []
    for (const child of node.children) {
      if (child.type === 'element') {
        if (child.tagName === 'code') child.properties = { ...child.properties, dataInline: true }
        // 链接、代码块里的内容保持原样
        if (child.tagName !== 'a' && child.tagName !== 'pre' && child.tagName !== 'code') walk(child)
        out.push(child)
        continue
      }
      const text = child.type === 'text' ? (child.value ?? '') : ''
      const matches = text ? findBarePaths(text) : []
      if (!matches.length) {
        out.push(child)
        continue
      }
      let i = 0
      for (const m of matches) {
        if (m.start > i) out.push({ type: 'text', value: text.slice(i, m.start) })
        const raw = text.slice(m.start, m.end)
        out.push({
          type: 'element',
          tagName: 'a',
          properties: { dataFilePath: m.ref.path, dataFileLine: m.ref.line },
          children: [{ type: 'text', value: raw }]
        })
        i = m.end
      }
      if (i < text.length) out.push({ type: 'text', value: text.slice(i) })
    }
    node.children = out
  }
  return walk
}

const REHYPE = [rehypeFilePaths]
// 默认会去掉 file:// 链接；本地文件链接要保留
const urlTransform = (url: string): string => (/^file:/i.test(url) ? url : defaultUrlTransform(url))

export const Markdown = memo(function Markdown({ text, userMessage = false }: { text: string; userMessage?: boolean }) {
  return (
    <div className={userMessage ? 'md md-user select-text' : 'md select-text'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={REHYPE}
        urlTransform={urlTransform}
        components={{
          a: ({ href, children, node, title }) => {
            const path = node?.properties.dataFilePath
            if (typeof path === 'string') {
              const line = node?.properties.dataFileLine
              return <FileLink pathRef={{ path, line: typeof line === 'number' ? line : undefined }} fallback={children} attachment={userMessage} />
            }
            const webUrl = href && /^https?:\/\//i.test(href) ? URL.parse(href) : null
            if (webUrl && href) {
              const label = children === href || children === href.replace(/^https?:\/\//i, '') ? webUrl.host : children
              return <a className="web-link" href={href} title={title ? `${title}\n${href}` : href} target="_blank" rel="noreferrer">{label}</a>
            }
            const link = (
              <a href={href} title={title} target="_blank" rel="noreferrer">
                {children}
              </a>
            )
            const ref = href && !/^(https?|mailto):/i.test(href) ? parsePathRef(href) : null
            if (!ref) return link
            return <FileLink pathRef={ref} fallback={link} />
          },
          code: ({ node, children, ...rest }) => {
            const code = <code {...rest}>{children}</code>
            const ref = node?.properties?.dataInline && typeof children === 'string' ? parsePathRef(children) : null
            return ref ? <FileLink pathRef={ref} fallback={code} /> : code
          },
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => <TableBlock>{children}</TableBlock>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="group relative">
      <pre>{children}</pre>
      <button
        type="button"
        title="复制"
        onClick={(e) => {
          const code = e.currentTarget.parentElement?.querySelector('pre')?.innerText ?? ''
          void navigator.clipboard.writeText(code)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        className="absolute top-2 right-2 hidden size-7 items-center justify-center rounded-md bg-card text-fg2 shadow-sm group-hover:flex hover:text-fg"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  )
}

/** 表格内容转成制表符分隔的文本，可以直接粘贴进 Excel */
function tableText(table: HTMLTableElement | null): string {
  if (!table) return ''
  return [...table.rows].map((row) => [...row.cells].map((cell) => cell.innerText.trim()).join('\t')).join('\n')
}

/** 表格：悬停时右上角出现「复制」和「放大查看」 */
function TableBlock({ children }: { children: React.ReactNode }) {
  const table = useRef<HTMLTableElement>(null)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="group/table relative">
      <table ref={table}>{children}</table>
      <div className="absolute top-1 right-1 hidden gap-0.5 rounded-lg bg-card/90 p-0.5 shadow-sm backdrop-blur group-hover/table:flex">
        <button
          type="button"
          title={copied ? '已复制' : '复制表格（可粘贴到 Excel）'}
          onClick={() => {
            void navigator.clipboard.writeText(tableText(table.current))
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          className="flex size-7 items-center justify-center rounded-md text-fg2 hover:bg-hover hover:text-fg"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button
          type="button"
          title="放大查看"
          onClick={() => setExpanded(true)}
          className="flex size-7 items-center justify-center rounded-md text-fg2 hover:bg-hover hover:text-fg"
        >
          <Maximize2 size={13} />
        </button>
      </div>
      {expanded && createPortal(<TableDialog onClose={() => setExpanded(false)}>{children}</TableDialog>, document.body)}
    </div>
  )
}

function TableDialog({ children, onClose }: { children: React.ReactNode; onClose(): void }) {
  useModalLayer()
  const box = useRef<HTMLDivElement>(null)
  useDismiss(box, true, onClose)
  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-overlay p-8 [animation-delay:0s]">
      <div ref={box} role="dialog" aria-modal="true" aria-label="表格预览" className="animate-pop-in relative max-h-full max-w-full overflow-auto rounded-2xl border border-line bg-card p-6 shadow-pop [transform-origin:center]">
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-md text-fg3 hover:bg-hover hover:text-fg"
        >
          <X size={14} />
        </button>
        <div className="md">
          <table className="!table">{children}</table>
        </div>
      </div>
    </div>
  )
}
