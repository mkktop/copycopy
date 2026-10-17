/**
 * 端到端测试的启动器：
 *  1. 起模拟站点
 *  2. 用 esbuild 的 JS API 把测试脚本打成 cjs
 *  3. 用 electron 以主进程方式执行（因为主进程模块依赖 electron.app）
 *
 * 打包和 electron 启动都直接走各自的真实可执行路径，不经过 shell，
 * 免得 Windows 上冒出 DEP0190 警告、参数被二次解析。
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import * as esbuild from 'esbuild'
import electronPath from 'electron'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outFile = path.join(root, '.tmp', 'e2e.cjs')

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', shell: false })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} 退出码 ${code}`))))
    child.on('error', reject)
  })
}

function waitForServer(port, timeoutMs = 15000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v3/comic2/x?platform=1`, {
          signal: AbortSignal.timeout(1000)
        })
        if (res.ok) return resolve()
      } catch {
        /* 还没起来 */
      }
      if (Date.now() - start > timeoutMs) return reject(new Error('模拟站点启动超时'))
      setTimeout(tick, 300)
    }
    tick()
  })
}

const mock = spawn(process.execPath, [path.join(root, 'scripts', 'mock-server.mjs')], {
  cwd: root,
  stdio: 'inherit',
  shell: false
})

let exitCode = 1
try {
  await waitForServer(8899)
  console.log('[e2e] 模拟站点就绪，开始打包测试脚本…')

  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(root, 'scripts', 'e2e-test.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: outFile,
    logLevel: 'silent'
  })

  console.log('[e2e] 在 electron 中执行测试…\n')
  await run(electronPath, [outFile])
  exitCode = 0
} catch (e) {
  console.error('[e2e] 失败:', e.message)
  exitCode = 1
} finally {
  mock.kill()
}

process.exit(exitCode)
