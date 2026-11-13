<script setup lang="ts">
import { computed, onActivated, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, remoteImage } from '../services/api'
import { useAppStore } from '../stores/app'
import { useDownloadStore } from '../stores/downloads'
import type { DownloadTask } from '../types'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'
defineOptions({ name: 'DownloadsView' })
const app = useAppStore()
const store = useDownloadStore()
const router = useRouter()
const filter = ref('all')
const error = ref('')
const tabs = computed(() => [
  { value: 'all', label: '全部任务', count: store.tasks.length },
  { value: 'active', label: '进行中', count: store.counts.pending + store.counts.running },
  { value: 'done', label: '已完成', count: store.counts.done },
  { value: 'failed', label: '失败', count: store.counts.failed }
])
// 队列可能很长：只渲染前 PAGE_LIMIT 条，避免全量 v-for 卡顿；容器再用 content-visibility 兜底。
const PAGE_LIMIT = 100
const pageLimit = ref(PAGE_LIMIT)
const filtered = computed(() =>
  store.tasks.filter(
    (t) =>
      filter.value === 'all' ||
      (filter.value === 'active' && ['pending', 'running'].includes(t.status)) ||
      t.status === filter.value
  )
)
const visible = computed(() => filtered.value.slice(0, pageLimit.value))
const progress = (task: DownloadTask) =>
  task.total ? Math.min(100, Math.floor(((task.completed + task.skipped) / task.total) * 100)) : 0
const labels = {
  pending: '排队中',
  running: '正在下载',
  done: '下载完成',
  failed: '下载失败',
  canceled: '已取消'
}
async function refresh() {
  error.value = ''
  try {
    await store.refresh()
  } catch (cause) {
    error.value = String(cause)
  }
}
async function action(type: Parameters<typeof api.queueAction>[0], id: string | null = null) {
  // 危险批量操作统一走确认，避免误触清空队列。
  if (type === 'cancelAll' || type === 'clearFinished') {
    const title = type === 'cancelAll' ? '取消全部下载任务？' : '清理已结束的记录？'
    const message =
      type === 'cancelAll'
        ? '正在下载和排队中的任务都会被取消，已下载的文件会保留。'
        : '已完成、失败与已取消的记录会从列表移除，不影响本地文件。'
    if (!(await app.confirm(title, message, type === 'cancelAll' ? '取消全部' : '清理记录', true)))
      return
  }
  const result = await app.run(() => api.queueAction(type, id))
  if (result) store.apply(result)
}
function finished(task: DownloadTask) {
  return task.finishedAt ? new Date(task.finishedAt).toLocaleString('zh-CN') : ''
}
function read(task: DownloadTask) {
  void router.push({
    name: 'reader',
    params: { comicId: task.comic.id, chapterId: task.chapter.id },
    query: { local: '1', index: task.chapter.index, title: task.chapter.title }
  })
}
onActivated(refresh)
</script>
<template>
  <div class="page">
    <div class="page-header">
      <div>
        <div class="eyebrow">MAKE ROOM FOR MORE STORIES</div>
        <h1>下载管理</h1>
        <p>故事正在抵达，下载完成后就能随时离线阅读。</p>
      </div>
      <button
        class="btn btn-secondary btn-sm"
        @click="app.run(() => api.openLocation('downloads'))"
      >
        <AppIcon name="folder" :size="15" />
        下载目录
      </button>
    </div>
    <div class="stats-strip">
      <div>
        <AppIcon name="download" />
        <span>
          <strong>{{ store.counts.running }}</strong>
          正在下载
        </span>
      </div>
      <div>
        <AppIcon name="clock" />
        <span>
          <strong>{{ store.counts.pending }}</strong>
          等待中
        </span>
      </div>
      <div>
        <AppIcon name="check" />
        <span>
          <strong>{{ store.counts.done }}</strong>
          已完成
        </span>
      </div>
      <span class="stats-note">
        {{
          store.busy ? '请保持程序开启，退出后下次会继续未完成的任务。' : '此刻没有正在进行的下载。'
        }}
      </span>
    </div>
    <div class="task-toolbar">
      <nav class="task-tabs" aria-label="任务状态">
        <button
          v-for="tab in tabs"
          :key="tab.value"
          :class="{ active: filter === tab.value }"
          @click="filter = tab.value"
        >
          {{ tab.label }}
          <span>{{ tab.count }}</span>
        </button>
      </nav>
      <div class="task-actions">
        <button v-if="store.counts.failed" class="text-btn" @click="action('retryFailed')">
          重试失败
        </button>
        <button v-if="store.busy" class="text-btn" @click="action('cancelAll')">取消全部</button>
        <button
          v-if="store.tasks.some((t) => ['done', 'failed', 'canceled'].includes(t.status))"
          class="text-btn"
          @click="action('clearFinished')"
        >
          清理已结束记录
        </button>
        <button class="icon-btn" title="刷新任务" @click="refresh">
          <AppIcon name="refresh" :size="16" />
        </button>
      </div>
    </div>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <EmptyState
      v-if="!filtered.length"
      :title="store.tasks.length ? '这里暂时没有对应状态的任务' : '让喜欢的故事，慢慢到来'"
      description="从作品详情选择想保存的章节，下载进度会显示在这里。"
      icon="download"
    >
      <RouterLink to="/" class="btn btn-primary">发现故事</RouterLink>
    </EmptyState>
    <div v-else class="download-list">
      <article
        v-for="task in visible"
        :key="task.id"
        class="download-row"
        :data-task-status="task.status"
      >
        <img
          v-if="task.comic.cover"
          class="task-cover"
          :src="remoteImage(task.comic.cover)"
          :alt="task.comic.title"
          loading="lazy"
        />
        <span v-else class="task-cover cover-fallback"><AppIcon name="book" /></span>
        <div class="task-body">
          <div class="task-title">
            <strong>{{ task.comic.title }}</strong>
            <span
              class="status-pill"
              :class="
                task.status === 'done' ? 'success' : task.status === 'failed' ? 'warning' : ''
              "
            >
              {{ labels[task.status] }}
            </span>
          </div>
          <p>{{ task.chapter.title }}</p>
          <div v-if="task.status === 'running'" class="task-progress">
            <progress
              :value="task.completed + task.skipped"
              :max="task.total || 1"
              :aria-label="task.chapter.title + ' 下载进度'"
            />
            <span>{{ progress(task) }}%</span>
          </div>
          <div class="task-detail">
            <span>
              {{ task.completed + task.skipped }} / {{ task.total || task.chapter.pageCount }} 页
            </span>
            <span v-if="task.skipped">已跳过 {{ task.skipped }} 页</span>
            <span v-if="task.failedPages.length" class="error-text">
              失败 {{ task.failedPages.length }} 页
            </span>
            <span v-if="finished(task)">完成于 {{ finished(task) }}</span>
          </div>
          <p
            v-if="task.error"
            class="task-error"
            :class="{ 'error-text': task.status === 'failed' }"
          >
            {{ task.error }}
          </p>
        </div>
        <div class="task-row-actions">
          <button
            v-if="task.status === 'pending'"
            class="text-btn"
            @click="action('moveTop', task.id)"
          >
            置顶
          </button>
          <button
            v-if="['pending', 'running'].includes(task.status)"
            class="btn btn-secondary btn-sm"
            @click="action('cancel', task.id)"
          >
            取消
          </button>
          <button
            v-else-if="['failed', 'canceled'].includes(task.status)"
            class="btn btn-secondary btn-sm"
            @click="action('retry', task.id)"
          >
            重试续传
          </button>
          <button v-else class="btn btn-secondary btn-sm" @click="read(task)">
            <AppIcon name="book" :size="14" />
            开始阅读
          </button>
        </div>
      </article>
      <button
        v-if="filtered.length > visible.length"
        class="btn btn-secondary btn-sm load-more"
        @click="pageLimit += PAGE_LIMIT"
      >
        加载更多（还有 {{ filtered.length - visible.length }} 条）
      </button>
    </div>
  </div>
</template>
