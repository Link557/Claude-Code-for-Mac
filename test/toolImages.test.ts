import { describe, expect, it } from 'vitest'
import { toolImages } from '../src/shared/toolImages'
import { Transcript } from '../src/main/transcript'

const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
const dataUrl = 'data:image/png;base64,aGVsbG8='
const start = (t: Transcript, id = 'read') => t.apply({ type: 'assistant', message: { id: 'a' + id, content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/image.png' } }] } })
const tool = (t: Transcript) => t.messages.flatMap(m => m.blocks).find(b => b.kind === 'tool')!

describe('tool image extraction', () => {
  it('supports SDK and MCP inline raster blocks and deduplicates them', () => {
    expect(toolImages([image, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }])).toEqual([dataUrl])
  })
  it('does not load remote URLs, active formats, invalid or oversized data', () => {
    expect(toolImages([
      { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'aGVsbG8=' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '<bad>' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(12 * 1024 * 1024 + 1) } }, null
    ])).toEqual([])
  })
  it.each(['live', 'history'] as const)('preserves tool images and technical notices in %s without changing SDK input', mode => {
    const t = new Transcript()
    start(t)
    const event = { type: 'user', isMeta: true, message: { content: [
      { type: 'tool_result', tool_use_id: 'read', content: [image, { type: 'text', text: 'read completed' }] },
      { type: 'text', text: '[Image: original 2400x540, displayed at 2000x450. Multiply coordinates by 1.20 to map to original image.]' }
    ] } }
    const original = structuredClone(event)
    t.apply(event, mode)
    expect(tool(t)).toMatchObject({ result: { images: [dataUrl], text: '[image]\nread completed', isError: false } })
    expect(t.messages.find(m => m.role === 'notice')).toMatchObject({ source: 'internal' })
    expect(event).toEqual(original)
    // A final assistant echo must not erase the attached image result.
    start(t)
    expect(tool(t)).toMatchObject({ result: { images: [dataUrl] } })
  })
  it('associates sibling images only when there is one unambiguous tool result', () => {
    const t = new Transcript()
    start(t)
    t.apply({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'image' }, image] } })
    expect(tool(t)).toMatchObject({ result: { images: [dataUrl] } })
    start(t, 'second')
    t.apply({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'image' }, { type: 'tool_result', tool_use_id: 'second', content: 'image' }, image] } })
    expect(tool(t)).toMatchObject({ result: { text: 'image' } })
    expect(tool(t).kind === 'tool' && tool(t).result?.images).toBeUndefined()
  })
})
