// 밤 축제 불빛. 이번 주 켜진 초가 많을수록 어둠이 걷히고 불빛이 넓어집니다.
//   어둠은 맵 1px 크기의 작은 캔버스에 칠한 뒤 불빛 자리를 지워(destination-out) 부드럽게 키워 덮습니다.
//   초가 쌓이면 풍등이 하늘로 오르고, 아주 많아지면 담 위로 불꽃놀이가 터집니다.

/** 밝기 단계 기준 (이번 주 켜진 초, 월요일에 새로 시작): 0 · 2 · 10 · 30 · 80 · 200 → 0~5단계 */
export const GLOW_STEPS = [0, 2, 10, 30, 80, 200]

/** 이번 주 켜진 초 → 밝기 0~1 (처음 몇 개가 크게 보이도록 로그 눈금) */
export function glowTarget(today) {
  return Math.min(1, Math.log1p(Math.max(0, today)) / Math.log1p(GLOW_STEPS[GLOW_STEPS.length - 1]))
}

export function glowLevel(today) {
  let level = 0
  for (let i = 1; i < GLOW_STEPS.length; i++) if (today >= GLOW_STEPS[i]) level = i
  return level
}

/** 다음 단계까지 남은 초 (마지막 단계면 0) */
export function toNextLevel(today) {
  const next = GLOW_STEPS.find(n => n > today)
  return next == null ? 0 : next - today
}

let soft = null
/** 가운데가 진하고 가장자리로 갈수록 사라지는 둥근 빛 (한 번 만들어 늘려 씁니다) */
function softCircle() {
  if (soft) return soft
  soft = document.createElement('canvas')
  soft.width = 64
  soft.height = 64
  const c = soft.getContext('2d')
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(0,0,0,1)')
  g.addColorStop(0.45, 'rgba(0,0,0,.75)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  c.fillStyle = g
  c.fillRect(0, 0, 64, 64)
  return soft
}

let mask = null

/**
 * 어둠 덮기. lights는 [x, y, r, a] (맵 좌표), holes는 어둠을 빼 줄 사각형 [x, y, w, h] (맵 좌표, 이름표 자리).
 * c는 맵 좌표 변환이 걸린 상태여야 합니다.
 */
export function drawDarkness(c, cx, cy, vw, vh, lights, holes, b) {
  const w = Math.ceil(vw) + 2
  const h = Math.ceil(vh) + 2
  if (!mask) mask = document.createElement('canvas')
  if (mask.width !== w) mask.width = w
  if (mask.height !== h) mask.height = h
  const m = mask.getContext('2d')
  m.globalCompositeOperation = 'source-over'
  m.globalAlpha = 1
  m.clearRect(0, 0, w, h)
  const dark = 0.07 + 0.58 * (1 - b) ** 1.3
  m.fillStyle = `rgba(3,7,22,${dark.toFixed(3)})`
  m.fillRect(0, 0, w, h)
  m.globalCompositeOperation = 'destination-out'
  const grow = 0.7 + 0.9 * b
  const circle = softCircle()
  for (const [x, y, r, a] of lights) {
    const rr = r * grow
    if (x + rr < cx || x - rr > cx + vw || y + rr < cy || y - rr > cy + vh) continue
    m.globalAlpha = Math.min(1, a)
    m.drawImage(circle, x - cx - rr, y - cy - rr * 0.78, rr * 2, rr * 1.56)
  }
  m.globalAlpha = 1
  m.fillStyle = '#000'
  for (const [x, y, hw, hh] of holes) m.fillRect(x - cx, y - cy, hw, hh)
  c.save()
  c.imageSmoothingEnabled = true
  c.imageSmoothingQuality = 'high'
  c.drawImage(mask, cx, cy)
  // 밝아질수록 화면 전체가 따뜻한 빛을 띠고, 더 밝아지면 바닥 색이 살아납니다
  if (b > 0.35) {
    c.globalCompositeOperation = 'soft-light'
    c.fillStyle = `rgba(255,176,96,${((b - 0.35) * 0.48).toFixed(3)})`
    c.fillRect(cx, cy, vw + 2, vh + 2)
  }
  if (b > 0.6) {
    c.globalCompositeOperation = 'screen'
    c.fillStyle = `rgba(255,196,140,${((b - 0.6) * 0.14).toFixed(3)})`
    c.fillRect(cx, cy, vw + 2, vh + 2)
  }
  c.restore()
}

/* ── 풍등: 광장 · 신당에서 하늘로 천천히 오릅니다 ── */

export function updateSky(sky, dt, b, world, rnd = Math.random) {
  // 밝기 0.55부터 조금씩, 1이면 1초에 한 개쯤
  const rate = Math.max(0, (b - 0.55) / 0.45)
  if (rate > 0 && sky.lanterns.length < 4 + Math.round(rate * 14) && rnd() < dt * rate * 1.1) {
    const from = world.props.filter(p => p.k === 'fire' || p.k === 'temple' || p.k === 'pole')
    const p = from[Math.floor(rnd() * from.length)]
    if (p) sky.lanterns.push({ x: p.x + (rnd() - 0.5) * 40, y: p.y - 10, life: 0, max: 9 + rnd() * 5, seed: rnd() * 6, speed: 5 + rnd() * 4 })
  }
  for (const l of sky.lanterns) {
    l.life += dt
    l.y -= l.speed * dt
    l.x += Math.sin(l.life * 0.8 + l.seed) * dt * 3
  }
  sky.lanterns = sky.lanterns.filter(l => l.life < l.max)

  // 불꽃놀이: 밝기 0.9부터, 담 위 하늘(화면 위쪽)에서 터집니다
  if (b >= 0.9) {
    sky.next -= dt
    if (sky.next <= 0) {
      sky.next = 1.2 + rnd() * 1.8
      sky.burst = true
    }
  }
  for (const s of sky.sparks) {
    s.life += dt
    s.x += s.vx * dt
    s.y += s.vy * dt
    s.vy += 22 * dt
  }
  sky.sparks = sky.sparks.filter(s => s.life < s.max)
}

const FIRE_COLORS = ['#ffd36b', '#ff7a6b', '#7ad0ff', '#a8f09a', '#ff9ad5']

/** 화면 위쪽에 불꽃 하나 터뜨리기 (보이는 범위 기준) */
export function burst(sky, cx, cy, vw, rnd = Math.random) {
  const x = cx + vw * (0.15 + rnd() * 0.7)
  const y = cy + 18 + rnd() * 30
  const col = FIRE_COLORS[Math.floor(rnd() * FIRE_COLORS.length)]
  const n = 18
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const sp = 22 + rnd() * 10
    sky.sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: 1.1 + rnd() * 0.4, col })
  }
}

export function drawSky(c, sky, rect, glow) {
  for (const l of sky.lanterns) {
    const fade = Math.min(1, l.life / 0.8, (l.max - l.life) / 2)
    c.globalAlpha = Math.max(0, fade)
    glow(c, l.x, l.y + 1, 6, '#ffb347', 0.9)
    rect(c, l.x - 1, l.y - 2, 3, 4, '#ffcf7a')
    rect(c, l.x - 1, l.y - 2, 3, 1, '#ffe8b0')
    rect(c, l.x - 1, l.y + 1, 3, 1, '#f08a3a')
  }
  for (const s of sky.sparks) {
    c.globalAlpha = Math.max(0, 1 - s.life / s.max)
    rect(c, s.x, s.y, 1, 1, s.col)
  }
  c.globalAlpha = 1
}
