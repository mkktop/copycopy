import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import { installDesktop } from './desktop.fixture'

const failures = new WeakMap<object, string[]>()
test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  failures.set(page, errors)
  page.on('pageerror', (error) => errors.push(error.message))
  await installDesktop(page)
  await page.goto('/')
  await expect(page.locator('[data-app-ready]')).toBeVisible()
})
test.afterEach(async ({ page }) => {
  expect(failures.get(page)).toEqual([])
})

test('pika-style navigation, card layout and persistent appearance', async ({ page }) => {
  await expect(page.getByRole('heading', { name: '发现故事', exact: true })).toBeVisible()
  await expect(page.locator('.comic-card')).toHaveCount(24)
  await expect(page.getByRole('navigation', { name: '主导航' })).not.toContainText(/AI|广告整理/)
  await fs.mkdir('test-results/previews', { recursive: true })
  await page.screenshot({ path: 'test-results/previews/home.png' })
  await page.getByRole('button', { name: '收起导航', exact: true }).click()
  await expect(page.locator('.sidebar')).toHaveClass(/collapsed/)
  await page.reload()
  await expect(page.locator('.sidebar')).toHaveClass(/collapsed/)
  await page.getByRole('button', { name: '展开导航', exact: true }).click()
  await page.getByRole('button', { name: '切换外观', exact: true }).click()
  await expect(page.locator('.app-container')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('.app-container')).toHaveAttribute('data-theme', 'dark')
})

test('search keeps committed terms and results across detail navigation', async ({ page }) => {
  await page.getByRole('textbox', { name: '全局搜索' }).fill('冒险')
  await page.getByRole('textbox', { name: '全局搜索' }).press('Enter')
  await expect(page.getByRole('heading', { name: /「冒险」的搜索结果/ })).toBeVisible()
  await page.getByRole('textbox', { name: '漫画搜索词' }).fill('尚未提交')
  await expect(page.getByRole('heading', { name: /「冒险」的搜索结果/ })).toBeVisible()
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.locator('.comic-card')).toHaveCount(8)
  const first = await page.locator('.comic-title').first().textContent()
  await page.locator('.comic-card').first().click()
  await expect(page.locator('.chapter-cell')).toHaveCount(50)
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await expect(page.locator('.comic-title').first()).toHaveText(first!)
  await expect(page.locator('.paginator .page-btn.active')).toHaveText('2')
})

test('chapter selection survives pagination and enqueue uses exact selected ids', async ({
  page
}) => {
  await page.locator('.comic-card').first().click()
  await page.getByRole('checkbox', { name: '选择 第3话', exact: true }).check()
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await page.getByRole('checkbox', { name: '选择 第51话', exact: true }).check()
  await expect(page.locator('.selection-count')).toHaveText('已选 2 章')
  await page.locator('[data-download-selected]').click()
  const ids = await page.evaluate(() => (window as any).__copycopyTest.state.enqueued)
  expect(ids).toEqual(['c1-ch3', 'c1-ch51'])
  await page.getByRole('button', { name: '加入追更', exact: true }).click()
  await page.getByRole('link', { name: '追更订阅', exact: true }).click()
  await expect(page.locator('.subscription-info h3')).toHaveText('雨后的书店')
  await page.getByRole('spinbutton', { name: '雨后的书店 单次追更章数' }).fill('3')
  await page.getByRole('button', { name: '保存偏好', exact: true }).click()
  expect(
    await page.evaluate(() => (window as any).__copycopyTest.state.subscriptions[0].chapterLimit)
  ).toBe(3)
  await page.getByRole('link', { name: /下载管理/ }).click()
  await expect(page.locator('[data-task-status="done"]')).toHaveCount(2)
  await expect(page.getByRole('button', { name: '开始阅读', exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '清理已结束记录', exact: true }).click()
  // 危险操作现在要求二次确认
  await page.getByRole('dialog').getByRole('button', { name: '清理记录', exact: true }).click()
  await expect(page.locator('.download-row')).toHaveCount(0)
})

test('library filtering, deliberate chapter management, PDF export and deletion', async ({
  page
}) => {
  await page.getByRole('link', { name: '本地书库', exact: true }).click()
  await page.getByRole('textbox', { name: '筛选书库' }).fill('不存在')
  await expect(page.getByRole('heading', { name: '没有符合筛选的漫画', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '清除筛选', exact: true }).click()
  await page.getByRole('button', { name: '查看 雨后的书店', exact: true }).click()
  await expect(page.locator('[data-chapter-batch]')).toHaveCount(0)
  await page.getByRole('button', { name: '管理章节', exact: true }).click()
  await page.getByRole('checkbox', { name: '全选当前结果', exact: true }).check()
  await page
    .locator('[data-chapter-batch]')
    .getByRole('button', { name: '导出 PDF', exact: true })
    .click()
  await expect(page.getByRole('button', { name: '打开 PDF', exact: true })).toHaveCount(2)
  expect(
    await page.evaluate(() => (window as any).__copycopyTest.state.exportCalls[0].chapterIds)
  ).toEqual(['c1-ch1', 'c1-ch2'])
  await page
    .locator('[data-chapter-batch]')
    .getByRole('button', { name: '删除章节', exact: true })
    .click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('.local-chapter-row')).toHaveCount(2)
  await page.getByRole('button', { name: '退出管理', exact: true }).click()
  await expect(page.locator('[data-chapter-batch]')).toHaveCount(0)
})

test('reader changes chapter, persists page and handles Esc from focused controls', async ({
  page
}) => {
  await page.getByRole('link', { name: '本地书库', exact: true }).click()
  await page.getByRole('button', { name: '查看 雨后的书店', exact: true }).click()
  await page.getByRole('button', { name: '阅读 第1话', exact: true }).click()
  await expect(page.locator('.sidebar')).toHaveCount(0)
  await expect(page.locator('.reader-heading')).toContainText('第1话')
  await page.getByRole('combobox', { name: '阅读模式', exact: true }).selectOption('paged')
  await page.getByRole('button', { name: '下一章', exact: true }).click()
  await expect(page.locator('.reader-heading')).toContainText('第2话')
  await expect(page.getByRole('img', { name: '第2话 第 1 页', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '下一张图片', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: '阅读页码' })).toHaveValue('2')
  await page.getByRole('combobox', { name: '阅读模式', exact: true }).focus()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: '雨后的书店', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '继续阅读', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: '阅读页码' })).toHaveValue('2')
})

test('settings are drafts, leave guard works, saved values and dark preview persist', async ({
  page
}) => {
  await page.getByRole('link', { name: '偏好设置', exact: true }).click()
  await page.getByRole('button', { name: '下载与追更', exact: true }).click()
  await page.getByRole('spinbutton', { name: '图片并发数' }).fill('7')
  expect(
    await page.evaluate(() => (window as any).__copycopyTest.state.settings.parallelImages)
  ).toBe(5)
  await expect(page.locator('.settings-savebar')).toContainText('有未保存的偏好')
  await page.getByRole('link', { name: '发现故事', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '保存偏好', exact: true }).click()
  expect(
    await page.evaluate(() => (window as any).__copycopyTest.state.settings.parallelImages)
  ).toBe(7)
  await page.getByRole('button', { name: '外观与体验', exact: true }).click()
  await page.getByRole('button', { name: /夜间小书房/ }).click()
  await page.getByRole('button', { name: '保存偏好', exact: true }).click()
  await expect(page.locator('.app-container')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('.toast')).toHaveCount(0)
  await fs.mkdir('test-results/previews', { recursive: true })
  await page.screenshot({ path: 'test-results/previews/settings-dark.png' })
  await page.reload()
  await expect(page.locator('.app-container')).toHaveAttribute('data-theme', 'dark')
})

test('software update notes remain text and download waits for explicit installation', async ({
  page
}) => {
  await page.getByRole('link', { name: '偏好设置', exact: true }).click()
  await page.getByRole('button', { name: '软件更新', exact: true }).click()
  await page.evaluate(() => (window as any).__copycopyTest.setUpdateAvailable(true))
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await expect(page.locator('.app-updates')).toContainText('发现新版本 v2.2.0')
  await page.getByText('更新说明', { exact: true }).click()
  await expect(page.locator('.update-notes img')).toHaveCount(0)
  await page.getByRole('button', { name: /下载更新/ }).click()
  await expect(page.getByRole('button', { name: '退出并安装', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).__copycopyTest.state.installRequested)).toBe(
    false
  )
})

test('desktop layouts fit at the minimum window width', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 700 })
  for (const path of ['/library', '/downloads', '/subscriptions', '/settings', '/search']) {
    await page.goto('/#' + path)
    await expect(page.locator('[data-app-ready]')).toBeVisible()
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.querySelector('.workspace')!.scrollWidth <=
            document.querySelector('.workspace')!.clientWidth + 1
      )
    ).toBe(true)
  }
})

// ---------------------------------------------------------------------------
// 回归用例：分页竞态 / 键盘翻页 / 错误重试 / 队列动作 / 危险确认 / 事件清理
// ---------------------------------------------------------------------------

function task(id: string, index: number, status: string) {
  return {
    id,
    comic: {
      id: 'c1',
      title: '雨后的书店',
      alias: '冒险 / 完结',
      cover: 'https://covers.example/cover/1.jpg',
      authors: ['青木'],
      description: '',
      updatedAt: '2026-11-03',
      latestChapter: '第52话'
    },
    chapter: {
      id: 'c1-ch' + index,
      title: '第' + index + '话',
      index,
      pageCount: 7,
      updatedAt: '2026-11-03'
    },
    directory: 'fixture',
    status,
    completed: status === 'done' ? 7 : 0,
    total: 7,
    skipped: 0,
    failedPages: status === 'failed' ? [1] : [],
    error: status === 'failed' ? '图片下载失败' : null,
    startedAt: 1,
    finishedAt: ['done', 'failed', 'canceled'].includes(status) ? 2 : null
  }
}

// ① 章节分页快速连点的竞态：乱序返回后页码与列表一致（只认最后一次点击）
test('chapter pagination ignores out-of-order responses', async ({ page }) => {
  await page.evaluate(() => {
    const h = (window as any).__TEST_HOOKS__
    h.setChapterTotal(150) // 3 页，每页 50 章
    h.delayChapterPage(2, 500) // 第 2 页故意变慢，先点 2 再点 3
  })
  await page.locator('.comic-card').first().click()
  await expect(page.locator('.chapter-cell')).toHaveCount(50)
  // 同步连点两个分页按钮：两者都读到旧的 loading=false，产生两个并发请求。
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.paginator .page-btn:not(.nav)')]
    const click = (n: string) =>
      buttons
        .find((b) => (b.textContent || '').trim() === n)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    click('2') // 慢请求（gen 较旧）
    click('3') // 快请求（最后一次点击，gen 最新）
  })
  // 首次响应（第 3 页）之后按钮即解锁；旧的慢请求返回后不得覆盖。
  await expect(page.locator('.paginator .page-btn.active')).toHaveText('3')
  await expect(page.locator('.chapter-cell')).toHaveCount(50)
  await expect(page.locator('.chapter-cell').first()).toContainText('第101话')
  // 等慢请求也返回，确认没有回写成第 2 页。
  await page.waitForTimeout(650)
  await expect(page.locator('.paginator .page-btn.active')).toHaveText('3')
  await expect(page.locator('.chapter-cell').first()).toContainText('第101话')
})

// ② 焦点停留在按钮上时，方向键 / PageDown 仍能翻页（不被当作文本输入屏蔽）
test('reader arrow keys work while a flip button keeps focus', async ({ page }) => {
  await page.getByRole('link', { name: '本地书库', exact: true }).click()
  await page.getByRole('button', { name: '查看 雨后的书店', exact: true }).click()
  await page.getByRole('button', { name: '阅读 第1话', exact: true }).click()
  await page.getByRole('combobox', { name: '阅读模式', exact: true }).selectOption('paged')
  await page.getByRole('button', { name: '下一张图片', exact: true }).click() // 焦点留在此 button
  await expect(page.getByRole('spinbutton', { name: '阅读页码' })).toHaveValue('2')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('spinbutton', { name: '阅读页码' })).toHaveValue('3')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('spinbutton', { name: '阅读页码' })).toHaveValue('2')
  await page.keyboard.press('PageDown')
  await expect(page.getByRole('spinbutton', { name: '阅读页码' })).toHaveValue('3')
})

// ③ 搜索失败后点「重试搜索」恢复结果
test('search failure shows retry and recovers', async ({ page }) => {
  await page.evaluate(() =>
    (window as any).__TEST_HOOKS__.failOnce('search_comics', '网络抖了一下')
  )
  await page.getByRole('textbox', { name: '全局搜索' }).fill('冒险')
  await page.getByRole('textbox', { name: '全局搜索' }).press('Enter')
  await expect(page.getByRole('heading', { name: '搜索暂时不可用' })).toBeVisible()
  await expect(page.locator('.empty-state')).toContainText('网络抖了一下')
  await page.getByRole('button', { name: '重试搜索', exact: true }).click()
  await expect(page.locator('.comic-card')).toHaveCount(24)
})

// ④ retry / moveTop 队列动作生效；增量 task 事件（Delta）能 merge 进列表
test('queue retry / moveTop actions and delta events take effect', async ({ page }) => {
  await page.getByRole('link', { name: /下载管理/ }).click()
  const seed = [task('t1', 1, 'pending'), task('t2', 2, 'pending'), task('t3', 3, 'failed')]
  await page.evaluate((tasks) => (window as any).__TEST_HOOKS__.seedQueue(tasks), seed)
  await expect(page.locator('.download-row')).toHaveCount(3)
  // moveTop：把第 2 个任务置顶
  await page.locator('.download-row').nth(1).getByRole('button', { name: '置顶' }).click()
  await expect(page.locator('.download-row').first()).toContainText('第2话')
  // retry：failed -> pending，出现「取消」且失败态消失
  await page
    .locator('[data-task-status="failed"]')
    .getByRole('button', { name: '重试续传' })
    .click()
  await expect(page.locator('[data-task-status="failed"]')).toHaveCount(0)
  await expect(page.locator('.download-row').filter({ hasText: '第3话' })).toContainText('取消')
  // Delta 增量事件：{revision, task} 单对象，按 id 合并新增一行
  const delta = task('t4', 4, 'running')
  await page.evaluate((t) => (window as any).__TEST_HOOKS__.emitTaskDelta(t), delta)
  await expect(page.locator('.download-row')).toHaveCount(4)
  await expect(page.locator('.download-row').filter({ hasText: '第4话' })).toHaveCount(1)
})

// ⑤ 危险操作要求确认：取消保留、确认清空；遮罩点击可关闭
test('dangerous queue actions require confirmation', async ({ page }) => {
  await page.getByRole('link', { name: /下载管理/ }).click()
  const seed = [task('t1', 1, 'done'), task('t2', 2, 'running')]
  await page.evaluate((tasks) => (window as any).__TEST_HOOKS__.seedQueue(tasks), seed)
  await expect(page.locator('.download-row')).toHaveCount(2)
  // 取消全部：先取消，任务仍在
  await page.getByRole('button', { name: '取消全部', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('[data-task-status="running"]')).toHaveCount(1)
  // 清理已结束记录：点遮罩关闭（不执行），再确认才清空 done
  await page.getByRole('button', { name: '清理已结束记录', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveAttribute('aria-describedby', 'confirm-message')
  await page.locator('.dialog-backdrop').click({ position: { x: 5, y: 5 } })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.download-row')).toHaveCount(2)
  await page.getByRole('button', { name: '清理已结束记录', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '清理记录', exact: true }).click()
  await expect(page.locator('.download-row')).toHaveCount(1)
  await expect(page.locator('[data-task-status="running"]')).toHaveCount(1)
})

// ⑥ App.vue 卸载时调用 unlisten 清理事件监听
test('app unmount unlistens the queue-update listener', async ({ page }) => {
  await expect(page.locator('[data-app-ready]')).toBeVisible()
  await page.evaluate(() => (document.querySelector('#app') as any).__vue_app__.unmount())
  await expect
    .poll(() => page.evaluate(() => (window as any).__TEST_HOOKS__.stats().unlistenCalls))
    .toBeGreaterThan(0)
})

// 「退出并安装」要求危险确认，确认后才真正 install
test('update installation requires a danger confirmation', async ({ page }) => {
  await page.getByRole('link', { name: '偏好设置', exact: true }).click()
  await page.getByRole('button', { name: '软件更新', exact: true }).click()
  await page.evaluate(() => (window as any).__copycopyTest.setUpdateAvailable(true))
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await page.getByRole('button', { name: /下载更新/ }).click()
  await expect(page.getByRole('button', { name: '退出并安装', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '退出并安装', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
  expect(await page.evaluate(() => (window as any).__copycopyTest.state.installRequested)).toBe(
    false
  )
  await page.getByRole('button', { name: '退出并安装', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '退出并安装', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__copycopyTest.state.installRequested))
    .toBe(true)
})

// can_install:false 时不提供下载/安装按钮，只提示前往发布页
test('update without an installer cannot be installed', async ({ page }) => {
  await page.getByRole('link', { name: '偏好设置', exact: true }).click()
  await page.getByRole('button', { name: '软件更新', exact: true }).click()
  await page.evaluate(() => {
    ;(window as any).__copycopyTest.setUpdateAvailable(true)
    ;(window as any).__TEST_HOOKS__.setCanInstall(false)
  })
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await expect(page.locator('.app-updates')).toContainText('发现新版本 v2.2.0')
  await expect(page.getByRole('button', { name: /下载更新/ })).toHaveCount(0)
  await expect(page.locator('.app-updates')).toContainText('没有适配当前系统')
})

// 下载进度（Channel）事件在下载过程中被渲染
test('update download renders channel progress events', async ({ page }) => {
  await page.getByRole('link', { name: '偏好设置', exact: true }).click()
  await page.getByRole('button', { name: '软件更新', exact: true }).click()
  await page.evaluate(() => (window as any).__copycopyTest.setUpdateAvailable(true))
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await page.getByRole('button', { name: /下载更新/ }).click()
  // download_update 通过 Channel 连发进度，最终 phase 变为 ready。
  await expect(page.getByRole('button', { name: '退出并安装', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).__copycopyTest.state.installRequested)).toBe(
    false
  )
})

// 失败任务分支：显示错误与「重试失败」，点击后状态真实变化
test('failed task shows error and retryFailed works', async ({ page }) => {
  await page.locator('.comic-card').first().click()
  await page.getByRole('checkbox', { name: '选择 第1话', exact: true }).check()
  await page.evaluate(() => (window as any).__TEST_HOOKS__.setNextTaskStatus('failed'))
  await page.locator('[data-download-selected]').click()
  await page.getByRole('link', { name: /下载管理/ }).click()
  await expect(page.locator('[data-task-status="failed"]')).toHaveCount(1)
  await expect(page.locator('.download-row')).toContainText('图片下载失败')
  await page.getByRole('button', { name: '重试失败', exact: true }).click()
  await expect(page.locator('[data-task-status="failed"]')).toHaveCount(0)
})

// 深链接启动：全局搜索框与 URL 查询词同步（watch immediate）
test('deep link to search syncs the global search box', async ({ page }) => {
  await page.goto('/#/search?q=%E5%86%92%E9%99%A9')
  await expect(page.locator('[data-app-ready]')).toBeVisible()
  await expect(page.getByRole('textbox', { name: '全局搜索' })).toHaveValue('冒险')
  await expect(page.getByRole('heading', { name: /「冒险」的搜索结果/ })).toBeVisible()
})

// 全局搜索框未提交的输入不被路由变化覆盖
test('global search draft is not overwritten on route change', async ({ page }) => {
  await page.getByRole('textbox', { name: '全局搜索' }).fill('尚未提交')
  await page.getByRole('link', { name: '本地书库', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '全局搜索' })).toHaveValue('尚未提交')
})
