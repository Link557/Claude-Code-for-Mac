import type { CSSProperties } from 'react'
import { Crab } from '../newSession/Crab'
import { agentAppearance } from './agentAppearance'

export function AgentCrab({ index, running = false, small = false }: { index: number; running?: boolean; small?: boolean }) {
  const appearance = agentAppearance(index)
  return <span className={`agent-crab ${small ? 'agent-crab-small' : ''}`} data-working={running} data-accessory={appearance.accessory}
    style={{ '--agent-delay': `${index * -0.7}s` } as CSSProperties} aria-hidden="true">
    <Crab color={appearance.color} accessory={appearance.accessory} pose={running ? 'working' : 'idle'} />
  </span>
}
