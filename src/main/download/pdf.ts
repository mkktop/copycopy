import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { PDFDocument } from 'pdf-lib-plus-encrypt'
import { isImageFile } from '../library'
import { logger } from '../logger'

/** CSS 96dpi 换算成 PDF 点（72dpi） */
const PX_TO_PT = 72 / 96
/** 每嵌这么多页让出一次事件循环，免得主进程被长章节的 PDF 堵死 */
const YIELD_EVERY = 8

export interface PdfOptions {
  /** null / 空串 = 不加密 */
  password?: string | null
}

export interface PdfResult {
  ok: boolean
  pdfPath?: string
  pages?: number
  error?: string
}

/** 让出事件循环，让 IPC 和窗口事件在生成长 PDF 时还能响应 */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * 把一个章节目录下的所有图片合并成单个 PDF，输出到章节目录的同级目录。
 *
 * 与原 Python 版的三点差异（均为修 bug）：
 *  1. 原版 `range(1, number)` 会漏掉第 001 页；
 *  2. 原版用 len(contents) 而非 len(words) 算页数，多批次章节会算错；
 *  3. 原版固定 US Letter 纸，竖长漫画会留出大片白边，这里按图片实际比例分页。
 */
export async function makePdf(
  chapterDir: string,
  options: PdfOptions = {}
): Promise<PdfResult> {
  let files: string[]
  try {
    files = fs
      .readdirSync(chapterDir)
      .filter(isImageFile)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map((f) => path.join(chapterDir, f))
  } catch (e) {
    return { ok: false, error: `读取章节目录失败: ${String(e)}` }
  }

  const usable = files.filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
  if (usable.length === 0) {
    return { ok: false, error: '目录中没有可用的 JPEG/PNG 图片' }
  }
  if (usable.length !== files.length) {
    logger.warn(
      `有 ${files.length - usable.length} 张非 JPEG/PNG 图片未纳入 PDF` +
        `（通常是 WebP，下载时未带 webp 头一般不会出现）`
    )
  }

  const dirName = path.basename(chapterDir)
  const parent = path.dirname(chapterDir)
  const pdfPath = path.join(parent, `${dirName}.pdf`)

  try {
    const doc = await PDFDocument.create()
    doc.setTitle(dirName)
    doc.setProducer('CopyCopy')
    doc.setCreator('CopyCopy')

    for (const [i, file] of usable.entries()) {
      // pdf-lib 解析 JPEG 时直接按 buffer.byteOffset 读开头，
      // 而 Node 对小文件会从 Buffer 池分配（offset != 0）导致误判 "SOI not found"。
      // 这里复制成独立 ArrayBuffer，保证 offset 归零。
      const bytes = new Uint8Array(fs.readFileSync(file))
      const isPng = /\.png$/i.test(file)
      const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)

      // 按图片自身比例分页，1px 当作 96dpi 折算成 pt
      const w = Math.max(1, img.width * PX_TO_PT)
      const h = Math.max(1, img.height * PX_TO_PT)
      const page = doc.addPage([w, h])
      page.drawImage(img, { x: 0, y: 0, width: w, height: h })

      if ((i + 1) % YIELD_EVERY === 0) await yieldToLoop()
    }

    const password = options.password
    if (password) {
      // 说明：pdf-lib-plus-encrypt 的 encrypt() 会用文档头版本覆盖 pdfVersion，
      // 而 PDFHeader 的版本号是只读的，所以这里最高只能得到 V4/R4 的 AES-128。
      // 这是 PDF 标准加密，所有阅读器都认，密码保护功能是完整的。
      await doc.encrypt({
        userPassword: password,
        // owner 口令必须和 user 口令不同：设成一样的话，任何拿到阅读口令的人
        // 实际上就是拥有者，下面那些权限位形同虚设。这里派生一个固定的 owner 口令。
        ownerPassword: ownerPasswordFor(password),
        permissions: {
          printing: 'highResolution',
          copying: true,
          contentAccessibility: true,
          modifying: false,
          annotating: false,
          fillingForms: false,
          documentAssembly: false
        },
        pdfVersion: '1.7'
      })
    }

    await yieldToLoop()
    const bytes = await doc.save()
    await fs.promises.writeFile(pdfPath, bytes)
    logger.info(`已生成 PDF: ${pdfPath}（${usable.length} 页${password ? '，已加密' : ''}）`)
    return { ok: true, pdfPath, pages: usable.length }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.error('生成 PDF 失败: ' + msg)
    return { ok: false, error: msg }
  }
}

/** 由阅读口令稳定派生 owner 口令：同一个密码导出的文件 owner 口令保持一致 */
function ownerPasswordFor(userPassword: string): string {
  return crypto.createHash('sha256').update(`copycopy-owner:${userPassword}`).digest('hex')
}
