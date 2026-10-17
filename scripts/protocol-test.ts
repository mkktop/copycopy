/**
 * 自定义协议 library:// 的端到端验证。
 *
 * 这条链路（渲染层 <img> -> library:// -> 主进程读 out/ 内的文件）原先是
 * readImage() 把图片 base64 编码过 IPC。改成协议之后必须真的在 Electron 里
 * 跑一遍才算数：权限注册、URL 解析、CSP 放行、Chromium 解码，任一环不对
 * 漫画库封面就全是空白。
 */
import { app, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import {
  registerLibraryProtocol,
  registerRemoteProtocol,
  registerSchemes
} from '../src/main/media-protocol'
import { getOutDir } from '../src/main/paths'
import { REMOTE_SCHEME } from '../src/shared/ipc'
import { logger } from '../src/main/logger'

// 必须是 ready 之前
registerSchemes()

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ->  ' + detail : ''}`)
}

// 1x1 红色 PNG
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

async function main(): Promise<void> {
  const outDir = getOutDir()
  const comicDir = path.join(outDir, '协议测试漫画')
  const imgPath = path.join(comicDir, '001.png')
  const pdfPath = path.join(comicDir, '001.pdf')
  fs.mkdirSync(comicDir, { recursive: true })
  fs.writeFileSync(imgPath, PNG_1PX)
  fs.writeFileSync(pdfPath, Buffer.from('%PDF-1.7 not really a pdf'))

  registerLibraryProtocol()
  registerRemoteProtocol()

  const html = `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'self'; img-src 'self' library: remote:; connect-src 'self' library: remote:; script-src 'self'">
  </head><body>
    <img id="ok" src="library://local/${encodeURIComponent('协议测试漫画')}/001.png">
    <img id="denied" src="library://local/../../../../Windows/win.ini">
  </body></html>`
  const htmlPath = path.join(comicDir, 'probe.html')
  fs.writeFileSync(htmlPath, html, 'utf-8')

  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })

  await win.loadFile(htmlPath)
  // 等两张图都出结果
  const result = await win.webContents.executeJavaScript(
    `new Promise((resolve) => {
       const done = () => {
         const ok = document.getElementById('ok')
         const denied = document.getElementById('denied')
         resolve({
           okLoaded: ok.complete && ok.naturalWidth > 0,
           okWidth: ok.naturalWidth,
           deniedLoaded: denied.complete && denied.naturalWidth > 0
         })
       }
       const imgs = [...document.images]
       if (imgs.every(i => i.complete)) return done()
       let n = 0
       imgs.forEach(i => i.addEventListener('load', () => { if (++n === imgs.length) done() }))
       imgs.forEach(i => i.addEventListener('error', () => { if (++n === imgs.length) done() }))
       setTimeout(done, 3000)
     })`
  )

  check(
    'library:// 图片能被 <img> 加载并解码',
    !!result.okLoaded,
    `naturalWidth=${result.okWidth}`
  )
  check('越界路径被拒绝（图片加载失败）', !result.deniedLoaded, `naturalWidth>0=${result.deniedLoaded}`)

  // 非图片扩展名应当被协议层挡掉。
  // 探针页特意放开了 connect-src，否则请求会被 CSP 先拦掉，
  // 测的就不是协议层自己的扩展名白名单了。
  // （应用真实的 CSP 不含 connect-src library:，本来就不该走 fetch。）
  const pdfProbe = await win.webContents.executeJavaScript(
    `fetch('library://local/${encodeURIComponent('协议测试漫画')}/001.pdf')
       .then(r => r.status).catch(e => 'error:' + e.message)`
  )
  check('PDF 之类的非图片不被协议放行', pdfProbe === 403, `status=${pdfProbe}`)

  // ---- remote:// 的 SSRF 防护 ----
  // 探针页必须放开 connect-src，否则请求会被 CSP 先拦掉，测的就不是协议层了
  const ssrfProbes: Array<[string, string]> = [
    ['回环', 'http://127.0.0.1:8899/img/p-1-1.jpg'],
    ['localhost', 'http://localhost:8899/img/p-1-1.jpg'],
    ['云元数据', 'http://169.254.169.254/latest/meta-data/'],
    ['file 协议', 'file:///C:/Windows/win.ini'],
    ['非法 IP', 'http://999.1.1.1/x.jpg']
  ]
  for (const [label, target] of ssrfProbes) {
    const status = await win.webContents.executeJavaScript(
      `fetch('${REMOTE_SCHEME}://img/${encodeURIComponent(target)}')
         .then(r => r.status).catch(() => 'blocked')`
    )
    // 正常返回 502（被 guard 挡下后 fetch 失败），不能是 200
    check(`remote:// 拒绝 ${label}`, status !== 200, `status=${status}`)
  }

  win.destroy()
  fs.rmSync(comicDir, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  console.log('\n' + '='.repeat(60))
  console.log(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  if (failed.length) failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`))
  console.log('='.repeat(60))
  logger.dispose()
  process.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady()
  .then(main)
  .catch((e) => {
    console.error('协议测试异常:', e)
    process.exit(1)
  })
