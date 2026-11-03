import fs from 'node:fs'
import path from 'node:path'
function report(file) {
  const content = fs.readFileSync(file).toString('base64')
  console.log('COPYCOPY_FILE_START ' + file)
  for (let i = 0; i < content.length; i += 10000) console.log('COPYCOPY_FILE_CHUNK ' + content.slice(i, i + 10000))
  console.log('COPYCOPY_FILE_END ' + file)
}
function walk(directory) {
  if (!fs.existsSync(directory)) return
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (/\.(ts|vue|css|rs)$/.test(file)) report(file)
  }
}
for (const dir of ['src', 'tests', 'src-tauri/src']) walk(dir)
for (const file of ['package-lock.json', 'src-tauri/Cargo.lock', 'vite.config.ts', 'playwright.config.ts', 'src-tauri/icons/icon.png', 'src-tauri/icons/icon.ico']) if (fs.existsSync(file)) report(file)
for (const file of ['test-results/previews/home.png', 'test-results/previews/settings-dark.png']) if (fs.existsSync(file)) report(file)
