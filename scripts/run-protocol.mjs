/**
 * library:// 协议测试的启动器。
 * 和 run-e2e 一样：esbuild 打成 cjs，再用 electron 以主进程方式跑。
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import * as esbuild from 'esbuild'
import electronPath from 'electron'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outFile = path.join(root, '.tmp', 'protocol-test.cjs')
// 同样隔离数据目录：测试会在 out/ 下建临时漫画，不该碰到开发者真实的库
const dataDir = path.join(root, '.tmp', 'protocol-data')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })

fs.mkdirSync(path.dirname(outFile), { recursive: true })

await esbuild.build({
  entryPoints: [path.join(root, 'scripts', 'protocol-test.ts')],
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
child.on('exit', (code) => process.exit(code ?? 1))
