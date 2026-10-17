/**
 * 真实站点冒烟测试：直接连拷贝漫画当前域名，验证
 * 搜索 -> 章节 -> 页表还原 -> 真实图片下载 -> PDF 加密导出 全流程。
 *
 * 用法：npx electron .tmp/live.cjs
 * （会真的下载一章，用第 1 话这种短章节，避免拉几百页）
 */
import fs from 'fs'
import path from 'path'
import { toJpegUrl } from '../src/main/download/image'

async function main(): Promise<void> {
  const { setupProxy } = await import('../src/main/proxy')
  setupProxy() // 直连不通时靠系统代理，和应用启动时的行为一致

  const api = await import('../src/main/api/copymanga')
  const { makePdf } = await import('../src/main/download/pdf')
  const { getOutDir } = await import('../src/main/paths')
  const { logger } = await import('../src/main/logger')
  void logger

  const results: Array<[string, boolean, string]> = []
  const check = (n: string, ok: boolean, d = '') => {
    results.push([n, ok, d])
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ->  ' + d : ''}`)
  }

  console.log('接口域名:', api.API_HOST, '\n')

  // 1. 搜索
  const s = await api.searchComic('海贼王')
  check('搜索连通真实站点', s.ok && (s.data.list?.length ?? 0) > 0,
    s.ok ? `共 ${s.data.total} 条，首条《${s.data.list[0].name}》` : s.error)
  if (!s.ok) return finish(results)
  const comic = s.data.list[0]

  // 2. 详情
  const d = await api.getComic(comic.path_word)
  check('漫画详情', d.ok && !!d.data?.name,
    d.ok ? `${d.data.name} / 最新 ${d.data.last_chapter?.name ?? '?'} / 更新 ${d.data.datetime_updated}` : d.error)

  // 3. 章节列表
  const c = await api.getChapters(comic.path_word, 1)
  check('章节列表', c.ok && c.data.total > 0, c.ok ? `共 ${c.data.total} 章` : c.error)
  if (!c.ok) return finish(results)

  // 4. 取最短的一章，避免下载几百页
  let target = c.data.list[0]
  for (const ch of c.data.list) if (ch.size < target.size) target = ch
  check('选定最短章节', true, `${target.name}，站点标注 ${target.size} 页`)

  // 5. 页表还原
  const pages = await api.getChapterPages(comic.path_word, target.uuid)
  check('页表按 words 还原', pages.ok && pages.data.urls.length > 0,
    pages.ok ? `${pages.data.urls.length} 页（站点标注 ${target.size}）` : pages.error)
  if (!pages.ok) return finish(results)

  const urls = pages.data.urls
  const isIdentity = urls.every((_, i) => i === 0) // 占位，下面比内容
  const dupes = new Set(urls).size !== urls.length
  check('页地址无重复', !dupes, dupes ? '存在重复地址' : `${new Set(urls).size} 个唯一地址`)
  void isIdentity

  // 6. 真实下载前 5 页
  const dir = path.join(getOutDir(), 'LIVE_TEST', target.name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })

  const { downloadImage } = await import('../src/main/download/image')
  let okCount = 0
  let jpegCount = 0
  for (let i = 0; i < Math.min(5, urls.length); i++) {
    const r = await downloadImage(urls[i], dir, i + 1)
    if (!r.ok) continue
    okCount++
    if (/\.jpe?g$/i.test(r.file!)) jpegCount++
    const head = fs.readFileSync(r.file!).subarray(0, 3).toString('hex')
    if (head !== 'ffd8ff') console.log(`  警告: 第 ${i + 1} 页不是 JPEG (${head})`)
  }
  check('真实图片下载', okCount === Math.min(5, urls.length), `${okCount}/5 页成功`)
  check('落盘为 JPEG（PDF 可嵌入）', jpegCount === okCount, `${jpegCount}/${okCount} 是 .jpg`)
  console.log(`  URL 改写示例:\n    原: ${urls[0].slice(-40)}\n    后: ${toJpegUrl(urls[0]).slice(-40)}`)

  // 7. PDF 加密导出
  const enc = await makePdf(dir, { password: 'test1234' })
  check('加密 PDF 导出', enc.ok, enc.ok ? `${enc.pages} 页` : enc.error)
  if (enc.ok && enc.pdfPath) {
    const buf = fs.readFileSync(enc.pdfPath)
    const txt = buf.toString('latin1')
    const i = txt.indexOf('/Filter /Standard')
    const dict = i > 0 ? txt.slice(i, i + 300) : ''
    check('PDF 已加密', dict.includes('/AESV2') && txt.includes('/Encrypt'), dict.includes('/AESV2') ? 'AES 加密字典已写入' : '未找到加密字典')
  }

  // 8. 未加密版本，用 pdf-lib 读回页数
  const plain = await makePdf(dir, { password: null })
  check('未加密 PDF 导出', plain.ok, plain.ok ? `${plain.pages} 页` : plain.error)
  if (plain.ok && plain.pdfPath) {
    const { PDFDocument } = await import('pdf-lib-plus-encrypt')
    const doc = await PDFDocument.load(fs.readFileSync(plain.pdfPath))
    check('PDF 页数正确', doc.getPageCount() === 5, `读回 ${doc.getPageCount()} 页`)
    const p0 = doc.getPage(0)
    console.log(`  首页尺寸: ${p0.getWidth().toFixed(1)} x ${p0.getHeight().toFixed(1)} pt`)
  }

  fs.rmSync(path.join(getOutDir(), 'LIVE_TEST'), { recursive: true, force: true })
  finish(results)
}

function finish(results: Array<[string, boolean, string]>): void {
  const failed = results.filter((r) => !r[1])
  console.log('\n' + '='.repeat(56))
  console.log(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  failed.forEach((f) => console.log(`  - ${f[0]}  ${f[2]}`))
  console.log('='.repeat(56))
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('异常:', e)
  process.exit(1)
})
