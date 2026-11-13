<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute } from 'vue-router'
import { api } from '../services/api'
import { useAppStore } from '../stores/app'
import type { Settings } from '../types'
import AppIcon from '../components/AppIcon.vue'
import AppUpdates from '../components/AppUpdates.vue'
const app = useAppStore()
const route = useRoute()
const tabs = [
  { key: 'appearance', title: '外观与体验', icon: 'sun' },
  { key: 'downloads', title: '下载与追更', icon: 'download' },
  { key: 'network', title: '网络与存储', icon: 'network' },
  { key: 'updates', title: '软件更新', icon: 'refresh' }
]
const active = ref('appearance')
const draft = ref<Settings>({ ...app.settings })
const snapshot = ref(JSON.stringify(draft.value))
const dirty = computed(() => JSON.stringify(draft.value) !== snapshot.value)
const saving = ref(false)
const version = __APP_VERSION__
watch(
  () => route.query.tab,
  (value) => {
    if (typeof value === 'string' && tabs.some((t) => t.key === value)) active.value = value
  },
  { immediate: true }
)
function reset() {
  draft.value = { ...app.settings }
  snapshot.value = JSON.stringify(draft.value)
}
watch(
  () => app.settings,
  () => {
    if (!dirty.value) reset()
  }
)
// 数字输入被清空时 v-model.number 会给出 ''，这里统一当非法值，给出具体字段提示。
function intField(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}
function validate(): string | null {
  const d = draft.value
  const parallel = intField(d.parallelImages)
  if (parallel === null || parallel < 1 || parallel > 16) return '图片并发数应为 1–16 的整数'
  const delayMin = intField(d.chapterDelayMin)
  const delayMax = intField(d.chapterDelayMax)
  if (delayMin === null || delayMax === null || delayMin < 0 || delayMax > 300)
    return '章节等待时间应为 0–300 秒的整数'
  if (delayMin > delayMax) return '章节等待时间的最小值不能大于最大值'
  const interval = intField(d.subscriptionIntervalHours)
  if (interval === null || interval < 0 || interval > 168)
    return '订阅检查间隔应为 0–168 小时的整数'
  const cache = intField(d.imageCacheLimitMb)
  if (cache === null || cache < 16 || cache > 8192) return '封面缓存容量应为 16–8192 MB 的整数'
  if (d.proxyMode === 'custom' && !d.proxyUrl.trim()) return '自定义代理模式请填写代理地址'
  // 空密码后端会归一化成 null，合法；其余字段由后端兜底，前端不误拒合法值。
  return null
}
async function save() {
  if (saving.value) return
  const problem = validate()
  if (problem) {
    app.notify(problem, true)
    return
  }
  saving.value = true
  const before = JSON.parse(snapshot.value) as Record<string, unknown>
  const patch = Object.fromEntries(
    Object.entries(draft.value).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key])
    )
  ) as Partial<Settings>
  const result = await app.run(() => app.save(patch), '偏好设置已保存')
  if (result) reset()
  saving.value = false
}
async function directory() {
  const result = await app.run(() => api.pickDirectory())
  if (result) draft.value.downloadDirectory = result
}
async function clearCache() {
  if (
    !(await app.confirm(
      '清空封面缓存？',
      '只清理浏览时的图片缓存，已下载的漫画会保留。',
      '清空缓存'
    ))
  )
    return
  await app.run(() => api.clearCache(), '封面缓存已清空')
}
onBeforeRouteLeave(
  async () =>
    !dirty.value ||
    (await app.confirm(
      '离开前要放弃更改吗？',
      '当前设置还没有保存。放弃后会恢复已保存的偏好。',
      '放弃更改'
    ))
)
</script>
<template>
  <div class="page settings-page">
    <div class="page-header">
      <div>
        <div class="eyebrow">A PLACE THAT FEELS LIKE YOU</div>
        <h1>偏好设置</h1>
        <p>给阅读留一个舒服的位置。</p>
      </div>
      <span class="version-label">CopyCopy v{{ version }}</span>
    </div>
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="设置分类">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          :class="{ active: active === tab.key }"
          @click="active = tab.key"
        >
          <AppIcon :name="tab.icon" :size="18" />
          {{ tab.title }}
        </button>
      </nav>
      <div class="settings-panels">
        <template v-if="active === 'appearance'">
          <section class="setting-group">
            <div class="setting-title">
              <AppIcon name="sun" />
              <div>
                <h2>喜欢的样子</h2>
                <p>暖白和深绿，把注意力留给故事。</p>
              </div>
            </div>
            <div class="theme-options">
              <button
                v-for="theme in [
                  { key: 'system', title: '跟随系统', note: '随设备外观自动切换', icon: 'layers' },
                  { key: 'light', title: '明亮阅读室', note: '暖白背景，安静舒展', icon: 'sun' },
                  { key: 'dark', title: '夜间小书房', note: '深绿层次，柔和低光', icon: 'moon' }
                ]"
                :key="theme.key"
                :class="{ selected: draft.appearance === theme.key }"
                @click="draft.appearance = theme.key as Settings['appearance']"
              >
                <span class="theme-preview" :class="theme.key">
                  <i />
                  <i />
                  <i />
                </span>
                <strong>
                  <AppIcon :name="theme.icon" :size="15" />
                  {{ theme.title }}
                </strong>
                <small>{{ theme.note }}</small>
              </button>
            </div>
          </section>
          <section class="setting-group">
            <div class="setting-title">
              <AppIcon name="grid" />
              <div>
                <h2>浏览体验</h2>
                <p>按照自己的阅读习惯，安排一点留白。</p>
              </div>
            </div>
            <label class="setting-row">
              <span>
                <strong>紧凑的漫画卡片</strong>
                <small>在同一屏中展示更多作品。</small>
              </span>
              <input
                v-model="draft.compactCards"
                class="switch"
                type="checkbox"
                role="switch"
                aria-label="紧凑的漫画卡片"
              />
            </label>
            <label class="setting-row">
              <span>
                <strong>下载完成通知</strong>
                <small>队列结束时，用系统通知轻轻提醒。</small>
              </span>
              <input
                v-model="draft.notifyOnDone"
                class="switch"
                type="checkbox"
                role="switch"
                aria-label="下载完成通知"
              />
            </label>
          </section>
        </template>
        <template v-else-if="active === 'downloads'">
          <section class="setting-group">
            <div class="setting-title">
              <AppIcon name="download" />
              <div>
                <h2>下载节奏</h2>
                <p>章节顺序下载，同一章中的图片可以并行。</p>
              </div>
            </div>
            <label class="setting-row">
              <span>
                <strong>图片并发数</strong>
                <small>1–16 张；过高可能触发站点限流。</small>
              </span>
              <input
                v-model.number="draft.parallelImages"
                class="input number-input"
                type="number"
                min="1"
                max="16"
                aria-label="图片并发数"
              />
            </label>
            <div class="setting-row">
              <span>
                <strong>章节间等待</strong>
                <small>每章完成后随机等待一会儿，再下载下一章。</small>
              </span>
              <div class="number-range">
                <input
                  v-model.number="draft.chapterDelayMin"
                  class="input number-input"
                  type="number"
                  min="0"
                  max="300"
                  aria-label="最短等待秒数"
                />
                <span>至</span>
                <input
                  v-model.number="draft.chapterDelayMax"
                  class="input number-input"
                  type="number"
                  min="0"
                  max="300"
                  aria-label="最长等待秒数"
                />
                <span>秒</span>
              </div>
            </div>
          </section>
          <section class="setting-group">
            <div class="setting-title">
              <AppIcon name="book" />
              <div>
                <h2>PDF 导出</h2>
                <p>把一章整理成一本小册子，方便分享或收藏。</p>
              </div>
            </div>
            <label class="setting-row">
              <span>
                <strong>下载后自动导出 PDF</strong>
                <small>只有图片完整下载的章节才会自动导出。</small>
              </span>
              <input
                v-model="draft.exportPdfAfterDownload"
                class="switch"
                type="checkbox"
                role="switch"
                aria-label="下载后自动导出 PDF"
              />
            </label>
            <label class="setting-row">
              <span>
                <strong>PDF 阅读密码</strong>
                <small>留空则不加密；使用标准 AES-128 加密。</small>
              </span>
              <input
                v-model="draft.pdfPassword"
                class="input password-input"
                type="password"
                autocomplete="new-password"
                placeholder="不设置密码"
                aria-label="PDF 阅读密码"
              />
            </label>
          </section>
          <section class="setting-group">
            <div class="setting-title">
              <AppIcon name="heart" />
              <div>
                <h2>下一章的期待</h2>
                <p>定时追更只检查订阅作品，按各自的单次上限下载。</p>
              </div>
            </div>
            <label class="setting-row">
              <span>
                <strong>启动时检查追更</strong>
                <small>队列空闲时，查看订阅作品是否有新章节。</small>
              </span>
              <input
                v-model="draft.checkSubscriptionsOnLaunch"
                class="switch"
                type="checkbox"
                role="switch"
                aria-label="启动时检查追更"
              />
            </label>
            <label class="setting-row">
              <span>
                <strong>定时检查间隔</strong>
                <small>0 表示关闭定时检查。</small>
              </span>
              <div class="number-range">
                <input
                  v-model.number="draft.subscriptionIntervalHours"
                  class="input number-input"
                  type="number"
                  min="0"
                  max="168"
                  aria-label="追更检查间隔"
                />
                小时
              </div>
            </label>
          </section>
        </template>
        <template v-else-if="active === 'network'">
          <section class="setting-group">
            <div class="setting-title">
              <AppIcon name="network" />
              <div>
                <h2>网络连接</h2>
                <p>漫画请求、图片和软件更新使用同一套代理偏好，保存后生效。</p>
              </div>
            </div>
            <label class="setting-row">
              <span>
                <strong>连接方式</strong>
                <small>根据本机网络选择直连、系统代理或自定义代理。</small>
              </span>
              <select v-model="draft.proxyMode" class="input" aria-label="代理模式">
                <option value="system">系统代理</option>
                <option value="direct">直接连接</option>
                <option value="custom">自定义代理</option>
              </select>
            </label>
            <label v-if="draft.proxyMode === 'custom'" class="setting-row">
              <span>
                <strong>代理地址</strong>
                <small>支持 HTTP、HTTPS 和 SOCKS5。</small>
              </span>
              <input
                v-model="draft.proxyUrl"
                class="input proxy-input"
                placeholder="http://127.0.0.1:7890"
                aria-label="代理地址"
              />
            </label>
          </section>
          <section class="setting-group">
            <div class="setting-title">
              <AppIcon name="folder" />
              <div>
                <h2>书库与存储</h2>
                <p>给喜欢的故事，安排一个固定的位置。</p>
              </div>
            </div>
            <div class="setting-row">
              <span>
                <strong>漫画下载目录</strong>
                <small>切换后显示新目录中的下载，已有文件不会移动。</small>
              </span>
              <button class="btn btn-secondary btn-sm" @click="directory">选择目录</button>
            </div>
            <code class="directory-path">{{ draft.downloadDirectory }}</code>
            <button
              class="text-btn folder-link"
              @click="app.run(() => api.openLocation('downloads'))"
            >
              打开当前下载目录
              <AppIcon name="chevron-right" :size="14" />
            </button>
            <label class="setting-row">
              <span>
                <strong>封面缓存上限</strong>
                <small>超出上限后优先清理较早浏览的缓存。</small>
              </span>
              <div class="number-range">
                <input
                  v-model.number="draft.imageCacheLimitMb"
                  class="input number-input"
                  type="number"
                  min="16"
                  max="8192"
                  aria-label="封面缓存上限"
                />
                MB
              </div>
            </label>
            <div class="setting-row">
              <span>
                <strong>清理浏览缓存</strong>
                <small>已下载的漫画和阅读进度会保留。</small>
              </span>
              <button class="btn btn-secondary btn-sm" @click="clearCache">清空缓存</button>
            </div>
            <div class="setting-row">
              <span>
                <strong>应用数据</strong>
                <small>设置、订阅、下载记录和阅读进度保存在本机。</small>
              </span>
              <button
                class="btn btn-secondary btn-sm"
                @click="app.run(() => api.openLocation('data'))"
              >
                打开数据目录
              </button>
            </div>
          </section>
        </template>
        <template v-else>
          <AppUpdates />
          <section class="setting-group">
            <label class="setting-row">
              <span>
                <strong>启动时检查软件更新</strong>
                <small>只提示正式版本，下载与安装均由你决定。</small>
              </span>
              <input
                v-model="draft.checkUpdatesOnLaunch"
                class="switch"
                type="checkbox"
                role="switch"
                aria-label="启动时检查软件更新"
              />
            </label>
          </section>
          <div class="settings-about">
            <img src="/brand.svg" alt="CopyCopy" />
            <strong>CopyCopy</strong>
            <span>让好故事，留在身边。</span>
            <small>v{{ version }}</small>
          </div>
        </template>
      </div>
    </div>
    <footer class="settings-savebar">
      <span :class="{ changed: dirty }">
        <i />
        {{ dirty ? '有未保存的偏好' : '所有偏好已保存' }}
      </span>
      <div>
        <button class="btn btn-secondary" :disabled="!dirty || saving" @click="reset">
          还原更改
        </button>
        <button class="btn btn-primary" :disabled="!dirty || saving" @click="save">
          {{ saving ? '保存中…' : '保存偏好' }}
        </button>
      </div>
    </footer>
  </div>
</template>
