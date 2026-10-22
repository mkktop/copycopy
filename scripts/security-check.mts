import path from 'path'
import { resolveInside, sanitizeName, isBlockedRemoteUrl } from '../src/main/safe-path'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ->  ' + detail : ''}`)
}

const out = path.resolve('.tmp', 'security-root', 'out')

console.log('--- resolveInside: 越界必须被拒 ---')
check('拒绝 ..', resolveInside(out, '..', '..', 'Windows') === null)
check('拒绝 ../..', resolveInside(out, '..', '..') === null)
check('拒绝 out 自身', resolveInside(out) === null)
check('拒绝兄弟目录 outsecret', resolveInside(out, '..', 'outsecret') === null)
check('拒绝目录外的绝对路径', resolveInside(out, path.resolve(out, '..', '..', 'Windows')) === null)
check('拒绝多级目录穿越', resolveInside(out, path.join('..', '..', '..', 'etc')) === null)
check(
  '拒绝 UNC',
  resolveInside(out, process.platform === 'win32' ? '\\\\attacker\\share' : '//attacker/share') ===
    null,
  String(
    resolveInside(out, process.platform === 'win32' ? '\\\\attacker\\share' : '//attacker/share')
  )
)
check(
  '拒绝空漫画名（空段会被 resolve 丢弃，把章节名顶到 out/ 顶层）',
  resolveInside(out, '', '第1话') === null,
  String(resolveInside(out, '', '第1话'))
)
check(
  '拒绝空章节名',
  resolveInside(out, '海贼王', '') === null,
  String(resolveInside(out, '海贼王', ''))
)
check('放行 ..foo 这种以..开头的合法名', resolveInside(out, '..foo') !== null, '应放行')

console.log('\n--- resolveInside: 目录内必须放行 ---')
check(
  '放行普通相对路径',
  resolveInside(out, '海贼王', '第1话') === path.join(out, '海贼王', '第1话')
)
check(
  '放行 out 内的绝对路径',
  resolveInside(out, path.join(out, 'a', 'b.jpg')) === path.join(out, 'a', 'b.jpg')
)
check('放行带空格/中文', resolveInside(out, 'A B', '第 12 话') !== null)

console.log('\n--- sanitizeName: 目录名不得逃逸 ---')
for (const raw of ['..', '.', '../..', '..\\..']) {
  const s = sanitizeName(raw)
  const joined = path.join(out, s)
  const inside =
    !path.resolve(joined).startsWith(path.resolve(out) + path.sep) || joined === path.resolve(out)
  check(`sanitizeName(${JSON.stringify(raw)}) = ${JSON.stringify(s)} 不越界`, !inside, joined)
}
check('sanitizeName("..") 不再是 ..', sanitizeName('..') !== '..')
check('sanitizeName("") 有兜底', sanitizeName('') === '未命名', sanitizeName(''))
check('sanitizeName("   ") 有兜底', sanitizeName('   ') === '未命名', sanitizeName('   '))
check('sanitizeName("CON") 避开保留名', sanitizeName('CON') !== 'CON', sanitizeName('CON'))
check(
  'sanitizeName("com1.txt") 避开保留名',
  !/^com1/i.test(sanitizeName('com1.txt')),
  sanitizeName('com1.txt')
)
check(
  'sanitizeName("第1话.") 去尾点',
  !sanitizeName('第1话.').endsWith('.'),
  sanitizeName('第1话.')
)
check('sanitizeName("a/b") 去斜杠', !sanitizeName('a/b').includes('/'), sanitizeName('a/b'))
check(
  '长名字被截断到 <=100',
  sanitizeName('x'.repeat(500)).length <= 100,
  String(sanitizeName('x'.repeat(500)).length)
)
check('正常名字不变', sanitizeName('海贼王') === '海贼王', sanitizeName('海贼王'))

console.log('\n--- isBlockedRemoteUrl: remote:// 不能变成 SSRF 口子 ---')
const blocked = [
  ['回环 http://127.0.0.1/x.jpg', 'http://127.0.0.1/x.jpg'],
  ['回环带端口', 'http://127.0.0.1:8899/x.jpg'],
  ['localhost', 'http://localhost:3000/x.jpg'],
  ['*.localhost', 'http://foo.localhost/x.jpg'],
  ['*.local', 'http://printer.local/x.jpg'],
  ['私有 10.x', 'http://10.0.0.5/x.jpg'],
  ['私有 172.16.x', 'http://172.16.0.1/x.jpg'],
  ['私有 172.31.x', 'http://172.31.255.255/x.jpg'],
  ['私有 192.168.x', 'http://192.168.1.1/x.jpg'],
  ['链路本地 169.254.169.254', 'http://169.254.169.254/latest/meta-data/'],
  ['0.0.0.0', 'http://0.0.0.0/x.jpg'],
  ['CGNAT 100.64.x', 'http://100.64.0.1/x.jpg'],
  ['非法 IP 999.1.1.1', 'http://999.1.1.1/x.jpg'],
  ['file 协议', 'file:///C:/Windows/win.ini'],
  ['data 协议', 'data:image/png;base64,AAAA'],
  ['IPv6 ::1', 'http://[::1]/x.jpg'],
  ['IPv6 fe80::', 'http://[fe80::1]/x.jpg'],
  ['IPv6 ULA fc00::', 'http://[fc00::1]/x.jpg'],
  ['不是 URL', 'not a url at all'],
  ['空串', '']
]
for (const [name, url] of blocked) {
  check(`拒绝 ${name}`, isBlockedRemoteUrl(url))
}

const allowed = [
  'https://cdn.example.com/cover.jpg',
  'http://api.2026copy.com/a.jpg',
  'https://172.32.0.1/x.jpg', // 172.32 已出私有段
  'https://11.0.0.1/x.jpg',
  'https://[2001:db8::1]/x.jpg'
]
for (const url of allowed) {
  check(`放行 ${url}`, !isBlockedRemoteUrl(url))
}

console.log('\n' + '='.repeat(50))
console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
