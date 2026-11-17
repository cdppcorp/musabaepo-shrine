// 운영 도구. 운영자가 사당을 손으로 넣고, 등록소 접수를 승인하고, 상태를 바꿀 때 씁니다.
//
//   npm run shrine -- list
//   npm run shrine -- add <사당.json>          (규칙 검사 후 추가)
//   npm run shrine -- status <slug> live|check (점검중 전환)
//   npm run shrine -- remove <slug> [사유]      (등록소에서 온 사당이면 그 접수는 반려로)
//   npm run shrine -- move <slug> <자리>        (다른 빈 자리로 옮기기)
//   npm run shrine -- posts                     (AI 트렌드 게시판 글 · 신고 수)
//   npm run shrine -- post-hide <id> | post-show <id> | post-del <id>
//   npm run shrine -- projects [all]            (내 프로젝트 등록소 접수: 검토할 것만, all이면 전부)
//   npm run shrine -- approve <접수번호> [자리]  (빈 자리에 사당 세우기 · 링크 변경 승인)
//   npm run shrine -- reject <접수번호> [사유]   (접수 반려 · 링크 변경 반려)
//
// 서버가 떠 있는 동안 바꾸면 30초 안에 맵 정보(/api/world)에 반영됩니다. 이미 들어와 있는 사람은 새로고침해야 보입니다.
import { readFileSync } from 'node:fs'
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
    if (!a) fail('사용법: npm run shrine -- add <사당.json>')
    // 등록소에서 생긴 칸(저장소 · 이메일 · 접수 번호)은 비워 두면 기본값
    const s = { repo: '', email: '', emailPublic: false, projectId: 0, ...(JSON.parse(readFileSync(a, 'utf8')) as Partial<Shrine>) } as Shrine
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
      const review = p.pending_github != null || p.pending_url != null
      console.log(`#${p.id}  ${when}  ${p.status}${review ? ' (링크 변경 검토)' : ''}  ${p.name} — ${p.tagline}  [${p.category}]`)
      console.log(`      GitHub: ${p.github || '-'}${p.repo_ok ? ` (확인됨 · 별 ${p.stars})` : p.github ? ' (확인 못 함)' : ''}  서비스: ${p.url || '-'}`)
      if (review) console.log(`      바꿀 링크 → GitHub: ${p.pending_github || '-'}  서비스: ${p.pending_url || '-'}`)
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
  default:
    fail('명령: list | add <json> | status <slug> live|check | remove <slug> [사유] | move <slug> <자리> | posts | post-hide <id> | post-show <id> | post-del <id> | projects [all] | approve <id> [자리] | reject <id> [사유]')
}
