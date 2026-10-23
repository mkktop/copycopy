import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { build } from 'esbuild'
import electronPath from 'electron'
import { connectRenderer } from './lib/cdp.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version
await fs.mkdir(path.join(root, '.tmp'), { recursive: true })
const data = await fs.mkdtemp(path.join(root, '.tmp', 'update-ui-'))
const shots = path.join(root, '.tmp/ui-screenshots')
await fs.mkdir(shots, { recursive: true })
const binary = Buffer.alloc(6 * 1024 * 1024, 43)
const sha512 = createHash('sha512').update(binary).digest('base64')
let failCheck = false
let corrupt = false
let downloads = 0
const [major, minor] = version.split('.').map(Number)
const releaseVersion = `${major}.${minor + 1}.0`
const release = {
  version: releaseVersion,
  notes: '改进下载体验\n修复已知问题\n<img src=x onerror=alert(1)>',
  publishedAt: '2026-10-23T10:00:00.000Z'
}
const server = http.createServer((request, response) => {
  const route = new URL(request.url, 'http://localhost').pathname
  if (route.endsWith('.yml')) {
    if (failCheck) {
      response.writeHead(503)
      response.end('Unavailable')
      return
    }
    response.setHeader('Content-Type', 'text/yaml')
    response.end(
      JSON.stringify({
        version: release.version,
        files: [{ url: 'fixture.exe', sha512, size: binary.length }],
        path: 'fixture.exe',
        sha512,
        releaseNotes: release.notes,
        releaseDate: release.publishedAt
      })
    )
  } else if (route === '/release.json') {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(release))
  } else if (route === '/fixture.exe') {
    downloads++
    response.setHeader('Content-Type', 'application/octet-stream')
    response.setHeader('Content-Length', binary.length)
    const payload = Buffer.from(binary)
    if (corrupt) payload[0] = 99
    let offset = 0
    const timer = setInterval(() => {
      response.write(payload.subarray(offset, offset + 128 * 1024))
      offset += 128 * 1024
      if (offset >= payload.length) {
        clearInterval(timer)
        response.end()
      }
    }, 40)
    response.on('close', () => clearInterval(timer))
  } else {
    response.writeHead(404)
    response.end()
  }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const fixtureUrl = `http://127.0.0.1:${server.address().port}`
const testMain = path.join(data, 'main.cjs')
await build({
  entryPoints: [path.join(root, 'src/main/index.ts')],
  outfile: testMain,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  define: { __dirname: JSON.stringify(path.join(root, 'out/main')) },
  plugins: [
    {
      name: 'test-updater',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/update$/ }, () => ({
          path: path.join(root, 'scripts/fixtures/update-factory.ts')
        }))
      }
    }
  ],
  logLevel: 'silent'
})
let desktop
let ui
const output = []
async function launch(mode) {
  const profile = path.join(data, mode)
  await fs.mkdir(path.join(profile, 'config'), { recursive: true })
  await fs.mkdir(path.join(profile, 'profile'), { recursive: true })
  await fs.writeFile(
    path.join(profile, 'config/comic.yaml'),
    JSON.stringify({
      global: {
        auto_check_on_launch: 0,
        auto_check_interval_hours: 0,
        notify_on_done: 0,
        ai_enabled: 0
      },
      comics: []
    })
  )
  const bootstrap = path.join(data, `bootstrap-${mode}.cjs`)
  await fs.writeFile(
    bootstrap,
    `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(path.join(profile, 'profile'))}); app.getVersion = () => ${JSON.stringify(version)}; app.disableHardwareAcceleration(); require(${JSON.stringify(testMain)});`
  )
  desktop = spawn(
    electronPath,
    ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9226', bootstrap],
    {
      cwd: root,
      env: {
        ...process.env,
        MKK_DATA_DIR: profile,
        MKK_UPDATE_FIXTURE_URL: fixtureUrl,
        MKK_UPDATE_FIXTURE_MODE: mode
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  desktop.stdout.on('data', (chunk) => output.push(String(chunk)))
  desktop.stderr.on('data', (chunk) => output.push(String(chunk)))
  ui = await connectRenderer(9226)
  await ui.waitFor(
    '!!document.querySelector("[data-search-input]") && !document.querySelector(".startup-error")'
  )
  await ui.evaluate('window.mkk.proxySet(null)')
  await ui.evaluate('location.hash = "#/settings?tab=updates"')
  await ui.waitFor('!!document.querySelector("[data-app-update]")')
  return profile
}
async function waitStatus(status) {
  await ui.waitFor(`window.mkk.appUpdateState().then(s => s.status === ${JSON.stringify(status)})`)
}
async function stop() {
  if (ui) {
    assert.deepEqual(ui.exceptions, [], 'No uncaught renderer errors')
    ui.close()
    ui = null
  }
  if (desktop && desktop.exitCode === null) {
    const exited = once(desktop, 'exit')
    desktop.kill()
    await exited
  }
  desktop = null
}
try {
  const profile = await launch('installer')
  failCheck = true
  await ui.click('[data-update-check]')
  await waitStatus('error')
  await ui.waitFor('document.querySelector("[data-app-update]").textContent.includes("检查失败")')
  failCheck = false
  release.version = version
  await ui.click('[data-update-check]')
  await waitStatus('not-available')
  await ui.waitFor('document.querySelector("[data-update-title]").textContent.includes("最新版本")')
  release.version = releaseVersion
  await ui.click('[data-update-check]')
  await waitStatus('available')
  await ui.waitFor('!!document.querySelector("[data-update-download]")')
  assert.equal(downloads, 0, '检查和启动不会自动下载')
  assert.equal(await ui.evaluate('!!document.querySelector("[data-update-badge]")'), true)
  assert.equal(
    await ui.evaluate('!!document.querySelector("[data-app-update] pre img")'),
    false,
    '更新说明只渲染为文本'
  )
  await ui.screenshot(path.join(shots, 'update-available.png'))
  console.log('PASS  真实 Electron 检查失败重试、显示新版本与安全更新说明，检查不自动下载')
  corrupt = true
  await ui.click('[data-update-download]')
  await waitStatus('downloading')
  await ui.waitFor('window.mkk.appUpdateState().then(s => s.progress?.percent > 0)')
  await ui.screenshot(path.join(shots, 'update-progress.png'))
  await waitStatus('error')
  assert.equal(await ui.evaluate('!!document.querySelector("[data-update-install]")'), false)
  corrupt = false
  await ui.click('[data-update-download]')
  await waitStatus('downloaded')
  assert.equal(downloads, 2, '校验失败后重新下载')
  assert.equal(
    await fs.stat(path.join(profile, 'install-requested')).then(
      () => true,
      () => false
    ),
    false
  )
  await ui.screenshot(path.join(shots, 'update-ready.png'))
  console.log(
    'PASS  原生 NSIS 更新引擎进度、SHA512 拒绝损坏安装包、重试下载成功，完成后等待手动安装'
  )
  await fs.writeFile(path.join(profile, 'busy'), 'pdf')
  await ui.click('[data-update-install]')
  await ui.waitFor(
    'document.querySelector("[data-app-update]").textContent.includes("PDF 正在导出")'
  )
  await waitStatus('downloaded')
  assert.equal(
    await fs.stat(path.join(profile, 'install-requested')).then(
      () => true,
      () => false
    ),
    false
  )
  await fs.rm(path.join(profile, 'busy'))
  await ui.click('[data-update-auto]')
  await ui.clickText('保存设置')
  await ui.waitFor('window.mkk.getConfig().then(c => c.global.app_update_check_on_launch === 0)')
  await ui.click('[data-update-install]')
  await waitStatus('installing')
  assert.equal(await fs.readFile(path.join(profile, 'install-requested'), 'utf8'), 'yes')
  console.log('PASS  安装操作检查活动任务，启动检查偏好可保存；点击安装才调用安装引擎')
  await stop()
  const portableProfile = await launch('portable')
  await ui.click('[data-update-check]')
  await waitStatus('available')
  await ui.waitFor('!!document.querySelector("[data-update-manual]")')
  assert.equal(await ui.evaluate('!!document.querySelector("[data-update-download]")'), false)
  await ui.click('[data-update-manual]')
  await ui.waitFor('window.mkk.appUpdateState().then(s => s.mode === "portable")')
  assert.equal(
    await fs.readFile(path.join(portableProfile, 'opened-release.txt'), 'utf8'),
    releaseVersion
  )
  await ui.screenshot(path.join(shots, 'update-portable.png'))
  console.log('PASS  便携版提供新版发布页入口，不调用安装版升级')
} catch (error) {
  console.error(output.join('').slice(-14000))
  throw error
} finally {
  await stop()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
