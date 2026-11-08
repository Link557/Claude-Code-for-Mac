// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UiBlock } from '../src/shared/chat'
import { ToolCard } from '../src/renderer/components/chat/ToolCard'

const url = 'data:image/png;base64,aGVsbG8='
const block: Extract<UiBlock, { kind: 'tool' }> = { kind: 'tool', id: 'read', name: 'Read', input: { file_path: '/image.png' }, result: { text: '[image]', isError: false, images: [url] } }
const show = (value = block) => render(<ToolCard block={value} running={false} cwd="/project" />)
beforeEach(() => { window.desk = { files: { read: vi.fn() }, chat: { send: vi.fn() } } as unknown as Window['desk'] })
afterEach(cleanup)

it('shows a thumbnail on a collapsed tool and opens the same embedded image without a file or model request', () => {
  show()
  expect(screen.getByRole('img').getAttribute('src')).toBe(url)
  fireEvent.click(screen.getByRole('button', { name: '放大图片 image.png' }))
  expect(screen.getByRole('dialog').querySelector('img')?.src).toBe(url)
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(window.desk.files.read).not.toHaveBeenCalled()
  expect(window.desk.chat.send).not.toHaveBeenCalled()
})

it('loads the current local file for old transcripts and identifies it as current content', async () => {
  vi.mocked(window.desk.files.read).mockResolvedValue({ kind: 'image', size: 1, dataUrl: url })
  show({ ...block, input: { file_path: 'old.png' }, result: { text: '[image]', isError: false } })
  await screen.findByRole('img')
  expect(window.desk.files.read).toHaveBeenCalledWith('/project/old.png')
  expect(screen.getByText('原文件预览 · 当前内容')).toBeTruthy()
  expect(window.desk.chat.send).not.toHaveBeenCalled()
})

it('reports missing files without changing tool success or issuing another model read', async () => {
  vi.mocked(window.desk.files.read).mockResolvedValue({ kind: 'missing' })
  show({ ...block, result: { text: '[image]', isError: false } })
  await screen.findByText('原图片已不可用')
  expect(screen.queryByRole('img')).toBeNull()
  expect(window.desk.chat.send).not.toHaveBeenCalled()
})

it('does not preview a failed Read', () => {
  show({ ...block, result: { text: 'permission denied', isError: true } })
  expect(screen.queryByRole('img')).toBeNull()
  expect(window.desk.files.read).not.toHaveBeenCalled()
})

it('ignores late local file loads after the tool changes', async () => {
  let finish!: (value: { kind: 'image'; size: number; dataUrl: string }) => void
  vi.mocked(window.desk.files.read).mockReturnValue(new Promise(resolve => { finish = resolve }))
  const view = show({ ...block, result: { text: '[image]', isError: false } })
  view.rerender(<ToolCard block={{ ...block, input: { file_path: '/new.png' } }} running={false} />)
  await act(async () => finish({ kind: 'image', size: 1, dataUrl: 'data:image/png;base64,bmV3' }))
  await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe(url))
})

it('replaces a broken thumbnail with a readable message', () => {
  show()
  fireEvent.error(screen.getByRole('img'))
  expect(screen.getByText('图片无法显示')).toBeTruthy()
})
