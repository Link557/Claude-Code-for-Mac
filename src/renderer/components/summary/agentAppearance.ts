export type AgentAccessory = 'glasses' | 'hat' | 'mohawk'
export interface AgentAppearance { color: string; accessory: AgentAccessory }

const COLORS = ['#629ab8', '#7caa81', '#c5ad45', '#4e9b94', '#bd6878', '#7294c7', '#98aa59', '#539eaf', '#c16671', '#58a984', '#acb84e', '#577f9c']
const ACCESSORIES: AgentAccessory[] = ['glasses', 'hat', 'mohawk']

/** 摘要按首次调用顺序保存；身份与状态、标题、当前选中项无关。 */
export function agentAppearance(index: number): AgentAppearance {
  const extra = index - COLORS.length
  const color = COLORS[index] ?? `hsl(${(48 + extra * 137.508 % 180).toFixed(2)} 38% ${50 + extra % 5 * 3}%)`
  return { color, accessory: ACCESSORIES[index % ACCESSORIES.length] }
}
