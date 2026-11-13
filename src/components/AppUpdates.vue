<script setup lang="ts">
import { computed, onMounted } from 'vue'
import AppIcon from './AppIcon.vue'
import { useUpdateStore } from '../stores/updates'
import { useAppStore } from '../stores/app'
import { useDownloadStore } from '../stores/downloads'

const updates = useUpdateStore()
const app = useAppStore()
const downloads = useDownloadStore()
const macInstaller = computed(() => updates.result?.installer_kind === 'macos')
// 安装会退出客户端：队列忙时实时禁用，并要求二次确认。
const installDisabled = computed(() => updates.busy || downloads.busy)
async function install() {
  if (installDisabled.value) return
  const ok = await app.confirm(
    '退出并安装更新？',
    '安装程序会关闭当前客户端，请确认漫画下载已全部结束，书库与阅读进度会保留。',
    '退出并安装',
    true
  )
  if (ok) await updates.install()
}
onMounted(() => updates.loadVersion())
const publishedDate = computed(() => {
  const date = new Date(updates.result?.published_at || '')
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN')
})
function megabytes(bytes: number) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}
</script>

<template>
  <section
    class="setting-group app-updates"
    aria-labelledby="updates-title"
    :aria-busy="updates.busy"
  >
    <div class="setting-title">
      <AppIcon name="refresh" />
      <div>
        <h2 id="updates-title">软件更新</h2>
        <p>检查并安装 CopyCopy 的最新正式版本</p>
      </div>
    </div>
    <div class="setting-row">
      <div>
        <strong>
          当前版本 {{ updates.currentVersion ? 'v' + updates.currentVersion : '读取中…' }}
        </strong>
        <p>检查与下载使用「网络连接」中的代理设置。</p>
      </div>
      <button class="btn btn-secondary btn-sm" :disabled="updates.busy" @click="updates.check">
        <AppIcon name="refresh" :size="14" />
        {{ updates.phase === 'checking' ? '检查中…' : '检查更新' }}
      </button>
    </div>
    <p v-if="updates.message" role="status" class="setting-message update-message">
      {{ updates.message }}
    </p>
    <div v-if="updates.result?.status === 'available'" class="update-details">
      <p v-if="publishedDate" class="hint">发布时间：{{ publishedDate }}</p>
      <details v-if="updates.result.notes" class="update-notes">
        <summary>更新说明</summary>
        <p>{{ updates.result.notes }}</p>
      </details>
      <div v-if="updates.phase === 'downloading'" class="update-progress">
        <progress :value="updates.downloaded" :max="updates.total || 1" aria-label="更新下载进度" />
        <span role="status">
          {{ updates.percent }}% · {{ megabytes(updates.downloaded) }} /
          {{ megabytes(updates.total) }}
        </span>
      </div>
      <div class="setting-actions">
        <button
          v-if="updates.result.can_install && !['ready', 'installing'].includes(updates.phase)"
          class="btn btn-primary btn-sm"
          :disabled="updates.busy"
          @click="updates.download"
        >
          <AppIcon name="download" :size="14" />
          {{ updates.phase === 'downloading' ? '下载中…' : '下载更新' }}
          <span v-if="updates.result.download_size">
            ({{ megabytes(updates.result.download_size) }})
          </span>
        </button>
        <button
          v-if="['ready', 'installing'].includes(updates.phase)"
          class="btn btn-primary btn-sm"
          :disabled="installDisabled"
          @click="install"
        >
          {{
            updates.phase === 'installing'
              ? macInstaller
                ? '正在打开安装包…'
                : '正在启动安装程序…'
              : macInstaller
                ? '退出并打开安装包'
                : '退出并安装'
          }}
        </button>
        <button
          class="btn btn-secondary btn-sm"
          :disabled="updates.busy"
          @click="updates.openRelease"
        >
          前往发布页
        </button>
      </div>
      <p v-if="!updates.result.can_install" class="hint">
        此版本没有适配当前系统且可校验的安装包，请前往发布页手动下载更新。
      </p>
      <p v-else-if="macInstaller" class="hint">
        请先等待漫画下载完成。打开安装包前会退出客户端；将 CopyCopy 拖入 Applications
        文件夹并替换旧版，书库、阅读进度和设置会保留。
      </p>
      <p v-else class="hint">
        安装会退出客户端并打开安装向导，请先等待漫画下载完成。书库、阅读进度和设置会保留。
      </p>
    </div>
    <p v-if="updates.error" role="alert" class="setting-message error update-message">
      {{ updates.error }}
    </p>
  </section>
</template>

<style scoped>
.update-message {
  margin-top: 16px;
  line-height: 1.8;
}
.update-details {
  margin-top: 12px;
}
.update-notes {
  margin-top: 12px;
  font-size: 11px;
  line-height: 1.8;
  color: var(--text-secondary);
}
.update-notes summary {
  cursor: pointer;
  color: var(--text-primary);
}
.update-notes p {
  margin-top: 10px;
  max-height: 240px;
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.update-progress {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  font-size: 10px;
  color: var(--text-secondary);
}
.update-progress progress {
  flex: 1;
  min-width: 120px;
  height: 8px;
  accent-color: var(--success);
}
</style>
