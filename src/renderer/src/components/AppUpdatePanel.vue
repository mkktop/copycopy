<script setup lang="ts">
import { computed } from 'vue'
import { NAlert, NButton, NCard, NIcon, NProgress, NTag } from 'naive-ui'
import { ArrowUpCircleOutline, OpenOutline } from '@vicons/ionicons5'
import { useUpdateStore } from '../stores/update'

const update = useUpdateStore()
const version = __APP_VERSION__
const state = computed(() => update.state)
const busy = computed(() =>
  ['checking', 'downloading', 'installing'].includes(state.value?.status || '')
)
const title = computed(() => {
  switch (state.value?.status) {
    case 'checking':
      return '正在检查新版本'
    case 'available':
      return `发现新版本 ${state.value.release?.version}`
    case 'not-available':
      return '当前已是最新版本'
    case 'downloading':
      return '正在下载升级包'
    case 'downloaded':
      return '升级包已就绪'
    case 'installing':
      return '正在启动安装程序'
    case 'error':
      return '升级暂未完成'
    default:
      return '让 CopyCopy 保持最新'
  }
})
const canDownload = computed(
  () =>
    state.value?.mode === 'installer' &&
    !!state.value.release &&
    ['available', 'error'].includes(state.value.status)
)
const modeLabel = computed(
  () =>
    ({
      installer: 'Windows 安装版',
      portable: 'Windows 便携版',
      manual: '手动安装',
      development: '开发环境'
    })[state.value?.mode || 'development']
)
function bytes(value: number): string {
  return value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(value / 1024)} KB`
}
function date(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString('zh-CN')
}
</script>

<template>
  <NCard size="small" class="app-update" data-app-update>
    <div class="update-heading">
      <span class="update-icon"><NIcon :component="ArrowUpCircleOutline" :size="30" /></span>
      <div>
        <span class="eyebrow">程序升级</span>
        <h2 data-update-title>{{ title }}</h2>
        <p>
          当前版本 {{ state?.currentVersion || version }}
          <span class="update-dot">·</span>
          {{ modeLabel }}
        </p>
      </div>
    </div>

    <p v-if="state?.mode === 'installer'" class="update-description">
      下载完成并校验通过后，由你决定何时重启安装。退出应用不会自动安装。
    </p>
    <p v-else-if="state?.mode === 'portable'" class="update-description">
      便携版可检查新版本。升级时打开发布页下载新版，退出应用后替换程序，保留原有数据目录。
    </p>
    <p v-else-if="state?.mode === 'development'" class="update-description">
      开发环境不执行程序升级。请使用正式发行版本，或打开发布页下载安装。
    </p>
    <p v-else class="update-description">从官方发布页获取适合当前系统的新版本。</p>

    <div v-if="state?.status === 'downloading'" class="update-progress" aria-live="polite">
      <NProgress type="line" :percentage="Math.floor(state.progress?.percent || 0)" />
      <p v-if="state.progress" class="muted">
        {{ bytes(state.progress.transferred) }} / {{ bytes(state.progress.total) }}
        <span>{{ bytes(state.progress.bytesPerSecond) }}/s</span>
      </p>
      <p v-else class="muted">正在连接下载服务器…</p>
    </div>
    <NAlert v-if="state?.error || update.actionError" type="warning" :bordered="false" role="alert">
      {{ update.actionError || state?.error }}
    </NAlert>
    <NAlert v-if="state?.status === 'downloaded'" type="success" :bordered="false">
      安装将退出并重启 CopyCopy，请先完成正在进行的任务。
    </NAlert>

    <div class="update-actions">
      <NButton
        v-if="state?.status === 'downloaded' || state?.status === 'installing'"
        type="primary"
        :loading="state.status === 'installing'"
        data-update-install
        @click="update.install"
      >
        重启并安装
      </NButton>
      <NButton v-else-if="canDownload" type="primary" data-update-download @click="update.download">
        {{ state?.status === 'error' ? '重新下载升级包' : '下载升级包' }}
      </NButton>
      <NButton
        v-else-if="state?.release && state.mode !== 'installer'"
        type="primary"
        data-update-manual
        @click="update.openRelease"
      >
        下载新版本
      </NButton>
      <NButton
        :loading="state?.status === 'checking'"
        :disabled="!state || busy || state.mode === 'development' || state.status === 'downloaded'"
        :type="state?.release ? 'default' : 'primary'"
        data-update-check
        @click="update.check"
      >
        {{ state?.status === 'error' && !state.release ? '重试检查' : '检查程序更新' }}
      </NButton>
      <NButton quaternary data-update-release @click="update.openRelease">
        <template #icon><NIcon :component="OpenOutline" /></template>
        发布页
      </NButton>
    </div>
    <p v-if="state?.checkedAt" class="update-checked muted">
      上次成功检查：{{ date(state.checkedAt) }}
    </p>

    <div v-if="state?.release" class="update-release">
      <div class="release-heading">
        <h3>更新说明</h3>
        <NTag size="small" :bordered="false" type="info">v{{ state.release.version }}</NTag>
        <span v-if="state.release.publishedAt" class="muted">
          {{ date(state.release.publishedAt) }}
        </span>
      </div>
      <pre>{{ state.release.notes || '此版本未提供更新说明，请前往发布页查看详情。' }}</pre>
    </div>
  </NCard>
</template>

<style scoped>
.update-heading {
  display: flex;
  align-items: center;
  gap: 18px;
}
.update-icon {
  display: grid;
  place-items: center;
  width: 62px;
  height: 62px;
  border-radius: 18px;
  color: var(--c-accent);
  background: var(--c-accent-soft);
  flex-shrink: 0;
}
h2 {
  margin: 5px 0 6px;
  font-size: 21px;
  letter-spacing: -0.5px;
}
.update-heading p {
  margin: 0;
  color: var(--c-text-2);
}
.update-dot {
  margin: 0 6px;
}
.update-description {
  color: var(--c-text-2);
  line-height: 1.8;
  margin: 22px 0;
}
.update-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 22px;
}
.update-progress {
  margin: 22px 0;
}
.update-progress p {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}
.update-checked {
  margin: 14px 0 0;
  font-size: 12px;
}
.update-release {
  border-top: 1px solid var(--c-border);
  margin-top: 26px;
  padding-top: 20px;
}
.release-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.release-heading h3 {
  margin: 0;
  font-size: 14px;
}
.release-heading > span:last-child {
  font-size: 12px;
}
pre {
  margin: 16px 0 0;
  max-height: 300px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  line-height: 1.8;
  color: var(--c-text-2);
}
</style>
