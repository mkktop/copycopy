import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { useDownloadStore } from '../src/renderer/src/stores/download'
import { useAiStore } from '../src/renderer/src/stores/ai'
import type { DownloadTask } from '../src/shared/types'

let tasks: DownloadTask[] = []
let detectCalls: string[] = []
let failSecond = true
globalThis.window = {
  mkk: {
    queueList: async () => tasks,
    aiDetectChapter: async (_comic: string, chapter: string) => {
      detectCalls.push(chapter)
      if (chapter === '第二章' && failSecond)
        return { ok: false, moved: 0, ads: [], elapsedMs: 1, error: '模拟限流' }
      return { ok: true, moved: 0, ads: [], elapsedMs: 1 }
    }
  }
} as unknown as Window & typeof globalThis

setActivePinia(createPinia())
const download = useDownloadStore()
const pending: DownloadTask = {
  id: 'task-1',
  comicName: '测试',
  comicPath: 'test',
  chapterName: '第一章',
  chapterIndex: 1,
  uuid: 'uuid-1',
  dir: '/tmp/test',
  status: 'pending',
  downloaded: 0,
  total: 12,
  skipped: 0,
  failedPages: []
}
tasks = [pending]
await download.refresh()
assert.equal(download.stats.pending, 1, '首次加载队列即可显示准确数量，不依赖进度事件')
download.applyProgress({
  task: { ...pending, status: 'done', downloaded: 12 },
  queue: { running: 0, pending: 0, done: 1, failed: 0 }
})
assert.equal(download.stats.done, 1)
tasks = []
await download.refresh()
assert.deepEqual(
  download.stats,
  { pending: 0, running: 0, done: 0, failed: 0 },
  '清空记录会同步清空导航和统计'
)
console.log('PASS  队列首次加载、进度更新、清除记录后的统计保持一致')
let resolveSnapshot!: (value: DownloadTask[]) => void
window.mkk.queueList = () =>
  new Promise((resolve) => {
    resolveSnapshot = resolve
  })
const refreshing = download.refresh()
download.applyProgress({
  task: { ...pending, status: 'done', downloaded: 12 },
  queue: { pending: 0, running: 0, done: 1, failed: 0 }
})
resolveSnapshot([pending])
await refreshing
assert.equal(download.tasks[0].status, 'done', '较早的快照不能覆盖刷新期间到达的新进度')
console.log('PASS  加载中的旧快照不会覆盖实时下载进度')

const ai = useAiStore()
const run = await ai.runDetection('测试漫画', ['第一章', '第二章'])
assert.deepEqual(
  run?.items.map((item) => item.status),
  ['done', 'failed']
)
assert.notEqual(run?.finishedAt, null)
failSecond = false
detectCalls = []
await ai.retryFailed('测试漫画')
assert.deepEqual(detectCalls, ['第二章'], '只重试结束批次中的失败章节')
assert.deepEqual(
  ai.runOf('测试漫画')?.items.map((item) => item.status),
  ['done', 'done']
)
assert.notEqual(ai.runOf('测试漫画')?.finishedAt, null)
console.log('PASS  已结束的 AI 批次能够重试，已成功章节不会重复调用')

let resolveDetection!: (value: {
  ok: boolean
  moved: number
  ads: number[]
  elapsedMs: number
}) => void
window.mkk.aiDetectChapter = () =>
  new Promise((resolve) => {
    resolveDetection = resolve
  })
const active = ai.runDetection('仍在检测', ['第一章'])
const activeRun = ai.runOf('仍在检测')
await ai.retryFailed('仍在检测')
assert.equal(ai.runOf('仍在检测'), activeRun, '进行中的批次不会被重复启动')
resolveDetection({ ok: true, moved: 0, ads: [], elapsedMs: 1 })
await active
assert.equal(ai.busy, false)
console.log('PASS  检测进行期间不会重复启动重试 worker')
