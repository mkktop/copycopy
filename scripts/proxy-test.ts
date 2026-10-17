/**
 * 验证代理链路是否真的生效。
 * 用例：google.com 直连不通、经代理可通 —— 能区分「代理生效」与「只是网络好」。
 */
import { setupProxy, getCurrentProxy } from '../src/main/proxy'
import { logger } from '../src/main/logger'

async function probe(label: string, url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
    console.log(`${label}: HTTP ${r.status}`)
    return r.ok
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message
    console.log(`${label}: 失败 (${code})`)
    return false
  }
}

async function main(): Promise<void> {
  logger.dispose() // 测试输出走 console，别写文件
  console.log('=== 1. 未挂代理时直连 ===')
  const directGoogle = await probe('google.com 直连', 'https://www.google.com/')

  console.log('\n=== 2. 挂上系统代理 ===')
  const p = setupProxy()
  console.log('setupProxy ->', p ?? '(未检测到代理)')

  console.log('\n=== 3. 挂代理后 ===')
  const proxiedGoogle = await probe('google.com 走代理', 'https://www.google.com/')
  console.log('getCurrentProxy ->', getCurrentProxy())

  console.log('\n=== 4. 真实站点 ===')
  const site = await probe('api.2025copy.com', 'https://api.2025copy.com/api/v3/comic2/haizeiwang?platform=1')

  console.log('\n' + '='.repeat(56))
  if (directGoogle) {
    console.log('注意：google 直连就通了，本机无法用它证明代理是否生效')
  } else if (p && proxiedGoogle) {
    console.log('结论：代理链路生效（直连失败 -> 经代理成功）')
  } else {
    console.log('结论：未能验证代理生效')
  }
  console.log(`真实站点可达: ${site ? '是' : '否'}`)
  console.log('='.repeat(56))
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
