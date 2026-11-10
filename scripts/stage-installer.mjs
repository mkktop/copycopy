import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const directory = 'src-tauri/target/release/bundle/nsis'
const files = fs.readdirSync(directory).filter(file => file.endsWith('.exe'))
if (files.length !== 1) throw new Error('Expected one Windows installer')
fs.mkdirSync('artifacts/windows-x64', { recursive: true })
const source = path.join(directory, files[0])
const name = 'CopyCopy_' + pkg.version + '_x64-setup.exe'
fs.copyFileSync(source, 'artifacts/windows-x64/' + name)
const manifest = {
  version: pkg.version, commit: process.env.GITHUB_SHA, platform: 'windows-x64',
  file: name, size: fs.statSync(source).size,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')
}
fs.writeFileSync('artifacts/windows-x64/manifest.json', JSON.stringify(manifest, null, 2))
console.log('Staged ' + name + ' (' + manifest.size + ' bytes)')
