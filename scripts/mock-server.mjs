/**
 * 本地模拟站点，复刻拷贝漫画的 4 个 v3 接口。
 * 真实站点在当前网络下不可达，用它把下载流水线端到端跑通。
 *
 * 关键设计：contents 顺序是打乱的，words 才是阅读顺序，
 * 且第 n 页图片宽度 = 100 + n，测试据此验证页序还原是否正确。
 */
import http from 'http'
import { encodeSolidJpeg } from './jpeg.mjs'

const PORT = Number(process.env.MOCK_PORT || 8899)
const PAGES_PER_CHAPTER = Number(process.env.MOCK_PAGES || 12)
const TOTAL_CHAPTERS = Number(process.env.MOCK_CHAPTERS || 8)

const COMIC = { name: '测试漫画', path: 'test_comic' }

/** chapterIndex(1起) -> uuid */
function uuidFor(chapterIndex) {
  return `uuid-ch-${String(chapterIndex).padStart(4, '0')}`
}
function chapterIndexOf(uuid) {
  return Number(String(uuid).replace('uuid-ch-', ''))
}
function chapterName(i) {
  return `第${i}话`
}

/** 打乱 n 个元素的确定性乱序 */
function shuffled(n) {
  const arr = Array.from({ length: n }, (_, i) => i)
  let seed = 42
  for (let i = n - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const j = seed % (i + 1)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function ok(results) {
  return { code: 200, message: 'success', results }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const p = url.pathname
  const send = (obj) => {
    const body = JSON.stringify(obj)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(body)
  }

  // 搜索
  if (p === '/api/v3/search/comic') {
    const q = url.searchParams.get('q') || ''
    const limit = Number(url.searchParams.get('limit') || 5)
    const offset = Number(url.searchParams.get('offset') || 0)
    // 匹配得上就返回；匹配不上也返回。
    //
    // 应用首页那排推荐词（海贼王、电锯人…）是真实漫画名，对着模拟站点
    // 点任何一颗都必然搜不到东西，看起来像应用坏了。这里放宽成"永远有结果"，
    // 让人一眼就能确认搜索链路是通的。
    const matched = [COMIC].filter((c) => c.name.includes(q) || c.path.includes(q))
    const all = matched.length > 0 ? matched : [COMIC]
    return send(
      ok({
        total: all.length,
        limit,
        offset,
        list: all.slice(offset, offset + limit).map((c) => ({
          name: c.name,
          alias: '测试 / 完结',
          path_word: c.path,
          cover: `http://127.0.0.1:${PORT}/img/cover.jpg`,
          author: [{ name: '测试作者' }]
        }))
      })
    )
  }

  // 详情
  let m = /^\/api\/v3\/comic2\/([^/]+)$/.exec(p)
  if (m) {
    return send(
      ok({
        comic: {
          name: COMIC.name,
          alias: '测试 / 完结',
          brief: '这是用于自动化测试的模拟漫画，用来验证页序还原、断点续传与 PDF 导出。',
          datetime_updated: '2026-09-28 00:00:00',
          cover: `http://127.0.0.1:${PORT}/img/cover.jpg`,
          last_chapter: { name: chapterName(TOTAL_CHAPTERS) }
        }
      })
    )
  }

  // 章节列表
  m = /^\/api\/v3\/comic\/([^/]+)\/group\/default\/chapters$/.exec(p)
  if (m) {
    const limit = Number(url.searchParams.get('limit') || 50)
    const offset = Number(url.searchParams.get('offset') || 0)
    const list = []
    for (let i = offset + 1; i <= Math.min(offset + limit, TOTAL_CHAPTERS); i++) {
      list.push({
        name: chapterName(i),
        size: PAGES_PER_CHAPTER,
        datetime_created: '2026-09-28 00:00:00',
        uuid: uuidFor(i)
      })
    }
    return send(ok({ total: TOTAL_CHAPTERS, limit, offset, list }))
  }

  // 单章页表
  m = /^\/api\/v3\/comic\/([^/]+)\/chapter2\/([^/]+)$/.exec(p)
  if (m) {
    const idx = chapterIndexOf(m[2])
    if (!Number.isFinite(idx) || idx < 1 || idx > TOTAL_CHAPTERS) {
      res.writeHead(404).end('{}')
      return
    }
    // contents 是乱序存放的（站点按批次分组），words 才是真实阅读顺序
    const perm = shuffled(PAGES_PER_CHAPTER)
    // contents[j] 存的是第 perm[j]+1 页
    const contents = perm.map((p0) => ({
      url: `img/p-${idx}-${p0 + 1}.jpg` // 相对路径，顺带验证 absoluteUrl
    }))
    // 阅读顺序为第 1..N 页：第 i 页对应 contents 中 perm[i] 所在的位置
    const words = Array.from({ length: PAGES_PER_CHAPTER }, (_, i) => perm.indexOf(i))
    return send(
      ok({
        chapter: { name: chapterName(idx), words, contents },
        comic: { name: COMIC.name }
      })
    )
  }

  // 图片
  m = /^\/img\/p-(\d+)-(\d+)\.jpg$/.exec(p)
  if (m) {
    const pageNo = Number(m[2])
    const jpeg = encodeSolidJpeg(100 + pageNo, 200)
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpeg.length })
    return res.end(jpeg)
  }
  if (p === '/img/cover.jpg') {
    const jpeg = encodeSolidJpeg(150, 200)
    res.writeHead(200, { 'content-type': 'image/jpeg' })
    return res.end(jpeg)
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"code":404}')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] 模拟站点已启动 http://127.0.0.1:${PORT}`)
  console.log(`[mock] 章节数=${TOTAL_CHAPTERS} 每章页数=${PAGES_PER_CHAPTER}`)
})
