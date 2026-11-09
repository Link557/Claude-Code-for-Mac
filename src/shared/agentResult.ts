/** 识别 SDK 附在 Agent 工具结果末尾的续接提示。 */
export function agentResultFooter(text: string): { agentId: string; start: number } | undefined {
  const footer = /(?:^|\n)agentId: ([\w-]+) \(([^()\r\n]+)\)\s*(?:<usage>[^<>]*<\/usage>)?\s*$/.exec(text)
  if (!footer) return
  const [, agentId, hint] = footer
  const legacy = /^for resuming(?: to continue this agent(?: if needed)?)?$/.test(hint)
  const current = hint === `use SendMessage with to: '${agentId}', summary: '<5-10 word recap>' to continue this agent`
  if (legacy || current) return { agentId, start: footer.index }
}
