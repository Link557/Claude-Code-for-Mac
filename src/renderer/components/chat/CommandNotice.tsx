export function CommandNotice({ text }: { text: string }) {
  return <div role="status" className="my-3 rounded-lg border border-line bg-hover/50 px-3 py-2 text-[13px] leading-5 text-fg3 whitespace-pre-wrap break-words select-text">{text}</div>
}
