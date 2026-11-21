// P2b Node 기준값: server/uploads.ts의 sniffImage · stripMetadata와 saveUpload의 검사 순서, server/notify.ts의 buildText.
//   node --disable-warning=ExperimentalWarning app/tests/p2b_ref.mjs < 요청.json   (DATA_DIR = 임시 폴더, uploads.ts가 db.ts를 엶)
//   요청: {"op": "images", "cases": ["<hex>", …]}  → [{sniff, strip: {png, jpg, webp}, clean}, …]
//         {"op": "notify", "cases": [[event, fields, skipped], …]} → ["<text>", …]
// 서버 소스는 읽기만 합니다.
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', '..', 'server')
const input = JSON.parse(readFileSync(0, 'utf8'))

if (input.op === 'images') {
  const { sniffImage, stripMetadata } = await import(pathToFileURL(join(SERVER, 'uploads.ts')).href)
  const hex = b => (b ? b.toString('hex') : null)
  const out = input.cases.map(h => {
    const buf = Buffer.from(h, 'hex')
    let sniff
    try { sniff = sniffImage(buf) } catch (e) { sniff = 'throw' }
    const strip = {}
    for (const ext of ['png', 'jpg', 'webp']) strip[ext] = hex(stripMetadata(buf, ext))
    // saveUpload(buf)의 검사 순서 (할당량 · 저장은 빼고)
    let clean
    if (buf.length === 0) clean = 'bad'
    else {
      const img = sniff === 'throw' ? null : sniff
      if (!img || img.w < 16 || img.h < 16 || img.w > 8000 || img.h > 8000) clean = 'type'
      else {
        const c = stripMetadata(buf, img.ext)
        clean = !c || sniffImage(c)?.ext !== img.ext ? 'type' : { ext: img.ext, hex: c.toString('hex') }
      }
    }
    return { sniff, strip, clean }
  })
  process.stdout.write(JSON.stringify(out))
} else if (input.op === 'notify') {
  const src = readFileSync(join(SERVER, 'notify.ts'), 'utf8').replace(/\r\n/g, '\n')
  const start = src.indexOf('const TIMEOUT_MS')
  const end = src.indexOf('/**\n * 운영자에게 알립니다')
  const code = stripTypeScriptTypes(src.slice(start, end), { mode: 'strip' })
  const { buildText } = new Function(`${code}\nreturn { buildText }`)()
  process.stdout.write(JSON.stringify(input.cases.map(([event, fields, skipped]) => buildText(event, fields, skipped))))
} else {
  throw new Error(`모르는 op: ${input.op}`)
}
