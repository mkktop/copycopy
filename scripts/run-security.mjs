/**
 * 路径安全回归测试。
 *
 * 这组用例守的是三件事，任何一条挂了都意味着 out/ 之外的文件可能被读、被改、被删：
 *   1. resolveInside 能挡住 ../..、绝对路径、UNC、兄弟目录前缀
 *   2. resolveInside 不误伤 out/ 之内的正常路径（尤其以 '..' 开头的合法目录名）
 *   3. sanitizeName 产出的目录名不会逃出 out/，也不会撞 Windows 保留名
 *
 * 纯逻辑，不依赖 electron，直接用 node 跑。
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import * as esbuild from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outFile = path.join(root, '.tmp', 'security-check.cjs')

fs.mkdirSync(path.dirname(outFile), { recursive: true })

await esbuild.build({
  entryPoints: [path.join(root, 'scripts', 'security-check.mts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: outFile,
  logLevel: 'silent'
})

const child = spawn(process.execPath, [outFile], {
  cwd: root,
  stdio: 'inherit',
  shell: false
})
child.on('exit', (code) => process.exit(code ?? 1))
