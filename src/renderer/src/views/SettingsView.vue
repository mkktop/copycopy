<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute } from 'vue-router'
import {
  NAlert,
  NButton,
  NCard,
  NIcon,
  NInput,
  NInputNumber,
  NSelect,
  NSwitch,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui'
import {
  ColorPaletteOutline,
  ArrowUpCircleOutline,
  CloudDownloadOutline,
  SparklesOutline,
  FolderOpenOutline,
  CheckmarkOutline,
  DesktopOutline,
  SunnyOutline,
  MoonOutline
} from '@vicons/ionicons5'
import type { AppConfig } from '@shared/types'
import { useAppStore } from '../stores/app'
import { usePreferencesStore, type Appearance } from '../stores/preferences'
import PageHeader from '../components/PageHeader.vue'
import SettingRow from '../components/SettingRow.vue'
import EmptyState from '../components/EmptyState.vue'
import AppUpdatePanel from '../components/AppUpdatePanel.vue'

const app = useAppStore()
const preferences = usePreferencesStore()
const route = useRoute()
const message = useMessage()
const dialog = useDialog()
const version = __APP_VERSION__
const g = ref<AppConfig['global'] | null>(null)
const snapshot = ref('')
const error = ref('')
const saving = ref(false)
const apiKey = ref('')
const hasSavedKey = ref(false)
const testing = ref(false)
const modelOptions = ref([{ label: 'MiniMax-M3', value: 'MiniMax-M3' }])
const proxyUrl = ref('')
const activeProxy = ref<string | null>(null)
const proxyBusy = ref(false)
const categories = [
  { key: 'updates', title: '程序升级', icon: ArrowUpCircleOutline, description: '版本检查与安装' },
  {
    key: 'general',
    title: '通用与外观',
    icon: ColorPaletteOutline,
    description: '外观、通知与自动追更'
  },
  {
    key: 'download',
    title: '下载与导出',
    icon: CloudDownloadOutline,
    description: '下载速度与 PDF 偏好'
  },
  {
    key: 'ai',
    title: 'AI 广告整理',
    icon: SparklesOutline,
    description: '连接模型，整理首尾广告'
  },
  {
    key: 'storage',
    title: '网络与数据',
    icon: FolderOpenOutline,
    description: '代理连接与本地目录'
  }
]
const activeTab = ref('general')
watch(
  () => route.query.tab,
  (tab) => {
    if (typeof tab === 'string' && categories.some((category) => category.key === tab))
      activeTab.value = tab
  },
  { immediate: true }
)
const dirty = computed(
  () => !!g.value && (JSON.stringify(g.value) !== snapshot.value || apiKey.value.length > 0)
)
const appearanceOptions: Array<{
  value: Appearance
  label: string
  icon: typeof DesktopOutline
}> = [
  { value: 'system', label: '跟随系统', icon: DesktopOutline },
  { value: 'light', label: '浅色模式', icon: SunnyOutline },
  { value: 'dark', label: '深色模式', icon: MoonOutline }
]
function copyDraft(): void {
  g.value = app.config ? { ...app.config.global } : null
  snapshot.value = JSON.stringify(g.value)
  apiKey.value = ''
}
async function loadAi(): Promise<void> {
  const [status, models] = await Promise.all([window.mkk.aiStatus(), window.mkk.aiModels()])
  hasSavedKey.value = status.hasKey
  if (models.length)
    modelOptions.value = models.map((model) => ({
      label: model,
      value: model
    }))
}
async function load(): Promise<void> {
  error.value = ''
  try {
    await app.loadConfig()
    copyDraft()
    const results = await Promise.allSettled([loadAi(), window.mkk.proxyGet(), app.loadPaths()])
    const proxy = results[1]
    if (proxy.status === 'fulfilled') {
      activeProxy.value = proxy.value
      proxyUrl.value = proxy.value || ''
    }
    if (results.some((result) => result.status === 'rejected'))
      message.warning('部分辅助信息加载失败，其他设置仍可使用')
  } catch (cause) {
    error.value = String(cause)
  }
}
function validate(): boolean {
  if (!g.value) return false
  const fields: Array<[string, number, number, number]> = [
    ['下载并发数', g.value.concurrency, 1, 16],
    ['最短等待时间', g.value.chapter_delay_min, 0, 300],
    ['最长等待时间', g.value.chapter_delay_max, 0, 300],
    ['检查间隔', g.value.auto_check_interval_hours, 0, 168],
    ['首部检查页数', g.value.ai_head_pages, 0, 3],
    ['尾部检查页数', g.value.ai_tail_pages, 0, 3],
    ['连续广告上限', g.value.ai_max_ad_pages, 1, 6],
    ['AI 并发数', g.value.ai_concurrency, 1, 5]
  ]
  for (const [label, value, min, max] of fields) {
    if (!Number.isInteger(value) || value < min || value > max) {
      message.warning(`${label}应为 ${min} 到 ${max} 之间的整数`)
      return false
    }
  }
  if (g.value.chapter_delay_min > g.value.chapter_delay_max) {
    message.warning('最短等待时间不能大于最长等待时间')
    activeTab.value = 'download'
    return false
  }
  if (g.value.ai_enabled && !hasSavedKey.value && !apiKey.value.trim()) {
    message.warning('启用 AI 整理前，请先填写 API Key')
    activeTab.value = 'ai'
    return false
  }
  if (g.value.ai_enabled && g.value.ai_head_pages + g.value.ai_tail_pages === 0) {
    message.warning('请至少检查一页首部或尾部内容')
    activeTab.value = 'ai'
    return false
  }
  return true
}
async function save(): Promise<boolean> {
  if (!g.value || saving.value || !validate()) return false
  saving.value = true
  try {
    const suppliedKey = !!apiKey.value.trim()
    await app.saveGlobal({
      ...g.value,
      pdf_password: g.value.pdf_password || null,
      ai_auto_detect: g.value.ai_enabled ? g.value.ai_auto_detect : 0,
      ...(apiKey.value.trim() ? { ai_api_key: apiKey.value.trim() } : {})
    })
    copyDraft()
    if (suppliedKey) hasSavedKey.value = true
    message.success('偏好设置已保存')
    return true
  } catch (cause) {
    message.error('保存失败：' + String(cause))
    return false
  } finally {
    saving.value = false
  }
}
async function testAi(): Promise<void> {
  if (!g.value) return
  if (!apiKey.value.trim() && !hasSavedKey.value) {
    message.info('请先填写 API Key')
    return
  }
  testing.value = true
  try {
    const result = await window.mkk.aiTest({
      baseUrl: g.value.ai_base_url,
      model: g.value.ai_model,
      useSavedKey: !apiKey.value.trim(),
      ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {})
    })
    if (result.ok) message.success(result.message)
    else message.error(result.message)
  } catch (cause) {
    message.error('连接失败：' + String(cause))
  } finally {
    testing.value = false
  }
}
async function applyProxy(value: string | null): Promise<void> {
  proxyBusy.value = true
  try {
    activeProxy.value = await window.mkk.proxySet(value)
    proxyUrl.value = activeProxy.value || ''
    message.success(value ? '代理已生效' : '已切换为直接连接')
  } catch (cause) {
    message.error('代理设置失败：' + String(cause))
  } finally {
    proxyBusy.value = false
  }
}
async function copyPath(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    message.success('已复制目录路径')
  } catch {
    message.error('复制失败，请手动选中路径复制')
  }
}
async function openPath(value: string): Promise<void> {
  try {
    const result = await window.mkk.openPath(value)
    if (result) message.error(result)
  } catch (cause) {
    message.error(String(cause))
  }
}
onBeforeRouteLeave(() => {
  if (!dirty.value) return true
  return new Promise<boolean>((resolve) => {
    dialog.warning({
      title: '还有未保存的设置',
      content: '保存这次修改后再离开，或者放弃修改。',
      positiveText: '保存并离开',
      negativeText: '放弃修改',
      onPositiveClick: async () => {
        const ok = await save()
        if (ok) resolve(true)
        return ok
      },
      onNegativeClick: () => resolve(true),
      onClose: () => resolve(false),
      onMaskClick: () => resolve(false),
      onEsc: () => resolve(false)
    })
  })
})
onMounted(load)
</script>

<template>
  <div class="page settings-page">
    <div class="content-width">
      <PageHeader
        title="偏好设置"
        description="调整到顺手的样子，让 CopyCopy 配合你的习惯。"
        eyebrow="MAKE YOURSELF AT HOME"
      >
        <NTag :bordered="false" size="small">CopyCopy v{{ version }}</NTag>
      </PageHeader>
      <EmptyState v-if="error" title="设置加载失败" :description="error">
        <NButton @click="load">重新加载</NButton>
      </EmptyState>
      <template v-else-if="g">
        <div class="settings-layout">
          <nav class="settings-nav" aria-label="设置分类">
            <button
              v-for="category in categories"
              :key="category.key"
              type="button"
              :class="{ selected: activeTab === category.key }"
              :aria-current="activeTab === category.key ? 'true' : undefined"
              @click="activeTab = category.key"
            >
              <NIcon :component="category.icon" :size="18" />
              <span>{{ category.title }}</span>
            </button>
          </nav>
          <div class="settings-panels">
            <section v-if="activeTab === 'updates'" aria-label="程序升级">
              <AppUpdatePanel />
              <NCard title="升级偏好" size="small">
                <SettingRow
                  title="启动时检查程序更新"
                  description="启动后检查正式版本，发现新版时在顶部提示。下载和安装都由你手动开始。"
                >
                  <NSwitch
                    v-model:value="g.app_update_check_on_launch"
                    :checked-value="1"
                    :unchecked-value="0"
                    data-update-auto
                  />
                </SettingRow>
              </NCard>
            </section>
            <section v-if="activeTab === 'general'" aria-label="通用与外观">
              <NCard title="外观" size="small">
                <p class="card-description">选一个舒服的阅读工作台，修改立即生效。</p>
                <div class="appearance-options">
                  <button
                    v-for="option in appearanceOptions"
                    :key="option.value"
                    type="button"
                    :class="{
                      selected: preferences.appearance === option.value
                    }"
                    :aria-pressed="preferences.appearance === option.value"
                    @click="preferences.appearance = option.value"
                  >
                    <div class="appearance-preview" :class="option.value">
                      <span />
                      <span>
                        <i />
                        <i />
                        <i />
                      </span>
                    </div>
                    <span>
                      <NIcon :component="option.icon" :size="15" />
                      {{ option.label }}
                      <NIcon
                        v-if="preferences.appearance === option.value"
                        :component="CheckmarkOutline"
                        :size="14"
                        class="appearance-check"
                      />
                    </span>
                  </button>
                </div>
              </NCard>
              <NCard title="通知与追更" size="small">
                <SettingRow
                  title="下载完成通知"
                  description="队列完成后显示系统通知，点击即可查看下载。"
                >
                  <NSwitch
                    v-model:value="g.notify_on_done"
                    :checked-value="1"
                    :unchecked-value="0"
                    aria-label="下载完成通知"
                  />
                </SettingRow>
                <SettingRow
                  title="启动时检查追更"
                  description="打开应用后，自动检查订阅漫画的新章节。"
                >
                  <NSwitch
                    v-model:value="g.auto_check_on_launch"
                    :checked-value="1"
                    :unchecked-value="0"
                    aria-label="启动时检查追更"
                  />
                </SettingRow>
                <SettingRow
                  title="定时检查间隔"
                  description="应用运行期间生效。设为 0 则只手动检查。"
                >
                  <NInputNumber
                    v-model:value="g.auto_check_interval_hours"
                    :min="0"
                    :max="168"
                    aria-label="自动检查间隔"
                  />
                  <span>小时</span>
                </SettingRow>
                <SettingRow
                  title="默认搜索范围"
                  description="每次进入发现页时使用，也能在搜索栏临时调整。"
                >
                  <NSelect
                    v-model:value="g.search_type"
                    :options="[
                      { label: '全部', value: '' },
                      { label: '漫画名称', value: 'name' },
                      { label: '作者', value: 'author' }
                    ]"
                    aria-label="默认搜索范围"
                  />
                </SettingRow>
              </NCard>
            </section>
            <section v-if="activeTab === 'download'" aria-label="下载与导出">
              <NCard title="下载策略" size="small">
                <SettingRow
                  title="图片并发数"
                  description="同时下载的图片数量。建议保持在 5，兼顾速度与稳定。"
                >
                  <NInputNumber
                    v-model:value="g.concurrency"
                    :min="1"
                    :max="16"
                    aria-label="图片并发数"
                  />
                </SettingRow>
                <SettingRow
                  title="章节间等待"
                  description="每章结束后随机等待，减少被站点限流的情况。"
                >
                  <NInputNumber
                    v-model:value="g.chapter_delay_min"
                    :min="0"
                    :max="300"
                    aria-label="最短等待秒数"
                  />
                  <span>至</span>
                  <NInputNumber
                    v-model:value="g.chapter_delay_max"
                    :min="0"
                    :max="300"
                    aria-label="最长等待秒数"
                  />
                  <span>秒</span>
                </SettingRow>
              </NCard>
              <NCard title="PDF 导出" size="small">
                <SettingRow
                  title="下载后自动生成 PDF"
                  description="每章下载完成后生成 PDF。关闭后仍可从书架手动导出。"
                >
                  <NSwitch
                    v-model:value="g.pdf_switch"
                    :checked-value="1"
                    :unchecked-value="0"
                    aria-label="自动生成 PDF"
                  />
                </SettingRow>
                <SettingRow
                  title="默认 PDF 密码"
                  description="留空则不加密。手动导出时也可以单独设置。"
                  wide
                >
                  <NInput
                    v-model:value="g.pdf_password"
                    type="password"
                    show-password-on="click"
                    placeholder="不设置密码"
                    clearable
                    aria-label="默认 PDF 密码"
                  />
                </SettingRow>
              </NCard>
            </section>
            <section v-if="activeTab === 'ai'" aria-label="AI 广告整理">
              <NCard title="AI 广告整理" size="small">
                <template #header-extra>
                  <NTag size="small" :bordered="false" :type="hasSavedKey ? 'success' : 'default'">
                    {{ hasSavedKey ? '已配置连接' : '等待配置' }}
                  </NTag>
                </template>
                <p class="card-description">
                  识别每章首尾的推广页面，归档后阅读和导出时自动跳过。可在章节中撤销归档。
                </p>
                <NAlert type="info" :bordered="false" style="margin: 16px 0 4px">
                  检测会将选中的首尾页发送到配置的 AI 服务，可能产生 API
                  费用。归档的图片仍保留在本机。
                </NAlert>
                <SettingRow
                  title="启用 AI 整理"
                  description="配置连接后，可从书架中的漫画发起检测。"
                >
                  <NSwitch
                    v-model:value="g.ai_enabled"
                    :checked-value="1"
                    :unchecked-value="0"
                    aria-label="启用 AI 整理"
                  />
                </SettingRow>
                <SettingRow
                  title="下载后自动检测"
                  description="每章下载完成后检测，再按设置生成 PDF。"
                >
                  <NSwitch
                    v-model:value="g.ai_auto_detect"
                    :checked-value="1"
                    :unchecked-value="0"
                    :disabled="!g.ai_enabled"
                    aria-label="下载后自动检测"
                  />
                </SettingRow>
                <SettingRow
                  title="API Key"
                  description="使用系统凭据加密保存。留空表示沿用已保存的 Key。"
                  wide
                >
                  <NInput
                    v-model:value="apiKey"
                    type="password"
                    show-password-on="click"
                    :placeholder="hasSavedKey ? '已保存，留空不修改' : '输入你的 API Key'"
                    clearable
                    aria-label="AI API Key"
                  />
                  <NButton :loading="testing" @click="testAi">测试连接</NButton>
                </SettingRow>
                <SettingRow title="模型" description="请使用与当前 API Key 账户匹配的模型。" wide>
                  <NSelect
                    v-model:value="g.ai_model"
                    :options="modelOptions"
                    aria-label="AI 模型"
                  />
                </SettingRow>
                <details class="advanced">
                  <summary>检测范围与高级选项</summary>
                  <SettingRow
                    title="检查首尾页数"
                    description="只检查章节的开头与结尾，不扫描中间内容。"
                  >
                    <NInputNumber
                      v-model:value="g.ai_head_pages"
                      :min="0"
                      :max="3"
                      aria-label="首部检查页数"
                    />
                    <span>+</span>
                    <NInputNumber
                      v-model:value="g.ai_tail_pages"
                      :min="0"
                      :max="3"
                      aria-label="尾部检查页数"
                    />
                    <span>页</span>
                  </SettingRow>
                  <SettingRow
                    title="连续广告上限"
                    description="发现连续广告时，每侧最多继续检查的页数。"
                  >
                    <NInputNumber
                      v-model:value="g.ai_max_ad_pages"
                      :min="1"
                      :max="6"
                      aria-label="连续广告上限"
                    />
                    <span>页 / 侧</span>
                  </SettingRow>
                  <SettingRow
                    title="同时检测章节数"
                    description="建议 3 个；过高可能触发接口限流。保存后用于新批次。"
                  >
                    <NInputNumber
                      v-model:value="g.ai_concurrency"
                      :min="1"
                      :max="5"
                      aria-label="AI 并发数"
                    />
                  </SettingRow>
                  <SettingRow title="识别置信度" description="阈值越高，归档判断越保守。">
                    <NInputNumber
                      :value="Math.round(g.ai_threshold * 100)"
                      :min="1"
                      :max="100"
                      aria-label="广告置信度百分比"
                      @update:value="
                        (value) => {
                          if (g) g.ai_threshold = (value ?? 80) / 100
                        }
                      "
                    />
                    <span>%</span>
                  </SettingRow>
                  <SettingRow
                    title="服务地址"
                    description="国内站使用 api.minimaxi.com，国际站的 Key 不通用。"
                    wide
                  >
                    <NInput
                      v-model:value="g.ai_base_url"
                      placeholder="https://api.minimaxi.com/v1"
                      aria-label="AI 服务地址"
                    />
                  </SettingRow>
                </details>
              </NCard>
            </section>
            <section v-if="activeTab === 'storage'" aria-label="网络与数据">
              <NCard title="网络代理" size="small">
                <template #header-extra>
                  <NTag size="small" :bordered="false" :type="activeProxy ? 'success' : 'default'">
                    {{ activeProxy ? '代理已启用' : '直接连接' }}
                  </NTag>
                </template>
                <p class="card-description">
                  代理修改立即生效。启动时会自动检测 Windows 系统代理。
                </p>
                <SettingRow
                  title="HTTP 代理地址"
                  description="例如 http://127.0.0.1:7897。关闭代理后恢复直连。"
                  wide
                >
                  <NInput
                    v-model:value="proxyUrl"
                    placeholder="http://127.0.0.1:7897"
                    clearable
                    aria-label="HTTP 代理地址"
                    @keyup.enter="applyProxy(proxyUrl.trim() || null)"
                  />
                  <NButton :loading="proxyBusy" @click="applyProxy(proxyUrl.trim() || null)">
                    应用代理
                  </NButton>
                  <NButton
                    :disabled="!activeProxy || proxyBusy"
                    quaternary
                    @click="applyProxy(null)"
                  >
                    关闭
                  </NButton>
                </SettingRow>
              </NCard>
              <NCard title="本地数据" size="small">
                <p class="card-description">
                  漫画与配置保存在本机。迁移前请先退出应用，再完整复制数据目录。
                </p>
                <div
                  v-for="path in [
                    { label: '下载目录', value: app.paths?.out },
                    { label: '配置文件', value: app.paths?.config },
                    { label: '日志目录', value: app.paths?.logs }
                  ]"
                  :key="path.label"
                  class="path-row"
                >
                  <span>{{ path.label }}</span>
                  <code :title="path.value">{{ path.value || '暂不可用' }}</code>
                  <NButton
                    size="small"
                    quaternary
                    :disabled="!path.value"
                    @click="copyPath(path.value!)"
                  >
                    复制
                  </NButton>
                  <NButton
                    size="small"
                    quaternary
                    :disabled="!path.value"
                    @click="openPath(path.value!)"
                  >
                    打开
                  </NButton>
                </div>
              </NCard>
            </section>
          </div>
        </div>
        <footer class="savebar surface">
          <span :class="{ 'savebar-dirty': dirty }">
            <span class="save-dot" />
            {{ dirty ? '有未保存的设置' : '所有设置已保存' }}
          </span>
          <div>
            <NButton :disabled="!dirty || saving" quaternary @click="copyDraft">还原更改</NButton>
            <NButton type="primary" :loading="saving" :disabled="!dirty" @click="save">
              保存设置
            </NButton>
          </div>
        </footer>
      </template>
      <div v-else class="empty">正在加载偏好设置…</div>
    </div>
  </div>
</template>

<style scoped>
.settings-page > .content-width {
  max-width: 1140px;
  min-height: 100%;
  display: flex;
  flex-direction: column;
}
.settings-layout {
  display: grid;
  grid-template-columns: 155px minmax(0, 1fr);
  gap: 26px;
  flex: 1;
  align-items: start;
}
.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
  position: sticky;
  top: 0;
}
.settings-nav button {
  display: flex;
  align-items: center;
  gap: 11px;
  border: 0;
  padding: 12px 14px;
  border-radius: 8px;
  background: transparent;
  color: var(--c-text-2);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.settings-nav button.selected {
  background: var(--c-accent-soft);
  color: var(--c-accent);
  font-weight: 600;
}
.settings-nav button:hover {
  background: var(--c-accent-soft);
}
.settings-panels {
  min-width: 0;
}
.settings-panels section {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.settings-panels :deep(.n-card__content) {
  padding-top: 0;
}
.card-description {
  font-size: 11px;
  color: var(--c-text-3);
  line-height: 1.9;
  margin: 0;
}
.appearance-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin-top: 20px;
}
.appearance-options > button {
  border: 1px solid var(--c-border);
  border-radius: 9px;
  background: transparent;
  padding: 7px;
  cursor: pointer;
  min-width: 0;
}
.appearance-options > button.selected {
  border-color: var(--c-accent);
  box-shadow: 0 0 0 2px var(--c-accent-soft);
}
.appearance-options > button > span {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 4px 3px;
  font-size: 10px;
}
.appearance-check {
  margin-left: auto;
  color: var(--c-accent);
}
.appearance-preview {
  display: flex;
  height: 64px;
  gap: 7px;
  padding: 9px;
  border-radius: 5px;
  background: #eef0f5;
}
.appearance-preview > span:first-child {
  width: 22%;
  background: #fff;
  border-radius: 3px;
}
.appearance-preview > span:last-child {
  display: flex;
  gap: 4px;
  flex: 1;
  align-items: flex-end;
  padding-bottom: 6px;
}
.appearance-preview i {
  display: block;
  height: 70%;
  flex: 1;
  background: #d7d2ef;
  border-radius: 2px;
}
.appearance-preview.dark {
  background: #252939;
}
.appearance-preview.dark > span:first-child {
  background: #42465c;
}
.appearance-preview.dark i {
  background: #73688f;
}
.appearance-preview.system {
  background: linear-gradient(110deg, #eef0f5 50%, #252939 50%);
}
.advanced {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--c-border);
}
.advanced > summary {
  font-size: 12px;
  color: var(--c-text-2);
  cursor: pointer;
  padding: 4px 0;
}
.path-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 0;
  border-bottom: 1px solid var(--c-border);
  font-size: 11px;
}
.path-row:last-child {
  border: 0;
}
.path-row > span {
  white-space: nowrap;
}
.path-row code {
  min-width: 0;
  flex: 1;
  overflow-wrap: anywhere;
  color: var(--c-text-3);
  font-size: 10px;
}
.savebar {
  position: sticky;
  bottom: -40px;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 20px;
  margin: 26px 0 0 181px;
  border-radius: 10px;
  box-shadow: 0 -4px 20px #00000006;
}
.savebar > span {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  color: var(--c-text-3);
}
.savebar > div {
  display: flex;
  gap: 10px;
}
.save-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--c-success);
}
.savebar-dirty .save-dot {
  background: var(--c-warn-fg);
}
.savebar > .savebar-dirty {
  color: var(--c-warn-fg);
}
@media (max-width: 1050px) {
  .settings-layout {
    grid-template-columns: 130px minmax(0, 1fr);
    gap: 18px;
  }
  .settings-nav button {
    padding: 12px 9px;
    gap: 8px;
    font-size: 11px;
  }
  .savebar {
    margin-left: 148px;
    bottom: -24px;
  }
  .appearance-options {
    gap: 8px;
  }
}
</style>
