import assert from 'node:assert/strict'
import { ApplicationUpdater, type UpdateBackend } from '../src/main/update/controller'
import type { AppRelease, AppUpdateMode, AppUpdateProgress } from '../src/shared/app-update'
import { createPinia, setActivePinia } from 'pinia'
import { useUpdateStore } from '../src/renderer/src/stores/update'

function fixture(mode: AppUpdateMode = 'installer') {
  let release: AppRelease | null = { version: '1.4.0', notes: '修复与改进' }
  let checkCalls = 0
  let downloadCalls = 0
  let installs = 0
  let blocked: string | null = null
  const backend: UpdateBackend = {
    async check() {
      checkCalls++
      return release
    },
    async download(progress) {
      downloadCalls++
      progress({ percent: 50, transferred: 512, total: 1024, bytesPerSecond: 256 })
    },
    install() {
      installs++
    },
    async openRelease() {}
  }
  const controller = new ApplicationUpdater('1.3.0', mode, backend, () => blocked)
  return {
    controller,
    backend,
    setRelease: (value: AppRelease | null) => {
      release = value
    },
    block: (reason: string | null) => {
      blocked = reason
    },
    calls: () => ({ checkCalls, downloadCalls, installs })
  }
}

for (const version of ['1.3.0', '1.2.9', '1.3.0+build.2']) {
  const test = fixture()
  test.setRelease({ version, notes: '' })
  assert.equal((await test.controller.check()).status, 'not-available')
  await test.controller.download()
  assert.equal(test.calls().downloadCalls, 0)
}
for (const version of ['garbage', '1.4.0-beta.1']) {
  const test = fixture()
  test.setRelease({ version, notes: '' })
  assert.equal((await test.controller.check()).status, 'error')
}
console.log('PASS  版本比较拒绝降级、重复版本、预发布和无效版本')

const test = fixture()
const states: string[] = []
test.controller.on('state', (state) => states.push(state.status))
await test.controller.check()
assert.equal(test.calls().downloadCalls, 0, '仅检查，绝不自动下载')
assert.ok(test.controller.state.checkedAt)
await test.controller.download()
assert.equal(test.controller.state.status, 'downloaded')
assert.equal(test.controller.state.progress?.percent, 50)
await test.controller.check()
await test.controller.download()
assert.deepEqual(test.calls(), { checkCalls: 1, downloadCalls: 1, installs: 0 })
for (const reason of ['漫画仍在下载', 'AI 整理中', 'PDF 导出中']) {
  test.block(reason)
  assert.equal(test.controller.install().error, reason)
  assert.equal(test.controller.state.status, 'downloaded')
  assert.equal(test.calls().installs, 0)
}
test.block(null)
assert.equal(test.controller.install().status, 'installing')
test.controller.install()
assert.equal(test.calls().installs, 1)
test.controller.installationFailed()
assert.equal(test.controller.state.status, 'downloaded', '异步安装错误恢复到可重试状态')
assert.ok(test.controller.state.error)
console.log('PASS  手动下载、进度、任务阻挡、重复安装与异步安装错误')

const retry = fixture()
retry.backend.check = async () => {
  throw new Error('Network')
}
assert.equal((await retry.controller.check()).status, 'error')
retry.backend.check = async () => ({ version: '1.4.0', notes: '' })
assert.equal((await retry.controller.check()).status, 'available')
retry.backend.download = async () => {
  throw new Error('SHA512 mismatch')
}
assert.equal((await retry.controller.download()).status, 'error')
assert.equal(retry.controller.install().status, 'error')
retry.backend.download = async () => {}
assert.equal((await retry.controller.download()).status, 'downloaded')
retry.backend.install = () => {
  throw new Error('Cannot launch')
}
assert.equal(retry.controller.install().status, 'downloaded')
console.log('PASS  断网、下载校验失败可重试，未校验通过的包不能安装')

const single = fixture()
let resolveCheck!: (release: AppRelease) => void
single.backend.check = () =>
  new Promise((resolve) => {
    resolveCheck = resolve
  })
const check = single.controller.check()
assert.equal(single.controller.check(), check)
resolveCheck({ version: '1.10.0', notes: '' })
await check
let resolveDownload!: () => void
let onProgress!: (progress: AppUpdateProgress) => void
single.backend.download = (progress) => {
  onProgress = progress
  return new Promise((resolve) => {
    resolveDownload = resolve
  })
}
const download = single.controller.download()
assert.equal(single.controller.download(), download)
assert.equal((await single.controller.check()).status, 'downloading')
onProgress({ percent: 150, transferred: 20, total: 20, bytesPerSecond: 1 })
assert.equal(single.controller.state.progress?.percent, 100)
resolveDownload()
await download
assert.equal(single.controller.state.release?.version, '1.10.0')
console.log('PASS  检查和下载不会重复并发，下载期间不会覆盖升级状态')

for (const mode of ['portable', 'manual', 'development'] as const) {
  const manual = fixture(mode)
  await manual.controller.check()
  await manual.controller.download()
  manual.controller.install()
  assert.equal(manual.calls().downloadCalls, 0)
  assert.equal(manual.calls().installs, 0)
  assert.equal(manual.calls().checkCalls, mode === 'development' ? 0 : 1)
}
console.log('PASS  便携版和开发环境不会调用安装版下载、安装接口')

setActivePinia(createPinia())
const store = useUpdateStore()
let resolveSnapshot!: (value: typeof single.controller.state) => void
globalThis.window = {
  mkk: {
    appUpdateState: () =>
      new Promise((resolve) => {
        resolveSnapshot = resolve
      })
  }
} as unknown as Window & typeof globalThis
const refreshing = store.refresh()
const latest = single.controller.state
store.applyState(latest)
resolveSnapshot({ ...latest, revision: latest.revision - 1, status: 'checking' })
await refreshing
assert.equal(store.state?.status, 'downloaded')
const snapshot = test.controller.state
snapshot.release!.version = '9.9.9'
assert.equal(test.controller.state.release?.version, '1.4.0', 'IPC 快照不修改控制器内部状态')
console.log('PASS  旧 IPC 快照不会覆盖实时事件，外部不能修改内部升级状态')
