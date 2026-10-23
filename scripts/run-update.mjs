import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, '.tmp', 'update-test.mjs')
await fs.mkdir(path.dirname(output), { recursive: true })
await build({
  entryPoints: [path.join(root, 'scripts/update-test.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  alias: { '@shared': path.join(root, 'src/shared') },
  logLevel: 'silent'
})
const result = spawnSync(process.execPath, [output], { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)
