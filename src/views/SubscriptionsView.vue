<script setup lang="ts">
import { onActivated, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, remoteImage } from '../services/api'
import { useAppStore } from '../stores/app'
import { useDownloadStore } from '../stores/downloads'
import type { Subscription } from '../types'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'
defineOptions({ name: 'SubscriptionsView' })
const app = useAppStore()
const downloads = useDownloadStore()
const router = useRouter()
const items = ref<Subscription[]>([])
const limits = ref<Record<string, number>>({})
const loading = ref(false)
const checking = ref(false)
const error = ref('')
async function load() {
  if (loading.value) return
  loading.value = true; error.value = ''
  try { items.value = await api.subscriptions(); limits.value = Object.fromEntries(items.value.map(s => [s.comic.id, s.chapterLimit])) }
  catch (cause) { error.value = String(cause) } finally { loading.value = false }
}
async function save(sub: Subscription) {
  const result = await app.run(() => api.subscribe(sub.comic, limits.value[sub.comic.id] || 10), '追更偏好已保存')
  if (result) await load()
}
async function remove(sub: Subscription) {
  if (!await app.confirm('停止追更这部作品？', '本地下载的漫画会保留，可以随时重新订阅。', '停止追更')) return
  const result = await app.run(async () => { await api.unsubscribe(sub.comic.id); return true }, '已停止追更')
  if (result) await load()
}
async function check() {
  checking.value = true
  const result = await app.run(() => api.checkSubscriptions())
  if (result) { app.notify('已检查 ' + result.checked + ' 部作品，加入 ' + result.queued + ' 章下载'); if (result.errors.length) app.notify(result.errors.join('；'), true); await downloads.refresh(); await load() }
  checking.value = false
}
function date(value: number | null) { return value ? new Date(value).toLocaleString('zh-CN') : '还未检查' }
onActivated(load)
</script>
<template>
  <div class="page">
    <div class="page-header"><div><div class="eyebrow">DON'T MISS THE NEXT CHAPTER</div><h1>追更订阅</h1><p>把期待交给下一章，新的故事来了就接着读。</p></div><button class="btn btn-primary" :disabled="checking || downloads.busy || !items.length" @click="check"><AppIcon name="refresh" :size="16"/>{{ checking ? '检查中…' : '检查章节更新' }}</button></div>
    <div class="subscription-note"><AppIcon name="clock" :size="18"/><span>按已完成的章节连续追更，缺页补齐后才会推进进度。可在偏好设置中开启定时检查。</span><RouterLink to="/settings?tab=downloads" class="text-btn">追更偏好<AppIcon name="chevron-right" :size="13"/></RouterLink></div>
    <EmptyState v-if="error" title="订阅暂时无法加载" :description="error" error><button class="btn btn-primary" @click="load">重试</button></EmptyState>
    <div v-else-if="loading && !items.length" class="loading"><span class="spinner"/>正在加载订阅…</div>
    <EmptyState v-else-if="!items.length" title="把期待，留给下一章" description="在作品详情中点击「加入追更」，新章节会按你设置的数量加入下载队列。" icon="heart"><RouterLink to="/" class="btn btn-primary">发现想追的故事</RouterLink></EmptyState>
    <div v-else class="subscription-list"><article v-for="sub in items" :key="sub.comic.id" class="subscription-row">
      <button class="subscription-cover" :aria-label="'打开 ' + sub.comic.title" @click="router.push('/comic/' + encodeURIComponent(sub.comic.id))"><img v-if="sub.comic.cover" :src="remoteImage(sub.comic.cover)" :alt="sub.comic.title"/><AppIcon v-else name="book" :size="30"/></button>
      <div class="subscription-info"><h3>{{ sub.comic.title }}</h3><p>{{ sub.comic.authors.join(' / ') }}</p><span class="status-pill success">已追到第 {{ sub.lastChapter }} 章</span><small>上次检查：{{ date(sub.checkedAt) }}</small><p v-if="sub.error" class="error-text">{{ sub.error }}</p></div>
      <div class="subscription-controls"><label>每次追更 <input v-model.number="limits[sub.comic.id]" type="number" min="1" max="100" :aria-label="sub.comic.title + ' 单次追更章数'"/> 章</label><button class="btn btn-secondary btn-sm" :disabled="limits[sub.comic.id] === sub.chapterLimit" @click="save(sub)">保存偏好</button><button class="text-btn muted" @click="remove(sub)">停止追更</button></div>
    </article></div>
  </div>
</template>
