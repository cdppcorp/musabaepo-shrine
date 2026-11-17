/* AI 안경: 켜면 보이는 것마다 옆에 설명 카드가 붙습니다 (튜토리얼처럼).
 * 화면 단추(HUD) 설명을 먼저 놓고, 맵 위 장소 설명은 단추 · 다른 카드와 겹치지 않는 자리를 찾아 놓습니다.
 * 좌표는 모두 캔버스 CSS 픽셀입니다 (main.js의 textLayer 상태에서 부릅니다). */

const CYAN = '#5ee6ff'
const EDGE = 6

/**
 * @param {CanvasRenderingContext2D} c
 * @param {{
 *   hud: { rect: number[], side: 'below'|'above'|'left', title: string, text: string }[],
 *   world: { ax: number, ay: number, pad: number, title: string, text: string, color: string }[],
 *   blocks: number[][], keep: number[][], soft: number[][], w: number, h: number, small: boolean, t: number, max: number, font: string,
 * }} o
 */
export function drawLens(c, o) {
  c.save()
  c.textAlign = 'left'
  c.textBaseline = 'top'
  vignette(c, o.w, o.h)
  const hard = o.blocks.map(r => grow(r, 4))
  // 내 캐릭터는 어떤 카드도 덮지 않습니다 (설명 자리 고를 때만 막고, 설명 대상에서는 빼지 않음)
  const keep = (o.keep ?? []).map(r => grow(r, 2))
  const placed = [...keep]
  const drawn = []
  for (const n of o.hud) {
    const box = measure(c, n, o)
    const [r, a] = placeHud(n, box, o, hard, placed)
    if (!r) continue
    placed.push(grow(r, 4))
    drawn.push({ n, box, r, a })
  }
  // 맵 위 설명: 설명하는 물건 자체는 가리지 않게 (첫 시도에서만)
  const own = o.world.map(n => [n.ax - n.pad, n.ay - n.pad, n.pad * 2, n.pad * 2])
  let count = 0
  for (const n of o.world) {
    if (count >= o.max) break
    if (hard.some(b => inside(n.ax, n.ay, b))) continue
    const box = measure(c, n, o)
    const r = placeWorld(n, box, o, hard, placed, [...o.soft, ...own])
    if (!r) continue
    placed.push(grow(r, 4))
    drawn.push({ n, box, r, a: [n.ax, n.ay] })
    count++
  }
  // 선을 먼저 긋고 카드를 덮어, 선이 글자를 가로지르지 않게 합니다
  for (const d of drawn) leader(c, d.a, d.r, o.t)
  for (const d of drawn) card(c, d, o)
  c.restore()
}

/** 화면 가장자리에 옅은 청록빛: 안경을 쓰고 있다는 표시 */
function vignette(c, w, h) {
  const g = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.38, w / 2, h / 2, Math.max(w, h) * 0.75)
  g.addColorStop(0, 'rgba(94,230,255,0)')
  g.addColorStop(1, 'rgba(94,230,255,.11)')
  c.fillStyle = g
  c.fillRect(0, 0, w, h)
}

function sizes(small) {
  return small
    ? { title: 12, body: 11, line: 15, padX: 8, padY: 6, maxW: 132 }
    : { title: 13, body: 12, line: 17, padX: 10, padY: 7, maxW: 204 }
}

/** 카드 크기와 줄바꿈 */
function measure(c, n, o) {
  const s = sizes(o.small)
  c.font = `800 ${s.title}px ${o.font}`
  const tw = c.measureText(n.title).width
  c.font = `500 ${s.body}px ${o.font}`
  const lines = wrap(c, n.text, Math.max(s.maxW, Math.min(tw, s.maxW + 40)))
  const bw = Math.max(tw, ...lines.map(l => c.measureText(l).width))
  return { lines, w: Math.ceil(bw) + s.padX * 2, h: s.padY * 2 + s.title + 4 + lines.length * s.line - (s.line - s.body) + 2, s }
}

/** 띄어쓰기 단위로 줄을 나누고, 한 낱말이 너무 길면 글자 단위로 자릅니다 */
function wrap(c, text, maxW) {
  const out = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (c.measureText(next).width <= maxW) { line = next; continue }
    if (line) out.push(line)
    line = ''
    let piece = ''
    for (const ch of word) {
      if (c.measureText(piece + ch).width > maxW && piece) { out.push(piece); piece = '' }
      piece += ch
    }
    line = piece
  }
  if (line) out.push(line)
  return out
}

function placeHud(n, box, o, hard, placed) {
  const [x, y, w, h] = n.rect
  const step = Math.round(box.h * 0.5) + 6
  const blockers = [...hard.filter(b => !same(b, grow(n.rect, 4))), ...placed]
  if (n.side === 'left') {
    const a = [x, y + h / 2]
    for (let i = 0; i < 8; i++) {
      for (const dy of i ? [-i * step, i * step] : [0]) {
        const r = fit([x - 14 - box.w, y + h / 2 - box.h / 2 + dy, box.w, box.h], o)
        if (free(r, blockers)) return [r, a]
      }
    }
    return [null]
  }
  const below = n.side === 'below'
  const a = [x + w / 2, below ? y + h : y]
  const xs = [x + w / 2 - box.w / 2, x + w - box.w, x]
  for (let i = 0; i < 9; i++) {
    const top = below ? y + h + 12 + i * step : y - 12 - box.h - i * step
    for (const left of xs) {
      const r = fit([left, top, box.w, box.h], o)
      if (free(r, blockers)) return [r, a]
    }
  }
  return [null]
}

function placeWorld(n, box, o, hard, placed, soft) {
  const { ax, ay } = n
  const tries = []
  for (const g of [n.pad + 16, n.pad + 56]) {
    const q = g * 0.7
    tries.push(
      [ax + g, ay - box.h / 2], [ax - g - box.w, ay - box.h / 2],
      [ax + q, ay - q - box.h], [ax - q - box.w, ay - q - box.h],
      [ax - box.w / 2, ay - g - box.h], [ax + q, ay + q], [ax - q - box.w, ay + q], [ax - box.w / 2, ay + g],
    )
  }
  for (const avoid of [[...hard, ...placed, ...soft], [...hard, ...placed]]) {
    for (const [left, top] of tries) {
      const r = fit([left, top, box.w, box.h], o)
      // 화면 끝에 밀려 붙느라 설명하는 곳에서 너무 멀어지면 쓰지 않습니다
      if (Math.hypot(r[0] - left, r[1] - top) > 60) continue
      if (free(r, avoid)) return r
    }
  }
  return null
}

/** 선: 설명하는 곳(점)에서 카드 가장 가까운 곳까지 */
function leader(c, [ax, ay], [x, y, w, h], t) {
  const px = Math.max(x, Math.min(ax, x + w))
  const py = Math.max(y, Math.min(ay, y + h))
  c.strokeStyle = 'rgba(94,230,255,.75)'
  c.lineWidth = 1
  c.setLineDash([3, 3])
  c.beginPath()
  c.moveTo(Math.round(ax) + 0.5, Math.round(ay) + 0.5)
  c.lineTo(Math.round(px) + 0.5, Math.round(py) + 0.5)
  c.stroke()
  c.setLineDash([])
  const pulse = 0.5 + 0.5 * Math.sin(t / 260)
  c.fillStyle = `rgba(94,230,255,${0.18 + pulse * 0.22})`
  c.beginPath()
  c.arc(ax, ay, 5 + pulse * 2, 0, Math.PI * 2)
  c.fill()
  c.fillStyle = CYAN
  c.beginPath()
  c.arc(ax, ay, 2.5, 0, Math.PI * 2)
  c.fill()
}

/** 카드: 짙은 유리판 + 청록 테두리 + 네 모서리 꺾쇠 (AR 안경 느낌) */
function card(c, { n, box, r }, o) {
  const [x, y, w, h] = r.map(Math.round)
  const s = box.s
  c.fillStyle = 'rgba(0,0,0,.35)'
  c.fillRect(x + 2, y + 3, w, h)
  c.fillStyle = 'rgba(6,20,34,.94)'
  c.fillRect(x, y, w, h)
  c.strokeStyle = 'rgba(94,230,255,.45)'
  c.lineWidth = 1
  c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  c.fillStyle = CYAN
  const L = 7
  for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
    c.fillRect(sx > 0 ? cx : cx - L, sy > 0 ? cy : cy - 2, L, 2)
    c.fillRect(sx > 0 ? cx : cx - 2, sy > 0 ? cy : cy - L, 2, L)
  }
  c.font = `800 ${s.title}px ${o.font}`
  c.fillStyle = n.color ?? '#7ff0ff'
  c.fillText(n.title, x + s.padX, y + s.padY)
  c.font = `500 ${s.body}px ${o.font}`
  c.fillStyle = '#d8eef6'
  let ty = y + s.padY + s.title + 5
  for (const line of box.lines) {
    c.fillText(line, x + s.padX, ty)
    ty += s.line
  }
}

/* 사각형 [x, y, w, h] 도우미 */
function grow([x, y, w, h], d) { return [x - d, y - d, w + d * 2, h + d * 2] }
function same(a, b) { return a.every((v, i) => Math.abs(v - b[i]) < 0.5) }
function inside(px, py, [x, y, w, h]) { return px >= x && px <= x + w && py >= y && py <= y + h }
function hit(a, b) { return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3] }
function free(r, list) { return !list.some(b => hit(r, b)) }
function fit([x, y, w, h], o) {
  return [Math.max(EDGE, Math.min(o.w - EDGE - w, x)), Math.max(EDGE, Math.min(o.h - EDGE - h, y)), w, h]
}
