// 운영자 로그인. 성공하면 서버가 세션 쿠키(HttpOnly)를 주고, /admin을 다시 열면 운영 화면이 뜹니다.
const BASE = document.querySelector('meta[name="shrine-base"]')?.content ?? ''
const form = document.getElementById('loginForm')
const input = document.getElementById('password')
const btn = document.getElementById('loginBtn')
const msg = document.getElementById('loginMsg')

const FAIL = {
  password: '비밀번호가 맞지 않습니다.',
  locked: '여러 번 틀려서 잠겼습니다. 15분 뒤에 다시 해 주세요.',
  origin: '이 주소에서 연 화면에서만 로그인할 수 있습니다.',
}

form.addEventListener('submit', async e => {
  e.preventDefault()
  btn.disabled = true
  msg.textContent = '확인하는 중…'
  try {
    const res = await fetch(`${BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: input.value }),
      cache: 'no-store',
    })
    const data = await res.json().catch(() => ({}))
    if (data.ok) {
      input.value = ''
      location.replace(`${BASE}/admin`)
      return
    }
    msg.textContent = FAIL[data.reason] ?? '로그인하지 못했습니다. 잠시 뒤에 다시 해 주세요.'
  } catch {
    msg.textContent = '서버에 닿지 않습니다.'
  }
  btn.disabled = false
  input.select()
})
