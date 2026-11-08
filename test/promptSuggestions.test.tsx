// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { $getRoot, $createParagraphNode, $createTextNode, type LexicalEditor } from 'lexical'
import { Composer } from '../src/renderer/components/newSession/Composer'
import { applyChatEvent, mergeChatSnapshot, type ChatProjection } from '../src/renderer/chatSync'
import { useModal } from '../src/renderer/modalStore'
afterEach(cleanup)
const suggestion = { id: 's', text: '运行测试并检查结果' }
function Harness({ submit = vi.fn(), running = false, initial = '' }: { submit?: ReturnType<typeof vi.fn>; running?: boolean; initial?: string }) {
 const [text, setText] = useState(initial)
 return <Composer promptSuggestion={suggestion} value={text} onChange={setText} attachments={[]} onAttachmentsChange={() => {}} onSubmit={submit} canSubmit submitHint="发送" chips={null} running={running} />
}
async function type(box: HTMLElement, text: string) {
 const editor = (box as unknown as { __lexicalEditor: LexicalEditor }).__lexicalEditor
 await act(async () => { editor.update(() => { $getRoot().clear().append($createParagraphNode().append($createTextNode(text))) }) })
}
it('shows gray placeholder only and Tab accepts without sending, then Enter sends', async () => {
 const submit=vi.fn().mockResolvedValue(undefined)
 render(<Harness submit={submit} />)
 const box=screen.getByRole('textbox');fireEvent.focus(box)
 expect(screen.getByText(suggestion.text)).toBeTruthy()
 expect(box.textContent).toBe('')
 fireEvent.keyDown(box,{key:'Tab',isComposing:true});expect(box.textContent).toBe('')
 fireEvent.keyDown(box,{key:'Tab',shiftKey:true});expect(box.textContent).toBe('')
 fireEvent.keyDown(box,{key:'Tab'})
 await waitFor(()=>expect(box.textContent).toBe(suggestion.text))
 expect(submit).not.toHaveBeenCalled()
 fireEvent.keyDown(box,{key:'Enter'})
 await waitFor(()=>expect(submit).toHaveBeenCalledOnce())
})
it('typing or Escape dismisses a suggestion and clearing the draft does not resurrect it', async () => {
 render(<Harness />);const box=screen.getByRole('textbox');fireEvent.focus(box)
 await type(box,'我自己的问题');await type(box,'')
 expect(screen.queryByText(suggestion.text)).toBeNull()
})
it('Escape dismisses and running sessions do not show suggestions', async () => {
 const view=render(<Harness />);fireEvent.keyDown(screen.getByRole('textbox'),{key:'Escape'})
 expect(screen.queryByText(suggestion.text)).toBeNull()
 view.unmount();render(<Harness running />)
 expect(screen.queryByText(suggestion.text)).toBeNull()
})
it('does not overwrite an existing draft', async () => {
 render(<Harness initial="我的草稿" />);const box=screen.getByRole('textbox')
 fireEvent.keyDown(box,{key:'Tab'})
 expect(box.textContent).toBe('我的草稿');expect(screen.queryByText(suggestion.text)).toBeNull()
})
it('does not show or accept a suggestion behind a modal', () => {
  const off = useModal.getState().register()
  try {
    render(<Harness />)
    expect(screen.queryByText(suggestion.text)).toBeNull()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' })
    expect(screen.getByRole('textbox').textContent).toBe('')
  } finally { act(off) }
})
it('preserves a newer prediction over a delayed snapshot and honors a newer clear event', () => {
 const base:ChatProjection={messages:[],state:'idle',approvals:[],options:{model:null,mode:'default',effort:null},error:null}
 const current={...base,...applyChatEvent(base,{kind:'promptSuggestion',suggestion,revision:11},2)}
 expect(mergeChatSnapshot(current,{messages:[],state:'idle',approvals:[],live:true,revision:10},1).promptSuggestion).toEqual(suggestion)
 expect(applyChatEvent(current,{kind:'promptSuggestion',suggestion:null,revision:12},3).promptSuggestion).toBeNull()
})
