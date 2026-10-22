import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, '.tmp', 'ui-state-test.mjs')
fs.mkdirSync(path.dirname(output), { recursive: true })
await build({
  entryPoints: [path.join(root, 'scripts/ui-state-test.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@shared': path.join(root, 'src/shared') },
  logLevel: 'silent'
})
const result = spawnSync(process.execPath, [output], { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)
