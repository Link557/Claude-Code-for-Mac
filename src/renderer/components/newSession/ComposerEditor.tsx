// 输入框的编辑器（Lexical 纯文本模式）：文件以「文件小组件」的形式插在文字中间，删除时整块删除。
// 对外仍是一个字符串：文件节点导出为 @相对路径（和附件引用格式一致），提交、命令拦截都不用变。
import { useEffect, useImperativeHandle, useRef, type ReactNode, type Ref } from 'react'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  DecoratorNode,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread
} from 'lexical'
import { referenceFor } from '@shared/attachments'
import { findBarePaths, pastedFilePaths, resolvePath } from '@shared/fileLinks'
import { AttachmentCard } from '../files/AttachmentCard'

/** 命令和 @ 补全的识别里，文件节点当作一个空白字符：光标紧跟在文件后面时不会被误认成正在输入 @ */
export const FILE_PLACEHOLDER = ' '

type SerializedFileNode = Spread<{ path: string; ref: string }, SerializedLexicalNode>

export class FileNode extends DecoratorNode<ReactNode> {
  __path: string
  __ref: string

  static getType(): string {
    return 'file'
  }

  static clone(node: FileNode): FileNode {
    return new FileNode(node.__path, node.__ref, node.__key)
  }

  static importJSON(json: SerializedFileNode): FileNode {
    return new FileNode(json.path, json.ref)
  }

  constructor(path: string, ref: string, key?: NodeKey) {
    super(key)
    this.__path = path
    this.__ref = ref
  }

  exportJSON(): SerializedFileNode {
    return { ...super.exportJSON(), type: 'file', version: 1, path: this.__path, ref: this.__ref }
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'composer-file'
    return span
  }

  updateDOM(): false {
    return false
  }

  isInline(): true {
    return true
  }

  getTextContent(): string {
    return this.__ref
  }

  decorate(): ReactNode {
    return <AttachmentCard path={this.__path} />
  }
}

function $isFileNode(node: LexicalNode | null | undefined): node is FileNode {
  return node instanceof FileNode
}

/** 用纯文本重建内容（外部改写 value 时，比如发送后清空） */
function $setPlainText(text: string, cwd?: string, home?: string): void {
  const root = $getRoot()
  root.clear()
  const p = $createParagraphNode()
  text.split('\n').forEach((line, i) => {
    if (i > 0) p.append($createLineBreakNode())
    let offset = 0
    for (const match of findBarePaths(line)) {
      if (!line.slice(match.start).startsWith('@')) continue
      const path = resolvePath(match.ref.path, cwd, home)
      if (!path) continue
      if (match.start > offset) p.append($createTextNode(line.slice(offset, match.start)))
      p.append(new FileNode(path, line.slice(match.start, match.end)))
      offset = match.end
    }
    if (offset < line.length) p.append($createTextNode(line.slice(offset)))
  })
  root.append(p)
  p.selectEnd()
}

/** 当前内容：导出用的字符串、识别命令用的文字（文件节点换成占位符）和光标位置 */
function $readState(): { value: string; text: string; caret: number } {
  const value = $getRoot().getTextContent()
  const selection = $getSelection()
  let text = ''
  let caret = -1
  const anchor = $isRangeSelection(selection) ? selection.anchor : null
  const visit = (node: LexicalNode): void => {
    if (anchor && anchor.type === 'element' && $isElementNode(node) && node.getKey() === anchor.key) {
      node.getChildren().forEach((child, i) => {
        if (i === anchor.offset) caret = text.length
        visit(child)
      })
      if (anchor.offset >= node.getChildrenSize() && caret < 0) caret = text.length
      return
    }
    if ($isElementNode(node)) return node.getChildren().forEach(visit)
    if (anchor && node.getKey() === anchor.key && $isTextNode(node)) caret = text.length + anchor.offset
    text += $isFileNode(node) ? FILE_PLACEHOLDER : $isLineBreakNode(node) ? '\n' : node.getTextContent()
  }
  $getRoot().getChildren().forEach((p, i) => {
    if (i > 0) text += '\n'
    visit(p)
  })
  return { value, text, caret: caret < 0 ? text.length : caret }
}

export interface EditorHandle {
  focus(): void
  /** 把光标前 length 个字符换成文字，或换成一个文件小组件 */
  replaceBeforeCaret(length: number, insert: { text: string } | { file: string }): void
}

interface EditorProps {
  onFiles?(files: File[]): void
  value: string
  /** 内容或光标变化：value 是导出字符串，text/caret 用来识别 / 命令和 @ 补全 */
  onChange(value: string, text: string, caret: number): void
  /** 按键交给输入框处理（建议列表、回车发送）；返回 true 表示已处理 */
  onKey(event: KeyboardEvent): boolean
  placeholder: ReactNode
  rows: number
  autoFocus?: boolean
  cwd?: string
  home?: string
  editorRef: Ref<EditorHandle>
}

export function ComposerEditor(props: EditorProps) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'composer',
        nodes: [FileNode],
        onError: (err) => console.error('[composer]', err),
        editorState: () => $setPlainText(props.value, props.cwd, props.home)
      }}
    >
      <Editor {...props} />
    </LexicalComposer>
  )
}

function Editor({ onFiles, value, onChange, onKey, placeholder, rows, autoFocus, cwd, home, editorRef }: EditorProps) {
  const [editor] = useLexicalComposerContext()
  const emitted = useRef(value)
  const latest = useRef({ onChange, onKey, cwd, home, onFiles })
  latest.current = { onChange, onKey, cwd, home, onFiles }

  const fileNode = (path: string): FileNode => new FileNode(path, referenceFor(path, latest.current.cwd))

  useImperativeHandle(editorRef, () => ({
    focus: () => editor.focus(),
    replaceBeforeCaret(length, insert) {
      editor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) return
        const node = selection.anchor.getNode()
        if ($isTextNode(node) && length > 0) {
          const end = selection.anchor.offset
          const range = $createRangeSelection()
          range.anchor.set(node.getKey(), Math.max(end - length, 0), 'text')
          range.focus.set(node.getKey(), end, 'text')
          $setSelection(range)
        }
        const sel = $getSelection()
        if (!$isRangeSelection(sel)) return
        if ('text' in insert) sel.insertText(insert.text)
        else sel.insertNodes([fileNode(insert.file), $createTextNode(' ')])
      })
      editor.focus()
    }
  }))

  // 外部改写了 value（发送后清空、执行命令后去掉命令）：重建内容
  useEffect(() => {
    if (value === emitted.current) return
    emitted.current = value
    editor.update(() => $setPlainText(value, latest.current.cwd, latest.current.home))
  }, [editor, value])

  useEffect(() => {
    const offUpdate = editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const state = $readState()
        emitted.current = state.value
        latest.current.onChange(state.value, state.text, state.caret)
      })
    })
    const key =
      (command: typeof KEY_ENTER_COMMAND) =>
      (): (() => void) =>
        editor.registerCommand(
          command,
          (event: KeyboardEvent | null) => {
            // 中文输入法选词时的按键交给输入法
            if (!event || event.isComposing || event.keyCode === 229) return false
            if (!latest.current.onKey(event)) return false
            event.preventDefault()
            return true
          },
          COMMAND_PRIORITY_HIGH
        )
    const offs = [KEY_ENTER_COMMAND, KEY_ARROW_UP_COMMAND, KEY_ARROW_DOWN_COMMAND, KEY_TAB_COMMAND, KEY_ESCAPE_COMMAND].map((c) =>
      key(c as typeof KEY_ENTER_COMMAND)()
    )
    // 粘贴的内容如果全是完整路径（每行一个），变成文件小组件
    const offPaste = editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (event instanceof ClipboardEvent && event.clipboardData?.files.length && latest.current.onFiles) {
          event.preventDefault()
          latest.current.onFiles(Array.from(event.clipboardData.files))
          return true
        }
        const text = event instanceof ClipboardEvent ? event.clipboardData?.getData('text/plain')?.trim() : ''
        if (!text) return false
        const paths = pastedFilePaths(text, latest.current.cwd, latest.current.home)
        if (!paths) return false
        event.preventDefault()
        editor.update(() => {
          const sel = $getSelection()
          if (!$isRangeSelection(sel)) return
          sel.insertNodes(paths.flatMap((p) => [fileNode(p!), $createTextNode(' ')]))
        })
        return true
      },
      COMMAND_PRIORITY_HIGH
    )
    return () => {
      offUpdate()
      offs.forEach((off) => off())
      offPaste()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  return (
    <div className="relative">
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            data-composer
            aria-label="输入消息"
            style={{ minHeight: rows * 24 + 18 }}
            className="block max-h-[260px] w-full overflow-y-auto px-4 pt-3.5 pb-1 text-[14.5px] leading-6 break-words whitespace-pre-wrap outline-none select-text"
          />
        }
        placeholder={<div className="pointer-events-none absolute top-3.5 left-4 right-4 text-[14.5px] leading-6 text-fg3 select-none">{placeholder}</div>}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      {autoFocus && <AutoFocusPlugin />}
    </div>
  )
}
