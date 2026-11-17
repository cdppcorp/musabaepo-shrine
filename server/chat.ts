// 직접 쓴 메시지 검사. 말풍선으로 잠깐 떠 있다 사라지며, 서버는 저장하거나 기록하지 않습니다.
// 모르는 사람끼리 만나는 공간이라 링크(광고 · 사기) · 연락처 · 욕설은 보내지 않습니다.

export const CHAT_MAX = 40

export type ChatVerdict =
  | { ok: true; text: string }
  | { ok: false; reason: 'empty' | 'long' | 'link' | 'contact' | 'word' }

/** 제어 문자 · 보이지 않는 문자 · 글자 방향 바꾸는 문자 */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu
const LINK = /(https?:|www\.|[a-z0-9-]+\.(com|net|org|kr|io|co|me|ly|gg|xyz|app|dev|shop|site|link|to|be|ai|so|kakao)\b|t\.me|open\.kakao|닷컴|닷넷)/i
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/
/** 숫자가 8자리 이상 이어지면(사이에 띄어쓰기 · 하이픈 · 점 포함) 전화번호 · 계좌로 봅니다 */
const LONG_NUMBER = /\d(?:[\s.-]*\d){7,}/
const CONTACT_WORDS = /(카톡|카카오톡|오픈채팅|오픈톡|텔레그램|라인아이디|디엠주세요|dm주세요|연락주세요|연락처)/i

/**
 * 띄어쓰기 · 기호 · 숫자를 빼고 비교합니다 (시 발, 시1발 같은 우회).
 * '초가 꺼져요', '걸레질'처럼 이 공간에서 평범하게 쓸 말과 겹치는 낱말은 넣지 않았습니다.
 */
const BAD_WORDS = [
  '시발', '씨발', '씨빨', '시빨', '씨팔', '시팔', 'ㅅㅂ', 'ㅆㅂ', 'ㅄ', '병신', '븅신', 'ㅂㅅ', '개새', '개색', '개세끼',
  '새끼', 'ㅅㄲ', '좆', '존나', 'ㅈㄴ', '지랄', 'ㅈㄹ', '미친놈', '미친년', '니미', '느금', '엠창', '염병', '닥쳐',
  '애미', '애비', '창녀', '보지', '자지', '섹스', 'fuck', 'shit', 'bitch', 'sex', 'porn', '야동', '바카라',
]

export function cleanChat(raw: unknown, max: number = CHAT_MAX): ChatVerdict {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' }
  const text = raw.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
  if (!text) return { ok: false, reason: 'empty' }
  if ([...text].length > max) return { ok: false, reason: 'long' }
  if (LINK.test(text) || EMAIL.test(text)) return { ok: false, reason: 'link' }
  const compactAll = text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
  if (LONG_NUMBER.test(text) || CONTACT_WORDS.test(compactAll)) return { ok: false, reason: 'contact' }
  const compact = compactAll.replace(/\d/g, '')
  if (BAD_WORDS.some(w => compact.includes(w))) return { ok: false, reason: 'word' }
  return { ok: true, text }
}
