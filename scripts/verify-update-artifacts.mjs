import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const directory = process.argv[2] || 'release'
const metadata = yaml.load(fs.readFileSync(path.join(directory, 'latest.yml'), 'utf8'))
assert.equal(metadata.version, version, '更新元数据版本必须与程序一致')
assert.ok(Array.isArray(metadata.files) && metadata.files.length > 0, '更新元数据缺少文件')
for (const file of metadata.files) {
  const name = decodeURIComponent(file.url)
  assert.equal(name, `CopyCopy-${version}-安装包.exe`, '自动更新只能使用 NSIS 安装包')
  const bytes = fs.readFileSync(path.join(directory, name))
  assert.equal(file.size, bytes.length, '安装包大小与元数据不一致')
  assert.equal(
    file.sha512,
    createHash('sha512').update(bytes).digest('base64'),
    '安装包 SHA512 不一致'
  )
  assert.ok(fs.statSync(path.join(directory, `${name}.blockmap`)).size > 0)
}
assert.equal(decodeURIComponent(metadata.path), `CopyCopy-${version}-安装包.exe`)
assert.equal(metadata.sha512, metadata.files[0].sha512)
const configPath = path.join(directory, 'win-unpacked/resources/app-update.yml')
if (fs.existsSync(configPath)) {
  const config = yaml.load(fs.readFileSync(configPath, 'utf8'))
  assert.equal(config.provider, 'github')
  assert.equal(config.owner, 'mkktop')
  assert.equal(config.repo, 'copycopy')
}
console.log(`PASS  v${version} 更新元数据、安装包 SHA512、blockmap 与官方发布源`)
