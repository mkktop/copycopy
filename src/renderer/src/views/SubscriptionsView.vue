<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NIcon, NInputNumber, NPopconfirm, NSkeleton, useMessage } from 'naive-ui'
import { BookmarkOutline, RefreshOutline, SettingsOutline, AddOutline } from '@vicons/ionicons5'
import { useAppStore } from '../stores/app'
import { useDownloadStore } from '../stores/download'
import type { ComicSubscription, LibraryComic } from '@shared/types'
import PageHeader from '../components/PageHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import ComicCover from '../components/ComicCover.vue'

const app = useAppStore()
const dl = useDownloadStore()
const router = useRouter()
const message = useMessage()
const loading = ref(true)
const checking = ref(false)
const error = ref('')
const savingPath = ref('')
const library = ref<LibraryComic[]>([])
const limits = ref<Record<string, number | null>>({})
const subscriptions = computed(() => app.config?.comics || [])
const schedule = computed(() => {
  const hours = app.config?.global.auto_check_interval_hours || 0
  return hours ? `每 ${hours} 小时自动检查` : '当前为手动检查'
})
async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    await app.loadConfig()
    limits.value = Object.fromEntries(
      subscriptions.value.map((comic) => [comic.path, comic.download_limit])
    )
    library.value = await window.mkk.libraryList()
  } catch (cause) {
    error.value = String(cause)
  } finally {
    loading.value = false
  }
}
function cover(name: string): string | null {
  return app.imgUrl(library.value.find((comic) => comic.name === name)?.cover)
}
async function check(): Promise<void> {
  checking.value = true
  try {
    const result = await window.mkk.checkUpdates()
    await Promise.all([load(), dl.refresh()])
    if (result.queued) message.success(`发现 ${result.queued} 个新章节，已加入下载队列`)
    else message.info(`已检查 ${result.checked} 部漫画，暂时没有新章节`)
  } catch (cause) {
    message.error('检查更新失败：' + String(cause))
  } finally {
    checking.value = false
  }
}
async function saveLimit(comic: ComicSubscription): Promise<void> {
  const limit = limits.value[comic.path]
  if (!limit || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    message.warning('请填写 1 到 500 之间的整数')
    return
  }
  savingPath.value = comic.path
  try {
    app.config = await window.mkk.subscribe({ name: comic.name, path: comic.path }, limit)
    message.success('追更数量已更新')
  } catch (cause) {
    message.error('保存失败：' + String(cause))
  } finally {
    savingPath.value = ''
  }
}
async function unsubscribe(path: string): Promise<void> {
  try {
    app.config = await window.mkk.unsubscribe(path)
    message.success('已取消追更，本地漫画仍在书架中')
  } catch (cause) {
    message.error('取消失败：' + String(cause))
  }
}
onMounted(load)
</script>

<template>
  <div class="page">
    <div class="content-width">
      <PageHeader
        title="追更订阅"
        description="把连载交给 CopyCopy，好故事更新时不再错过。"
        eyebrow="FOLLOW THE NEXT CHAPTER"
      >
        <NButton @click="router.push('/settings?tab=general')">
          <template #icon><NIcon :component="SettingsOutline" /></template>
          检查计划
        </NButton>
        <NButton
          type="primary"
          :loading="checking"
          :disabled="!subscriptions.length || loading"
          @click="check"
        >
          <template #icon><NIcon :component="RefreshOutline" /></template>
          检查更新
        </NButton>
      </PageHeader>
      <div class="subscription-summary surface">
        <span class="subscription-icon"><NIcon :component="BookmarkOutline" :size="23" /></span>
        <div>
          <strong>{{ subscriptions.length }} 部漫画正在追更</strong>
          <p>
            {{ schedule }}
            <template v-if="app.config?.global.auto_check_on_launch">· 启动时自动检查</template>
          </p>
        </div>
        <NButton quaternary @click="router.push('/search')">
          <template #icon><NIcon :component="AddOutline" /></template>
          添加订阅
        </NButton>
      </div>
      <div class="section-heading">
        <h2>我的订阅</h2>
        <span class="muted" style="font-size: 11px">下载完成后自动记录进度</span>
      </div>
      <div v-if="loading && !subscriptions.length" class="subscription-list">
        <NSkeleton v-for="index in 3" :key="index" height="134px" :sharp="false" />
      </div>
      <EmptyState v-else-if="error" title="订阅加载失败" :description="error">
        <NButton @click="load">重试</NButton>
      </EmptyState>
      <div v-else-if="subscriptions.length" class="subscription-list">
        <article v-for="comic in subscriptions" :key="comic.path" class="subscription surface">
          <button
            type="button"
            class="subscription-cover"
            :aria-label="`查看《${comic.name}》`"
            @click="router.push('/comic/' + encodeURIComponent(comic.path))"
          >
            <ComicCover :src="cover(comic.name)" :name="comic.name" />
          </button>
          <div class="subscription-info">
            <button
              type="button"
              class="subscription-name"
              @click="router.push('/comic/' + encodeURIComponent(comic.path))"
            >
              {{ comic.name }}
            </button>
            <p>
              已下载至第
              <strong>{{ comic.last_chapter }}</strong>
              章
            </p>
            <small>上次检查：{{ comic.last_check_time || '还没有检查过' }}</small>
          </div>
          <div class="subscription-settings">
            <label :for="'limit-' + comic.path">每次最多下载</label>
            <div>
              <NInputNumber
                :id="'limit-' + comic.path"
                v-model:value="limits[comic.path]"
                :min="1"
                :max="500"
                size="small"
                style="width: 94px"
              />
              <span>章</span>
              <NButton
                v-if="limits[comic.path] !== comic.download_limit"
                size="small"
                type="primary"
                :loading="savingPath === comic.path"
                @click="saveLimit(comic)"
              >
                保存
              </NButton>
            </div>
          </div>
          <NPopconfirm @positive-click="unsubscribe(comic.path)">
            <template #trigger><NButton quaternary size="small">取消追更</NButton></template>
            取消《{{ comic.name }}》的追更？已下载的内容会保留。
          </NPopconfirm>
        </article>
      </div>
      <EmptyState
        v-else
        :icon="BookmarkOutline"
        title="下一话，帮你记着"
        description="在漫画详情中点击「加入追更」，新章节就会按你的计划下载。"
      >
        <NButton type="primary" @click="router.push('/search')">寻找想追的漫画</NButton>
      </EmptyState>
    </div>
  </div>
</template>

<style scoped>
.subscription-summary {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 24px;
}
.subscription-icon {
  display: grid;
  place-items: center;
  width: 49px;
  height: 49px;
  border-radius: 13px;
  background: var(--c-accent-soft);
  color: var(--c-accent);
}
.subscription-summary strong {
  font-size: 15px;
  font-weight: 600;
}
.subscription-summary p {
  font-size: 11px;
  color: var(--c-text-2);
  margin: 7px 0 0;
}
.subscription-summary > .n-button {
  margin-left: auto;
}
.subscription-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.subscription {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 20px 24px;
  border-radius: 12px;
}
.subscription-cover {
  border: 0;
  padding: 0;
  background: none;
  width: 65px;
  flex-shrink: 0;
  cursor: pointer;
}
.subscription-cover :deep(.comic-cover__fallback) {
  padding: 7px;
  gap: 5px;
}
.subscription-cover :deep(.comic-cover__fallback > span) {
  font-size: 10px;
}
.subscription-cover :deep(.comic-cover__fallback small) {
  display: none;
}
.subscription-info {
  flex: 1;
  min-width: 0;
}
.subscription-name {
  font-weight: 600;
  font-size: 14px;
  border: 0;
  background: none;
  padding: 0;
  cursor: pointer;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.subscription-info p {
  font-size: 12px;
  color: var(--c-text-2);
  margin: 9px 0 6px;
}
.subscription-info p strong {
  color: var(--c-accent);
}
.subscription-info small {
  font-size: 10px;
  color: var(--c-text-3);
}
.subscription-settings label {
  font-size: 10px;
  color: var(--c-text-3);
  display: block;
  margin-bottom: 8px;
}
.subscription-settings > div {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--c-text-2);
}
@media (max-width: 1050px) {
  .subscription {
    gap: 14px;
    padding: 18px;
    flex-wrap: wrap;
  }
  .subscription-info {
    min-width: 160px;
  }
}
</style>
