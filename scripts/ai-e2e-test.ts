/**
 * 广告检测端到端验证（真 Key）。
 * 在 Electron 里跑，走的是和正式功能完全相同的那条路径。
 */
import { app, safeStorage } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'

const KEY = process.env.MMK || ''

// 隔离数据目录
const DATA = path.join(os.tmpdir(), `copycopy-ai-e2e-${Date.now()}`)
fs.mkdirSync(DATA, { recursive: true })
process.env.MKK_DATA_DIR = DATA

// JPEG 编解码用仓库里的测试工具。encodeSolidJpeg 只能画纯色，
// 正好用来验「空白图不该被误判成广告」这个 fail-safe 行为。
const { encodeSolidJpeg } = require('./jpeg.mjs')

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ->  ' + detail : ''}`)
}

function makeChapter(dir: string, pages: number): void {
  fs.mkdirSync(dir, { recursive: true })
  for (let i = 1; i <= pages; i++) {
    // 每页尺寸不同，方便肉眼确认是哪一页被搬走了
    fs.writeFileSync(path.join(dir, `${String(i).padStart(3, '0')}.jpg`), encodeSolidJpeg(80 + i, 120))
  }
}

async function main(): Promise<void> {
  if (!KEY) {
    console.log('缺少 MKK 环境变量，跳过真实调用')
    process.exit(0)
  }

  const { initBaseDir, getOutDir } = require('../src/main/paths')
  const { loadConfig, saveConfig, DEFAULT_CONFIG } = require('../src/main/config')
  const { detectAdsForChapter, readAiSettings, undoAdsForChapter } = require('../src/main/ai/ad-service')
  const { listChapterFiles, ADS_DIR, moveAdsToArchive, restoreAds } = require('../src/main/library')
  const { readMeta, rememberComic, rememberChapterResult, forgetAds } = require('../src/main/meta')
  const { encryptSecret, decryptSecret } = require('../src/main/secrets')

  initBaseDir()
  check('MKK_DATA_DIR 生效（数据目录被隔离）', getOutDir().startsWith(DATA), getOutDir())

  /* ---------- 1. 密钥加密往返 ---------- */
  const enc = encryptSecret('sk-test-12345')
  check('safeStorage 加密可用', !!enc && enc !== 'sk-test-12345', String(enc).slice(0, 24) + '…')
  check('加密后能解回明文', decryptSecret(enc) === 'sk-test-12345')
  check('明文（旧格式）也能直接读', decryptSecret('plain-key') === 'plain-key')
  check('解密失败返回 null 而不抛异常', decryptSecret('safeStorage:@@@bogus@@@') === null)

  /* ---------- 2. 配置 ---------- */
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.global.ai_enabled = 1
  cfg.global.ai_base_url = 'https://api.minimaxi.com/v1'
  cfg.global.ai_model = 'MiniMax-M3'
  cfg.global.ai_head_pages = 1
  cfg.global.ai_tail_pages = 1
  cfg.global.ai_threshold = 0.5
  // 这里要用**真** Key，前面那个 sk-test-12345 只用来验加解密往返
  cfg.global.ai_api_key_enc = encryptSecret(KEY)
  saveConfig(cfg)

  const s = readAiSettings()
  check('配置能读回已解密的 Key', s.key === KEY)
  check('域名归一化保留', s.baseUrl === 'https://api.minimaxi.com/v1', s.baseUrl)

  /* ---------- 3. 造一章 6 页的"漫画" ---------- */
  const comic = '测试漫画'
  const chapter = '第1话'
  const dir = path.join(getOutDir(), comic, chapter)
  makeChapter(dir, 6)
  rememberComic(comic, { pathWord: 'test_comic', name: comic })
  rememberChapterResult(comic, chapter, { total: 6, failed: [] })

  check('检测前该章 6 页', listChapterFiles(dir).length === 6, `${listChapterFiles(dir).length} 页`)

  /* ---------- 4. 归档逻辑（确定性，不依赖 AI） ---------- */
  const mv = moveAdsToArchive(comic, chapter, [path.join(dir, '001.jpg'), path.join(dir, '006.jpg')])
  check('归档移动了 2 页', mv.moved === 2, `moved=${mv.moved} failed=${mv.failed}`)
  check('_ads/ 目录已建立', fs.existsSync(path.join(dir, ADS_DIR)))
  check('正文剩 4 页', listChapterFiles(dir).length === 4, `${listChapterFiles(dir).length} 页`)
  check('001 已不在正文', !fs.existsSync(path.join(dir, '001.jpg')))
  check('001 在 _ads 里', fs.existsSync(path.join(dir, ADS_DIR, '001.jpg')))
  check('越界路径被拒绝', moveAdsToArchive(comic, chapter, ['../../escape.jpg']).moved === 0)

  const back = restoreAds(comic, chapter)
  check('撤销恢复 2 页', back === 2, `恢复 ${back}`)
  check('正文恢复成 6 页', listChapterFiles(dir).length === 6, `${listChapterFiles(dir).length} 页`)
  check('_ads 目录已空', fs.readdirSync(path.join(dir, ADS_DIR)).length === 0)

  /* ---------- 5. 短章保护 ---------- */
  const shortDir = path.join(getOutDir(), comic, '短章')
  makeChapter(shortDir, 2)
  rememberChapterResult(comic, '短章', { total: 2, failed: [] })
  const shortRes = await detectAdsForChapter(comic, '短章')
  check(
    '短章被保护（页数 <= 头+尾 时跳过）',
    !shortRes.ok && /少于检查范围/.test(shortRes.error ?? ''),
    shortRes.error ?? ''
  )
  check('短章文件一个都没动', listChapterFiles(shortDir).length === 2)

  /* ---------- 6. 真实调用 ---------- */
  console.log('\n--- 真实调用 MiniMax-M3（6 页纯色图）---')
  const t0 = Date.now()
  const res = await detectAdsForChapter(comic, chapter)
  const ms = Date.now() - t0
  check('检测调用成功', res.ok, `${ms}ms  ${res.error ?? ''}`)
  console.log(`  耗时 ${ms}ms，判定 ${res.verdicts?.length ?? 0} 条：`)
  for (const v of res.verdicts ?? []) {
    console.log(
      `    第${v.page}页 isAd=${v.isAd} conf=${v.confidence} type=${v.adType ?? '-'} ${v.reason ?? ''}`
    )
  }
  // 纯色空白图不该被判成广告——这是防误删的关键
  check(
    '纯色图未被误判为广告（防误删）',
    (res.verdicts ?? []).every((v) => !v.isAd),
    JSON.stringify((res.verdicts ?? []).filter((v) => v.isAd).map((v) => v.page))
  )
  check('没有文件被搬走', listChapterFiles(dir).length === 6, `${listChapterFiles(dir).length} 页`)

  const rec = readMeta(comic)?.chapters?.[chapter]
  check('元信息写入了检测时间', !!rec?.adCheckedAt, rec?.adCheckedAt ?? '')
  check('元信息写入了模型名', rec?.adModel === 'MiniMax-M3', rec?.adModel ?? '')

  /* ---------- 7. 幂等：不重复付费 ---------- */
  const again = await detectAdsForChapter(comic, chapter)
  check('已检测过的章节直接跳过（不重复花钱）', again.skipped === true && again.elapsedMs === 0)

  /* ---------- 8. 撤销清标记 ---------- */
  forgetAds(comic, chapter)
  check('清标记后 adCheckedAt 消失', !readMeta(comic)?.chapters?.[chapter]?.adCheckedAt)

  /* ---------- 9. 失败时 fail-open ---------- */
  const badCfg = structuredClone(cfg)
  badCfg.global.ai_api_key_enc = encryptSecret('sk-invalid-key-for-failopen-test')
  saveConfig(badCfg)
  const failRes = await detectAdsForChapter(comic, chapter, true)
  check('Key 无效时检测失败', !failRes.ok, failRes.error ?? '')
  check('失败后文件一个没少（fail-open）', listChapterFiles(dir).length === 6, `${listChapterFiles(dir).length} 页`)
  check('失败不写入"已检测"标记（下次可重试）', !readMeta(comic)?.chapters?.[chapter]?.adCheckedAt)

  /* ---------- 10. 国际站域名应给出明确失败 ---------- */
  saveConfig(cfg)
  const intlCfg = structuredClone(cfg)
  intlCfg.global.ai_base_url = 'https://api.minimax.io/v1'
  saveConfig(intlCfg)
  const intlRes = await detectAdsForChapter(comic, chapter, true)
  check('国际站域名会被拒绝（Key 不通用）', !intlRes.ok, intlRes.error ?? '')

  /* ---------- 11. 并发闸门 ---------- */
  const { aiActiveCount } = require('../src/main/ai/ad-service')
  saveConfig(cfg)
  const chapters: string[] = []
  for (let n = 1; n <= 6; n++) {
    const name = `并发${n}话`
    makeChapter(path.join(getOutDir(), comic, name), 8)
    rememberChapterResult(comic, name, { total: 8, failed: [] })
    chapters.push(name)
  }

  for (const limit of [1, 3]) {
    const lc = structuredClone(cfg)
    lc.global.ai_concurrency = limit
    saveConfig(lc)

    let peak = 0
    const watch = setInterval(() => {
      peak = Math.max(peak, aiActiveCount())
    }, 25)

    const t = Date.now()
    // force=true：第二轮要重跑，否则会命中"已检测过就跳过"的幂等逻辑，秒退
    await Promise.all(chapters.map((c) => detectAdsForChapter(comic, c, true)))
    const ms = Date.now() - t
    clearInterval(watch)

    check(
      `并发上限 ${limit} 生效（实测峰值不超过它）`,
      peak <= limit && peak >= 1,
      `峰值 ${peak}，6 章耗时 ${ms}ms`
    )
    console.log(`  并发 ${limit} -> 峰值 ${peak}，${ms}ms`)
  }

  /* ---------- 汇总 ---------- */
  console.log('\n' + '='.repeat(60))
  console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
  console.log('='.repeat(60))
  // logger 还开着写句柄，目录可能删不掉，失败无所谓
  try {
    fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* 留给系统清理 */
  }
  process.exit(fail === 0 ? 0 : 1)
}

app.whenReady()
  .then(main)
  .catch((e) => {
    console.error('异常', e)
    process.exit(1)
  })
