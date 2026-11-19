// 시험용 훅 (Node 대상): 서버 내부 함수를 한 번 부르고 결과를 표준 출력에 찍습니다. DATA_DIR은 환경 변수로.
// Python 대상은 같은 일을 `python -m shrine.cli dev <훅> …`이 합니다 (README.md 참고).
//   retention              → runRetention() 결과 JSON
//   erase-now <id>         → destroyProjectNow(id) 결과 JSON
//   notify <event> <json>  → notify(event, fields) 부르고 'done' (보내기는 프로세스가 끝나기 전에 마침)
//   npc-goals <ch> <n>     → NPC 목적지 n번 (자리는 모두 찬 것으로) JSON [{kind, at}]
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const mod = name => import(pathToFileURL(join(ROOT, 'server', name)).href)
const [cmd, a, b] = process.argv.slice(2)

switch (cmd) {
  case 'retention': {
    const m = await mod('retention.ts')
    console.log(JSON.stringify(m.runRetention()))
    break
  }
  case 'erase-now': {
    const m = await mod('retention.ts')
    console.log(JSON.stringify(m.destroyProjectNow(Number(a))))
    break
  }
  case 'notify': {
    const { notify } = await mod('notify.ts')
    notify(a, JSON.parse(b ?? '{}'))
    console.log('done')
    break
  }
  case 'npc-goals': {
    const { NpcWorld } = await mod('npc.ts')
    const id = Number(a)
    const n = Number(b)
    const world = new NpcWorld({ send: () => {}, seatTaken: () => true, room: () => 20 })
    // NPC가 없는 채널(3)은 빈 채널 상태로 목적지만 뽑아 봅니다
    const ch = world['chans'].get(id) ?? { id, target: 0, nextDrift: 0, nextSpawn: 0, lastSay: 0, npcs: new Map() }
    const goals = []
    for (let i = 0; i < n; i++) {
      const g = world['chooseGoal'](ch)
      goals.push({ kind: g.kind, at: g.at })
    }
    console.log(JSON.stringify(goals))
    process.exit(0)
  }
  default:
    console.error('훅: retention | erase-now <id> | notify <event> <json> | npc-goals <채널> <횟수>')
    process.exit(2)
}
