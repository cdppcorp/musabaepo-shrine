// NPC 시험: NPC가 사당 구경을 갈 때 자기 채널의 사당만 고르는지 봅니다 (채널 1 · 2에 사당을 서로 다른 자리에 넣음).
// 예전 npc-run.mjs(준비) + npc-unit.mjs(server/npc.ts를 직접 부름)를 합쳤습니다.
//   · NPC 목적지: driver 훅 npc-goals (node: lib/node-hooks.mjs, py: python -m shrine.cli dev npc-goals)
//   · 자리 좌표 · 사당 목록: 서버를 잠깐 띄워 /api/world에서 받음 (예전에는 world.ts · shrines.ts를 직접 읽음)
//   SHRINE_TARGET=node|py node tests/conformance/npc.test.mjs
import * as D from './driver.mjs'
import { suite } from './lib/check.mjs'

const T = suite('npc')
const ok = T.ok
const PORT = D.PORTS.npc
const DATA = await D.freshDataDir('npc')
const env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1' }
delete env.ADMIN_PASSWORD
const shrine = (slug, channel, plot) => ({
  slug, name: slug, tagline: `${slug} 시험`, category: 'devtools', domain: `${slug}.example.com`, url: `https://${slug}.example.com`,
  operator: '시험', keeper: false, paid: false, verifiedDomain: '2026-11-18', verifiedBusiness: null, joinedAt: '2026-11-18',
  status: 'live', prayer: 'deploy', charm: null, deco: [], screens: ['a.png'], capturedAt: '2026-11-18', sign: '', channel, plot,
})
for (const s of [shrine('n1-a', 1, 0), shrine('n1-b', 1, 12), shrine('n1-c', 1, 19), shrine('n2-a', 2, 5), shrine('n2-b', 2, 17)]) {
  const r = D.cli(['add', '-'], { env, input: JSON.stringify(s) })
  if (r.status !== 0) throw new Error(`seed ${s.slug}: ${r.stderr}`)
}

// 자리 좌표(PLOTS)와 서 있는 사당은 서버가 내려 주는 값으로
const srv = await D.startServer(env)
let PLOTS = []
let live = []
try {
  const w = await (await fetch(`http://127.0.0.1:${PORT}/api/world`)).json()
  PLOTS = w.world.plots
  live = w.shrines.filter(s => s.status === 'live')
} finally {
  await D.stopServer(srv)
}
console.log('사당:', live.map(s => `${s.slug}(채널 ${s.channel} · ${s.plot})`).join(' '))
/** 목적지에서 가장 가까운 자리 앞 */
const nearestPlot = at => PLOTS.reduce((best, p) => (Math.hypot(p.front.x - at.x, p.front.y - at.y) < Math.hypot(best.front.x - at.x, best.front.y - at.y) ? p : best))

for (const id of [1, 2]) {
  const mine = new Set(live.filter(s => s.channel === id).map(s => s.plot))
  const goals = D.npcGoals(env, id, 4000).filter(g => g.kind === 'shrine')
  const plots = goals.map(g => nearestPlot(g.at).id)
  const wrong = plots.filter(p => !mine.has(p))
  ok(`채널 ${id}: 사당 구경 목적지 ${goals.length}번이 모두 이 채널 사당 앞 (${[...mine].join(',')}번)`,
    goals.length > 100 && wrong.length === 0, wrong.length ? `다른 자리 ${[...new Set(wrong)].join(',')}` : `간 자리 ${[...new Set(plots)].sort((a, b) => a - b).join(',')}`)
  ok(`채널 ${id}: 이 채널 사당을 골고루 감`, [...mine].every(p => plots.includes(p)))
}
// 채널 3에는 NPC가 없고(NPC_CHANNELS = 1 · 2), 사당이 없는 채널은 사당 구경을 고르지 않습니다
const shrinesInEmpty = live.filter(s => s.channel === 3)
if (!shrinesInEmpty.length) {
  const shrineGoals = D.npcGoals(env, 3, 2000).filter(g => g.kind === 'shrine').length
  ok('사당이 없는 채널(3)에서는 사당 구경을 고르지 않음', shrineGoals === 0, `${shrineGoals}번`)
}
await T.done()
