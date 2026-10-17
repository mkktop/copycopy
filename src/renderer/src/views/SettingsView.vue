<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { AppConfig } from '@shared/types'
import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
  NEmpty,
  NInput,
  NInputNumber,
  NSpace,
  NSwitch,
  NTag,
  NSelect,
  useMessage
} from 'naive-ui'
import { useAppStore } from '../stores/app'

const app = useAppStore()
const message = useMessage()

const g = computed(() => app.config?.global)
const saving = ref(false)
const checking = ref(false)
const unsubPath = ref<string | null>(null)
const proxyUrl = ref('')
const activeProxy = ref<string | null>(null)

/**
 * 未保存检测。
 * 之前改完并发数往下滑就忘了点保存，改动静默丢失，用户根本不知道。
 * 注意：只能在"配置刚加载/刚保存"时取快照，不能 watch(g)——
 * 界面上改的正是 g 里的字段，一 watch 就永远是"没改动"。
 */
const savedSnapshot = ref<string>('')
const dirty = computed(() => !!g.value && JSON.stringify(g.value) !== savedSnapshot.value)

function markSaved(): void {
  savedSnapshot.value = g.value ? JSON.stringify(g.value) : ''
}

async function reload(): Promise<void> {
  await app.loadConfig()
  markSaved()
}

async function loadProxy(): Promise<void> {
  const p = await window.mkk.proxyGet()
  activeProxy.value = p
  proxyUrl.value = p ?? ''
}

async function applyProxy(url: string | null): Promise<void> {
  const p = await window.mkk.proxySet(url)
  activeProxy.value = p
  if (url) message.success('已启用代理：' + p)
  else message.info('已关闭代理，恢复直连')
}

// 配置里存的是 0/1（与原 Python 版 YAML 兼容），NSwitch 只认布尔值，这里做一层转换
const pdfSwitch = computed({
  get: () => g.value?.pdf_switch === 1,
  set: (v: boolean) => {
    if (g.value) g.value.pdf_switch = v ? 1 : 0
  }
})
const autoCheck = computed({
  get: () => g.value?.auto_check_on_launch === 1,
  set: (v: boolean) => {
    if (g.value) g.value.auto_check_on_launch = v ? 1 : 0
  }
})
const notifyOnDone = computed({
  get: () => g.value?.notify_on_done === 1,
  set: (v: boolean) => {
    if (g.value) g.value.notify_on_done = v ? 1 : 0
  }
})

/* ---------------- AI 广告识别 ---------------- */

const aiEnabled = computed({
  get: () => g.value?.ai_enabled === 1,
  set: (v: boolean) => {
    if (g.value) g.value.ai_enabled = v ? 1 : 0
  }
})
const aiAutoDetect = computed({
  get: () => g.value?.ai_auto_detect === 1,
  set: (v: boolean) => {
    if (g.value) g.value.ai_auto_detect = v ? 1 : 0
  }
})

/** 明文只在用户输入时存在于这个 ref，绝不落盘 */
const apiKeyInput = ref('')
const hasSavedKey = ref(false)
const testing = ref(false)
const modelOptions = ref<Array<{ label: string; value: string }>>([
  { label: 'MiniMax-M3', value: 'MiniMax-M3' }
])

async function loadAi(): Promise<void> {
  try {
    const [st, models] = await Promise.all([window.mkk.aiStatus(), window.mkk.aiModels()])
    hasSavedKey.value = st.hasKey
    if (models.length) {
      modelOptions.value = models.map((m) => ({ label: m, value: m }))
    }
  } catch {
    /* 未启用时忽略 */
  }
}

async function testAi(): Promise<void> {
  if (!g.value) return
  if (!apiKeyInput.value && !hasSavedKey.value) {
    message.warning('请先填写 API Key')
    return
  }
  testing.value = true
  try {
    const r = await window.mkk.aiTest({
      baseUrl: g.value.ai_base_url,
      model: g.value.ai_model,
      // 没重新填就说明用已保存的那把
      useSavedKey: !apiKeyInput.value,
      ...(apiKeyInput.value ? { apiKey: apiKeyInput.value } : {})
    })
    if (r.ok) message.success(r.message)
    else message.error(r.message)
  } finally {
    testing.value = false
  }
}

async function save(): Promise<void> {
  if (!g.value) return
  saving.value = true
  try {
    await app.saveGlobal({
      pdf_switch: g.value.pdf_switch,
      pdf_password: g.value.pdf_password || null,
      concurrency: g.value.concurrency,
      chapter_delay_min: g.value.chapter_delay_min,
      chapter_delay_max: g.value.chapter_delay_max,
      auto_check_on_launch: g.value.auto_check_on_launch,
      auto_check_interval_hours: g.value.auto_check_interval_hours,
      notify_on_done: g.value.notify_on_done,
      search_type: g.value.search_type,

      ai_enabled: g.value.ai_enabled,
      ai_auto_detect: g.value.ai_enabled && g.value.ai_auto_detect ? 1 : 0,
      ai_base_url: g.value.ai_base_url,
      ai_model: g.value.ai_model,
      ai_head_pages: g.value.ai_head_pages,
      ai_tail_pages: g.value.ai_tail_pages,
      ai_max_ad_pages: g.value.ai_max_ad_pages,
      ai_threshold: g.value.ai_threshold,
      ai_concurrency: g.value.ai_concurrency,
      // 只有用户真的填了才提交；留空 = 沿用已保存的那把
      ...(apiKeyInput.value ? { ai_api_key: apiKeyInput.value } : {})
    } as Partial<AppConfig['global']>)
    apiKeyInput.value = ''
    await loadAi()
    message.success('设置已保存')
    markSaved()
  } finally {
    saving.value = false
  }
}

async function checkNow(): Promise<void> {
  checking.value = true
  try {
    const res = await window.mkk.checkUpdates()
    await reload()
    message.success(
      res.queued > 0
        ? `检查完成，发现 ${res.queued} 章新内容，已加入下载队列`
        : `检查完成，共检查 ${res.checked} 部漫画，无新章节`
    )
  } finally {
    checking.value = false
  }
}

async function removeSub(path: string): Promise<void> {
  await window.mkk.unsubscribe(path)
  await reload()
  message.success('已取消订阅')
}

/** 数据目录三行，模板里循环渲染，别再写三遍一样的结构 */
const pathRows = computed(() => [
  { label: '下载目录', value: app.paths?.out ?? '' },
  { label: '配置文件', value: app.paths?.config ?? '' },
  { label: '日志目录', value: app.paths?.logs ?? '' }
])

async function copyText(v: string): Promise<void> {
  if (!v) return
  try {
    await navigator.clipboard.writeText(v)
    message.success('已复制到剪贴板')
  } catch {
    message.error('复制失败')
  }
}

onMounted(() => {
  void reload()
  void loadProxy()
  void loadAi()
})
</script>

<template>
  <div class="page" v-if="g">
    <div class="sheet">
      <NCard title="下载与追更" size="small" class="card">
        <template #header-extra>
          <NSpace align="center" :size="10">
            <NTag v-if="dirty" size="small" type="warning" :bordered="false">有未保存的改动</NTag>
            <NButton
              size="small"
              type="primary"
              :loading="saving"
              :disabled="!dirty"
              @click="save"
            >
              保存
            </NButton>
          </NSpace>
        </template>

        <!-- 分组标题：7 条设置原本平铺在一起，看不出哪些相关 -->
        <div class="group">下载</div>

        <div class="row">
          <div class="label">
            <div class="label-title">章内并发数</div>
            <div class="label-hint">同时下载的图片数量。调高更快，但更容易触发限流，建议 5</div>
          </div>
          <div class="ctl">
            <NInputNumber v-model:value="g.concurrency" :min="1" :max="16" size="small" />
          </div>
        </div>

        <div class="row">
          <div class="label">
            <div class="label-title">章节间随机等待</div>
            <div class="label-hint">每下完一章随机等几秒再继续，用于反限流</div>
          </div>
          <div class="ctl range">
            <NInputNumber
              v-model:value="g.chapter_delay_min"
              :min="0"
              :max="300"
              size="small"
            />
            <span class="sep">~</span>
            <NInputNumber
              v-model:value="g.chapter_delay_max"
              :min="0"
              :max="300"
              size="small"
            />
            <span class="unit">秒</span>
          </div>
        </div>

        <div class="row">
          <div class="label">
            <div class="label-title">下载后自动生成 PDF</div>
            <div class="label-hint">关闭则只存图片，可在漫画库随时手动导出</div>
          </div>
          <div class="ctl">
            <NSwitch v-model:value="pdfSwitch" size="small" />
          </div>
        </div>

        <div class="row">
          <div class="label">
            <div class="label-title">PDF 密码</div>
            <div class="label-hint">留空不加密。标准 PDF 加密（AES-128）</div>
          </div>
          <div class="ctl">
            <NInput
              v-model:value="g.pdf_password"
              type="password"
              show-password-on="click"
              placeholder="不设置则不加密"
              size="small"
              clearable
            />
          </div>
        </div>

        <div class="group">追更</div>

        <div class="row">
          <div class="label">
            <div class="label-title">启动时自动检查</div>
            <div class="label-hint">应用启动 3 秒后自动执行一次更新检查</div>
          </div>
          <div class="ctl">
            <NSwitch v-model:value="autoCheck" size="small" />
          </div>
        </div>

        <div class="row">
          <div class="label">
            <div class="label-title">定时检查</div>
            <div class="label-hint">
              保持运行期间每隔一段时间查一次；队列正忙会跳过该轮。0 表示关闭
            </div>
          </div>
          <div class="ctl range">
            <NInputNumber
              v-model:value="g.auto_check_interval_hours"
              :min="0"
              :max="168"
              :step="1"
              size="small"
            />
            <span class="unit">小时</span>
          </div>
        </div>

        <div class="row">
          <div class="label">
            <div class="label-title">下载完成通知</div>
            <div class="label-hint">队列跑完弹一条系统通知，点一下直达下载页</div>
          </div>
          <div class="ctl">
            <NSwitch v-model:value="notifyOnDone" size="small" />
          </div>
        </div>
      </NCard>

      <NCard title="AI 广告识别" size="small" class="card">
        <template #header-extra>
          <NTag size="small" :bordered="false" :type="hasSavedKey ? 'success' : 'default'">
            {{ hasSavedKey ? '已配置 Key' : '未配置 Key' }}
          </NTag>
        </template>

        <div class="row">
          <div class="label">
            <div class="label-title">启用</div>
            <div class="label-hint">
              识别每章首尾页里的广告（字幕组招新、求订阅、社群宣传），确认后移入该章的
              <code class="mono">_ads/</code> 子目录。识别失败一律保留原图，不会误删
            </div>
          </div>
          <div class="ctl">
            <NSwitch v-model:value="aiEnabled" size="small" />
          </div>
        </div>

        <div class="row">
          <div class="label">
            <div class="label-title">下载后自动检测</div>
            <div class="label-hint">
              每下完一章自动跑一次检测（发生在生成 PDF 之前，导出的 PDF 才是干净的）
            </div>
          </div>
          <div class="ctl">
            <NSwitch v-model:value="aiAutoDetect" size="small" :disabled="!g.ai_enabled" />
          </div>
        </div>

        <div class="row">
          <div class="label">
            <div class="label-title">检查范围</div>
            <div class="label-hint">只检查首尾各若干页，章内页永不送检，省钱也省时间</div>
          </div>
          <div class="ctl range">
            <NInputNumber v-model:value="g.ai_head_pages" :min="0" :max="3" size="small" />
            <span class="sep">+</span>
            <NInputNumber v-model:value="g.ai_tail_pages" :min="0" :max="3" size="small" />
            <span class="unit">页</span>
          </div>
        </div>

        <div class="row">
          <div class="label">
            <div class="label-title">连续广告上限</div>
            <div class="label-hint">
              招新往往是连着好几页。首轮命中广告后会自动往里继续探，
              连续是广告就一直探，直到撞上正文页为止；探到这里就停手，防止一路探进正文
            </div>
          </div>
          <div class="ctl range">
            <NInputNumber v-model:value="g.ai_max_ad_pages" :min="1" :max="6" size="small" />
            <span class="unit">页/侧</span>
          </div>
        </div>

        <div class="row">
          <div class="label">
            <div class="label-title">并发数</div>
            <div class="label-hint">
              批量检测时同时请求几章。调大更快，但也更容易触发限流；被限流会自动退避重试。改完立即生效
            </div>
          </div>
          <div class="ctl range">
            <NInputNumber v-model:value="g.ai_concurrency" :min="1" :max="5" size="small" />
            <span class="unit">路</span>
          </div>
        </div>

        <div class="row">
          <div class="label">
            <div class="label-title">置信度阈值</div>
            <div class="label-hint">
              低于这个值就不算广告。宁可漏删也别误删正文，调高更保守
            </div>
          </div>
          <div class="ctl range">
            <NInputNumber
              :value="Math.round(g.ai_threshold * 100)"
              :min="1"
              :max="100"
              size="small"
              @update:value="(v: number | null) => {
                if (g) g.ai_threshold = (v ?? 80) / 100
              }"
            />
            <span class="unit">%</span>
          </div>
        </div>

        <div class="group">MiniMax 接口</div>

        <div class="row">
          <div class="label">
            <div class="label-title">接口地址</div>
            <div class="label-hint">
              国内站是 <code class="mono">api.minimaxi.com</code>；
              <code class="mono">api.minimax.io</code> 是国际站，Key 不通用（会 401）
            </div>
          </div>
          <div class="ctl wide">
            <NInput v-model:value="g.ai_base_url" size="small" />
          </div>
        </div>

        <div class="row">
          <div class="label">
            <div class="label-title">API Key</div>
            <div class="label-hint">
              用系统凭据加密后保存，不落明文。换机器后需重新填写
            </div>
          </div>
          <div class="ctl wide">
            <NInput
              v-model:value="apiKeyInput"
              type="password"
              show-password-on="click"
              size="small"
              :placeholder="hasSavedKey ? '已保存，留空表示不修改' : 'sk-...'"
              clearable
            />
            <NButton size="small" :loading="testing" @click="testAi">测试连接</NButton>
          </div>
        </div>

        <div class="row">
          <div class="label">
            <div class="label-title">模型</div>
            <div class="label-hint">
              M3 系列原生多模态，可直接看图。M3.1 只走 Token Plan 订阅 Key，与按量 Key 不通用
            </div>
          </div>
          <div class="ctl wide">
            <NSelect v-model:value="g.ai_model" :options="modelOptions" size="small" />
          </div>
        </div>

        <NAlert type="info" :bordered="false" class="mt">
          检测结果会记进 <code class="mono">.copycopy.json</code>，同一章不会重复付费。
          误判了可以在漫画库对应章节点「撤销」把图移回来。
        </NAlert>
      </NCard>

      <NCard title="网络代理" size="small" class="card">
        <NAlert :type="activeProxy ? 'success' : 'info'" :bordered="false" class="mb">
          <template #default>
            <span v-if="activeProxy">当前生效代理：<b>{{ activeProxy }}</b></span>
            <span v-else>当前直连。启动时若检测到 Windows 系统代理会自动启用。</span>
          </template>
        </NAlert>
        <div class="row">
          <div class="label">
            <div class="label-title">代理地址</div>
            <div class="label-hint">如 http://127.0.0.1:7897，留空表示直连</div>
          </div>
          <div class="ctl wide">
            <NInput
              v-model:value="proxyUrl"
              placeholder="http://127.0.0.1:7897"
              size="small"
              clearable
              @keyup.enter="applyProxy(proxyUrl.trim() || null)"
            />
            <NButton size="small" type="primary" @click="applyProxy(proxyUrl.trim() || null)">
              应用
            </NButton>
            <NButton size="small" quaternary @click="applyProxy(null)">关闭</NButton>
          </div>
        </div>
      </NCard>

      <NCard title="追更订阅" size="small" class="card">
        <template #header-extra>
          <NButton size="small" :loading="checking" @click="checkNow">
            立即检查更新
          </NButton>
        </template>
        <template v-if="app.config && app.config.comics.length">
          <div v-for="c in app.config.comics" :key="c.path" class="sub-row">
            <div class="sub-info">
              <div class="sub-name">
                {{ c.name }}
                <NTag size="tiny" :bordered="false" class="ml">{{ c.path }}</NTag>
              </div>
              <div class="sub-meta">
                已下载至第 {{ c.last_chapter }} 章 · 单次最多 {{ c.download_limit }} 章 ·
                上次检查 {{ c.last_check_time || '从未' }}
              </div>
            </div>
            <NButton
              size="tiny"
              quaternary
              type="error"
              :loading="unsubPath === c.path"
              @click="unsubPath = c.path; removeSub(c.path).finally(() => (unsubPath = null))"
            >
              取消订阅
            </NButton>
          </div>
        </template>
        <NEmpty v-else description="还没有订阅任何漫画，在搜索页进入漫画详情后点「加入追更订阅」" />
      </NCard>

      <NCard title="数据目录" size="small" class="card">
        <div v-for="p in pathRows" :key="p.label" class="row">
          <div class="label"><div class="label-title">{{ p.label }}</div></div>
          <div class="ctl wide path">
            <code class="path-text" :title="p.value">{{ p.value }}</code>
            <NButton size="tiny" quaternary @click="copyText(p.value)">复制</NButton>
          </div>
        </div>
        <NAlert type="info" :bordered="false" class="mt">
          整个目录拷走即可带走配置、下载内容与日志（便携版语义）。
        </NAlert>
      </NCard>
    </div>
  </div>

  <div v-else class="empty">加载中…</div>
</template>

<style scoped>
/*
 * 之前的写法是 .row { display:flex; justify-content: space-between }，
 * 标签贴左、控件被推到卡片最右：760px 宽里中间空出 400px 空洞，
 * 一眼扫过去对不上"这个控件属于哪一行"，描述一换行还会把控件顶歪。
 *
 * 现在改成两列网格：控件全部落在同一条竖线上，成组可扫。
 * 整页再限宽居中，宽屏上不会孤零零挂在左边。
 */
.sheet {
  max-width: 780px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.card {
  width: 100%;
}

.mb {
  margin-bottom: 12px;
}
.mt {
  margin-top: 10px;
}
.ml {
  margin-left: 6px;
}

/* 卡内分组标题，把 7 条设置切成「下载 / 追更」两段 */
.group {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.6px;
  color: var(--c-text-4);
  padding: 12px 0 4px;
}
.group:first-child {
  padding-top: 0;
}

.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  align-items: center;
  gap: 20px;
  padding: 10px 0;
  border-bottom: 1px solid var(--c-border);
}
.row:last-child {
  border-bottom: none;
}

.label {
  min-width: 0;
}
.label-title {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
}
.label-hint {
  font-size: 12px;
  line-height: 1.55;
  color: var(--c-text-3);
  margin-top: 2px;
}

/* 所有控件右对齐，落在同一条竖线上 */
.ctl {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}
.ctl.wide {
  grid-column: 2;
}

/* 数字输入统一宽度，否则每行宽度不同，竖线还是歪的 */
.ctl :deep(.n-input-number) {
  width: 104px;
}
.ctl.range :deep(.n-input-number) {
  width: 86px;
}
.ctl.wide :deep(.n-input) {
  flex: 1;
  min-width: 0;
}

.sep,
.unit {
  color: var(--c-text-3);
  font-size: 12px;
  flex: 0 0 auto;
}
.unit {
  min-width: 26px;
}

/* 路径是长字符串，允许截断显示，完整值走 title */
.ctl.path {
  gap: 6px;
}
.path-text {
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-size: 12px;
  color: var(--c-text-2);
  background: var(--c-elevated-hover);
  border: 1px solid var(--c-border);
  border-radius: 4px;
  padding: 3px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.sub-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--c-border);
}
.sub-row:last-child {
  border-bottom: none;
}

.sub-info {
  flex: 1;
  min-width: 0;
}
.sub-name {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 2px;
}
.sub-meta {
  font-size: 12px;
  color: var(--c-text-3);
}

/* 提示里提到的路径/域名，等宽一下更好认 */
.mono {
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-size: 11px;
  background: var(--c-elevated-hover);
  border-radius: 3px;
  padding: 1px 4px;
}
</style>
