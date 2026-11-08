/** 启动开屏：橙底白色 spark 随加载伸缩，加载完成后 spark 炸开成窗口露出主界面。骨架在 index.html，首帧即可见。 */
// 参数在 design/splash/preview.html 中调定
const MIN_SHOW = 500
const PERIOD = 900
const ENTER = 260
const CHARGE = 90
const BURST = 420
const FADE_FROM = 0.25
const FADE_TO = 0.75
const CURVE = 1.8
const LAND = 300
const FAILSAFE = 8000

// 按官方 logo（Simple Icons claude.svg，24×24）逐条实测重建
// 每条光芒 [轴线角度°, 长度, 中段测点, 中段宽, 中段偏移, 端头测点, 端头宽, 端头偏移]，原点为光芒汇聚中心
type Ray = readonly [number, number, number, number, number, number, number, number]
const RAYS: readonly Ray[] = [
  [-179.2, 11.59, 7, 1.38, -0.26, 10.39, 1.44, -0.11],
  [-143.6, 11.83, 7, 2.23, -0.05, 10.63, 2.37, -0.05],
  [-114.6, 12.93, 7, 2.49, 0.34, 11.73, 2.79, 0.19],
  [-76.7, 11.82, 7, 1.83, 0.31, 10.62, 2.00, 0.01],
  [-46.0, 12.53, 7, 2.97, 0.56, 11.33, 2.62, 0.18],
  [-8.6, 12.43, 7, 1.86, 0.31, 11.23, 1.72, 0.10],
  [11.8, 12.67, 7, 1.45, 0.41, 11.47, 2.10, 0.21],
  [43.8, 12.66, 7, 1.45, -0.65, 11.46, 1.18, -0.88],
  [53.7, 12.14, 7, 2.01, 0.35, 10.94, 1.96, 0.51],
  [90.8, 12.08, 7, 1.58, -0.55, 10.88, 2.02, -0.02],
  [121.0, 11.75, 7, 1.59, -0.72, 10.55, 1.49, -0.23],
  [144.5, 11.06, 7, 1.81, -0.29, 9.86, 1.82, -0.16]
]
const CORE_R = 2.1, ROOT = 0.8, KEEP = 2.4, EXTENT = 26.4, LOGO_PX = 120

const f3 = (v: number): number => +v.toFixed(3)
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const outCubic = (t: number): number => 1 - (1 - t) ** 3
const outBack = (t: number): number => 1 + 2.9 * (t - 1) ** 3 + 1.9 * (t - 1) ** 2
const smooth = (a: number, b: number, x: number): number => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t) }
// 官方 thinking 动画：从圆点快速伸出、在全长附近停留、再收回
const pulse = (phase: number): number => Math.sin(Math.PI * (phase - Math.floor(phase))) ** 0.6

// 一条光芒：中心线按两处实测点线性插值，端头为半圆，根部收细埋进圆核
function rayD([deg, len, a1, w1, o1, a2, w2, o2]: Ray, k: number): string {
  const ax = deg * Math.PI / 180, c = Math.cos(ax), s = Math.sin(ax)
  const at = (v1: number, v2: number, a: number): number => v1 + (v2 - v1) * (a - a1) / (a2 - a1)
  const rt = w2 / 2
  const tip = Math.max(KEEP + (len - KEEP) * k - rt, ROOT)
  const off = (a: number): number => at(o1, o2, Math.min(a, a2))
  const r0 = Math.max(at(w1, w2, ROOT), w1 * 0.6) / 2
  const pt = (a: number, o: number): string => `${f3(a * c - o * s)} ${f3(a * s + o * c)}`
  return `M${pt(ROOT, off(ROOT) - r0)}L${pt(tip, off(tip) - rt)}A${f3(rt)} ${f3(rt)} 0 0 1 ${pt(tip, off(tip) + rt)}`
    + `L${pt(ROOT, off(ROOT) + r0)}A${f3(r0)} ${f3(r0)} 0 0 1 ${pt(ROOT, off(ROOT) - r0)}Z`
}
// k 为光芒统一伸出比例（0 圆点，1 原始 logo）；收回时圆核胀大盖住根部。子路径同为顺时针，nonzero 填充取并集
function sparkD(k: number): string {
  const r = CORE_R + 1.3 * (1 - k)
  return `M${f3(r)} 0A${f3(r)} ${f3(r)} 0 1 1 ${f3(-r)} 0A${f3(r)} ${f3(r)} 0 1 1 ${f3(r)} 0Z` + RAYS.map(ray => rayD(ray, k)).join('')
}

function reduced(): boolean {
  return document.documentElement.dataset.reduceMotion === 'true' || Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

interface Pose { s: number; rot: number; wo: number; k: number }
let t0 = 0
let doneAt: number | undefined
let exitAt: number | undefined
let exitReduced = false
let snap: Pose | undefined
let frame = 0
let failsafe: ReturnType<typeof setTimeout> | undefined
let els: { root: SVGSVGElement; spark: SVGPathElement; logo: SVGGElement; hole: SVGGElement; page: HTMLElement | null } | undefined

export function startSplash(): void {
  const root = document.getElementById('splash') as SVGSVGElement | null
  const spark = document.getElementById('splash-spark') as SVGPathElement | null
  const logo = document.getElementById('splash-logo') as SVGGElement | null
  const hole = document.getElementById('splash-hole-t') as SVGGElement | null
  if (!root || !spark || !logo || !hole || els) return
  els = { root, spark, logo, hole, page: document.getElementById('root') }
  t0 = performance.now()
  failsafe = setTimeout(finishSplash, FAILSAFE)
  frame = requestAnimationFrame(tick)
}

/** 会话列表就绪后调用；保证最短展示时间，可重复调用。 */
export function finishSplash(): void {
  if (!els || doneAt !== undefined) return
  doneAt = Math.max(performance.now(), t0 + MIN_SHOW)
}

function tick(now: number): void {
  if (!els) return
  const { root, spark, logo, hole, page } = els
  const t = now - t0
  const vw = innerWidth, vh = innerHeight, unit = LOGO_PX / EXTENT
  let pose: Pose
  let showHole = false, landing = 0, finished = false

  if (exitAt === undefined && doneAt !== undefined && now >= doneAt) { exitAt = now; exitReduced = reduced() }

  if (exitAt === undefined) {
    const e = clamp01(t / ENTER)
    pose = reduced()
      ? { s: 1, rot: 0, wo: outCubic(e), k: 1 }
      : { s: lerp(0.4, 1, outBack(e)), rot: 15 * (1 - outCubic(e)), wo: outCubic(e), k: pulse(t / PERIOD) }
    snap = pose
  } else if (exitReduced) {
    const f = clamp01((now - exitAt) / 200)
    pose = snap!
    root.style.opacity = String(1 - f)
    landing = 1
    finished = f >= 1
  } else {
    const dt = now - exitAt
    const from = snap!
    if (dt < CHARGE) {
      const u = outCubic(dt / CHARGE)
      pose = { s: lerp(from.s, 0.82, u), rot: from.rot - 22 * u, wo: lerp(from.wo, 1, u), k: lerp(from.k, 1, u) }
    } else {
      const v = clamp01((dt - CHARGE) / BURST)
      const ev = v ** CURVE
      // 圆核盖住半条对角线时，橙色已被完全推出屏幕
      const sEnd = Math.hypot(vw, vh) / 2 / (CORE_R * unit) * 1.15
      pose = { s: Math.exp(lerp(Math.log(0.82), Math.log(sEnd), ev)), rot: from.rot - 22 + 100 * ev, wo: 1 - smooth(FADE_FROM, FADE_TO, v), k: 1 }
      showHole = true
      if (v >= 1) root.style.display = 'none'
    }
    landing = clamp01((dt - CHARGE - FADE_FROM * BURST) / LAND)
    finished = dt >= CHARGE + BURST && landing >= 1
  }

  const transform = `translate(${f3(vw / 2)} ${f3(vh / 2)}) scale(${f3(pose.s * unit)}) rotate(${f3(pose.rot)})`
  logo.setAttribute('transform', transform)
  logo.setAttribute('opacity', String(f3(pose.wo)))
  hole.setAttribute('transform', transform)
  hole.setAttribute('visibility', showHole ? 'visible' : 'hidden')
  spark.setAttribute('d', sparkD(pose.k))

  // 主界面只做缩放落地：整页 blur 每帧都要重绘全部界面，实测会在铺开末段卡顿 100ms 以上
  if (page && exitAt !== undefined && !exitReduced) {
    const l = outCubic(landing)
    page.style.transform = l >= 1 ? '' : `scale(${f3(lerp(1.05, 1, l))})`
  }

  if (finished) { cleanup(); return }
  frame = requestAnimationFrame(tick)
}

function cleanup(): void {
  cancelAnimationFrame(frame)
  if (failsafe) clearTimeout(failsafe)
  if (els?.page) els.page.style.transform = ''
  els?.root.remove()
  els = undefined
  void window.desk?.app.splashFinished?.().catch(error => console.error('无法恢复窗口控制按钮', error))
}
