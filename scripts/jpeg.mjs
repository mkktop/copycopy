/**
 * 极简灰度 JPEG 编码器，只用于本地测试。
 * 输出单色 128 的灰度图，尺寸由参数决定 —— 测试里用尺寸来编码“第几页”，
 * 从而验证下载后的页序是否与 words 还原一致。
 */

const ZIGZAG_DC = 0 // 单色图：所有 DC 系数都是 0

const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]

const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d]
const AC_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61,
  0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52,
  0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25,
  0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
  0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64,
  0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83,
  0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99,
  0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3,
  0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8,
  0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa
]

/** 由 BITS/HUFFVAL 生成 code -> {code, len} 映射 */
function buildHuffTable(bits, vals) {
  const table = {}
  let code = 0
  let k = 0
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) {
      table[vals[k++]] = { code, len }
      code++
    }
    code <<= 1
  }
  return table
}

const DC_TABLE = buildHuffTable(DC_BITS, DC_VALS)

class BitWriter {
  constructor() {
    this.bytes = []
    this.cur = 0
    this.count = 0
  }
  write(code, len) {
    for (let i = len - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((code >> i) & 1)
      this.count++
      if (this.count === 8) {
        this.bytes.push(this.cur)
        // 0xFF 后必须补 0x00，避免被当成标记
        if (this.cur === 0xff) this.bytes.push(0x00)
        this.cur = 0
        this.count = 0
      }
    }
  }
  flush() {
    while (this.count !== 0) this.write(1, 1)
    return Buffer.from(this.bytes)
  }
}

function segment(marker, payload) {
  const len = payload.length + 2
  return Buffer.concat([Buffer.from([0xff, marker]), u16(len), payload])
}

function u16(n) {
  return Buffer.from([(n >> 8) & 0xff, n & 0xff])
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} 合法灰度 JPEG
 */
export function encodeSolidJpeg(width, height) {
  const soi = Buffer.from([0xff, 0xd8])

  // DQT：单张 8bit 量化表，全 16（仅 DC 会被用到）
  const dqtPayload = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 16)])
  const dqt = segment(0xdb, dqtPayload)

  // SOF0：8bit 精度，高，宽，1 个分量，无采样，量化表 0
  const sofPayload = Buffer.concat([
    Buffer.from([8]),
    u16(height),
    u16(width),
    Buffer.from([1, 1, 0x11, 0])
  ])
  const sof = segment(0xc0, sofPayload)

  // DHT：DC 表 0 + AC 表 0
  const dhtDc = segment(0xc4, Buffer.concat([Buffer.from([0x00]), Buffer.from(DC_BITS), Buffer.from(DC_VALS)]))
  const dhtAc = segment(
    0xc4,
    Buffer.concat([Buffer.from([0x10]), Buffer.from(AC_BITS), Buffer.from(AC_VALS)])
  )

  // SOS：1 个分量，用 DC 表 0 / AC 表 0，Ss=0 Se=63 Ah=0 Al=0
  const sosPayload = Buffer.concat([
    Buffer.from([1, 1, 0x00, 0x00, 63, 0x00])
  ])
  const sos = segment(0xda, sosPayload)

  // 熵编码数据：每个 8x8 块都是 DC=0 + EOB
  const blocksX = Math.ceil(width / 8)
  const blocksY = Math.ceil(height / 8)
  const bw = new BitWriter()
  for (let i = 0; i < blocksX * blocksY; i++) {
    // DC 类别 0 -> code 0 len 2 ; AC EOB -> code 0x00 len 4
    bw.write(DC_TABLE[ZIGZAG_DC].code, DC_TABLE[ZIGZAG_DC].len)
    bw.write(0x00, 4)
  }

  const eoi = Buffer.from([0xff, 0xd9])
  return Buffer.concat([soi, dqt, sof, dhtDc, dhtAc, sos, bw.flush(), eoi])
}

/** 从 JPEG 的 SOF0 段里读回宽高，测试用来反查“这一页本该是第几页” */
export function readJpegSize(buf) {
  let i = 2
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  return null
}
