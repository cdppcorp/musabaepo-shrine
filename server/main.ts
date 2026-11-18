// 무사배포 기원소 서버. HTTP와 실시간(WebSocket)을 한 프로세스에서 받습니다.
//
// 끝내기 (SIGTERM · SIGINT, docker compose stop · 배포):
//   새 연결을 받지 않음 → 모든 WebSocket에 1012(서버 재시작)를 보내고 최대 3초 기다림
//   → 처리 중인 HTTP 요청을 최대 2초 기다림 → DB 체크포인트 · 닫기 → 종료(0).
//   전체가 8초를 넘으면 강제로 끝냅니다 (Docker 기본 유예 10초 안). 신호를 한 번 더 받으면 바로 끝냅니다.
// 예외 처리:
//   · 잡히지 않은 예외(uncaughtException): 프로세스 상태를 믿을 수 없으므로 로그 · 알림을 남기고
//     위와 같은 순서로 정리한 뒤 1로 끝냅니다. Docker(restart: unless-stopped)가 다시 띄웁니다.
//     WebSocket 메시지 · 주기 작업 · 요청 처리 안의 예외는 각자 잡으므로 여기까지 오는 일은 드뭅니다.
//   · 처리되지 않은 Promise 거부(unhandledRejection): 로그만 남기고 계속 돕니다.
//     요청 처리 Promise는 아래에서 잡고, 나머지는 알림처럼 기다리지 않는 작업이라 공유 상태를 망가뜨리지 않습니다.
import { createServer } from 'node:http'
import { config, devSkipHumanCheck, isProd } from './config.ts'
import { closeDb } from './db.ts'
import { handleRequest } from './http.ts'
import { handleUpgrade, startRealtime, stopRealtime } from './realtime.ts'
import { cleanupUploads } from './uploads.ts'
import { allShrines, seedShrines } from './shrines.ts'
import { notify } from './notify.ts'
import { startRetention } from './retention.ts'

/** 끝내기 전체 제한 시간 (Docker stop 기본 유예 10초 안) */
const SHUTDOWN_MS = 8_000
const WS_CLOSE_WAIT_MS = 3_000
const HTTP_DRAIN_MS = 2_000

seedShrines()
allShrines()

// 요청 전체 60초(느린 모바일에서 10MB 이미지 올리기), 헤더는 10초 안에 (느린 헤더 공격은 그대로 막음)
const server = createServer({ requestTimeout: 60_000, headersTimeout: 10_000 }, (req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('[shrine] 요청 처리 실패', err)
    try {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end()
    } catch {
      res.destroy()
    }
  })
})
// 앞단 프록시(Caddy)의 keep-alive(기본 2분)보다 길게: 서버가 먼저 끊으면 그 사이 들어온 요청이 드물게 502가 됩니다
server.keepAliveTimeout = 130_000
server.maxHeadersCount = 50

server.on('upgrade', (req, socket, head) => {
  try {
    const path = new URL(req.url ?? '/', 'http://local').pathname
    if (path !== `${config.basePath}/ws`) {
      socket.destroy()
      return
    }
    handleUpgrade(req, socket, head)
  } catch (err) {
    console.error('[shrine] WebSocket 연결 처리 실패', err)
    socket.destroy()
  }
})

server.on('error', err => {
  console.error(`[shrine] 서버를 열지 못했습니다 (${config.host}:${config.port}):`, err.message)
  void shutdown('listen-error', 1)
})

startRealtime()

server.listen(config.port, config.host, () => {
  console.log(`[shrine] http://${config.host}:${config.port}${config.basePath}/ (${isProd ? '운영' : '개발'})`)
  if (devSkipHumanCheck) console.warn('[shrine] 개발 모드: Turnstile 키가 없어 사람 확인을 건너뜁니다. 운영에서는 키가 꼭 필요합니다.')
  if (isProd) notify('서버 시작', { 주소: config.publicOrigin, Node: process.version })
})

/* ── 끝내기 ── */

let stopping = false
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 정리하고 끝냅니다. 두 번째 부름은 무시합니다 (제한 시간이 지나면 강제 종료) */
export async function shutdown(why: string, exitCode = 0): Promise<void> {
  if (stopping) return
  stopping = true
  process.exitCode = exitCode
  console.log(`[shrine] 끝내는 중 (${why}) …`)
  const force = setTimeout(() => {
    console.error(`[shrine] ${SHUTDOWN_MS / 1000}초 안에 정리하지 못해 강제로 끝냅니다`)
    process.exit(exitCode || 1)
  }, SHUTDOWN_MS)
  force.unref()
  // 1) 새 연결 거부 (처리 중인 요청은 마저 끝냄)
  const drained = new Promise<void>(r => server.close(() => r()))
  server.closeIdleConnections()
  // 2) WebSocket: 1012로 닫고 기다림
  try {
    await stopRealtime(WS_CLOSE_WAIT_MS)
  } catch (err) {
    console.error('[shrine] 실시간 연결 정리 실패', err)
  }
  // 3) 처리 중인 HTTP 요청을 조금 기다린 뒤 남은 연결을 끊음
  await Promise.race([drained, sleep(HTTP_DRAIN_MS)])
  server.closeAllConnections()
  // 4) DB: WAL을 db 파일로 옮기고 닫음
  try {
    closeDb()
  } catch (err) {
    console.error('[shrine] DB 닫기 실패', err)
  }
  console.log(`[shrine] 끝났습니다 (${why})`)
  process.exit(exitCode)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) {
      console.error(`[shrine] ${signal}를 다시 받아 바로 끝냅니다`)
      process.exit(1)
    }
    void shutdown(signal, 0)
  })
}

process.on('uncaughtException', err => {
  console.error('[shrine] 잡히지 않은 예외 — 정리한 뒤 끝냅니다 (Docker가 다시 띄웁니다)', err)
  notify('서버 비정상 종료', { 이유: `${err?.name ?? 'Error'}: ${String(err?.message ?? '').slice(0, 120)}` })
  void shutdown('uncaughtException', 1)
})

process.on('unhandledRejection', reason => {
  console.error('[shrine] 처리되지 않은 Promise 거부 (서버는 계속 돕니다)', reason)
})

/* ── 주기 작업 ── */

// 접수에 안 쓰인 지 하루 넘은 이미지 정리 (시작할 때 · 6시간마다)
const runCleanup = () => {
  try {
    cleanupUploads()
  } catch (err) {
    console.error('[shrine] 이미지 정리 실패', err)
  }
}
runCleanup()
setInterval(runCleanup, 6 * 3600_000).unref()
// 개인정보 보관 기간 정리 (시작할 때 · 하루마다, retention.ts)
startRetention()
