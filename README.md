# CopyCopy（漫画下载器桌面版）

基于 Python 版 [mkk_comic](https://github.com/mkktop/mkk_comic) 移植的 Electron 桌面应用，
在原 CLI 功能之上补了图形界面、下载队列和本地漫画库。

## 1.2 桌面体验

界面整理为「发现漫画、我的书架、追更订阅、下载管理、广告整理」五个工作区，配合固定侧边导航。
浅色、深色和跟随系统均可使用；下载任务按状态筛选，设置按用途分组，追更订阅可以独立管理。

设置使用独立草稿，保存后才影响运行配置；从详情返回会保留搜索结果。阅读器支持正确换章、恢复上次阅读章节，
AI 检测的失败章节也可以正常重试。

详细交互、修复项目及验证方式见 [桌面体验整理](docs/desktop-refresh.md)。

开发验证：`npm run typecheck`、`npm run format:check`、`npm test`、`npm run test:ui`。
GitHub Actions 会验证 Linux / Windows，并生成可下载的 Windows 安装包和便携版构建产物。

## 功能

- **搜索**：按名称/作者搜索拷贝漫画（CopyManga），封面卡片浏览
- **漫画详情**：简介、最新章节、分页章节列表，支持单选 / 区间选 / 本页全选
- **下载队列**：实时进度（当前页 / 总页 / 已跳过 / 失败页）、瞬时速度与剩余时间，
  支持取消、重试、置顶、清除；退出后重开会自动续上没下完的
- **阅读器**：章节内翻页阅读，适应宽度/高度/原始、缩放、跳页，记住每章读到的位置
- **漫画库**：扫描本地下载目录，按漫画/章节筛选，支持排序与"只看缺页"，
  多选批量导出 PDF / 批量删除，缺页一键补下
- **PDF 导出**：整章合并为单个 PDF，按图片实际比例分页，支持密码保护；可直接调系统阅读器打开
- **完整性追踪**：每部漫画记下站点 `path_word` 与每章的期望页数/失败页，
  缺页的章节会标出来，并能只补缺的那几页
- **追更订阅**：记录已下载章节号，按设定的单次上限增量下载，每章完成立即落盘；
  可选启动时检查 / 定时检查
- **AI 广告识别**：用 MiniMax M3 多模态模型判断每章首尾页是不是广告（字幕组招新、
  求订阅、社群宣传），确认后移入 `_ads/`，阅读器和 PDF 导出自动跳过，可随时撤销
- **完成通知**：整个队列跑完弹系统通知，点一下直接跳到下载页
- **日志**：按天轮转写入 `logs/`，界面内实时查看

## AI 广告识别

译制组招新、求订阅、社群宣传这类图常出现在每章的首尾页。开启后程序会把每章的
**首 N 页和尾 N 页**（章内页永不送检）发给 MiniMax M3 判断，确认是广告的页
移进 `<章节>/_ads/`。

### 为什么不直接删

误判的代价不对称：**误删正文**会永久丢失内容，**漏删广告**只是看着碍眼。
所以默认只归档不删除，随时可以在漫画库点「撤销归档」把图移回来。

### 关键设计

| 做法 | 原因 |
| --- | --- |
| **任何失败都保留页面**（fail-open） | 超时 / 限流 / Key 错 / 返回坏 JSON，一律当作"没检测出来"，绝不据此移走文件 |
| **只检查边界页** | 章内页不可能是广告，省钱也省时间 |
| **短章保护** | 总页数 ≤ 头+尾 时直接跳过，否则 2 页的短章可能被整章端掉 |
| **边缘连续段自动往里探** | 招新常是连着 2–3 页。第 1 页判定为广告就继续探 2、3 页，撞上正文才停手；尾页同理。章内页永不标记 |
| **按需分轮扩展** | 每轮只发新探到的页。没有广告的章节（大多数）一轮就结束，不多花钱；最坏 4 轮 |
| **两侧不重叠 + 每侧上限** | 短章上按 `min(上限, ⌊(总页-1)/2⌋)` 压缩，保证至少留一页正文 |
| **结果写进 `.copycopy.json`** | 同一章不重复付费；顺带让断点续传跳过已归档的广告页 |
| **检测在生成 PDF 之前** | 否则导出的 PDF 里还带着广告 |
| **并发可配（1~5）** | 批量检测 100 章串行要 6 分钟。主进程有全局闸门兜底，渲染层按配置开 worker，改完立即生效不用重启 |
| **429 自动退避重试** | 限流不算失败，指数退避 + 抖动后重试，最多 3 次 |
| **API Key 用 safeStorage 加密** | Windows 走 DPAPI，不落明文；换机器解不开会提示重填 |

实测同一批 6 章：并发 1 耗时 12.2s，并发 3 耗时 7.7s。提速没有 3 倍——瓶颈在
模型响应延迟而不在本地，所以并发开到 3~4 就够，再高收益很小。

### 接口要点（实测）

- 域名是 **`https://api.minimaxi.com/v1`**。
  `api.minimax.io` 是国际站，**Key 不通用，直接 401**
- 模型 `MiniMax-M3` 是原生多模态，可直接吃图，不需要先 OCR
- **必须传 `thinking: { type: "disabled" }`**。M3 默认会输出 `<think>…</think>`
  思考过程，既污染 JSON 解析又多耗 token（实测 332 → 204）。`enable_thinking: false` 无效
- `MiniMax-M3.1-Flash-Preview` 只走 Token Plan 订阅 Key，与按量 API Key **不通用**；
  且它强制要求 adaptive thinking，禁用会被拒（code 2013）。客户端的处理是：
  先按"禁用"发，命中 2013 就去掉 `thinking` 参数重发一次，`<think>` 块由 `stripThink()` 清掉

## 技术栈

Electron 33 · Vue 3 · TypeScript · Vite（electron-vite）· Pinia · naive-ui · pdf-lib-plus-encrypt

## 开发

```bash
npm install
npm run dev          # 开发模式
npm run build        # 构建（输出到 out/）
npm run typecheck    # 类型检查（node 用 tsc，web 用 vue-tsc）
npm test             # 端到端测试（内置模拟站点，无需联网）
npm run build:win    # 打包 Windows exe（输出到 release/）
```

国内网络下载 Electron 二进制可能失败，可先设置镜像：

```bash
export ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
npm install
```

## 数据存放

打包后 `config/`、`out/`、`logs/` 都放在 exe 同级目录（便携版语义），
把整个目录拷走即可带走全部数据。安装版若装在不可写位置（如 Program Files）会自动退回
`%APPDATA%\mkk-comic`。实际路径可在「设置 → 数据目录」查看。

```
config/comic.yaml          # 订阅与设置（与原 Python 版同格式，可直接迁移）
config/queue.json          # 未下完的下载队列，退出不丢
out/<漫画名>/<章节名>/       # 下载的图片，001.jpg 起按阅读顺序编号
out/<漫画名>/<章节名>/_ads/  # 被判定为广告的页，可整目录移回撤销
out/<漫画名>/<章节名>.pdf    # 导出的 PDF
out/<漫画名>/.copycopy.json  # 站点 path_word + 每章的期望页数/失败页/广告页
logs/data_YYYY-MM-DD.log    # 按天轮转，保留 7 天
cache/remote/               # 远程封面缓存（按 URL 哈希）
```

### 漫画元信息 `.copycopy.json`

下载时站点 `path_word` 和漫画名本来就在手上，顺手写一份成本几乎为零。
有了它：

- 补封面直接用 `path_word` 查详情（1 次请求），不用再拿目录名去搜索站反查
- 站点给漫画改了名，目录对不上也不会认错成另一部
- 漫画库可以直接查更新、只补缺页
- 一章 20 页下成 8 页，库里会标成"缺页"，而不是和本来就短的章节长得一样

老版本下载的没有这个文件，补一次封面或重新下载任意一章之后就有了。

## 配置项（`config/comic.yaml`）

```yaml
global:
  pdf_switch: 1                 # 下载后自动生成 PDF
  pdf_password: null            # PDF 密码，null 表示不加密
  concurrency: 5                # 章内图片并发数
  chapter_delay_min: 5          # 章节间随机等待下限（秒，反限流）
  chapter_delay_max: 10         # 上限
  auto_check_on_launch: 0       # 启动 3 秒后自动检查追更
  auto_check_interval_hours: 0  # 定时检查间隔（小时），0 = 关闭
  notify_on_done: 1             # 队列跑完发系统通知
  search_type: ''               # 默认搜索维度：'' 全部 / name 名称 / author 作者
  ai_enabled: 0                 # AI 广告识别总开关
  ai_auto_detect: 0             # 下载完成后自动检测（须 ai_enabled 同时为 1）
  ai_base_url: https://api.minimaxi.com/v1
  ai_api_key_enc: null          # safeStorage 密文，界面上填写，不建议手改
  ai_model: MiniMax-M3
  ai_head_pages: 1              # 首轮检查几页
  ai_tail_pages: 1              # 尾页同理
  ai_max_ad_pages: 4            # 每侧最多往里探到第几页（1~6）
  ai_threshold: 0.8             # 置信度阈值，高一点更保守
  ai_concurrency: 3             # 同时检测几章（1~5），改完立即生效
comics:
- name: 海贼王
  path: haizeiwang           # 站点 path_word
  last_chapter: 393          # 已下载到第几章
  download_limit: 10         # 单次追更多少章
  last_check_time: '2026-07-17 04:43:28'
```

## 站点域名

接口域名写在 `src/main/api/copymanga.ts`。站点按年份轮换域名，
原 Python 版硬编码的 `api.2025copy.com` 已停止服务（会报
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`），当前可用：

| 域名 | 状态 |
| --- | --- |
| `api.mangacopy.com` | **默认**。等价域名里响应更快，也不跟着年份走 |
| `api.2026copy.com` | 可用，备用 |

两者接口完全一致，实测同一网络下平均响应 760ms vs 890ms（各 4 轮采样）。

> **2026-10 起站点开始校验客户端身份**：`User-Agent: COPY/3.x` + 旧 `version`
> 会被 `api.mangacopy.com` 打 HTTP 210（提示"请更新最新APP，等待1小时"），
> 章节列表、搜索全部拿不到数据。`api.2026copy.com` 目前还放行旧身份。
> 已把内置身份升到 `COPY/4.0.0` + `2026.10.10`；再被拦时可用环境变量
> `MKK_API_VERSION` 覆盖，或临时切 `MKK_API_HOST=api.2026copy.com`。

域名再变时不用改代码：

```bash
MKK_API_HOST=api.newsite.com     # 换域名
MKK_API_VERSION=2026.01.01       # 客户端版本号（站点校验用）
MKK_API_BASE=http://127.0.0.1:8899   # 连本地模拟站点
```

### 关于图片格式

图片 CDN 无论请求头怎么带都只发 WebP（`content-type` 恒为 `image/webp`），
但把 URL 末尾的 `.webp` 换成 `.jpg` 就会返回真正的 JPEG。
`src/main/download/image.ts` 的 `toJpegUrl()` 负责这个改写——
必须做，否则 PDF 嵌入不了图片。

## 代理

Node / Electron 的 `fetch` **不读系统代理**，所以程序会自己探测并挂载 `ProxyAgent`。
优先级：`MKK_PROXY` > `HTTPS_PROXY` / `HTTP_PROXY` > Windows「系统代理」设置。

开着 Clash / v2rayN 等工具时启动即自动识别；也可在「设置 → 网络代理」里手动填写
`http://127.0.0.1:7897` 之类的地址，或点「关闭代理」强制直连。

### 内置 CA 证书

站点证书链为 `*.2025copy.com` → Let's Encrypt YE2 → **ISRG Root YE**。
Root YE 是 2025 年新增的根证书，Electron 33 内置的 Node 尚未收录，
不补会直接报 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`。程序启动时会把
`resources/isrg-roots.pem` 追加进信任链。换成别的站点若也缺根证书，
把对应根证书 PEM 追加进这个文件即可。

> 文件名必须和 `electron-builder.yml` 的 `extraResources` 对得上（两边都是
> `isrg-roots.pem`）。候选名集中在 `src/main/proxy.ts` 的 `EXTRA_CA_FILES`，
> 改打包配置时记得同步。

## 路径安全

`out/` 里的漫画名和章节名有一部分来自站点接口，属于不可信输入；
另一部分来自渲染层 IPC，同样按不可信处理。所有拿这些片段拼路径的地方
都必须走 `src/main/safe-path.ts`：

- `resolveInside(base, ...segments)` —— 解析后用 `path.relative` 判断是否越界，
  越界返回 `null`。**不要用 `startsWith` 做这个判断**：
  `D:\app\outsecret` 对 `D:\app\out` 做前缀比较是成立的。
- `sanitizeName(name)` —— 站点名转目录名。除了文件系统非法字符，还要处理
  `.` / `..`（`path.join` 会当成目录跳转）、Windows 保留设备名
  （`CON` / `COM1` …），以及结尾的点和空格（NTFS 会静默丢弃，导致两个目录撞名）。

删除操作（`deleteChapter` / `deleteComic`）尤其要当心：名字直接来自渲染层，
一旦漏掉包含性检查，`deleteComic('../../Windows')` 会把整个目录递归删掉。
`npm run test:security` 就是为这条线加的回归网。

## 本地图片与远程封面怎么加载的

两个自定义协议，都由主进程兜底，渲染层拿不到 `ipcRenderer` 之外的东西。

**`library://local/<相对 out/ 的路径>`** — 读本地已下载的图片。
不用 `readImage()` 把整张图 base64 编码过 IPC——那样体积凭空涨 1/3，
翻一页传几百 KB 字符串，几百页的库点开就是几十 MB 的序列化开销。
协议处理器会做包含性校验和扩展名白名单，只放图片。

**`remote://img/<整条 URL 编码后>`** — 中转站点封面。
渲染层不能直接 `<img src="https://站点CDN/...">`：

1. 渲染层是 Chromium 的独立网络栈，读不到「设置 → 网络代理」里配的代理
   （开着 Clash 手动指定端口的场景下，搜索页和详情页封面会全裂，但下载却是好的）
2. 发不出 `version` / `platform` / `region` 这些 CDN 要求的请求头，容易 403

所以统一由主进程 `fetch`（自带 ProxyAgent 和请求头）后再返回，顺带落盘缓存。
代价是这个协议等于一个可被渲染层调用的取件器，所以加了 SSRF 防护：
只允许 http(s)，并挡掉回环、私有网段、云元数据地址等目标。
`isBlockedRemoteUrl()` 在 `src/main/safe-path.ts`，
已知边界写在函数注释里（只查主机名和字面量 IP，不做 DNS 解析）。

渲染层 CSP 的 `img-src` 里放行了 `library:` 和 `remote:`。

## 测试

不需要真实站点，用内置模拟站点即可跑通全流程：

```bash
npm test               # 安全用例 + 端到端 + 协议 + 扩展探测策略，全跑一遍
npm run test:security  # 路径越界回归（纯逻辑，秒级）
npm run test:e2e       # 端到端：搜索/下载/页序/PDF/续传/漫画库/追更
npm run test:protocol  # library:// 协议：真在 Electron 里验 <img> 能加载
npm run test:ad-policy # 连续广告扩展探测策略（纯逻辑，不联网不花钱）
npm run test:ai        # AI 广告识别（需真实 Key，会产生费用）
node scripts/make-icon.mjs    # 重新生成应用图标
```

`npm run test:ai` 需要真实的 MiniMax API Key，会**实际调用模型产生费用**：

```bash
# Windows PowerShell
$env:MMK="sk-cp-..."
npm run test:ai
```

它验的是：加解密往返、归档/撤销、短章保护、**真实调用与 JSON 解析**、
纯色图不被误判（防误删）、幂等不重复计费、Key 失效时 fail-open。

`npm run test:security` 守着三道边界，任何一条挂了都意味着数据目录外的东西可能被读、被改、被删：

- `resolveInside()` 必须挡住 `../..`、绝对路径、UNC 和 `outsecret` 这种兄弟目录前缀
- `sanitizeName()` 产出的名字不能逃出 `out/`、也不能撞 Windows 保留名
- `isBlockedRemoteUrl()` 必须挡住回环 / 私有网段 / 云元数据 / 非 http 协议

真实站点测试需要先打包再在 Electron 里跑：

```bash
npm run test:live
```

`scripts/mock-server.mjs` 复刻了站点的 4 个接口，并且刻意把 `contents` 打乱、
把页号编码进图片宽度，用来验证按 `words` 还原页序是否正确。
要让应用连模拟站点：

```bash
node scripts/mock-server.mjs
MKK_API_BASE=http://127.0.0.1:8899 MKK_API_HOST=127.0.0.1:8899 npm run dev
```

## 相比原 Python 版的修正

原版 `app.py` 存在几个问题，移植时一并修掉：

| 问题 | 说明 |
| --- | --- |
| PDF 漏首页 | `range(1, number)` 从第 2 页开始循环，第 001 页永远进不了 PDF |
| PDF 页数算错 | 用 `len(contents)` 而非 `len(words)`，多批次章节页数不对 |
| PDF 排版 | 固定 US Letter 纸，竖长漫画留大片白边；改为按图片比例分页 |
| 区间下载只下一章 | `handle_chapters_results` 在循环内 `return`，跨多章的区间只会下载第一页 |
| 无断点续传 | 重跑会整章重下；现在已存在且非空的图片会跳过 |
| WebP 无法嵌入 PDF | CDN 恒发 WebP（去掉 webp 头也没用），pdf-lib 嵌不了；现在把 URL 后缀 `.webp` 改写成 `.jpg` 拿到真 JPEG |
| 配置可写性 | 原版 exe 必须放在非中文路径；本版数据目录可写性会自动降级 |
| 不认系统代理 | Electron 的 fetch 不读 Windows 系统代理，开着 Clash 也走不出去；现在自动探测并挂 ProxyAgent |
| 缺新根证书 | 站点用 Let's Encrypt 的 ISRG Root YE，Electron 33 内置的 Node 没收录，会直接 TLS 失败；已内置该根证书 |

## 已知限制

- PDF 加密为标准 V4/R4（AES-128）。`pdf-lib-plus-encrypt` 的 `encrypt()` 会用文档头版本
  覆盖 `pdfVersion`，而版本号只读，所以拿不到 AES-256。所有阅读器都支持 AES-128。
- 定时追更只在应用保持运行时生效。原版靠 GitHub Actions 定时，桌面端没有那个东西；
  要做到"即使没开应用也检查"，得配合系统任务计划程序调用「立即检查更新」。
- 退出重开会自动继续上次没下完的队列（图片还在盘上，走断点续传）。
  如果你就是想停下来，退出前先点「全部取消」。
- `remote://` 的 SSRF 防护不解析 DNS，挡不住"域名解析到 127.0.0.1"这类情况。
  定位是纵深防御的第一层，不是唯一一道。
- `makePdf` 仍在主进程跑。长章节导出期间会分片让出事件循环，界面不冻，
  但彻底解决要迁到 `utilityProcess`，需要为那个 context 单独打包。

## 免责声明

仅供学习与个人使用，请勿用于批量抓取或商业分发，遵守目标站点的使用条款。
