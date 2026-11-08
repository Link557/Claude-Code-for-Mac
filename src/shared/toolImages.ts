/** Only embedded raster images are previewed; never fetch URLs from tool output. */
export function isToolImage(value: unknown): value is string {
  return typeof value === 'string' && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
}

/** Bound IPC payload size. The original SDK transcript remains untouched. */
export function toolImages(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const images: string[] = []
  let bytes = 0
  for (const block of content) {
    if (!block || block.type !== 'image') continue
    const source = block.source
    const mime = source?.type === 'base64' ? source.media_type : block.mimeType
    const data = source?.type === 'base64' ? source.data : block.data
    if (typeof data !== 'string' || data.length > 12 * 1024 * 1024) continue
    const url = `data:${mime};base64,${data}`
    if (!isToolImage(url) || bytes + url.length > 12 * 1024 * 1024 || images.length >= 8) continue
    if (!images.includes(url)) { images.push(url); bytes += url.length }
  }
  return images
}
