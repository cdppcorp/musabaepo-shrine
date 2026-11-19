// Node 기준값을 내는 도우미: server/*.ts를 그대로 불러(또는 내보내지 않은 함수는 소스에서 잘라 와) 계산한 결과를 JSON으로 찍습니다.
// Python 시험(tests/test_logic_*.py)이 같은 입력을 Python 포팅에 넣고 이 결과와 바이트까지 맞춰 봅니다.
//
//   node --disable-warning=ExperimentalWarning tests/node_ref/ref.mjs < 요청.json
//   요청: {"op": "<이름>", ...인자}   응답: JSON 하나 (stdout)
//
// 환경 변수: TICKET_SECRET · ADMIN_PASSWORD (시험이 고정 값을 넣음), DATA_DIR (db.ts가 여는 임시 폴더).
// 서버 소스는 읽기만 합니다.
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { isIP } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', '..', '..', 'server')
const load = name => import(pathToFileURL(join(SERVER, name)).href)

/**
 * server/<file>에서 맨 왼쪽에 선언된 함수 · 상수를 잘라 TS 타입을 지우고 실행합니다 (내보내지 않은 것을 원본 그대로 쓰려고).
 * deps: 그 코드가 쓰는 바깥 이름 → 값. 돌려주는 값: 이름 → 정의된 값.
 */
function extract(file, names, deps = {}, after = '') {
  const lines = readFileSync(join(SERVER, file), 'utf8').replace(/\r\n/g, '\n').split('\n')
  const chunks = []
  for (const name of names) {
    const re = new RegExp(`^(?:export )?(?:async )?(?:function ${name}\\b|const ${name}\\b|let ${name}\\b)`)
    const start = lines.findIndex(l => re.test(l))
    if (start < 0) throw new Error(`${file}: ${name}을(를) 찾지 못했습니다`)
    let end = start
    if (/^(?:export )?(?:async )?function /.test(lines[start])) {
      while (lines[end] !== '}') end++
    } else {
      while (end + 1 < lines.length && /^\s+\S/.test(lines[end + 1])) end++
    }
    chunks.push(lines.slice(start, end + 1).join('\n').replace(/^export /, ''))
  }
  const code = stripTypeScriptTypes(chunks.join('\n') + '\n' + after, { mode: 'strip' })
  const body = `${code}\nreturn { ${names.join(', ')} }`
  return new Function(...Object.keys(deps), body)(...Object.values(deps))
}

/** 소스에 이 글자가 그대로 있는지 (시험이 기대는 정규식 · 상수가 바뀌면 바로 알 수 있게) */
function assertSource(file, text) {
  const src = readFileSync(join(SERVER, file), 'utf8')
  if (!src.includes(text)) throw new Error(`${file}에 ${JSON.stringify(text)}가 없습니다 (원본이 바뀜: 포팅도 고쳐야 합니다)`)
}

const ops = {
  /* ── world.ts ── */
  async world() {
    const w = await load('world.ts')
    const angles = Array.from({ length: 6 }, (_, i) => (i / 6) * Math.PI * 2)
    const bits = x => { const b = Buffer.alloc(8); b.writeDoubleBE(x); return b.toString('hex') }
    return {
      text: JSON.stringify(w.WORLD_JSON),
      trig: angles.map(a => [bits(Math.cos(a)), bits(Math.sin(a))]),
      lookSizes: [...w.LOOK_SIZES], channels: w.CHANNELS, reach: w.REACH, reachServer: w.REACH_SERVER, near: w.NEAR,
      bubbles: w.BUBBLE_COUNT, sighs: w.SIGH_COUNT, emotes: [...w.EMOTES],
      aiKeys: w.AIS.map(a => a.key),
      boxes: { temple: w.TEMPLE_RECT, trend: w.TREND_RECT, registry: w.REGISTRY_RECT, fortune: w.FORTUNE_RECT },
    }
  },
  async worldChecks({ points, boxPoints, values }) {
    const w = await load('world.ts')
    const rects = [w.TEMPLE_RECT, w.TREND_RECT, w.REGISTRY_RECT, w.FORTUNE_RECT]
    return {
      blocked: points.map(([x, y]) => w.blocked(x, y)),
      near: boxPoints.map(([ax, ay, bx, by, r]) => w.near({ x: ax, y: ay }, { x: bx, y: by }, r ?? undefined)),
      nearBox: boxPoints.map(([ax, ay, , , r]) => rects.map(b => w.nearBox({ x: ax, y: ay }, b, r ?? undefined))),
      nearBoxServer: boxPoints.map(([ax, ay]) => rects.map(b => w.nearBox({ x: ax, y: ay }, b, w.REACH_SERVER))),
      isValidLook: values.map(v => w.isValidLook(v)),
      isChannel: values.map(v => w.isChannel(v)),
      shrineChannelOf: values.map(v => (typeof v === 'number' ? w.shrineChannelOf(v) : null)),
      isAiKey: values.map(v => w.isAiKey(v)),
    }
  },

  /* ── jsnum ── */
  numbers({ values, rounds, hypots, maxes, parses, structures }) {
    const num = h => Buffer.from(h, 'hex').readDoubleBE()
    const parse = s => { try { return { ok: true, v: JSON.parse(s) } } catch { return { ok: false } } }
    return {
      str: values.map(v => String(v)),
      json: values.map(v => JSON.stringify(v)),
      round: rounds.map(h => { const r = Math.round(num(h)); return Object.is(r, -0) ? '-0' : String(r) }),
      hypot: hypots.map(a => { const b = Buffer.alloc(8); b.writeDoubleBE(Math.hypot(...a.map(num))); return b.toString('hex') }),
      max: maxes.map(a => { const v = Math.max(...a.map(num)); return String(v) + (Object.is(v, -0) ? '-' : '') }),
      min: maxes.map(a => { const v = Math.min(...a.map(num)); return String(v) + (Object.is(v, -0) ? '-' : '') }),
      parse: parses.map(s => { const r = parse(s); return r.ok ? JSON.stringify(r.v) : null }),
      stringify: structures.map(s => JSON.stringify(JSON.parse(s))),
    }
  },
  numbersFromBits({ bits }) {
    return bits.map(h => { const v = Buffer.from(h, 'hex').readDoubleBE(); return [String(v), JSON.stringify(v), JSON.stringify([v])] })
  },
  jsonStrings() {
    // 모든 BMP 코드 단위 하나짜리 문자열
    const out = []
    for (let c = 0; c < 0x10000; c++) out.push(JSON.stringify(String.fromCharCode(c)))
    return out
  },
  objectKeys({ keys }) {
    const o = {}
    keys.forEach((k, i) => { o[k] = i })
    return JSON.stringify(o)
  },
  utf8({ hexes }) {
    return hexes.map(h => Buffer.from(h, 'hex').toString('utf8'))
  },

  /* ── chat.ts ── */
  async chat({ inputs }) {
    const { cleanChat, CHAT_MAX } = await load('chat.ts')
    return { max: CHAT_MAX, out: inputs.map(([v, max]) => cleanChat(v, max ?? undefined)) }
  },
  async opText({ inputs }) {
    // ops.ts cleanOpText (OpError 메시지까지)
    class OpError extends Error {}
    const { cleanOpText } = extract('ops.ts', ['INVISIBLE', 'cleanOpText'], { OpError })
    return inputs.map(([raw, max, label, optional]) => {
      try { return { ok: true, text: cleanOpText(raw ?? undefined, max, label, optional) } } catch (e) { return { ok: false, message: e.message } }
    })
  },
  async regText({ inputs }) {
    // registry.ts cleanText · cleanSign (이름 · 소개 · 지붕 글자)
    const { cleanChat } = await load('chat.ts')
    const r = extract('registry.ts', ['fail', 'SIGN_MAX', 'cleanSign', 'cleanText'], { cleanChat })
    return inputs.map(([raw, max, field, tagline]) => ({
      text: r.cleanText(raw ?? undefined, max, field),
      sign: r.cleanSign(raw ?? undefined, tagline),
    }))
  },
  chatSweep() {
    // chat.ts가 쓰는 유니코드 정규식 · 정규화를 코드 포인트 전체로
    assertSource('chat.ts', 'const INVISIBLE = /[\\p{Cc}\\p{Cf}]/gu')
    assertSource('chat.ts', ".replace(/[\\s\\p{P}\\p{S}]/gu, '')")
    assertSource('chat.ts', "raw.normalize('NFC')")
    assertSource('ops.ts', 'const INVISIBLE = /[\\p{Cc}\\p{Cf}]/gu')
    const inv = /[\p{Cc}\p{Cf}]/u
    const sps = /[\s\p{P}\p{S}]/u
    const invisible = []
    const spaceSymbol = []
    const nfc = []
    const lower = []
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      const s = String.fromCodePoint(cp)
      if (inv.test(s)) invisible.push(cp)
      if (sps.test(s)) spaceSymbol.push(cp)
      const n = s.normalize('NFC')
      if (n !== s) nfc.push([cp, n])
      const l = s.toLowerCase()
      if (l !== s) lower.push([cp, l])
    }
    return { invisible, spaceSymbol, nfc, lower }
  },
  normalize({ inputs }) {
    return inputs.map(s => s.normalize('NFC'))
  },

  /* ── shrines.ts · registry.ts (링크) ── */
  async links({ inputs, allowed, emails, slugs, ips }) {
    const s = await load('shrines.ts')
    const reg = extract('registry.ts', ['slugify'])
    const parts = u => ({ protocol: u.protocol, username: u.username, password: u.password, hostname: u.hostname, port: u.port, pathname: u.pathname, host: u.host, origin: u.origin })
    return {
      url: inputs.map(x => { try { return parts(new URL(x)) } catch { return null } }),
      github: inputs.map(x => s.parseGithub(x)),
      service: inputs.map(x => s.normalizeServiceUrl(x)),
      allowed: allowed.map(([u, d]) => s.isAllowedServiceUrl(u, d)),
      email: emails.map(e => s.isValidEmail(e)),
      isIP: ips.map(e => isIP(e)),
      slugify: slugs.map(t => reg.slugify(t)),
    }
  },
  async registryLinks({ pairs }) {
    const s = await load('shrines.ts')
    const { readLinks, domainOf, cleanEmail } = extract('registry.ts', ['fail', 'cleanEmail', 'readLinks', 'domainOf'],
      { parseGithub: s.parseGithub, normalizeServiceUrl: s.normalizeServiceUrl, isValidEmail: s.isValidEmail })
    return pairs.map(([g, u]) => {
      const r = readLinks(g ?? undefined, u ?? undefined)
      return { r, domain: r.ok ? domainOf(r.links) : null, email: cleanEmail(g ?? undefined) }
    })
  },
  async shrines({ items }) {
    const s = await load('shrines.ts')
    return items.map(sh => ({ errors: s.validateShrine(sh), pub: JSON.stringify(s.publicShrine(sh)) }))
  },
  async fromRow({ rows }) {
    const s = await load('shrines.ts')
    return rows.map(r => JSON.stringify(s.fromRow(r)))
  },
  idnaSweep({ from, to, step }) {
    const out = []
    for (let cp = from; cp <= to; cp += step) {
      if (cp >= 0xd800 && cp <= 0xdfff) { out.push(''); continue }
      try { out.push(new URL('https://a' + String.fromCodePoint(cp) + 'b.com/').hostname) } catch { out.push('') }
    }
    return out
  },
  urlHosts({ inputs }) {
    return inputs.map(x => { try { return new URL('https://' + x + '/').hostname } catch { return null } })
  },

  /* ── security.ts · moderation.ts · admin.ts · registry.ts (비밀 값) ── */
  async tickets({ sign, verify }) {
    const sec = await load('security.ts')
    return {
      signed: sign.map(t => sec.signTicket(t)),
      verified: verify.map(raw => sec.verifyTicket(raw ?? undefined)),
      cookies: verify.map(raw => sec.parseCookies(raw ?? undefined)),
    }
  },
  base64({ inputs }) {
    return inputs.map(s => Buffer.from(s, 'base64url').toString('hex'))
  },
  async ipHash({ salt, ips }) {
    const { kstDate } = await load('util.ts')
    // ipHash가 쓰는 모듈 변수(saltDay · salt)를 오늘 날짜 · 고정 소금으로 둡니다
    const { ipHash } = extract('security.ts', ['ipHash'], {
      createHash, kstDate, saltDay: kstDate(), salt: Buffer.from(salt, 'hex'),
      randomBytes: () => { throw new Error('소금이 바뀌면 안 됩니다') },
    })
    return ips.map(ip => ipHash(ip))
  },
  async blockKeys({ ips }) {
    const m = await load('moderation.ts')
    return ips.map(ip => ({ n: m.normalizeIp(ip), k: m.blockKey(ip) }))
  },
  async admin({ sessions, raws, ips, passwords, hosts }) {
    const { config } = await load('config.ts')
    const sec = await load('security.ts')
    const deps = { config, createHash, createHmac, isIP, Buffer, timingSafeEqual, parseCookies: sec.parseCookies, clientIp: sec.clientIp }
    const a = extract('admin.ts',
      ['ADMIN_COOKIE', 'SESSION_MS', 'PASSWORD_MAX', 'base', 'normIp', 'setup', 'A', 'SID_RE', 'revoked', 'signSession', 'readSession', 'isLoopbackHost', 'sessionCookie', 'adminIpHash'],
      deps)
    const req = (cookie, ip, host) => ({ headers: { cookie, host }, socket: { remoteAddress: ip } })
    return {
      enabled: a.A.enabled,
      keys: { pw: a.A.pwDigest.toString('hex'), session: a.A.sessionKey.toString('hex'), log: a.A.logKey.toString('hex') },
      signed: sessions.map(s => a.signSession(s)),
      read: raws.map(r => a.readSession(req(r === null ? undefined : `${a.ADMIN_COOKIE}=${r}`, '127.0.0.1'))),
      ipHash: ips.map(ip => a.adminIpHash(req(undefined, ip))),
      normIp: ips.map(ip => a.normIp(ip)),
      password: passwords.map(pw => typeof pw === 'string' && pw.length > 0 && pw.length <= a.PASSWORD_MAX * 4
        && timingSafeEqual(createHash('sha256').update(pw, 'utf8').digest(), a.A.pwDigest)),
      cookie: hosts.map(h => a.sessionCookie(req(undefined, '', h ?? undefined), 'v', 28800)),
      loopback: hosts.map(h => a.isLoopbackHost(h ?? undefined)),
    }
  },
  pins({ hash, check }) {
    const { hashPin, pinMatches } = extract('registry.ts', ['hashPin', 'pinMatches'], { randomBytes, scryptSync, timingSafeEqual, Buffer })
    return { hashed: hash.map(p => hashPin(p)), matches: check.map(([pin, stored]) => pinMatches(pin, stored)) }
  },

  /* ── util.ts ── */
  async util({ nows, dates }) {
    const u = await load('util.ts')
    const safe = f => { try { return f() } catch (e) { return `ERR ${e.name}` } }
    return {
      kstDate: nows.map(n => safe(() => u.kstDate(new Date(n)))),
      daysBack: nows.map(n => safe(() => u.kstDaysBack(3, new Date(n)))),
      week: nows.map(n => safe(() => u.kstWeekDays(new Date(n)))),
      since: dates.map(([d, n]) => safe(() => { const v = u.daysSince(d, new Date(n)); return Number.isNaN(v) ? null : v })),
    }
  },
}

const req = JSON.parse(readFileSync(0, 'utf8'))
const fn = ops[req.op]
if (!fn) throw new Error(`알 수 없는 op: ${req.op}`)
const result = await fn(req)
process.stdout.write(JSON.stringify(result), () => process.exit(0))
