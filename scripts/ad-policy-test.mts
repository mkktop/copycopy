/**
 * 边缘连续广告的扩展探测策略——纯逻辑单测，不联网、不花钱。
 *
 * 编译产物是纯 ESM 逻辑，不 import electron，可以直接用 node 跑。
 * 但它 import 了 ./client（会拉 electron），所以这里用 esbuild 打包时
 * 把 electron 相关的 stub 掉。
 */
import {
  planNextBatch,
  advanceProbes,
  edgeAdPages,
  type ProbeState
} from '../src/main/ai/ad-detect'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ->  ' + detail : ''}`)
}

const BASE = {
  total: 20,
  headPages: 1,
  tailPages: 1,
  cap: 4,
  step: 2
}

function fmt(a: number[]): string {
  return `[${a.join(',')}]`
}

/** 无序比较：头尾两段是分别收集的，返回顺序不代表先后 */
function sameSet(a: number[], b: number[]): boolean {
  return a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i])
}

/** 模拟整场：给定"哪些页是广告"，跑完整个多轮流程，返回送检过的页和最终广告页 */
function simulate(
  adPages: number[],
  overrides: Partial<typeof BASE> = {}
): { probed: number[]; finalAds: number[]; rounds: number } {
  const a = { ...BASE, ...overrides }
  // 与 detectChapterAds 同样的每侧上限压缩
  a.cap = Math.max(1, Math.min(a.cap, a.total, Math.floor((a.total - 1) / 2)))
  const isAdPage = (p: number): boolean => adPages.includes(p)
  const verdicts = new Map<number, boolean>()

  let st: ProbeState = { headProbed: 0, tailProbed: 0 }
  const sent = new Set<number>()
  const probed: number[] = []
  let rounds = 0

  for (;;) {
    const plan = planNextBatch(st, { ...a, firstRound: rounds === 0 }, sent)
    const batch = plan.pages
    if (batch.length === 0) break
    if (rounds >= 4) break
    for (const p of batch) {
      sent.add(p)
      probed.push(p)
      verdicts.set(p, isAdPage(p))
    }
    rounds++
    st = advanceProbes(plan.next, isAdPage, a)
  }

  const finalAds = edgeAdPages(
    (p) => (verdicts.has(p) ? ({ page: p, isAd: verdicts.get(p)!, confidence: 1 } as never) : undefined),
    isAdPage,
    a.total
  )
  return { probed, finalAds, rounds }
}

console.log('=== 1. 没有任何广告：一轮结束 ===')
{
  const r = simulate([])
  check('只送检首尾各 1 页', r.probed.length === 2, fmt(r.probed))
  check('没有广告页', r.finalAds.length === 0, fmt(r.finalAds))
  check('一轮就结束', r.rounds === 1, `rounds=${r.rounds}`)
}

console.log('\n=== 2. 首页是广告 -> 自动往下探 ===')
{
  const r = simulate([1])
  check('多探了 2,3 页', r.probed.includes(2) && r.probed.includes(3), fmt(r.probed))
  check('第 2 页不是广告就停手，没继续探第 4 页', !r.probed.includes(4), fmt(r.probed))
  check('最终只标记第 1 页', fmt(r.finalAds) === '[1]', fmt(r.finalAds))
  check('用了 2 轮', r.rounds === 2, `rounds=${r.rounds}`)
}

console.log('\n=== 3. 首页连着 2 页都是广告 -> 探到第 3 页确认边界 ===')
{
  const r = simulate([1, 2])
  // step=2：第 1 页命中广告后，一次探 2、3 两页，第 3 页不是广告就收手
  check('探了 2,3 页', r.probed.includes(2) && r.probed.includes(3), fmt(r.probed))
  check('标记 1,2 两页', fmt(r.finalAds) === '[1,2]', fmt(r.finalAds))
  check('没有多余地探第 4 页', !r.probed.includes(4), fmt(r.probed))
}

console.log('\n=== 4. 首页连着 3 页都是广告 ===')
{
  const r = simulate([1, 2, 3])
  check('3 页全部标记', fmt(r.finalAds) === '[1,2,3]', fmt(r.finalAds))
  // cap=4，第 4 页探完就撞上限了
  check('探到第 4 页确认边界', r.probed.includes(4), fmt(r.probed))
}

console.log('\n=== 5. 尾页是广告 -> 反向探 ===')
{
  const r = simulate([20])
  check('多探了 19,18 页', r.probed.includes(19) && r.probed.includes(18), fmt(r.probed))
  check('只标记第 20 页', fmt(r.finalAds) === '[20]', fmt(r.finalAds))
  check('没有继续探第 17 页', !r.probed.includes(17), fmt(r.probed))
}

console.log('\n=== 6. 尾页连着 2 页都是广告 ===')
{
  const r = simulate([19, 20])
  check('标记 19,20', sameSet(r.finalAds, [19, 20]), fmt(r.finalAds))
  check('探到第 18 页确认边界', r.probed.includes(18), fmt(r.probed))
}

console.log('\n=== 7. 首尾都有广告 ===')
{
  const r = simulate([1, 20])
  check('两端都扩探了', r.probed.includes(2) && r.probed.includes(19), fmt(r.probed))
  check('标记 1 和 20', fmt(r.finalAds) === '[1,20]', fmt(r.finalAds))
}

console.log('\n=== 8. 硬上限：连续 5 页广告也不能探过 cap ===')
{
  // cap=2：探到第 2 页就该停，哪怕它也是广告
  const r = simulate([1, 2, 3, 4, 5], { cap: 2 })
  // 只看头部页（20 是尾部首轮探的，不算）
  const headProbed = r.probed.filter((p) => p <= 5)
  check('探到的头部页不超过 cap', Math.max(...headProbed) <= 2, fmt(headProbed))
  check('最终只标记 1,2', fmt(r.finalAds) === '[1,2]', fmt(r.finalAds))
}

console.log('\n=== 9. 两侧不许重叠：短章上不能把整章都标成广告 ===')
{
  // 8 页章，cap=6，头尾各 1：即使全判成广告，也不能全被吃掉
  const r = simulate([1, 2, 3, 4, 5, 6, 7, 8], { total: 8, cap: 6 })
  const kept = 8 - r.finalAds.length
  check('至少留下 1 页正文', kept >= 1, `标记了 ${r.finalAds.length} 页，剩 ${kept} 页`)
  check('标记的全是边缘连续段',
    r.finalAds.every((p) => p <= 3 || p >= 6),
    fmt(r.finalAds))
}

console.log('\n=== 10. 章内广告不采纳 ===')
{
  // 第 5 页是广告，但它不在边缘连续段里
  const r = simulate([5])
  check('章内第 5 页不会被标记', !r.finalAds.includes(5), fmt(r.finalAds))
  check('且不会因此去探它', !r.probed.includes(5), fmt(r.probed))
}

console.log('\n' + '='.repeat(50))
console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
console.log('='.repeat(50))
process.exit(fail === 0 ? 0 : 1)
