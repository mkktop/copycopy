/**
 * 生成应用图标（build/icon.png 与 build/icon.ico），无需任何图像库。
 * PNG 用 zlib 压缩，ICO 直接内嵌 PNG（Vista 起支持）。
 */
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'build')
fs.mkdirSync(outDir, { recursive: true })

const SIZES = [256, 128, 64, 48, 32, 16]

/* ---------- 极简 PNG 编码 ---------- */
function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ---------- 绘制 ---------- */
function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4)
  const r = size * 0.22 // 圆角
  const put = (x, y, r0, g0, b0, a0) => {
    const i = (y * size + x) * 4
    const ia = a0 / 255
    const da = buf[i + 3] / 255
    const oa = ia + da * (1 - ia)
    if (oa === 0) return
    buf[i] = Math.round((r0 * ia + buf[i] * da * (1 - ia)) / oa)
    buf[i + 1] = Math.round((g0 * ia + buf[i + 1] * da * (1 - ia)) / oa)
    buf[i + 2] = Math.round((b0 * ia + buf[i + 2] * da * (1 - ia)) / oa)
    buf[i + 3] = Math.round(oa * 255)
  }

  // 圆角方形底 + 青色渐变
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.min(x, size - 1 - x)
      const cy = Math.min(y, size - 1 - y)
      let inside = true
      if (cx < r && cy < r) {
        const dx = r - cx
        const dy = r - cy
        inside = dx * dx + dy * dy <= r * r
      }
      if (!inside) continue
      const t = y / size
      put(x, y, Math.round(18 + 30 * t), Math.round(20 + 90 * t), Math.round(38 + 60 * t), 255)
    }
  }

  // 书本：两页白色矩形 + 中缝
  const bw = size * 0.6
  const bh = size * 0.44
  const bx = Math.round((size - bw) / 2)
  const by = Math.round((size - bh) / 2 - size * 0.04)
  const spine = Math.max(1, Math.round(size * 0.022))
  const pad = Math.max(2, Math.round(size * 0.07))
  for (let y = by; y < by + bh; y++) {
    for (let x = bx; x < bx + bw; x++) {
      const cx = Math.min(x - bx, bx + bw - 1 - x)
      const cy = Math.min(y - by, by + bh - 1 - y)
      if (cx < pad * 0.6 && cy < pad * 0.6) {
        const dx = pad * 0.6 - cx
        const dy = pad * 0.6 - cy
        if (dx * dx + dy * dy > pad * pad * 0.36) continue
      }
      if (Math.abs(x - (bx + bw / 2)) < spine) {
        put(x, y, 30, 40, 60, 255) // 书脊
      } else {
        const tt = (x - bx) / bw
        put(x, y, 245 - Math.round(20 * tt), 250, 255 - Math.round(15 * tt), 255)
      }
    }
  }

  // 三条“文字”线
  const lineH = Math.max(1, Math.round(size * 0.028))
  for (let i = 0; i < 3; i++) {
    const ly = by + bh * (0.3 + i * 0.2)
    for (let side = 0; side < 2; side++) {
      const lx0 = side === 0 ? bx + pad : bx + bw / 2 + spine
      const lx1 = side === 0 ? bx + bw / 2 - spine - pad : bx + bw - pad
      for (let y = Math.round(ly); y < Math.round(ly) + lineH; y++) {
        for (let x = Math.round(lx0); x < Math.round(lx1); x++) {
          put(x, y, 120, 135, 165, 255)
        }
      }
    }
  }

  return buf
}

const pngs = SIZES.map((s) => ({ size: s, png: encodePng(s, s, drawIcon(s)) }))

fs.writeFileSync(path.join(outDir, 'icon.png'), pngs[0].png)

/* ---------- ICO（内嵌 PNG） ---------- */
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(pngs.length, 4)

let offset = 6 + pngs.length * 16
const entries = []
for (const { size, png } of pngs) {
  const e = Buffer.alloc(16)
  e[0] = size >= 256 ? 0 : size // width
  e[1] = size >= 256 ? 0 : size // height
  e[2] = 0 // 调色板
  e[3] = 0 // reserved
  e.writeUInt16LE(1, 4) // color planes
  e.writeUInt16LE(32, 6) // bpp
  e.writeUInt32LE(png.length, 8)
  e.writeUInt32LE(offset, 12)
  entries.push(e)
  offset += png.length
}

fs.writeFileSync(
  path.join(outDir, 'icon.ico'),
  Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)])
)

console.log('已生成 build/icon.png (256x256) 与 build/icon.ico (含 ' + pngs.length + ' 种尺寸)')
