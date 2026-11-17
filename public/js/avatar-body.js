// 몸 · 옷 (목 아래) 도트 모듈 — v0 (서기만)
const W = 24
const H = 40
const EMPTY = () => Array.from({ length: H }, () => '.'.repeat(W))
function G(y0, rows) {
  const g = EMPTY()
  rows.forEach((r, i) => {
    if (r.length !== W) throw new Error(`body.js: row ${y0 + i} has ${r.length} chars: ${r}`)
    g[y0 + i] = r
  })
  return g
}

/* ── 앞 ── */
const F_TORSO = G(19, [
  '.........jhhhi..........',
  '........jihhhkii........',
  '.......kjiikkkiik.......',
  '.......kjllklliik.......',
  '.......kjjlkkliik.......',
  '.......kjjjklliik.......',
  '.......klllkkliik.......',
  '.......kkkkkkkkkk.......',
])
const F_L_HANG = G(22, [
  '......kl................',
  '.....klj................',
  '.....llj................',
  '.....dd.................',
  '....ddd.................',
  '....ddc.................',
  '....cc..................',
])
const F_R_HANG = G(21, [
  '.................k......',
  '................ik......',
  '................iik.....',
  '................kkk.....',
  '.................dd.....',
  '.................ddc....',
  '.................ddc....',
  '.................dcc....',
])
const F_LEGS = G(27, [
  '.......mnnnnnnnmm.......',
  '.......moooonnnnm.......',
  '.......mooomnnnnm.......',
  '......moooomnnnnm.......',
  '......mnooomnnnnm.......',
  '......mnooomnnnnm.......',
  '......mnooomnnnnm.......',
  '......mnnnnmnnnnm.......',
  '.......pppq.pppr........',
  '.....qppqqqppppr........',
  '.....pqqqrrpqqqr........',
])

/* ── 옆 (오른쪽을 봄) ── */
const S_TORSO = G(19, [
  '............hhc.........',
  '.........kjihhjk........',
  '........kjjjjjjk........',
  '........kjjjjjjjk.......',
  '........kjjjjjjjk.......',
  '........kijjjjiik.......',
  '........kkiiiiikk.......',
  '.........kiiiiik........',
])
const S_ARM_HANG = G(22, [
  '..........llll..........',
  '..........iljli.........',
  '..........iiiii.........',
  '..........iiiii.........',
  '..........iccci.........',
  '...........cccc.........',
  '............cc..........',
])
const S_LEGS = G(27, [
  '.........mnnnnnnm.......',
  '.........moooonnm.......',
  '.........moooonnm.......',
  '.........moooonnm.......',
  '.........mnooonnm.......',
  '.........mnooonnm.......',
  '.........mnooonnm.......',
  '.........mnnnnnnm.......',
  '.........ppppq..........',
  '.........qppppqqr.......',
  '.........pqqqrrrr.......',
])

/* ── 뒤 ── */
const B_TORSO = G(19, [
  '.........jhhhi..........',
  '........jjkkkiii........',
  '.......kjjjjjjiik.......',
  '.......kljjjjjiik.......',
  '.......kljjjjiiik.......',
  '.......kjjjjjiiik.......',
  '.......kjjjjiiiik.......',
  '.......kkkkkkkkkk.......',
])
const B_LEGS = G(27, [
  '.......mnnnnnnnnm.......',
  '.......mooomnnnnm.......',
  '.......mooomnnnnm.......',
  '......moooomnnnnm.......',
  '......mnooomnnnnm.......',
  '......mnooomnnnnm.......',
  '......mnooomnnnnm.......',
  '......mnnnnmnnnnm.......',
  '.......ppqq.ppqr........',
  '.......pqqr.pqqr........',
  '.......qqrr.qqrr........',
])


/* ── 걷기 (몸 1칸 내려감) ── */
const F_L_BACK = G(23, [
  '......kl................',
  '.....klj................',
  '.....llj................',
  '.....dd.................',
  '....ddc.................',
  '....cc..................',
])
const F_R_FWD = G(22, [
  '.................k......',
  '................ik......',
  '................iik.....',
  '................kkk.....',
  '................dd......',
  '................ddc.....',
  '................ddc.....',
  '................dcc.....',
])
const F_L_FWD = G(23, [
  '......kl................',
  '.....klj................',
  '.....llj................',
  '......dd................',
  '.....ddd................',
  '.....ddc................',
  '.....cc.................',
])
const F_R_BACK = G(22, [
  '.................k......',
  '................ik......',
  '................iik.....',
  '................kkk.....',
  '.................dd.....',
  '.................ddc....',
  '.................dcc....',
])
const F_LEGS_A = G(28, [
  '.......mnnnnnnnmm.......',
  '.......moooonnnnm.......',
  '......moooomnnnnm.......',
  '......mnooomnnnnm.......',
  '......mnooomnnnnm.......',
  '......mnooomnnnnm.......',
  '......mnnnnmpppr........',
  '.......pppq.qqqr........',
  '.....qppqqq.............',
  '.....pqqqrr.............',
])
const F_LEGS_B = G(28, [
  '.......mnnnnnnnmm.......',
  '.......moooonnnnm.......',
  '......moooomnnnnm.......',
  '......mnooomnnnnm.......',
  '......mnooomnnnnm.......',
  '......mnnnnmnnnnm.......',
  '.......pppqmnnnnm.......',
  '.......qqqr.pppr........',
  '...........ppppr........',
  '...........pqqqr........',
])
const B_LEGS_A = G(28, [
  '.......mnnnnnnnnm.......',
  '.......mooomnnnnm.......',
  '......moooomnnnnm.......',
  '......mnooomnnnnm.......',
  '......mnooomnnnnm.......',
  '......mnnnnmnnnnm.......',
  '.......ppqqmnnnnm.......',
  '.......pqqr.ppqr........',
  '.......qqrr.pqqr........',
  '............rrrr........',
])
const B_LEGS_B = G(28, [
  '.......mnnnnnnnnm.......',
  '.......mooomnnnnm.......',
  '......moooomnnnnm.......',
  '......mnooomnnnnm.......',
  '......mnooomnnnnm.......',
  '......mnooomnnnnm.......',
  '......mnnnnmppqr........',
  '.......ppqq.pqqr........',
  '.......pqqr.qqrr........',
  '.......rrrr.............',
])
const S_LEGS_A = G(28, [
  '.........mnnnnnnm.......',
  '.........moooonnm.......',
  '........mnoooooonm......',
  '........mnnmoooonm......',
  '.......mnnm.moooonm.....',
  '.......mnnm..moooom.....',
  '......mnnm...mnnnnm.....',
  '.....qppq....ppppq......',
  '.....rqqp....qppppqqr...',
  '.......rr....pqqqrrrr...',
])
const S_LEGS_B = G(28, [
  '.........mnnnnnnm.......',
  '.........moooonnm.......',
  '........mooooonnnm......',
  '........mooomnnnnm......',
  '.......moooommnnnm......',
  '.......mooom..mnnnm.....',
  '......mnnnm...mnnnm.....',
  '.....qpppq....pppq......',
  '.....rqqp.....qpppqqr...',
  '.......rr.....pqqqrrr...',
])
const S_ARM_BACK = G(23, [
  '..........llll..........',
  '..........iljli.........',
  '.........iiiik..........',
  '........iiiik...........',
  '.......kiiik............',
  '......cccc..............',
  '.......cc...............',
])
const S_ARM_FWD = G(23, [
  '..........llll..........',
  '..........iljli.........',
  '...........kiiii........',
  '............kiiii.......',
  '.............kiiik......',
  '..............cccc......',
  '...............cc.......',
])

/* ── 동작 · 앞 ── */
const F_TORSO_BOW = G(20, [
  '.........jhhhi..........',
  '........jihhhkii........',
  '.......kjiikkkiik.......',
  '.......kjllklliik.......',
  '.......kjjjklliik.......',
  '.......klllkkliik.......',
  '.......kkkkkkkkkk.......',
])
const F_L_BOW = G(23, [
  '......kl................',
  '.....klj................',
  '.....llj................',
  '....ddd.................',
  '....ddc.................',
  '....cc..................',
])
const F_R_BOW = G(22, [
  '.................k......',
  '................ik......',
  '................iik.....',
  '................kkk.....',
  '.................ddc....',
  '.................ddc....',
  '.................dcc....',
])
const F_L_WAVE0 = G(13, [
  '..dd....................',
  '.dddd...................',
  '.cddc...................',
  '..klj...................',
  '..klj...................',
  '..klj...................',
  '..kllj..................',
  '..kkljj.................',
  '...kkllj................',
])
const F_L_WAVE1 = G(13, [
  '...dd...................',
  '..dddd..................',
  '..cddc..................',
  '...klj..................',
  '..klj...................',
  '..klj...................',
  '..kllj..................',
  '..kkljj.................',
  '...kkllj................',
])
const F_L_MOUTH = G(15, [
  '.........cc.............',
  '........hddc............',
  '........hddh............',
  '.......klhh.............',
  '......klj...............',
  '.....klj................',
  '....klj.................',
  '....kkj.................',
  '.....kk.................',
])
const F_L_KISS1 = G(16, [
  '.dd.....................',
  'dddc....................',
  '.ddc....................',
  '.klj....................',
  '..klj...................',
  '...klj..................',
  '....klj.................',
])
const F_L_SMOKE0 = G(15, [
  '.........cc.............',
  '.....BAAhddc............',
  '........hddh............',
  '.......klhh.............',
  '......klj...............',
  '.....klj................',
  '....klj.................',
  '....kkj.................',
  '.....kk.................',
])
const F_L_SMOKE1 = G(19, [
  '...B....................',
  '...A....................',
  '...Add..................',
  '...dddc.................',
  '...cklj.................',
  '....kkj.................',
])
/* ── 동작 · 뒤 (오른손 = 화면 오른쪽) ── */
const B_TORSO_BOW = G(20, [
  '.........jhhhi..........',
  '........jjkkkiii........',
  '.......kjjjjjjiik.......',
  '.......kljjjjjiik.......',
  '.......kjjjjjiiik.......',
  '.......kjjjjiiiik.......',
  '.......kkkkkkkkkk.......',
])
const mirror = g => g.map(r => [...r].reverse().join(''))
const B_R_WAVE0 = mirror(F_L_WAVE0)
const B_R_WAVE1 = mirror(F_L_WAVE1)
const B_R_MOUTH = G(19, [
  '................kjjk....',
  '................kjjjk...',
  '...............kkijjk...',
  '................kiik....',
  '.................kk.....',
])
const B_R_KISS1 = G(17, [
  '...................dd...',
  '..................cddd..',
  '..................kjjk..',
  '.................kjjk...',
  '................kjjk....',
  '................kik.....',
])
const B_R_SMOKE1 = mirror(F_L_SMOKE1)
/* ── 동작 · 옆 ── */
const S_TORSO_BOW = G(20, [
  '.............hhc........',
  '..........kjihhjk.......',
  '.........kjjjjjjk.......',
  '........kjjjjjjjjk......',
  '........kjjjjjjjk.......',
  '........kijjjjiik.......',
  '.........kiiiiik........',
])
const S_ARM_BOW = G(23, [
  '...........llll.........',
  '...........iljli........',
  '...........iiiii........',
  '............iiiii.......',
  '............iccci.......',
  '.............cccc.......',
])
const S_ARM_WAVE0 = G(12, [
  '...................dd...',
  '..................dddd..',
  '..................cddc..',
  '...................kjk..',
  '...................kjk..',
  '..................kjjk..',
  '................kkjjk...',
  '..............kkjjk.....',
  '............kkjjk.......',
  '...........kjjjk........',
  '..........llllk.........',
  '..........iljli.........',
])
const S_ARM_WAVE1 = G(13, [
  '....................dd..',
  '...................dddd.',
  '...................cddc.',
  '...................kjk..',
  '..................kjjk..',
  '.................kjjk...',
  '...............kkjjk....',
  '.............kkjjk......',
  '............kjjjk.......',
  '..........llllk.........',
  '..........iljli.........',
])
const S_ARM_MOUTH = G(15, [
  '.................cc.....',
  '................hddc....',
  '................hddh....',
  '.................kjk....',
  '.................kjk....',
  '................kjjk....',
  '...............kjjk.....',
  '..........llllljjk......',
  '..........iljliik.......',
  '...........kiiik........',
])
const S_ARM_KISS1 = G(17, [
  '...................dd...',
  '..................dddc..',
  '..............kkkjcddc..',
  '...........kkkjjjjkcc...',
  '..........llllljjk......',
  '..........iljliik.......',
  '...........kiiik........',
])
const S_ARM_SMOKE0 = G(15, [
  '.................cc.....',
  '................hddcAAB.',
  '................hddh....',
  '.................kjk....',
  '.................kjk....',
  '................kjjk....',
  '...............kjjk.....',
  '..........llllljjk......',
  '..........iljliik.......',
  '...........kiiik........',
])
const S_ARM_SMOKE1 = G(22, [
  '..........llll..........',
  '..........iljli...B.....',
  '..........kiiijk.A......',
  '...........kiiijddc.....',
  '............kiiicddc....',
  '.............kkk.cc.....',
])

const F_CHAIR = G(31, [
  '.......moooonnnnm.......',
  '......msooomsnnnnm......',
  '......mnooomnnnnnm......',
  '.......mnnnmnnnm........',
  '.......pppq.pppr........',
  '.....qppqqqppppr........',
  '.....pqqqrrpqqqr........',
])
const S_CHAIR = G(31, [
  '.........moooooooonm....',
  '.........mooooooooom....',
  '.........mnnnnnnmnnm....',
  '...............mnonm....',
  '...............ppppq....',
  '...............qppppqqr.',
  '...............pqqqrrrr.',
])
const B_CHAIR = G(31, [
  '.......mooomnnnnm.......',
  '......mnooomnnnnnm......',
  '......mnnnnmnnnnnm......',
  '.......mnnnmnnnm........',
  '.......ppqq.ppqr........',
  '.......pqqr.pqqr........',
  '.......qqrr.qqrr........',
])
const F_FLOOR = G(34, [
  '......mooooomnnnnnm.....',
  '....mmoooooomnnnnnnmm...',
  '...mnoooooppqqnnnnnnm...',
  '....mmmmmmqrrqmmmmmm....',
])
const S_FLOOR = G(34, [
  '.........moooooooonm....',
  '........mooooooooonnm...',
  '........mnnnnnnnqppppq..',
  '.........mmmmmmmqqrrrr..',
])
const B_FLOOR = G(34, [
  '......mooooomnnnnnm.....',
  '....mmoooooomnnnnnnmm...',
  '...mnooooooonnnnnnnnm...',
  '....mmmmmmmmmmmmmmmm....',
])
/* ══════════ 옷 그림 (상의 몸통 도장: 서 있는 몸통 좌표) ══════════ */
// 앞
const TS_F_TEE = G(19, [
  '.........khhhk..........',
  '........jkhhhkii........',
  '.......kjjkkkiiik.......',
  '.......kjlljlliik.......',
  '.......kjjljjliik.......',
  '.......kjjjjlliik.......',
  '.......kllljjliik.......',
  '.......kkkkkkkkkk.......',
])
const TS_F_HOOD = G(22, [
  '..........C.C...........',
  '..........D.D...........',
])
const TS_F_SHIRT = G(19, [
  '.........lhhhl..........',
  '........jllEllii........',
  '.......kjjkEkiiik.......',
  '.......kjllEjliik.......',
  '.......kjjlEEliik.......',
  '.......kjjjEEliik.......',
  '.......kllljEliik.......',
])
const TS_F_CHECK = G(19, [
  '.........lhhhl..........',
  '........jllhllii........',
  '.......kjjkhkiiik.......',
])
const TS_F_SUIT = G(19, [
  '.........ChhhC..........',
  '........jlCECkii........',
  '.......kjlCECkiik.......',
  '.......kjjlEkiiik.......',
  '.......kjjjlkiiik.......',
  '.......kjjjjkiiik.......',
  '.......kjjjlkiiik.......',
])
const TS_F_VEST = G(19, [
  '.........ChhhC..........',
  '........jCChCDii........',
  '.......kjjCCDiiik.......',
  '.......kjllCkiiik.......',
  '.......kjjjkiiiik.......',
  '.......kjjjliiiik.......',
  '.......kjjjkiiiik.......',
])
const TS_F_CODE = G(22, [
  '.........C..C.C.........',
  '........C...C..C........',
  '.........C.C..C.........',
])
// 뒤
const TS_B_HOOD = G(20, [
  '........klllllik........',
  '.......kkjjjjjikk.......',
  '.......kjkjjjikik.......',
  '.......kljkkkkiik.......',
])
const TS_B_SHIRT = G(19, [
  '.........lllll..........',
  '........jkkkkkii........',
])
const TS_B_SUIT = G(19, [
  '.........kCCCk..........',
  '........jkkkkkii........',
  '...........k............',
  '...........k............',
  '...........k............',
  '...........k............',
  '...........k............',
])
const TS_B_VEST = G(19, [
  '.........CCCCD..........',
  '........jjkkkkii........',
])
// 옆
const TS_S_TEE = G(20, [
  '.........kjkhhkj........',
])
const TS_S_HOOD = G(22, [
  '...............C........',
  '...............D........',
])
const TS_S_SHIRT = G(20, [
  '.........kjlhhll........',
  '........kjjjjjjE........',
  '........kjjjjjjE........',
  '........kjjjjjjE........',
  '........kijjjjiE........',
])
const TS_S_CHECK = G(20, [
  '.........kjlhhll........',
])
const TS_S_SUIT = G(20, [
  '.........kjlhhCC........',
  '........kjjjjjlC........',
  '........kjjjjjlE........',
  '........kjjjjjjE........',
])
const TS_S_VEST = G(20, [
  '.........kjChhCC........',
  '........kjjjjjCk........',
])

const TS_SWEATER = {
  front: G(19, [
    '.........lhhhl..........',
    '........jlhhhlii........',
    '.......kjjlllliik.......',
  ]),
  back: G(19, [
    '.........lhhhl..........',
    '........jjllllii........',
  ]),
  side: G(20, [
    '.........kjlhhlj........',
  ]),
}

/** 치마 도장 (다리 자세별, 손으로 찍음). 뒤는 앞과 같음 */
const SK_F_IDLE = G(28, [
  '.......msooonnnnm.......',
  '......mosonoonnmnm......',
  '......mooonoonnmnm......',
  '.....mnnnnmnnmmmmmm.....',
])
const SK_F_WALKA = G(29, [
  '.......msooonnnnm.......',
  '......mosonoonnmnm......',
  '......mooonoonnmnm......',
  '......mnnnnmnnmmmmmm....',
])
const SK_F_WALKB = G(29, [
  '.......msooonnnnm.......',
  '......mosonoonnmnm......',
  '......mooonoonnmnm......',
  '....mnnnnmnnmmmmmm......',
])
const SK_F_CHAIR = G(31, [
  '.......msooonnnnm.......',
  '......mosonoonnmnm......',
  '.....mnnnnmnnmmmmmm.....',
])
const SK_F_FLOOR = G(34, [
  '......msooonoonnnm......',
  '....mnnnnmnnnmmmmmmm....',
])
const SK_S_IDLE = G(28, [
  '.........msoonnnm.......',
  '........moonoonnnm......',
  '........moonoonnnm......',
  '.......mnnnmnnmnnnm.....',
])
const SK_S_WALK = G(29, [
  '.........msoonnnm.......',
  '........moonoonnnm......',
  '.......mooonoonnnnm.....',
  '......mnnnnmnnnmnnnm....',
])
const SK_S_CHAIR = G(31, [
  '.........msoooonm.......',
  '.........mooooonnm......',
  '.........mnnnnnnnm......',
])
const SK_S_FLOOR = G(34, [
  '.........msoooooonnm....',
  '........mnnnnmnnnnnnm...',
])
const SKIRT = {
  front: { idle: SK_F_IDLE, walkA: SK_F_WALKA, walkB: SK_F_WALKB, chair: SK_F_CHAIR, floor: SK_F_FLOOR },
  back: { idle: SK_F_IDLE, walkA: SK_F_WALKB, walkB: SK_F_WALKA, chair: SK_F_CHAIR, floor: SK_F_FLOOR },
  side: { idle: SK_S_IDLE, walkA: SK_S_WALK, walkB: SK_S_WALK, chair: SK_S_CHAIR, floor: SK_S_FLOOR },
}
const legKind = f => (f === 'walkA' || f === 'walkB' || f === 'chair' || f === 'floor' ? f : 'idle')

/* ══════════ 조립 ══════════ */
function build(parts) {
  const px = Array.from({ length: H }, () => Array(W).fill('.'))
  const own = Array.from({ length: H }, () => Array(W).fill('.'))
  for (const [id, g, dx = 0, dy = 0] of parts) {
    g.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === '.') return
      const tx = x + dx, ty = y + dy
      if (tx < 0 || tx >= W || ty < 0 || ty >= H) return
      px[ty][tx] = ch
      own[ty][tx] = id
    }))
  }
  return { rows: px.map(r => r.join('')), own: own.map(r => r.join('')) }
}
const SPECS = {
  front: {
    idle: [['G', F_LEGS], ['T', F_TORSO], ['L', F_L_HANG], ['R', F_R_HANG]],
    walkA: [['G', F_LEGS_A], ['T', F_TORSO, 0, 1], ['L', F_L_BACK], ['R', F_R_FWD]],
    walkB: [['G', F_LEGS_B], ['T', F_TORSO, 0, 1], ['L', F_L_FWD], ['R', F_R_BACK]],
    bow: [['G', F_LEGS], ['T', F_TORSO_BOW], ['L', F_L_BOW], ['R', F_R_BOW]],
    wave0: [['G', F_LEGS], ['T', F_TORSO], ['L', F_L_WAVE0], ['R', F_R_HANG]],
    wave1: [['G', F_LEGS], ['T', F_TORSO], ['L', F_L_WAVE1], ['R', F_R_HANG]],
    kiss0: [['G', F_LEGS], ['T', F_TORSO], ['L', F_L_MOUTH], ['R', F_R_HANG]],
    kiss1: [['G', F_LEGS], ['T', F_TORSO], ['L', F_L_KISS1], ['R', F_R_HANG]],
    smoke0: [['G', F_LEGS], ['T', F_TORSO], ['L', F_L_SMOKE0], ['R', F_R_HANG]],
    smoke1: [['G', F_LEGS], ['T', F_TORSO], ['L', F_L_SMOKE1], ['R', F_R_HANG]],
  },
  side: {
    idle: [['G', S_LEGS], ['T', S_TORSO], ['R', S_ARM_HANG]],
    walkA: [['G', S_LEGS_A], ['T', S_TORSO, 0, 1], ['R', S_ARM_BACK]],
    walkB: [['G', S_LEGS_B], ['T', S_TORSO, 0, 1], ['R', S_ARM_FWD]],
    bow: [['G', S_LEGS], ['T', S_TORSO_BOW], ['R', S_ARM_BOW]],
    wave0: [['G', S_LEGS], ['T', S_TORSO], ['R', S_ARM_WAVE0]],
    wave1: [['G', S_LEGS], ['T', S_TORSO], ['R', S_ARM_WAVE1]],
    kiss0: [['G', S_LEGS], ['T', S_TORSO], ['R', S_ARM_MOUTH]],
    kiss1: [['G', S_LEGS], ['T', S_TORSO], ['R', S_ARM_KISS1]],
    smoke0: [['G', S_LEGS], ['T', S_TORSO], ['R', S_ARM_SMOKE0]],
    smoke1: [['G', S_LEGS], ['T', S_TORSO], ['R', S_ARM_SMOKE1]],
  },
  back: {
    idle: [['G', B_LEGS], ['T', B_TORSO], ['L', F_L_HANG], ['R', F_R_HANG]],
    walkA: [['G', B_LEGS_A], ['T', B_TORSO, 0, 1], ['L', F_L_BACK], ['R', F_R_FWD]],
    walkB: [['G', B_LEGS_B], ['T', B_TORSO, 0, 1], ['L', F_L_FWD], ['R', F_R_BACK]],
    bow: [['G', B_LEGS], ['T', B_TORSO_BOW], ['L', F_L_BOW], ['R', F_R_BOW]],
    wave0: [['G', B_LEGS], ['T', B_TORSO], ['L', F_L_HANG], ['R', B_R_WAVE0]],
    wave1: [['G', B_LEGS], ['T', B_TORSO], ['L', F_L_HANG], ['R', B_R_WAVE1]],
    kiss0: [['G', B_LEGS], ['R', B_R_MOUTH], ['T', B_TORSO], ['L', F_L_HANG]],
    kiss1: [['G', B_LEGS], ['R', B_R_KISS1], ['T', B_TORSO], ['L', F_L_HANG]],
    smoke0: [['G', B_LEGS], ['R', B_R_MOUTH], ['T', B_TORSO], ['L', F_L_HANG]],
    smoke1: [['G', B_LEGS], ['T', B_TORSO], ['L', F_L_HANG], ['R', B_R_SMOKE1]],
  },
}

/** 앉기: 서 있는 그림의 waist줄(바지 허리띠)까지를 dy만큼 내리고, 그 아래는 앉은 다리 그림. seatRow = 의자 · 바닥에 닿는 엉덩이 · 허벅지 아랫줄 */
export const SIT = { chair: { dy: 3, waist: 27, seatRow: 33 }, floor: { dy: 6, waist: 27, seatRow: 37 } }
const cut = (g, maxY) => g.map((r, y) => (y <= maxY ? r : '.'.repeat(W)))
const SIT_LEGS = { front: { chair: F_CHAIR, floor: F_FLOOR }, side: { chair: S_CHAIR, floor: S_FLOOR }, back: { chair: B_CHAIR, floor: B_FLOOR } }
for (const dir of ['front', 'back', 'side']) for (const seat of ['chair', 'floor']) {
  const { dy, waist } = SIT[seat]
  SPECS[dir][seat] = [...SPECS[dir].idle.map(([id, g, dx = 0, oy = 0]) => [id, cut(g, waist - oy), dx, oy + dy]), ['G', SIT_LEGS[dir][seat]]]
}

const FRAMES = ['idle', 'walkA', 'walkB', 'bow', 'wave0', 'wave1', 'kiss0', 'kiss1', 'smoke0', 'smoke1', 'chair', 'floor']
const BOW_TORSO = new Set([F_TORSO_BOW, B_TORSO_BOW, S_TORSO_BOW])
const HEADS = {
  front: { walkA: [0, 1], walkB: [0, 1], bow: [0, 2] },
  back: { walkA: [0, 1], walkB: [0, 1], bow: [0, 2] },
  side: { walkA: [0, 1], walkB: [0, 1], bow: [1, 2] },
}
/** 머리(얼굴 · 머리카락) 위에 한 번 더 그릴 팔: 입에 댄 손 · 머리 옆으로 든 팔 */
const OVER_PARTS = {
  front: { wave0: 'L', wave1: 'L', kiss0: 'L', kiss1: 'L', smoke0: 'L', smoke1: 'L' },
  back: { wave0: 'R', wave1: 'R', smoke1: 'R' },
  side: { wave0: 'R', wave1: 'R', kiss0: 'R', kiss1: 'R', smoke0: 'R' },
}
export const BODY = {}
export const HEAD = {}
export const OVER = {}
const OWN = {}
const META = {}
const BOTK = 'sonm'
for (const dir of ['front', 'back', 'side']) {
  BODY[dir] = {}; HEAD[dir] = {}; OVER[dir] = {}; OWN[dir] = {}; META[dir] = {}
  for (const f of FRAMES) {
    const spec = SPECS[dir][f] ?? SPECS[dir].idle
    const b = build(spec)
    BODY[dir][f] = b.rows
    OWN[dir][f] = b.own
    const seat = SIT[f]
    HEAD[dir][f] = seat ? [0, seat.dy] : (HEADS[dir][f] ?? [0, 0])
    const id = OVER_PARTS[dir][f]
    OVER[dir][f] = id ? b.rows.map((r, y) => [...r].map((ch, x) => (b.own[y][x] === id && y <= 22 ? ch : '.')).join('')) : null
    const t = spec.find(p => p[0] === 'T')
    const waist = b.rows.findIndex(r => [...r].some(ch => BOTK.includes(ch)))
    META[dir][f] = { kind: BOW_TORSO.has(t[1]) ? 'bow' : 'std', tdx: t[2] ?? 0, tdy: t[3] ?? 0, waist, seat: seat ? f : '' }
  }
}

/** 입 · 담배 불씨 · 뽀뽀 손 위치 (장면 좌표 [x, y], 옆은 오른쪽을 볼 때) */
const findKey = (rows, k) => { for (let y = 0; y < H; y++) { const x = rows[y].indexOf(k); if (x >= 0) return [x, y] } return null }
export const ANCHOR = {
  mouth: { front: [10, 16], back: [11, 16], side: [17, 16] },
  ember: {
    front: { smoke0: findKey(BODY.front.smoke0, 'B'), smoke1: findKey(BODY.front.smoke1, 'B') },
    back: { smoke0: [11, 16], smoke1: findKey(BODY.back.smoke1, 'B') },
    side: { smoke0: findKey(BODY.side.smoke0, 'B'), smoke1: findKey(BODY.side.smoke1, 'B') },
  },
  kissHand: { front: [1, 17], back: [20, 18], side: [20, 18] },
}

/** 고정색 (몸 · 옷 모듈: A–H) */
export const FIXED = {
  A: '#efe9dc', // 담배 종이
  B: '#f0763a', // 담배 불씨
  C: '#f7f3ec', // 흰 셔츠 · 끈 · 줄 (밝음)
  D: '#ddd6ca', // 흰 셔츠 그늘
  E: '#7a3342', // 넥타이 (자주)
  F: '#f3e4c2', // 줄무늬 크림
  G: '#dccba6', // 줄무늬 크림 그늘
  H: '#b8afa2', // 흰 셔츠 테두리
}

/* ══════════ 옷 갈아입히기 (덮개 격자를 돌려줌, '.' = 그대로, '_' = 지움) ══════════ */
const TOPK = 'ljik'
const SKINK = 'dch'
const SHOEK = 'tpqr'
const newBuf = () => Array.from({ length: H }, () => Array(W).fill('.'))
const done = b => b.map(r => r.join(''))
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]

/** 절할 때 몸통(한 줄 접힘)에 맞게 서 있는 몸통 도장을 옮김 */
function bowStamp(g, dir) {
  const out = EMPTY()
  if (dir === 'side') {
    const sh = r => '.' + r.slice(0, W - 1)
    out[20] = sh(g[19]); out[21] = sh(g[20]); out[22] = sh(g[21])
    out[23] = g[22]; out[24] = g[23]; out[25] = g[24]; out[26] = g[26]
    return out
  }
  for (let y = 20; y <= 23; y++) out[y] = g[y - 1]
  for (let y = 24; y <= 26; y++) out[y] = g[y]
  return out
}
function paintStamp(buf, g, m, own, dir) {
  if (!g) return
  const s = m.kind === 'bow' ? bowStamp(g, dir) : g
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ch = s[y][x]
    if (ch === '.') continue
    const tx = x + m.tdx, ty = y + m.tdy
    if (ty < 0 || ty >= H || tx < 0 || tx >= W || own[ty][tx] !== 'T') continue
    buf[ty][tx] = ch
  }
}
/** 팔 소매 중 손에 닿은 칸 (소매 끝) */
function cuffCells(rows, own) {
  const out = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const id = own[y][x]
    if ((id !== 'L' && id !== 'R') || !TOPK.includes(rows[y][x])) continue
    for (const [dx, dy] of N4) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue
      if (own[ny][nx] === id && SKINK.includes(rows[ny][nx])) { out.push([x, y, rows[ny][nx]]); break }
    }
  }
  return out
}
const at = (buf, rows, x, y) => (buf[y][x] !== '.' ? buf[y][x] : rows[y][x])
const darker = { l: 'j', j: 'i', i: 'k', k: 'k' }

const TOP_STAMP = {
  0: { front: TS_F_TEE, side: TS_S_TEE },
  1: { front: TS_F_HOOD, back: TS_B_HOOD, side: TS_S_HOOD },
  2: { front: TS_F_SHIRT, back: TS_B_SHIRT, side: TS_S_SHIRT },
  3: { front: TS_F_TEE, side: TS_S_TEE },
  4: { front: TS_F_CHECK, back: TS_B_SHIRT, side: TS_S_CHECK },
  5: { front: TS_F_SUIT, back: TS_B_SUIT, side: TS_S_SUIT },
  6: { front: TS_F_VEST, back: TS_B_VEST, side: TS_S_VEST },
  7: { front: TS_F_TEE, side: TS_S_TEE },
  8: { front: TS_F_TEE, side: TS_S_TEE },
}
/**
 * 상의 0~8: 티셔츠 · 후드티 · 셔츠와 넥타이 · 줄무늬 티 · 체크 남방 · 정장 · 조끼 · 스웨터 · 코딩 티
 * 기본 몸 그림이 후드티 모양이라 후드티는 끈 · 모자만 더합니다.
 */
export function topLayer(i, dir, frame, bodyRows) {
  const m = META[dir]?.[frame]
  if (!m) return null
  const own = OWN[dir][frame]
  const rows = bodyRows ?? BODY[dir][frame]
  const buf = newBuf()
  paintStamp(buf, TOP_STAMP[i]?.[dir], m, own, dir)
  if (i === 8 && dir === 'front') paintStamp(buf, TS_F_CODE, m, own, dir)
  const cuffs = cuffCells(rows, own)
  if (i === 0 || i === 3 || i === 8) for (const [x, y, sk] of cuffs) buf[y][x] = sk // 반소매: 소매 끝 한 칸이 맨팔
  if (i === 5) for (const [x, y] of cuffs) buf[y][x] = 'C' // 정장: 흰 셔츠 소맷부리
  if (i === 7) for (const [x, y] of cuffs) buf[y][x] = (x + y) % 2 ? 'k' : 'i' // 스웨터: 골지 소매
  if (i === 6) { // 조끼: 팔은 흰 셔츠
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const id = own[y][x]
      if ((id === 'L' || id === 'R') && TOPK.includes(rows[y][x])) buf[y][x] = { l: 'C', j: 'C', i: 'D', k: 'H' }[rows[y][x]]
    }
  }
  if (i === 7) { // 스웨터: 둥근 목 골지 · 밑단 두 줄 골지
    paintStamp(buf, TS_SWEATER[dir], m, own, dir)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (own[y][x] !== 'T') continue
      const ty = y - m.tdy, ch = rows[y][x]
      if (!TOPK.includes(ch)) continue
      if (ty === 26 || (ty === 25 && ch !== 'k')) buf[y][x] = x % 2 ? (x < 12 ? 'l' : 'j') : 'k'
    }
  }
  if (i === 3) { // 줄무늬: 크림색 가로줄
    for (let y = 0; y < H; y++) {
      const ty = y - m.tdy
      if (ty < 22 || ty % 2) continue
      for (let x = 0; x < W; x++) {
        const id = own[y][x]
        if (id !== 'T' && id !== 'L' && id !== 'R') continue
        const ch = at(buf, rows, x, y)
        if (ty >= 26 && id === 'T') continue
        if (ch === 'l' || ch === 'j') buf[y][x] = 'F'
        else if (ch === 'i') buf[y][x] = 'G'
      }
    }
  }
  if (i === 4) { // 체크: 세 칸마다 어두운 줄
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const id = own[y][x]
      if (id !== 'T' && id !== 'L' && id !== 'R') continue
      const ch = at(buf, rows, x, y)
      if (!TOPK.includes(ch) || ch === 'k') continue
      const ty = y - m.tdy, tx = x - m.tdx
      if (ty < 21) continue
      const v = (tx - 8) % 3 === 0, h = (ty - 22) % 3 === 0
      if (v && h) buf[y][x] = 'k'
      else if (v) buf[y][x] = ch === 'i' ? 'k' : 'i'
      else if (h) buf[y][x] = darker[ch]
      else if (ch === 'j' && x < 12 + m.tdx) buf[y][x] = 'l'
    }
  }
  return done(buf)
}

/* ── 하의 ── */
/** 맨다리: 바지 칸을 피부로, 바지 테두리(m)는 지워서 다리를 가늘게 */
function bareCell(ch) { return ch === 'm' ? '_' : ch === 'n' ? 'c' : 'd' }
function legRuns(rows, y) {
  const runs = []
  let s = -1
  for (let x = 0; x <= W; x++) {
    const ch = x < W ? rows[y][x] : '.'
    const inLeg = ch !== '.' && 'son'.includes(ch)
    if (inLeg && s < 0) s = x
    if (!inLeg && s >= 0) { runs.push([s, x - 1]); s = -1 }
  }
  return runs
}
const isBot = ch => BOTK.includes(ch)
/** 앉은 자세에서 맨살로 보일 칸 (반바지 · 치마) */
function sitBare(dir, seat, x, y) {
  if (seat === 'chair') return dir === 'side' ? (x >= 18 || y >= 34) : y >= 34
  return y >= 36
}
/**
 * 하의 0~4: 청바지(기본 그림) · 반바지 · 면바지 · 치마 · 트레이닝 바지
 */
export function bottomLayer(i, dir, frame, bodyRows) {
  const m = META[dir]?.[frame]
  if (!m) return null
  const rows = bodyRows ?? BODY[dir][frame]
  const buf = newBuf()
  const w = m.waist
  // 긴 바지(청바지 · 면바지 · 트레이닝 바지): 밑단이 신발 윗줄을 한 칸 덮음 (합성기가 신발 다음에 바지를 그림)
  if (i === 0 || i === 2 || i === 4) {
    for (let x = 0; x < W; x++) for (let y = w + 1; y < H - 1; y++) {
      if ('onms'.includes(rows[y][x]) && 'pqrt'.includes(rows[y + 1][x])) {
        const edge = x === 0 || x === W - 1 || !'onms'.includes(rows[y][x - 1]) || !'onms'.includes(rows[y][x + 1])
        buf[y + 1][x] = edge || rows[y][x] === 'm' ? 'm' : 'n'
        break
      }
    }
  }
  if (!i) return done(buf)
  if (i === 1 || i === 3) {
    const skirt = i === 3
    const hemY = m.seat ? -1 : w + (skirt ? 4 : 3)
    for (let y = w + 1; y < H; y++) for (let x = 0; x < W; x++) {
      const ch = rows[y][x]
      if (!isBot(ch)) continue
      const bare = m.seat ? sitBare(dir, m.seat, x, y) : y > hemY
      if (bare) buf[y][x] = bareCell(ch)
      else if (!skirt && y === hemY) buf[y][x] = ch === 'o' || ch === 's' ? 'n' : 'm'
    }
    if (dir !== 'side') for (let y = w + 1; y < H; y++) {
      const runs = []
      let st = -1
      for (let x = 0; x <= W; x++) {
        const c = x < W ? buf[y][x] : '.'
        const sk = c === 'd' || c === 'c'
        if (sk && st < 0) st = x
        if (!sk && st >= 0) { runs.push([st, x - 1]); st = -1 }
      }
      for (const [a, b] of runs) if (b - a >= 3) buf[y][(a + b) / 2 < 11.5 ? b : a] = '_'
    }
    if (skirt) {
      const st = SKIRT[dir][legKind(frame)]
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (st[y][x] !== '.') buf[y][x] = st[y][x]
    }
  } else if (i === 2) { // 면바지: 다리 가운데 주름
    for (let y = w + 2; y < H; y++) for (const [a, b] of legRuns(rows, y)) {
      if (b - a < 2 || b - a > 6) continue
      const x = a + ((b - a + 1) >> 1)
      buf[y][x] = rows[y][x] === 'n' ? 'o' : 's'
    }
  } else if (i === 4) { // 트레이닝 바지: 옆줄
    for (let y = w + 1; y < H; y++) for (const [a, b] of legRuns(rows, y)) {
      if (b - a > 6) continue
      let x
      if (dir === 'side') x = a + ((b - a) >> 1)
      else x = (a + b) / 2 < 11.5 ? a : b
      buf[y][x] = rows[y][x] === 'n' ? 'D' : 'C'
    }
  }
  return done(buf)
}

/* ── 신발 ── */
function shoeBlobs(rows, split) {
  const seen = Array.from({ length: H }, () => Array(W).fill(false))
  const blobs = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (seen[y][x] || !SHOEK.includes(rows[y][x])) continue
    const cells = []
    const st = [[x, y]]; seen[y][x] = true
    while (st.length) {
      const [cx, cy] = st.pop(); cells.push([cx, cy])
      for (const [dx, dy] of N4) {
        const nx = cx + dx, ny = cy + dy
        if (nx < 0 || nx >= W || ny < 0 || ny >= H || seen[ny][nx] || !SHOEK.includes(rows[ny][nx])) continue
        if (split && (nx < 11) !== (cx < 11)) continue
        seen[ny][nx] = true; st.push([nx, ny])
      }
    }
    const ys = cells.map(c => c[1]), xs = cells.map(c => c[0])
    blobs.push({ cells, y0: Math.min(...ys), y1: Math.max(...ys), x0: Math.min(...xs), x1: Math.max(...xs) })
  }
  return blobs
}
/**
 * 신발 0~5: 흰 운동화 · 검정 구두(기본 그림) · 갈색 부츠 · 빨간 운동화 · 슬리퍼 · 맨발
 */
export function shoeLayer(i, dir, frame, bodyRows) {
  const m = META[dir]?.[frame]
  if (!m || i === 1) return null
  const rows = bodyRows ?? BODY[dir][frame]
  const buf = newBuf()
  for (const bl of shoeBlobs(rows, dir !== 'side')) {
    const has = (x, y) => bl.cells.some(c => c[0] === x && c[1] === y)
    const mid = (bl.x0 + bl.x1) / 2
    if (i === 0 || i === 3) { // 운동화: 흰 밑창 · 밝은 앞코
      for (const [x, y] of bl.cells) {
        if (y === bl.y1) buf[y][x] = x <= mid ? 'C' : 'D'
        else if (y === bl.y0 && x === bl.x0 + (has(bl.x0, y) ? 0 : 1)) buf[y][x] = 't'
      }
      const ly = bl.y0, lx = Math.round(mid)
      if (has(lx, ly) && bl.y1 - bl.y0 >= 2) buf[ly][lx] = 't'
    } else if (i === 2) { // 부츠: 목이 두 칸 위로
      const top = bl.cells.filter(c => c[1] === bl.y0).map(c => c[0])
      const a = Math.min(...top), b = Math.max(...top)
      for (let k = 1; k <= 2; k++) {
        const y = bl.y0 - k
        if (y < 0) continue
        for (let x = a; x <= b; x++) {
          if (!isBot(rows[y][x])) continue
          buf[y][x] = x === b ? 'r' : k === 2 ? 't' : 'p'
        }
      }
    } else if (i === 4) { // 슬리퍼: 발등 맨살 · 띠 · 발가락
      for (const [x, y] of bl.cells) {
        const lit = x <= mid
        if (y === bl.y0) buf[y][x] = lit ? 'd' : 'c'
        else if (y < bl.y1) buf[y][x] = dir === 'side' && x < mid ? (x === bl.x0 ? 'c' : 'd') : lit ? 'p' : 'q'
        else if (dir === 'side') buf[y][x] = x === bl.x1 ? 'd' : x >= bl.x1 - 1 ? 'c' : 'q'
        else if (dir === 'back') buf[y][x] = 'q'
        else buf[y][x] = x === bl.x0 || x === bl.x1 ? 'q' : (x - bl.x0) % 2 ? 'c' : 'd'
      }
    } else if (i === 5) { // 맨발: 피부색 · 발목은 가늘게 · 발가락
      const topXs = bl.cells.filter(c => c[1] === bl.y0).map(c => c[0])
      const ta = Math.min(...topXs), tb = Math.max(...topXs)
      for (const [x, y] of bl.cells) {
        let c = x <= mid ? 'd' : 'c'
        if (y === bl.y0 && tb - ta >= 3) {
          if (dir === 'side' ? x > ta + 2 : x === ta || x === tb) c = '_'
        }
        if (y === bl.y1) c = dir === 'side' ? (x === bl.x1 ? 'd' : x === bl.x0 ? 'h' : 'c') : dir === 'back' ? 'c' : x === bl.x1 ? 'h' : (x - bl.x0) % 2 ? 'c' : 'd'
        buf[y][x] = c
      }
    }
  }
  return done(buf)
}
