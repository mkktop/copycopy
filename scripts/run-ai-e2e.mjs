/**
 * AI 广告识别的端到端测试启动器。
 * 需要真实 MKK（MiniMax API Key）环境变量；没有就跳过真实调用部分。
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import * as esbuild from 'esbuild'
import electronPath from 'electron'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outFile = path.join(root, '.tmp', 'ai-e2e.cjs')
const dataDir = path.join(root, '.tmp', 'ai-e2e-data')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(outFile.replace(/[^\\/]+$/, ''), { recursive: true })

await esbuild.build({
  entryPoints: [path.join(root, 'scripts', 'ai-e2e-test.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: outFile,
  logLevel: 'silent'
})

const child = spawn(electronPath, [outFile], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
  env: { ...process.env, MKK_DATA_DIR: dataDir }
})
child.on('exit', (code) => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(code ?? 1)
})
