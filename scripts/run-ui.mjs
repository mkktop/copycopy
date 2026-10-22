import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import electronPath from 'electron'
import { encodeSolidJpeg } from './jpeg.mjs'
import { connectRenderer } from './lib/cdp.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mockPort = 8898
const debugPort = 9224
await fs.mkdir(path.join(root, '.tmp'), { recursive: true })
const data = await fs.mkdtemp(path.join(root, '.tmp', 'ui-data-'))
const shots = path.join(root, '.tmp', 'ui-screenshots')
await fs.mkdir(shots, { recursive: true })
await fs.mkdir(path.join(data, 'config'), { recursive: true })
await fs.mkdir(path.join(data, 'profile'), { recursive: true })
await fs.writeFile(
  path.join(data, 'config', 'comic.yaml'),
  JSON.stringify({
    global: {
      concurrency: 5,
      chapter_delay_min: 0,
      chapter_delay_max: 0,
      pdf_switch: 0,
      auto_check_on_launch: 0,
      auto_check_interval_hours: 0,
      notify_on_done: 0,
      ai_enabled: 0
    },
    comics: []
  })
)
for (const [name, counts] of [
  ['测试漫画', [12, 12]],
  ['旅程 100%', [2, 3]],
  ['夏日来信', [5]],
  ['山海之间', [4]]
]) {
  const comicDir = path.join(data, 'out', name)
  const records = {}
  for (const [index, pages] of counts.entries()) {
    const chapterName = `第${index + 1}话`
    const chapterDir = path.join(comicDir, chapterName)
    await fs.mkdir(chapterDir, { recursive: true })
    for (let page = 1; page <= pages; page++)
      await fs.writeFile(
        path.join(chapterDir, `${String(page).padStart(3, '0')}.jpg`),
        encodeSolidJpeg(100 + page, 180)
      )
    records[chapterName] = {
      total: pages,
      failed: [],
      uuid: `uuid-ch-${String(index + 1).padStart(4, '0')}`
    }
  }
  await fs.writeFile(
    path.join(comicDir, '.copycopy.json'),
    JSON.stringify({
      name,
      ...(name === '测试漫画' ? { pathWord: 'test_comic' } : {}),
      chapters: records
    })
  )
}
const bootstrap = path.join(data, 'bootstrap.cjs')
// The Electron runtime, rather than the npm launcher module, provides require('electron').
await fs.writeFile(
  bootstrap,
  `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(path.join(data, 'profile'))}); app.disableHardwareAcceleration(); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`
)
const mock = spawn(process.execPath, [path.join(root, 'scripts/mock-server.mjs')], {
  cwd: root,
  env: { ...process.env, MOCK_PORT: String(mockPort), MOCK_CHAPTERS: '121' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let desktop
let ui
const output = []
function capture(child) {
  child.stdout?.on('data', (chunk) => output.push(String(chunk)))
  child.stderr?.on('data', (chunk) => output.push(String(chunk)))
}
capture(mock)
async function expect(expression, label) {
  assert.equal(await ui.evaluate(expression), true, label)
  console.log(`PASS  ${label}`)
}
async function navigate(route) {
  await ui.evaluate(`location.hash = ${JSON.stringify('#' + route)}`)
  await ui.waitFor(`location.hash === ${JSON.stringify('#' + route)}`)
}
try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      ready = (await fetch(`http://127.0.0.1:${mockPort}/api/v3/comic2/test_comic`)).ok
    } catch {
      /* Starting. */
    }
    if (ready) break
    await delay(100)
  }
  assert.ok(ready, 'Local comic fixture server is ready')
  desktop = spawn(
    electronPath,
    ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`, bootstrap],
    {
      cwd: root,
      env: {
        ...process.env,
        HTTPS_PROXY: 'http://127.0.0.1:1',
        HTTP_PROXY: 'http://127.0.0.1:1',
        MKK_PROXY: 'http://127.0.0.1:1',
        MKK_DATA_DIR: data,
        MKK_API_BASE: `http://127.0.0.1:${mockPort}`,
        MKK_API_HOST: `127.0.0.1:${mockPort}`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  capture(desktop)
  ui = await connectRenderer(debugPort)
  await ui.waitFor(
    "document.querySelector('[data-search-input]') && !document.querySelector('.startup-error')"
  )
  await expect(
    'typeof window.mkk === "object" && typeof require === "undefined"',
    '真实 preload 已注入，渲染层保持隔离'
  )
  await expect(
    'window.mkk.proxySet(null).then(proxy => proxy === null)',
    '关闭代理会显式直连，不会重新套用环境代理'
  )
  await ui.screenshot(path.join(shots, '01-discover.png'))

  await ui.fill('[data-search-input]', '测试')
  await ui.click('.search-submit')
  await ui.waitFor("document.querySelector('.comic-card')")
  await ui.fill('[data-search-input]', '尚未提交的关键词')
  await expect(
    "document.querySelector('.result-heading').textContent.includes('测试') && !document.querySelector('.result-heading').textContent.includes('尚未提交')",
    '结果标题绑定已提交的搜索词'
  )
  await ui.click('.comic-card')
  await ui.waitFor("document.querySelectorAll('.chapter-grid .chapter').length === 50")
  await ui.click('.chapter-grid .chapter:nth-child(3)')
  await ui.clickText('下一页')
  await ui.waitFor("document.querySelector('.chapter-index')?.textContent === '51'")
  await ui.click('.chapter-grid .chapter:first-child')
  await ui.clickText('上一页')
  await ui.waitFor("document.querySelector('.chapter-index')?.textContent === '01'")
  await expect(
    "document.querySelector('.chapter-grid .chapter:nth-child(3)').getAttribute('aria-checked') === 'true' && document.querySelector('.selection-bar strong').textContent === '2'",
    '跨页选章被保留，并显示正确总数'
  )
  await ui.screenshot(path.join(shots, '02-chapters.png'))
  await ui.clickText('下载所选章节')
  await ui.waitFor(
    "window.mkk.queueList().then(tasks => tasks.length === 2 && tasks.every(task => task.status === 'done'))"
  )
  await expect(
    "window.mkk.queueList().then(tasks => tasks.map(task => task.chapterIndex).sort((a,b) => a-b).join(',') === '3,51')",
    '跨页勾选通过真实 IPC 下载对应章节'
  )
  await ui.clickText('加入追更')
  await ui.waitFor('window.mkk.getConfig().then(config => config.comics.length === 1)')
  await ui.click('a[href="#/subscriptions"]')
  await ui.waitFor("document.querySelector('.subscription-settings input')")
  await ui.fill('.subscription-settings input', 3)
  await ui.clickText('保存')
  await ui.waitFor('window.mkk.getConfig().then(config => config.comics[0].download_limit === 3)')
  console.log('PASS  追更订阅独立管理，并可保存单次追更上限')
  await ui.screenshot(path.join(shots, '03-subscriptions.png'))

  await ui.click('a[href="#/downloads"]')
  await ui.waitFor("document.querySelector('.queue-overview')")
  await ui.clickText('已完成2')
  await ui.waitFor("document.querySelectorAll('.task-list .task').length === 2")
  await ui.screenshot(path.join(shots, '04-downloads.png'))
  await expect(
    "!Array.from(document.querySelectorAll('.task-actions button')).some(button => button.textContent.includes('重试'))",
    '成功的任务显示阅读入口，不提示不必要的重试'
  )

  await ui.click('a[href="#/library"]')
  await ui.waitFor("document.querySelectorAll('.comic-card').length === 4")
  await ui.screenshot(path.join(shots, '05-library.png'))
  await ui.fill('.library-search input', '不存在的漫画')
  await ui.waitFor(
    "document.querySelector('.empty-state h2')?.textContent === '没有符合条件的漫画'"
  )
  console.log('PASS  书架筛选为空与尚未下载分别提示')
  await ui.fill('.library-search input', '')
  await ui.click('.comic-card[aria-label="打开《旅程 100%》"]')
  await ui.waitFor(
    "document.querySelector('.head-info .page-title')?.textContent.includes('旅程 100%')"
  )
  await ui.clickText('开始阅读')
  await ui.waitFor(
    "document.querySelector('.reader .title-text')?.textContent.includes('第1话') && !!document.querySelector('.stage img.is-current')"
  )
  await expect("!document.querySelector('.sidebar')", '阅读时隐藏工作台导航，进入完整阅读空间')
  await ui.clickText('下一章')
  await ui.waitFor(
    "document.querySelector('.title-text')?.textContent.includes('第2话') && document.querySelector('.stage img.is-current')?.getAttribute('src').includes(encodeURIComponent('第2话'))"
  )
  console.log('PASS  含 % 的漫画能打开，下一章重新加载正确内容')
  await ui.clickText('返回')
  await ui.waitFor(
    "Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === '继续阅读')"
  )
  await ui.clickText('继续阅读')
  await ui.waitFor("document.querySelector('.title-text')?.textContent.includes('第2话')")
  console.log('PASS  返回漫画后能继续上次阅读的章节')
  await ui.clickText('返回')

  await ui.click('a[href="#/settings"]')
  await ui.waitFor("document.querySelector('.appearance-options')")
  await ui.clickText('下载与导出')
  await ui.fill('[aria-label="图片并发数"] input', 7)
  await expect("document.querySelector('.savebar-dirty') !== null", '设置改动显示未保存状态')
  await expect(
    'window.mkk.getConfig().then(config => config.global.concurrency === 5)',
    '编辑草稿不会提前修改已保存的运行设置'
  )
  await ui.click('a[href="#/search"]')
  await ui.waitFor("document.querySelector('.n-dialog')")
  await ui.clickText('放弃修改')
  await ui.waitFor("document.querySelector('[data-search-input]')")
  await expect(
    "document.querySelector('.result-heading')?.textContent.includes('测试')",
    '返回发现页时保留搜索结果'
  )
  await ui.click('a[href="#/settings"]')
  await ui.waitFor("document.querySelector('.appearance-options')")
  await ui.clickText('下载与导出')
  await ui.fill('[aria-label="图片并发数"] input', 7)
  await ui.clickText('保存设置')
  await ui.waitFor('window.mkk.getConfig().then(config => config.global.concurrency === 7)')
  await expect("!document.querySelector('.savebar-dirty')", '保存后才更新运行配置，并清除草稿标记')
  await ui.clickText('AI 广告整理')
  await ui.fill('[aria-label="AI API Key"] input', 'sk-ui-fixture-not-sent')
  await expect(
    "!!document.querySelector('.savebar-dirty')",
    '只输入 API Key 也会启用保存并保护离开操作'
  )
  await ui.clickText('还原更改')
  await ui.clickText('通用与外观')
  await ui.screenshot(path.join(shots, '06-settings.png'))
  await ui.clickText('深色模式')
  await ui.waitFor("document.documentElement.dataset.theme === 'dark'")
  await ui.send('Page.reload')
  await ui.waitFor(
    "document.querySelector('.appearance-options') && document.documentElement.dataset.theme === 'dark'"
  )
  console.log('PASS  外观偏好在重新加载后保留')
  await ui.screenshot(path.join(shots, '07-settings-dark.png'))
  await ui.clickText('浅色模式')

  await ui.send('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false
  })
  await ui.waitFor('innerWidth <= 900')
  for (const route of [
    '/settings',
    '/library',
    '/downloads',
    '/subscriptions',
    '/ai-queue',
    '/search'
  ]) {
    await navigate(route)
    await ui.waitFor("document.querySelector('.page')")
    await expect(
      "Array.from(document.querySelectorAll('.page')).every(page => page.scrollWidth <= page.clientWidth + 1)",
      `900px 窗口无页面横向溢出：${route}`
    )
  }
  await ui.screenshot(path.join(shots, '08-small-window.png'))
  assert.equal(ui.exceptions.length, 0, JSON.stringify(ui.exceptions))
  console.log('PASS  全流程无未捕获的渲染错误')
  console.log(`截图：${shots}`)
} catch (error) {
  if (ui) await ui.screenshot(path.join(shots, 'failure.png')).catch(() => {})
  console.error(output.join('').slice(-6000))
  console.error(error)
  process.exitCode = 1
} finally {
  ui?.close()
  desktop?.kill()
  mock.kill()
}
