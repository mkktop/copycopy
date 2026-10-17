/**
 * 端到端验证：连本地模拟站点，跑通 搜索 → 章节 → 下载 → 校验页序 →
 * PDF 加密导出 → 断点续传 → 漫画库扫描 → 追更检查 全流程。
 *
 * 运行方式（由 run-e2e.mjs 打包后在 electron 里执行）：
 *   node scripts/run-e2e.mjs
 */
import fs from 'fs'
import path from 'path'
import { readJpegSize } from './jpeg.mjs'

const PORT = process.env.MOCK_PORT || '8899'
process.env.MKK_API_BASE = `http://127.0.0.1:${PORT}`
process.env.MKK_API_HOST = `127.0.0.1:${PORT}`

// 关键：把数据根目录指到临时目录。
// 不指的话测试会写开发者真实的 config/comic.yaml 和 out/，
// 跑一次就把订阅列表、PDF 密码、章节间隔全改成测试值。
// 必须在 import 任何会碰 paths 的模块之前设置。
const DATA_DIR = path.join(__dirname, '..', '.tmp', 'e2e-data')
fs.rmSync(DATA_DIR, { recursive: true, force: true })
fs.mkdirSync(DATA_DIR, { recursive: true })
process.env.MKK_DATA_DIR = DATA_DIR

const results: Array<{ name: string; ok: boolean; detail: string }> = []

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ->  ' + detail : ''}`)
}

async function main(): Promise<void> {
  const api = await import('../src/main/api/copymanga')
  const { loadConfig, saveConfig, DEFAULT_CONFIG } = await import('../src/main/config')
  const { listLibrary, listIncompleteChapters } = await import('../src/main/library')
  const { queue } = await import('../src/main/download/queue')
  const { makePdf } = await import('../src/main/download/pdf')
  const { checkUpdates } = await import('../src/main/track')
  const { getOutDir } = await import('../src/main/paths')
  const { logger } = await import('../src/main/logger')

  // 关掉章节间等待，加快测试
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.global.chapter_delay_min = 0
  cfg.global.chapter_delay_max = 0
  cfg.global.pdf_switch = 1
  cfg.global.pdf_password = 'secret123'
  saveConfig(cfg)

  /* ---------- 1. 搜索 ---------- */
  const search = await api.searchComic('测试')
  check('搜索返回结果', search.ok && (search.data.list?.length ?? 0) > 0,
    search.ok ? `${search.data.total} 条` : search.error)

  const pathWord = search.ok ? search.data.list[0].path_word : ''

  /* ---------- 2. 详情与章节列表 ---------- */
  const detail = await api.getComic(pathWord)
  check('获取漫画详情', detail.ok && !!detail.data?.name, detail.ok ? detail.data.name : detail.error)

  const chapters = await api.getChapters(pathWord, 1)
  check('获取章节列表', chapters.ok && chapters.data.total === 8,
    chapters.ok ? `共 ${chapters.data.total} 章` : chapters.error)

  /* ---------- 3. 页序还原 ---------- */
  const firstCh = chapters.ok ? chapters.data.list[0] : null
  const pages = firstCh ? await api.getChapterPages(pathWord, firstCh.uuid) : null
  check(
    '页表按 words 还原顺序',
    !!pages?.ok && pages.data.urls.length === 12,
    pages?.ok ? `${pages.data.urls.length} 页，首页 ${pages.data.urls[0]}` : pages?.error
  )
  // urls[0] 应当是第 1 页（相对路径已补全为绝对地址）
  check(
    '首页地址补全为绝对 URL',
    !!pages?.ok && /^http:\/\/127\.0\.0\.1:\d+\/img\/p-1-1\.jpg$/.test(pages.data.urls[0]),
    pages?.ok ? pages.data.urls[0] : ''
  )

  /* ---------- 4. 下载两章 ---------- */
  const { subscribe } = await import('../src/main/track')
  subscribe({ name: detail.ok ? detail.data.name : '', path: pathWord })

  // 清掉上一次的残留再下，否则第二次跑会多出上次追更下载的章节，
  // "漫画库扫描到章节"这类计数断言就飘了。测试必须是幂等的。
  const comicDir = path.join(getOutDir(), detail.ok ? detail.data.name : '')
  if (fs.existsSync(comicDir)) fs.rmSync(comicDir, { recursive: true, force: true })

  const toDownload = chapters.ok ? chapters.data.list.slice(0, 2) : []
  queue.enqueue(
    toDownload.map((c, i) => ({
      comicPath: pathWord,
      comicName: detail.ok ? detail.data.name : '',
      chapterIndex: i + 1,
      chapterName: c.name,
      uuid: c.uuid,
      trackSubscription: i === 0
    }))
  )

  const started = Date.now()
  while (Date.now() - started < 90_000) {
    const s = queue.stats()
    if (s.pending === 0 && s.running === 0) break
    await new Promise((r) => setTimeout(r, 300))
  }

  const tasks = queue.list()
  check(
    '两章全部下载成功',
    tasks.length === 2 && tasks.every((t) => t.status === 'done'),
    tasks.map((t) => `${t.chapterName}:${t.status}${t.error ? '(' + t.error + ')' : ''}`).join(', ')
  )

  /* ---------- 5. 落盘校验：页数与页序 ---------- */
  const outDir = getOutDir()
  const dir = path.join(outDir, detail.ok ? detail.data.name : '', toDownload[0]?.name ?? '')
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
  check('章节目录页数正确', files.length === 12, `实际 ${files.length} 个文件`)

  let orderOk = files.length === 12
  let orderDetail = orderOk ? '' : `只有 ${files.length} 个文件，跳过校验`
  for (let i = 0; orderOk && i < files.length; i++) {
    const size = readJpegSize(fs.readFileSync(path.join(dir, files[i])))
    const expectPage = i + 1
    // 宽度 = 100 + 页号
    if (!size || size.width !== 100 + expectPage) {
      orderOk = false
      orderDetail = `${files[i]} 宽度=${size?.width}，期望 ${100 + expectPage}`
      break
    }
  }
  check('页序与 words 一致（001.jpg 是第 1 页）', orderOk, orderDetail || '12 页全部匹配')

  /* ---------- 6. PDF 导出 ---------- */
  // 6a. 不加密版本：用 pdf-lib 读回来核对页数（原版会漏掉第 001 页）
  const plainRes = await makePdf(dir, { password: null })
  check('生成未加密 PDF', plainRes.ok, plainRes.ok ? `${plainRes.pages} 页` : plainRes.error)
  if (plainRes.ok && plainRes.pdfPath) {
    const { PDFDocument } = await import('pdf-lib-plus-encrypt')
    const doc = await PDFDocument.load(fs.readFileSync(plainRes.pdfPath))
    check('PDF 页数 = 12（含第 001 页）', doc.getPageCount() === 12, `实际 ${doc.getPageCount()} 页`)
  }

  // 6b. 加密版本
  const pdfRes = await makePdf(dir, { password: 'secret123' })
  check('生成加密 PDF', pdfRes.ok && !!pdfRes.pdfPath, pdfRes.ok ? `${pdfRes.pages} 页` : pdfRes.error)

  if (pdfRes.ok && pdfRes.pdfPath && fs.existsSync(pdfRes.pdfPath)) {
    const bytes = fs.readFileSync(pdfRes.pdfPath)
    const text = bytes.toString('latin1')
    check('PDF 文件头正确', text.startsWith('%PDF-'), text.slice(0, 8).trim())

    const encIdx = text.indexOf('/Filter /Standard')
    const encDict = encIdx > 0 ? text.slice(encIdx, encIdx + 400) : ''
    check('PDF 含标准加密字典 /Filter /Standard', !!encDict, encDict.split('\n')[1]?.trim() ?? '')
    check('PDF 使用 AES 加密 (AESV2)', encDict.includes('AESV2'), encDict.includes('AESV2') ? 'AESV2' : encDict.slice(0, 80))
    check('PDF 标准加密 V4/R4', /\/V\s*4/.test(encDict) && /\/R\s*4/.test(encDict), (encDict.match(/\/(V|R)\s*\d/g) ?? []).join(' '))

    // 不带密码应当打不开
    const { PDFDocument: Plain } = await import('pdf-lib-plus-encrypt')
    let needsPassword = false
    try {
      await Plain.load(bytes)
    } catch (e) {
      needsPassword = /encrypt/i.test(String(e))
    }
    check('无密码时无法打开（确实受保护）', needsPassword, needsPassword ? '被拒绝' : '竟然能打开')
  }

  /* ---------- 7. 断点续传 ---------- */
  fs.unlinkSync(path.join(dir, '005.jpg'))
  const before = fs.readdirSync(dir).length
  queue.retry(tasks[0].id)
  const t2 = Date.now()
  while (Date.now() - t2 < 60_000) {
    if (queue.stats().pending === 0 && queue.stats().running === 0) break
    await new Promise((r) => setTimeout(r, 300))
  }
  const after = fs.readdirSync(dir).length
  const retried = queue.list().find((t) => t.id === tasks[0].id)
  check(
    '断点续传只补缺失页',
    after === before + 1 && retried?.skipped === 11 && retried?.downloaded === 1,
    `删后 ${before} 补后 ${after}，新下载 ${retried?.downloaded}，跳过 ${retried?.skipped}`
  )
  check(
    '补下的 005.jpg 确为第 5 页',
    readJpegSize(fs.readFileSync(path.join(dir, '005.jpg')))?.width === 105,
    `宽度=${readJpegSize(fs.readFileSync(path.join(dir, '005.jpg')))?.width}`
  )

  /* ---------- 8. 漫画库扫描 ---------- */
  const lib = await listLibrary()
  const libComic = lib.find((c) => c.name === (detail.ok ? detail.data.name : ''))
  check('漫画库扫描到章节', !!libComic && libComic.chapters.length === 2,
    libComic ? `${libComic.chapters.length} 章 / ${libComic.totalPages} 页` : '未找到')
  check('漫画库识别到已生成 PDF', !!libComic?.chapters[0].pdfPath, libComic?.chapters[0].pdfPath ?? '')

  /* ---------- 8b. 元信息与完整性 ---------- */
  check('已写入站点 path_word', libComic?.meta?.pathWord === pathWord,
    `pathWord=${libComic?.meta?.pathWord}`)
  check('两章都标记为完整',
    !!libComic && libComic.chapters.every((c) => c.complete === true),
    libComic?.chapters.map((c) => `${c.name}:${c.complete}`).join(', ') ?? '')
  check('章节记录了期望页数', libComic?.chapters[0]?.expectedPages === 12,
    `expectedPages=${libComic?.chapters[0]?.expectedPages}`)
  check('不完整计数为 0', libComic?.incompleteCount === 0, `incomplete=${libComic?.incompleteCount}`)

  // 通过正式 API 标一次"第 3 页失败"，验证"缺页"能被识别和补下。
  // 直接改文件不行：meta.ts 有进程内缓存，写完再读会拿到旧值。
  const { rememberChapterResult } = await import('../src/main/meta')
  rememberChapterResult(detail.ok ? detail.data.name : '', libComic!.chapters[0].name, {
    uuid: toDownload[0].uuid,
    total: 12,
    failed: [3]
  })

  const lib2 = await listLibrary()
  const lib2Comic = lib2.find((c) => c.name === (detail.ok ? detail.data.name : ''))
  check('缺页章节被标记为不完整',
    lib2Comic?.chapters[0]?.complete === false && lib2Comic.incompleteCount === 1,
    `complete=${lib2Comic?.chapters[0]?.complete} / incomplete=${lib2Comic?.incompleteCount}`)
  check('失败页码被记下',
    JSON.stringify(lib2Comic?.chapters[0]?.failedPages) === '[3]',
    JSON.stringify(lib2Comic?.chapters[0]?.failedPages))

  const missing = listIncompleteChapters()
  check('能列出待补的缺页章节', missing.length === 1 && !!missing[0].uuid,
    JSON.stringify(missing))

  // 补一次：走续传，已有的页会跳过
  const requeued = queue.enqueue(
    missing.map((c) => ({
      comicPath: c.comicPath,
      comicName: c.comicName,
      chapterIndex: 0,
      chapterName: c.chapterName,
      uuid: c.uuid
    }))
  )
  const t4 = Date.now()
  while (Date.now() - t4 < 90_000) {
    if (queue.stats().pending === 0 && queue.stats().running === 0) break
    await new Promise((r) => setTimeout(r, 300))
  }
  const lib3 = await listLibrary()
  const lib3Comic = lib3.find((c) => c.name === (detail.ok ? detail.data.name : ''))
  check('补下后重新标记为完整',
    requeued.length === 1 && lib3Comic?.chapters[0]?.complete === true,
    `重排 ${requeued.length} 章，complete=${lib3Comic?.chapters[0]?.complete}`)

  /* ---------- 9. 追更 ---------- */
  const cfg2 = loadConfig()
  check('追更订阅已写入配置', cfg2.comics.some((c) => c.path === pathWord),
    JSON.stringify(cfg2.comics))
  check('下载成功后推进 last_chapter', cfg2.comics[0]?.last_chapter === 1,
    `last_chapter=${cfg2.comics[0]?.last_chapter}`)

  // 把订阅指针退回，制造“已有更新”的场景再跑一次追更
  const cfg3 = loadConfig()
  cfg3.comics[0].last_chapter = 0
  cfg3.comics[0].download_limit = 3
  saveConfig(cfg3)

  const upd = await checkUpdates()
  check('追更检查入队新章节', upd.queued === 3, `检查 ${upd.checked} 部，入队 ${upd.queued} 章`)

  const t3 = Date.now()
  while (Date.now() - t3 < 120_000) {
    if (queue.stats().pending === 0 && queue.stats().running === 0) break
    await new Promise((r) => setTimeout(r, 300))
  }
  const cfg4 = loadConfig()
  check('追更后 last_chapter 推进到 3', cfg4.comics[0].last_chapter === 3,
    `last_chapter=${cfg4.comics[0].last_chapter}`)
  check('last_check_time 已写入', !!cfg4.comics[0].last_check_time, cfg4.comics[0].last_check_time)

  /* ---------- 汇总 ---------- */
  const failed = results.filter((r) => !r.ok)
  console.log('\n' + '='.repeat(60))
  console.log(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  if (failed.length) {
    console.log('失败项：')
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`))
  }
  console.log('='.repeat(60))
  logger.info('E2E 测试结束')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
