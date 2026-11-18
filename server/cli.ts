// 운영 도구. 운영자가 사당을 손으로 넣고, 등록소 접수를 승인하고, 상태를 바꿀 때 씁니다.
//
//   npm run shrine -- list
//   npm run shrine -- add <사당.json>          (규칙 검사 후 추가. 파일 대신 - 이면 표준 입력에서 읽음)
//   npm run shrine -- upload <이미지|->         (사당 이미지를 DATA_DIR/uploads에 넣고 screens에 쓸 이름 up/<…>을 알려 줌)
//   npm run shrine -- status <slug> live|check (점검중 전환)
//   npm run shrine -- remove <slug> [사유]      (등록소에서 온 사당이면 그 접수는 반려로)
//   npm run shrine -- move <slug> <자리>        (다른 빈 자리로 옮기기)
//   npm run shrine -- posts                     (AI 트렌드 게시판 글 · 신고 수)
//   npm run shrine -- post-hide <id> | post-show <id> | post-del <id>
//   npm run shrine -- projects [all]            (내 프로젝트 등록소 접수: 검토할 것만, all이면 전부)
//   npm run shrine -- approve <접수번호> [자리]  (빈 자리에 사당 세우기 · 링크 변경 승인)
//   npm run shrine -- reject <접수번호> [사유]   (접수 반려 · 변경 반려)
//   npm run shrine -- erase <접수번호>           (그 접수의 개인정보를 30일을 기다리지 않고 바로 파기. 되돌릴 수 없음)
//   npm run shrine -- blocks                    (지금 걸려 있는 차단 · 강퇴)
//   npm run shrine -- block-ip <IP> <기간> [사유] (IP 차단. 기간: 30m · 12h · 7d, 최대 90d. IPv6는 /64 대역)
//   npm run shrine -- unblock <번호>            (차단 · 강퇴 풀기)
//   npm run shrine -- schema                    (DB 구조 버전)
//
// 서버가 떠 있는 동안 바꾸면 30초 안에 맵 정보(/api/world)에 반영됩니다. 이미 들어와 있는 사람은 새로고침해야 보입니다.
// 차단은 10초 안에 서버에 반영되고, 걸리는 접속자는 그때 끊깁니다.
// Docker: docker compose exec -T shrine node --disable-warning=ExperimentalWarning server/cli.ts <명령>
//   (표준 입력을 쓰는 add - · upload - 는 -T가 꼭 필요합니다: ... cli.ts upload - < shot.png)
import { readFileSync } from 'node:fs'
import { db, SCHEMA_VERSION } from './db.ts'
import { addBlock, listBlocks, removeBlock, ModerationError } from './moderation.ts'
import { saveUpload } from './uploads.ts'
import { destroyProjectNow } from './retention.ts'
import { allShrines, clearShrineCache, insertShrine, validateShrine, type Shrine } from './shrines.ts'
import { allPostsForAdmin, deletePost, setPostHidden } from './ai.ts'
import { approveProject, projectsForAdmin, rejectProject } from './registry.ts'
import { moveShrine, removeShrine, setShrineStatus } from './ops.ts'

const [cmd, a, b] = process.argv.slice(2)

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

switch (cmd) {
  case 'list': {
    clearShrineCache()
    for (const s of allShrines()) console.log(`${String(s.plot).padStart(2)}  ${s.status.padEnd(5)}  ${s.slug.padEnd(20)}  ${s.name}  (${s.domain})`)
    break
  }
  case 'add': {
    if (!a) fail('사용법: npm run shrine -- add <사당.json | ->')
    let input: Partial<Shrine>
    try {
      input = JSON.parse(readFileSync(a === '-' ? 0 : a, 'utf8')) as Partial<Shrine>
    } catch (e) {
      fail(`사당 JSON을 읽지 못했습니다: ${(e as Error).message}`)
    }
    // 등록소에서 생긴 칸(저장소 · 이메일 · 접수 번호)은 비워 두면 기본값
    const s = { repo: '', email: '', emailPublic: false, projectId: 0, ...input } as Shrine
    const errors = validateShrine(s)
    if (errors.length) fail(`규칙에 맞지 않습니다: ${errors.join(' / ')}`)
    insertShrine(s)
    console.log(`추가했습니다: ${s.slug} (자리 ${s.plot})`)
    break
  }
  case 'status': {
    if (!a || (b !== 'live' && b !== 'check')) fail('사용법: npm run shrine -- status <slug> live|check')
    try {
      setShrineStatus(a, b)
    } catch (e) {
      fail((e as Error).message)
    }
    console.log(`${a} → ${b}`)
    break
  }
  case 'remove': {
    if (!a) fail('사용법: npm run shrine -- remove <slug> [사유]')
    try {
      const s = removeShrine(a, process.argv.slice(4).join(' '))
      console.log(`지웠습니다: ${a}${s.projectId ? ` (접수 #${s.projectId}는 반려로)` : ''}. 실제 화면 파일(public/img/shrines/)은 직접 지워 주세요.`)
    } catch (e) {
      fail((e as Error).message)
    }
    break
  }
  case 'move': {
    if (!a || b == null) fail('사용법: npm run shrine -- move <slug> <자리 번호>')
    try {
      const r = moveShrine(a, b)
      console.log(`${a}: 자리 ${r.from} → ${r.shrine.plot}`)
    } catch (e) {
      fail((e as Error).message)
    }
    break
  }
  case 'posts': {
    for (const p of allPostsForAdmin()) {
      const when = new Date(p.at + 9 * 3600_000).toISOString().slice(5, 16).replace('T', ' ')
      console.log(`${String(p.id).padStart(4)}  ${when}  ${p.hidden ? '숨김' : '보임'}  신고 ${p.reports}  [${p.topic}] ${p.text}  — ${p.nick}`)
    }
    break
  }
  case 'post-hide':
  case 'post-show': {
    const id = Number(a)
    if (!Number.isInteger(id) || !setPostHidden(id, cmd === 'post-hide')) fail(`없는 글입니다: ${a}`)
    console.log(`${id} → ${cmd === 'post-hide' ? '숨김' : '보임'} (화면은 새로 불러올 때 반영)`)
    break
  }
  case 'post-del': {
    const id = Number(a)
    if (!Number.isInteger(id) || !deletePost(id)) fail(`없는 글입니다: ${a}`)
    console.log(`지웠습니다: ${id}`)
    break
  }
  case 'projects': {
    const rows = projectsForAdmin(a === 'all')
    if (!rows.length) console.log(a === 'all' ? '접수된 프로젝트가 없습니다.' : '검토할 접수가 없습니다. (전부 보기: projects all)')
    for (const p of rows) {
      const when = new Date(p.at + 9 * 3600_000).toISOString().slice(5, 16).replace('T', ' ')
      const linkReview = p.pending_github != null || p.pending_url != null
      const textReview = p.pending_name != null || p.pending_tagline != null || p.pending_sign != null
      const review = [linkReview && '링크', textReview && '글자', p.pending_screen != null && '이미지'].filter(Boolean)
      const day = (ms: number | null | undefined) => (ms ? new Date(ms + 9 * 3600_000).toISOString().slice(0, 10) : '')
      console.log(`#${p.id}  ${when}  ${p.status}${p.status === 'approved' && review.length ? ` (${review.join(' · ')} 변경 검토)` : ''}  ${p.name} — ${p.tagline}  [${p.category}]`)
      console.log(`      GitHub: ${p.github || '-'}${p.repo_ok ? ` (확인됨 · 별 ${p.stars})` : p.github ? ' (확인 못 함)' : ''}  서비스: ${p.url || '-'}`)
      if (linkReview) console.log(`      바꿀 링크 → GitHub: ${p.pending_github || '-'}  서비스: ${p.pending_url || '-'}`)
      if (textReview) {
        console.log(`      바꿀 글자 → 이름: ${p.pending_name ?? '(그대로)'}  소개: ${p.pending_tagline ?? '(그대로)'}  지붕: ${p.pending_sign ?? '(그대로)'}`)
      }
      const dates = [p.consent_at && `동의 ${day(p.consent_at)}`, p.closed_at && `닫힘 ${day(p.closed_at)}`, p.purged_at && `파기 ${day(p.purged_at)}`].filter(Boolean)
      if (dates.length) console.log(`      ${dates.join('  ')}`)
      console.log(`      이메일: ${p.email} (${p.email_public ? '공개' : '비공개'})  작성: ${p.nick}${p.slug ? `  사당: ${p.slug}` : ''}${p.note ? `  메모: ${p.note}` : ''}`)
      console.log(`      원하는 자리: ${p.want_plot ?? '아무 데나'}  이미지: ${p.screen ? `data/uploads/${p.screen}` : '-'}${p.pending_screen != null ? `  바꿀 이미지: ${p.pending_screen ? `data/uploads/${p.pending_screen}` : '(지움)'}` : ''}`)
    }
    break
  }
  case 'approve': {
    const id = Number(a)
    if (!Number.isInteger(id)) fail('사용법: npm run shrine -- approve <접수번호> [자리 번호]')
    const plot = b == null ? undefined : Number(b)
    if (plot != null && !Number.isInteger(plot)) fail('자리 번호는 숫자입니다')
    try {
      console.log(approveProject(id, plot))
    } catch (e) {
      fail((e as Error).message)
    }
    break
  }
  case 'reject': {
    const id = Number(a)
    if (!Number.isInteger(id)) fail('사용법: npm run shrine -- reject <접수번호> [사유]')
    try {
      console.log(rejectProject(id, process.argv.slice(4).join(' ')))
    } catch (e) {
      fail((e as Error).message)
    }
    break
  }
  case 'erase': {
    const id = Number(a)
    if (!Number.isInteger(id) || id <= 0) fail('사용법: npm run shrine -- erase <접수번호>')
    const r = destroyProjectNow(id)
    if (!r.ok) fail(r.message)
    db.prepare('INSERT INTO admin_log (at, action, target, ip_hash, detail) VALUES (?, ?, ?, ?, ?)').run(Date.now(), 'project-erase', String(id), 'cli', `운영 도구 · 이미지 ${r.images}개`)
    console.log(r.message)
    break
  }
  case 'upload': {
    if (!a) fail('사용법: npm run shrine -- upload <이미지 파일 | ->')
    let buf: Buffer
    try {
      buf = readFileSync(a === '-' ? 0 : a)
    } catch (e) {
      fail(`이미지를 읽지 못했습니다: ${(e as Error).message}`)
    }
    const r = saveUpload(buf, 'cli', 'cli')
    if (!r.ok) fail(`올리지 못했습니다: ${{ type: 'PNG · JPEG · WebP만 됩니다', size: '10MB까지입니다', full: '이미지 저장 공간이 꽉 찼습니다' }[r.reason as string] ?? r.reason}`)
    console.log(`올렸습니다: up/${r.id}  (사당 JSON의 "screens": ["up/${r.id}"]. 하루 안에 사당에 쓰지 않으면 지워집니다)`)
    break
  }
  case 'blocks': {
    const rows = listBlocks()
    if (!rows.length) console.log('걸려 있는 차단이 없습니다.')
    for (const x of rows) {
      const until = new Date(x.until + 9 * 3600_000).toISOString().slice(5, 16).replace('T', ' ')
      console.log(`#${x.id}  ${x.kind === 'kick' ? '강퇴' : '차단'}  ~${until}  ${x.byIp ? 'IP' : ''}${x.byIp && x.bySid ? '+' : ''}${x.bySid ? '입장 표' : ''} (${x.tag})  ${x.nick || '-'}${x.reason ? `  사유: ${x.reason}` : ''}`)
    }
    break
  }
  case 'block-ip': {
    const m = /^(\d{1,6})(m|h|d)$/.exec(b ?? '')
    if (!a || !m) fail('사용법: npm run shrine -- block-ip <IP> <기간: 30m | 12h | 7d> [사유]')
    // 서버와 같은 키로 IP 키를 만들어야 해서 서버와 같은 TICKET_SECRET이 있어야 합니다
    if (!(process.env.TICKET_SECRET ?? '').trim()) fail('TICKET_SECRET이 없습니다. 서버와 같은 .env로 실행해 주세요 (예: node --env-file=.env … 또는 docker compose exec)')
    const ms = Number(m[1]) * { m: 60_000, h: 3600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd']
    try {
      const x = addBlock({ kind: 'block', ipKey: a, ms, reason: process.argv.slice(5).join(' ') })
      db.prepare('INSERT INTO admin_log (at, action, target, ip_hash, detail) VALUES (?, ?, ?, ?, ?)').run(Date.now(), 'ip-block', x.tag, 'cli', `운영 도구 · ${b}`)
      console.log(`막았습니다: #${x.id} (${x.tag}, ${b}). 서버에는 10초 안에 반영됩니다.`)
    } catch (e) {
      fail(e instanceof ModerationError ? e.message : `막지 못했습니다: ${(e as Error).message}`)
    }
    break
  }
  case 'unblock': {
    const id = Number(a)
    if (!Number.isInteger(id) || id <= 0) fail('사용법: npm run shrine -- unblock <번호>  (번호는 blocks로 확인)')
    const x = removeBlock(id)
    if (!x) fail(`없는 차단입니다: ${a}`)
    db.prepare('INSERT INTO admin_log (at, action, target, ip_hash, detail) VALUES (?, ?, ?, ?, ?)').run(Date.now(), 'block-remove', x.tag, 'cli', `운영 도구 · #${id}`)
    console.log(`풀었습니다: #${id} (${x.tag}). 서버에는 10초 안에 반영됩니다.`)
    break
  }
  case 'schema': {
    const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    console.log(`DB 구조 버전 v${v} (이 서버가 아는 마지막 버전 v${SCHEMA_VERSION})`)
    break
  }
  default:
    fail('명령: list | add <json|-> | upload <이미지|-> | status <slug> live|check | remove <slug> [사유] | move <slug> <자리> | posts | post-hide <id> | post-show <id> | post-del <id> | projects [all] | approve <id> [자리] | reject <id> [사유] | erase <id> | blocks | block-ip <IP> <기간> [사유] | unblock <번호> | schema')
}
