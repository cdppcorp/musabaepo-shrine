// 시험용 (Node 대상): server/main.ts를 띄우고 표준 입력 명령으로 신호 · 예외를 흉내 냅니다 (Windows는 SIGTERM을 보낼 수 없어서).
//   term   → process.emit('SIGTERM')   정상 종료와 같은 길
//   crash  → 잡히지 않은 예외
//   reject → 처리되지 않은 Promise 거부
// Python 대상은 같은 명령을 SHRINE_TEST_STDIN=1일 때 서버가 직접 읽습니다 (README.md 참고).
import { pathToFileURL } from 'node:url'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
await import(pathToFileURL(join(ROOT, 'server', 'main.ts')).href)
process.stdin.setEncoding('utf8')
process.stdin.on('data', s => {
  for (const cmd of s.split('\n').map(x => x.trim()).filter(Boolean)) {
    if (cmd === 'term') process.emit('SIGTERM', 'SIGTERM')
    if (cmd === 'crash') setTimeout(() => { throw new Error('시험용 예외') })
    if (cmd === 'reject') Promise.reject(new Error('시험용 거부'))
  }
})
