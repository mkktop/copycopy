import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'))
const cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8')
assert.equal(pkg.version, config.version)
assert.ok(cargo.includes('version = "' + pkg.version + '"'))
const banned = /\belectron(?:-updater|-builder|-vite)?\b|\bnaive-ui\b|window\.mkk|ai_enabled|ai_api_key|aiDetect|minimax|safeStorage|detectAdsForChapter/i
for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) assert.ok(!banned.test(name), 'Removed dependency: ' + name)
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) scan(file)
    else if (/\.(rs|ts|vue|css)$/.test(file)) assert.ok(!banned.test(fs.readFileSync(file, 'utf8')), 'Removed feature remains in ' + file)
  }
}
scan('src'); scan('src-tauri/src')
for (const removed of ['src/main', 'src/preload', 'src/renderer', 'electron-builder.yml', 'electron.vite.config.ts']) assert.ok(!fs.existsSync(removed), 'Old application tree remains: ' + removed)
assert.ok(config.app.security.csp && !config.app.security.csp.includes("script-src 'unsafe-inline'"))
console.log('PASS Tauri architecture, aligned versions, native IPC, and removal of the old runtime and model integrations')
