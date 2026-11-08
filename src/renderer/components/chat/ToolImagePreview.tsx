import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { UiBlock } from '@shared/chat'
import { fileName, resolvePath } from '@shared/fileLinks'
import { isToolImage } from '@shared/toolImages'
import { Button, Dialog } from '../ui/Dialog'

type ToolBlock = Extract<UiBlock, { kind: 'tool' }>

/** Presentation only: reads local files through IPC, never sends a chat message. */
export function ToolImagePreview({ block, cwd }: { block: ToolBlock; cwd?: string }) {
  const embedded = block.result?.images?.filter(isToolImage) ?? []
  const path = block.name === 'Read' && typeof block.input.file_path === 'string'
    ? resolvePath(block.input.file_path, cwd) : null
  const localPath = block.result && !block.result.isError && !embedded.length && path && /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(path) ? path : null
  const [local, setLocal] = useState<{ path: string; url?: string; error?: string }>()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [failed, setFailed] = useState<string[]>([])
  useEffect(() => {
    let active = true
    if (localPath) void window.desk.files.read(localPath).then(result => {
      if (active) setLocal(result.kind === 'image'
        ? { path: localPath, url: result.dataUrl }
        : { path: localPath, error: result.kind === 'too-large' ? '图片过大，无法预览' : '原图片已不可用' })
    }, () => { if (active) setLocal({ path: localPath, error: '无法读取原图片' }) })
    return () => { active = false }
  }, [localPath])
  if (!block.result || block.result.isError || (!embedded.length && !localPath)) return null
  const current = local?.path === localPath ? local : undefined
  const images = embedded.length ? embedded : current?.url ? [current.url] : []
  const label = path ? fileName(path) : '工具返回图片'
  return <div className="border-t border-line px-3 py-2">
    {localPath && <p className="mb-2 text-[11px] text-fg3">{current?.error ?? (current?.url ? '原文件预览 · 当前内容' : '正在加载图片…')}</p>}
    <div className="flex flex-wrap gap-2">
      {images.map((url, index) => failed.includes(url)
        ? <p key={index} className="text-xs text-fg3">图片无法显示</p>
        : <button key={index} type="button" aria-label={`放大图片 ${label}${images.length > 1 ? ` ${index + 1}` : ''}`}
          onClick={() => setExpanded(url)} className="overflow-hidden rounded-lg border border-line bg-chip hover:border-accent/50 focus-visible:outline-2 focus-visible:outline-accent">
          <img src={url} alt={label} loading="lazy" onError={() => setFailed(previous => [...previous, url])}
            className="max-h-40 max-w-[min(320px,65vw)] object-contain" />
        </button>)}
    </div>
    {expanded && images.includes(expanded) && createPortal(<Dialog title={label} width={960} onClose={() => setExpanded(null)}
      footer={<Button onClick={() => setExpanded(null)}>关闭</Button>}>
      <img src={expanded} alt={label} className="mx-auto max-h-[60vh] max-w-full object-contain" />
    </Dialog>, document.body)}
  </div>
}
