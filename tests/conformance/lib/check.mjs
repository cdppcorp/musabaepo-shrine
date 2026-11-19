// 검사 결과 세기 · 출력. 모든 시험 묶음이 같은 모양으로 찍어서 run.mjs가 셀 수 있게 합니다.
//   PASS  이름  덧붙임
//   FAIL  이름  덧붙임
//   SKIP  이름  (까닭)        ← 대상에 없는 특성(driver.caps)이라 셀 수 없는 검사
// 끝에 "##conformance {json}" 한 줄 (중간에 예외로 끝나도 process 'exit'에서 찍음: crashed=true)
import * as D from '../driver.mjs'

export function suite(name) {
  let pass = 0
  let fail = 0
  let skip = 0
  let finished = false
  const fails = []
  const line = (tag, label, extra) => {
    const tail = extra === undefined || extra === null || extra === '' ? '' : `  ${String(extra).slice(0, 400)}`
    console.log(`${tag}  ${label}${tail}`)
  }
  const summary = crashed => `##conformance ${JSON.stringify({ suite: name, target: D.TARGET, pass, fail, skip, crashed })}`
  process.on('exit', code => {
    if (finished) return
    console.log(`\n${pass} PASS / ${fail} FAIL / ${skip} SKIP  (중간에 끝남, 종료 코드 ${code})`)
    console.log(summary(true))
  })
  console.log(`[${name}] ${D.describe()}`)
  return {
    ok(label, cond, extra = '') {
      if (cond) pass++
      else { fail++; fails.push(label) }
      line(cond ? 'PASS' : 'FAIL', label, extra)
      return !!cond
    },
    skip(label, why) {
      skip++
      line('SKIP', label, `(${why})`)
    },
    /** 대상이 cap 특성을 가졌을 때만 검사, 아니면 SKIP. cond는 함수(가진 경우에만 계산) */
    async okIf(cap, label, cond, extra = '') {
      if (!D.has(cap)) return this.skip(label, `${D.TARGET}: ${cap} 없음`)
      const v = typeof cond === 'function' ? await cond() : cond
      return this.ok(label, v, typeof extra === 'function' ? extra() : extra)
    },
    get counts() { return { pass, fail, skip } },
    async done() {
      await D.cleanup()
      finished = true
      console.log(`\n${pass} PASS / ${fail} FAIL / ${skip} SKIP`)
      console.log(summary(false))
      process.exit(fail ? 1 : 0)
    },
  }
}
