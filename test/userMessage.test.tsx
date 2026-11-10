// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Markdown } from '../src/renderer/components/chat/Markdown'
import { UserMessage } from '../src/renderer/components/chat/UserMessage'
import { FileContext } from '../src/renderer/components/files/FileLink'
import type { UiMessage } from '../src/shared/chat'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'desk')
  Reflect.deleteProperty(navigator, 'clipboard')
})

const message: UiMessage = {
  id: 'user',
  role: 'user',
  source: 'human',
  startsTurn: true,
  parentToolUseId: null,
  blocks: []
}

it('renders pasted citations inline and preserves the source for copying and editing', async () => {
  const url = 'https://docs.example.com/guides/intro'
  const text = `**资料说明**\n参见 [参考文档](${url})。\n\n裸链接 ${url}`
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const view = render(<UserMessage message={message} text={text} onEdit={vi.fn()} />)
  const citation = screen.getByRole('link', { name: '参考文档' })
  expect(citation.getAttribute('href')).toBe(url)
  expect(citation.getAttribute('title')).toBe(url)
  expect(citation.getAttribute('target')).toBe('_blank')
  expect(screen.getByRole('link', { name: 'docs.example.com' }).getAttribute('href')).toBe(url)
  expect(view.container.querySelector('strong')?.textContent).toBe('资料说明')
  expect(view.container.querySelector('[data-user-bubble]')?.textContent).not.toContain(url)
  fireEvent.click(screen.getByRole('button', { name: '复制' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy())
  expect(writeText).toHaveBeenCalledWith(text)
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  expect(screen.getByRole('textbox')).toHaveProperty('value', text)
})

it('shows a Markdown image label without loading the remote resource', () => {
  render(<UserMessage message={message} text="![项目图](https://img.example.com/report.png)" />)
  expect(screen.getByText('项目图')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
})

it('leaves assistant bare URLs readable in full', () => {
  const url = 'https://docs.example.com/guides/intro'
  render(<Markdown text={url} />)
  expect(screen.getByRole('link', { name: url }).getAttribute('href')).toBe(url)
})

it('preserves sent attachment references alongside rendered links', async () => {
  const path = 'C:/work/季度 **汇报**.pdf'
  Object.defineProperty(window, 'desk', {
    configurable: true,
    value: { files: { stat: vi.fn().mockResolvedValue({ [path]: 'file' }) } }
  })
  render(
    <FileContext.Provider value={{ cwd: 'C:/work' }}>
      <UserMessage message={message} text={'@"季度 **汇报**.pdf"\n\n参见 [附件说明](https://docs.example.com/guides/attachments)'} />
    </FileContext.Provider>
  )
  expect(await screen.findByRole('button', { name: '预览 季度 **汇报**.pdf' })).toBeTruthy()
  expect(screen.getByRole('link', { name: '附件说明' })).toBeTruthy()
})
