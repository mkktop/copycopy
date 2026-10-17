/**
 * 扩展探测策略的纯逻辑测试。
 * ad-detect 会 import ./client（进而 import electron），这里把外部依赖
 * stub 掉，只测探测决策本身。
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import * as esbuild from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outFile = path.join(root, '.tmp', 'ad-policy.cjs')

// client 里会 import electron 的 logger；这里整体打成空实现，
// 但 ad-detect 导出的纯函数不依赖它，行为不受影响。
fs.mkdirSync(path.dirname(outFile), { recursive: true })

await esbuild.build({
  entryPoints: [path.join(root, 'scripts', 'ad-policy-test.mts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: outFile,
  logLevel: 'silent',
  // 只解析 ad-detect.ts 里的纯函数，遇到 electron 直接丢弃
  external: ['electron'],
  define: { 'process.env.NODE_ENV': '"test"' }
})

const child = spawn(process.execPath, [outFile], { cwd: root, stdio: 'inherit', shell: false })
child.on('exit', (code) => process.exit(code ?? 1))
