/**
 * 通过 CDP 驱动真实渲染进程，验证 preload/IPC 链路并截图。
 * 用法：node scripts/cdp-check.mjs
 */
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) {
  console.error('找不到可调试的页面')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})

await new Promise((r, j) => {
  ws.addEventListener('open', r)
  ws.addEventListener('error', j)
})

function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, resolve))
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails))
  }
  return r.result?.result?.value
}

await send('Runtime.enable')
await send('Page.enable')
await new Promise((r) => setTimeout(r, 1500))

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ->  ' + detail : ''}`)
}

// 1. preload 桥是否注入
const hasBridge = await evaluate('typeof window.mkk === "object"')
check('preload 桥 window.mkk 已注入', hasBridge === true, `typeof=${hasBridge}`)

// 2. 渲染层不能直接碰 Node
const noNode = await evaluate('typeof require === "undefined" && typeof process === "undefined"')
check('渲染层无 Node 能力（contextIsolation 生效）', noNode === true, `noNode=${noNode}`)

// 3. IPC 取配置
const cfg = await evaluate('window.mkk.getConfig().then(c => c.global.pdf_switch + "/" + c.global.concurrency)')
check('IPC 读取配置', typeof cfg === 'string' && cfg.includes('/'), `pdf_switch/concurrency=${cfg}`)

// 4. 走真实 IPC 调搜索接口
const search = await evaluate(`
  window.mkk.search('测试', 1).then(r => ({ ok: r.ok, n: r.ok ? r.data.list.length : 0, name: r.ok ? r.data.list[0].name : r.error }))
`)
check('IPC 搜索连通模拟站点', search?.ok === true && search.n > 0, JSON.stringify(search))

// 5. 章节列表
const chs = await evaluate(`
  window.mkk.chapters('test_comic', 1).then(r => ({ ok: r.ok, total: r.ok ? r.data.total : 0 }))
`)
check('IPC 获取章节列表', chs?.ok === true && chs.total === 8, JSON.stringify(chs))

// 6. 通过 IPC 真的入队并下载一章
const dl = await evaluate(`
  (async () => {
    const ch = await window.mkk.chapters('test_comic', 1)
    const c = ch.data.list[2]
    const t = await window.mkk.enqueue([{ comicPath: 'test_comic', comicName: '测试漫画', chapterIndex: 3, chapterName: c.name, uuid: c.uuid }])
    return { enqueued: t.length }
  })()
`)
check('IPC 入队下载任务', dl?.enqueued === 1, JSON.stringify(dl))

await new Promise((r) => setTimeout(r, 9000))
const tasks = await evaluate('window.mkk.queueList()')
const t0 = tasks?.[0]
check(
  '队列任务下载完成',
  t0 && t0.status === 'done',
  t0 ? `${t0.comicName} ${t0.chapterName} ${t0.downloaded}/${t0.total} ${t0.status}` : '无任务'
)

// 7. 漫画库 IPC
const lib = await evaluate('window.mkk.libraryList()')
check('IPC 漫画库列表', Array.isArray(lib) && lib.length > 0, `${lib?.length} 部漫画`)

// 8. 路径
const paths = await evaluate('window.mkk.paths()')
check('IPC 数据目录', !!paths?.out, paths?.out ?? '')

// 切到漫画库页面截图
await evaluate(`location.hash = '#/library'`)
await new Promise((r) => setTimeout(r, 1500))
const shot = await send('Page.captureScreenshot', { format: 'png' })
const fs = await import('fs')
fs.writeFileSync('.tmp/library.png', Buffer.from(shot.result.data, 'base64'))
check('漫画库页面截图已保存', true, '.tmp/library.png')

await evaluate(`location.hash = '#/downloads'`)
await new Promise((r) => setTimeout(r, 1200))
const shot2 = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('.tmp/downloads.png', Buffer.from(shot2.result.data, 'base64'))
check('下载队列页面截图已保存', true, '.tmp/downloads.png')

await evaluate(`location.hash = '#/settings'`)
await new Promise((r) => setTimeout(r, 1200))
const shot3 = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('.tmp/settings.png', Buffer.from(shot3.result.data, 'base64'))
check('设置页截图已保存', true, '.tmp/settings.png')

const failed = checks.filter((c) => !c.ok)
console.log('\n' + '='.repeat(56))
console.log(`共 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`)
console.log('='.repeat(56))

ws.close()
process.exit(failed.length === 0 ? 0 : 1)
