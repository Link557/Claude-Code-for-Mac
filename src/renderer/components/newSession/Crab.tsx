import type { CrabGesture } from './crabGestures'
import type { CrabPose } from './crabActivity'
import type { AgentAccessory } from '../summary/agentAppearance'

const BODY = ['...############...', '...##.######.##...', '..##############..', '...############...']
const COLOR = '#d97757'
const pixels = BODY.flatMap((row, y) => [...row].flatMap((pixel, x) => pixel === '#' ? [{ x, y: y * 2 }] : []))

/** The open tips meet the tool at (x, y); the wrist overlaps the body. */
function Grip({ x, y }: { x: number; y: number }) {
  return <g transform={`translate(${x} ${y})`} data-grip="" stroke="none">
    <path className="crab-grip-skin" fill="#d16e50" d="M-4 0h1.7v-1.3H0v.8h-1.2v1H0v.8h-2.3V1H-4z" />
  </g>
}

function Wrench() {
  return <g className="crab-prop">
    <path fill="#b29374" d="M20 0h2v9h-2zM18 8h5v1h-5z" />
    <path fill="#605c57" d="m21-2 1.5.8v1.6L21 1.2l-1.5-.8v-1.6z" />
    <g className="crab-wrench">
      <path fill="#718998" d="m16 6-1.3-1.3 4.2-4.3-.4-1.4.5-1.7 1.2-.8-.2 2 1.4.9 1.5-1.3.2 1.7-1.2 1.3-2 .2z" />
      <path stroke="#b8ced3" strokeWidth=".45" d="m16 4.6 3.8-3.8" />
      <Grip x={16.5} y={4.7} />
    </g>
  </g>
}

function Book({ y, color, motion }: { y: number; color: string; motion?: string }) {
  return <g className={motion}>
    <rect x={17} y={y} width={6.5} height={1.9} rx={0.35} fill={color} />
    <rect x={18.2} y={y + 0.48} width={5} height={0.9} fill="#f5e8cf" />
  </g>
}

function StackBooks() {
  return <g className="crab-prop">
    <Book y={7.2} color="#627983" />
    <Book y={5.2} color="#ba8168" />
    <Book y={3.2} color="#839971" motion="crab-book-first" />
    <Book y={1.2} color="#857897" motion="crab-book-last" />
    <g className="crab-book-push"><Grip x={17} y={2.1} /></g>
  </g>
}

type Eye = readonly [x: number, y: number, width: number, height: number]

// Resting silhouettes also serve as the still frames for reduced motion.
const EXPRESSIONS: Record<CrabGesture, readonly [Eye, Eye]> = {
  thinking: [[5, 1.5, 1.5, 1], [12, 1, 1, 2]],
  cooking: [[5, 3, 2, 0.8], [12, 3, 2, 0.8]],
  making: [[6, 2, 1, 2], [12.5, 2.5, 1.8, 1]],
  sorting: [[6, 3, 1.5, 1.25], [12.5, 3, 1.5, 1.25]],
  growing: [[6, 2.5, 1.6, 1.8], [12.5, 2.5, 1.6, 1.8]],
  exploring: [[6, 2, 1, 1.5], [12, 1.5, 2, 2.5]],
  playing: [[5, 2, 1.5, 2], [12, 2.75, 2, 0.75]]
}

function Eyes({ gesture }: { gesture?: CrabGesture }) {
  const eyes: readonly Eye[] = gesture ? EXPRESSIONS[gesture] : [[5, 2, 1, 2], [12, 2, 1, 2]]
  return <g key={gesture} className={gesture ? 'crab-gaze' : 'crab-eyes'} fill="#2b2a27">
    {eyes.map(([x, y, width, height], i) => <rect key={i} x={x} y={y} width={width} height={height} />)}
  </g>
}

/** 被夹住时的表情：眯眼 >_<、晕乎乎 x_x、瞪大眼（海绵宝宝那样） */
export type CrabFace = 'squint' | 'dizzy' | 'wide'
export const CRAB_FACES: readonly CrabFace[] = ['squint', 'dizzy', 'wide']
const FACES: Record<CrabFace, readonly Eye[]> = {
  squint: [[5, 1, 1, 1], [6, 2, 1, 1], [5, 3, 1, 1], [13, 1, 1, 1], [12, 2, 1, 1], [13, 3, 1, 1]],
  dizzy: [[4, 1, 1, 1], [6, 1, 1, 1], [5, 2, 1, 1], [4, 3, 1, 1], [6, 3, 1, 1], [11, 1, 1, 1], [13, 1, 1, 1], [12, 2, 1, 1], [11, 3, 1, 1], [13, 3, 1, 1]],
  wide: []
}

function Face({ face }: { face: CrabFace }) {
  if (face === 'wide') return <>
    <path fill="#f6efe6" d="M4 1h3v4H4zM11 1h3v4h-3z" />
    <path fill="#2b2a27" d="M5 2h1v2H5zM12 2h1v2h-1z" />
  </>
  return <g fill="#2b2a27">{FACES[face].map(([x, y, width, height], i) => <rect key={i} x={x} y={y} width={width} height={height} />)}</g>
}

/** Fixed pixel mascot; the extended viewBox leaves room for the bulb and stationery. */
export function Crab({ pose = 'idle', gesture, rainbow, face, color = COLOR, accessory }: { rainbow?: boolean; pose?: CrabPose; gesture?: CrabGesture; face?: CrabFace; color?: string; accessory?: AgentAccessory }) {
  return <svg viewBox="-2 -7 26 17" width={78} height={51} shapeRendering="crispEdges" aria-hidden="true" className={`crab crab-${pose}${rainbow ? ' crab-violet' : ''}${face ? ' crab-held' : ''}`} data-crab-pose={pose} data-crab-gesture={gesture} data-crab-face={face}>
    <rect x={-2} y={-7} width={26} height={17} fill="transparent" />
    <g fill={rainbow ? '#8e55ce' : color}>
      {[4, 6, 11, 13].map(x => <rect key={x} className="crab-leg" x={x} y={8} width={1} height={2} />)}
      <g className="crab-body">
        {pixels.map(p => <rect key={`${p.x}-${p.y}`} {...p} className={rainbow ? 'violet-pixel' : undefined} style={rainbow ? {animationDelay: ((p.x*.05+p.y*.0275)*4-4)+'s'} : undefined} width={1} height={2} />)}
        <rect className="crab-claw-l" x={1} y={4} width={1} height={2} />
        {!gesture && <rect className="crab-claw-r" x={16} y={4} width={1} height={2} />}
        {gesture === 'thinking' && <g className="crab-cheek"><Grip x={16.4} y={3.1} /></g>}
        {gesture === 'playing' && <g className="crab-flick"><Grip x={18.2} y={3.6} /></g>}
        {(gesture || face) && <path className="crab-face-skin" fill={rainbow ? '#8e55ce' : color} d="M5 2h1v4H5zM12 2h1v4h-1z" />}
        {face ? <Face face={face} /> : <Eyes gesture={gesture} />}
        {accessory === 'glasses' && <g fill="none" stroke="#343e43" strokeWidth={0.65}>
          <rect x={3.5} y={1} width={4} height={3.5} /><rect x={10.5} y={1} width={4} height={3.5} />
          <path d="M7.5 2h3M2 1.5h1.5M14.5 1.5H16" />
        </g>}
        {accessory === 'hat' && <g><path fill="#3d5949" d="M6-4h7v3H6zM4-1h11v1H4z" /><path fill="#d1b04f" d="M6-2h7v1H6z" /></g>}
        {accessory === 'mohawk' && <path fill="#35464e" d="M9-5h1v1h1v1h1v1h1v2H7v-2h1v-1h1z" />}
        {pose === 'writing' && <g fill="none" stroke="#34302e" strokeWidth={0.65}>
          <rect x={3.5} y={1} width={4} height={3.5} /><rect x={10.5} y={1} width={4} height={3.5} />
          <path d="M7.5 2h3M2 1.5h1.5M14.5 1.5H16" />
        </g>}
      </g>
    </g>
    {pose === 'sleep' && <g className="crab-zzz" fill="currentColor"><path d="M15-5h3v1h-1v1h-1v1h2v1h-3v-1h1v-1h1v-1h-2z" /></g>}
    {pose === 'thinking' && <g className="crab-bulb" transform="translate(8 0)">
      <path fill="#edbd56" d="M8-6h4v1h1v3h-1v1H8v-1H7v-3h1z" />
      <path fill="#8f8069" d="M9-1h2v1H9z" /><path fill="#fff0aa" d="M8-5h1v2H8z" />
    </g>}
    {pose === 'writing' && <g>
      <path fill="#f4e9d6" stroke="#a8987a" strokeWidth={0.4} d="M17 2h6v7h-6z" />
      <path stroke="#a8987a" strokeWidth={0.4} d="M18 5h3M18 7h3" />
      <g className="crab-pencil"><path stroke="#e9b34c" strokeWidth={1.2} d="m17 5 4-5" /><path stroke="#34302e" strokeWidth={0.7} d="m16.5 5.7.5-.7" /></g>
    </g>}
    {gesture === 'cooking' && <g className="crab-prop"><path fill="#92745e" d="M17 3h7v5h-1v1h-5V8h-1z"/><g className="crab-stir"><path stroke="#654c3c" d="m20.8 5-3.3-3.6"/><Grip x={17.8} y={2} /></g><g className="crab-steam" fill="#d9b799"><rect x={18} y={0} width={1} height={1}/><rect x={22} y={-2} width={1} height={1}/></g></g>}
    {gesture === 'making' && <Wrench />}
    {gesture === 'sorting' && <StackBooks />}
    {gesture === 'growing' && <g className="crab-prop"><path fill="#ae8167" d="M18 6h6l-1 3h-4z"/><Grip x={18.6} y={6.2} /><g className="crab-sprout" fill="#80a576"><path d="M20 6V1h1v5zM20 3h-3V0h2v1h1zM21 2V0h3v2z"/></g></g>}
    {gesture === 'exploring' && <g className="crab-glass" fill="none" stroke="#8d9f9e" strokeWidth={1}><circle cx={21} cy={1} r={2.5}/><path d="m19 3-3 4"/><Grip x={17.5} y={5} /></g>}
    {gesture === 'playing' && <g className="crab-star" fill="#e2b75d"><path d="m21-5 1 3 3 1-3 1-1 3-1-3-3-1 3-1z"/></g>}
    {pose === 'error' && <path fill="var(--danger, #ba493b)" d="M19-4h1v4h-1zM19 1h1v1h-1z" />}
  </svg>
}
