// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { commandNotice } from '../src/shared/commandNotice'
import { CommandRecord } from '../src/renderer/components/chat/CommandRecord'
import { InternalNotice } from '../src/renderer/components/chat/InternalNotice'
afterEach(cleanup)
it('renders a model change as a Chinese status announcement for actual model IDs', () => {
 render(<CommandRecord block={{kind:'command',name:'model',args:'haiku',output:'Set model to `haiku (claude-haiku-4-5)`'}} onOpen={vi.fn()} />)
 expect(screen.getByRole('status').textContent).toBe('模型已切换为 Haiku（claude-haiku-4-5）')
 expect(commandNotice('Set model to `deepseek-chat`')).toBe('模型已切换为 deepseek-chat')
})
it('requires command provenance before localizing a model change', () => {
  const text = 'Set model to haiku'
  expect(commandNotice(text, true)).toBeNull()
  expect(commandNotice('<local-command-stdout>' + text + '</local-command-stdout>', true)).toBe('模型已切换为 Haiku')
  render(<InternalNotice message={{ id: 'n', role: 'notice', source: 'external', parentToolUseId: null, blocks: [{ kind: 'text', text }] }} />)
  expect(screen.queryByText('模型已切换为 Haiku')).toBeNull()
})

it('removes the CLI envelope from internal announcements without losing failures', () => {
 render(<InternalNotice message={{id:'n',role:'notice',source:'internal',parentToolUseId:null,blocks:[{kind:'text',text:'<local-command-stdout>Set model to haiku (claude-haiku-4-5)</local-command-stdout>'}]}} />)
 expect(screen.getByRole('status').textContent).toBe('模型已切换为 Haiku（claude-haiku-4-5）')
 expect(commandNotice('<local-command-stderr>Permission denied</local-command-stderr>')).toBe('命令执行失败：Permission denied')
 expect(commandNotice('用户提到了 <local-command-stdout>原文</local-command-stdout>')).toBeNull()
})
