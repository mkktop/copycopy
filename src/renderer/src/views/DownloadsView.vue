<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NDropdown, NIcon, NProgress, NTag, useDialog, useMessage } from 'naive-ui'
import {
  CloudDownloadOutline,
  CheckmarkCircleOutline,
  TimeOutline,
  AlertCircleOutline,
  EllipsisHorizontalOutline,
  SearchOutline,
  RefreshOutline,
  FolderOpenOutline
} from '@vicons/ionicons5'
import { useDownloadStore } from '../stores/download'
import { useAppStore } from '../stores/app'
import type { DownloadTask } from '@shared/types'
import PageHeader from '../components/PageHeader.vue'
import EmptyState from '../components/EmptyState.vue'

const api = window.mkk
const dl = useDownloadStore()
const app = useAppStore()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const filter = ref('active')
const busy = ref(false)
const retryableCount = computed(
  () => dl.tasks.filter((task) => task.status === 'failed' || task.status === 'canceled').length
)
const tabs = computed(() => [
  {
    key: 'active',
    label: '进行中',
    count: dl.stats.running + dl.stats.pending
  },
  { key: 'done', label: '已完成', count: dl.stats.done },
  { key: 'failed', label: '需重试', count: retryableCount.value },
  { key: 'all', label: '全部', count: dl.tasks.length }
])
const tasks = computed(() =>
  dl.tasks
    .filter(
      (task) =>
        filter.value === 'all' ||
        (filter.value === 'active' && (task.status === 'running' || task.status === 'pending')) ||
        (filter.value === 'done' && task.status === 'done') ||
        (filter.value === 'failed' && (task.status === 'failed' || task.status === 'canceled'))
    )
    .sort((a, b) => (a.status === 'running' ? -1 : 0) - (b.status === 'running' ? -1 : 0))
)
const menu = computed(() => [
  {
    label: '取消所有进行中的任务',
    key: 'cancel',
    disabled: dl.stats.pending + dl.stats.running === 0
  },
  {
    label: '清除已结束记录',
    key: 'finished',
    disabled: !dl.tasks.some((task) => ['done', 'canceled'].includes(task.status))
  },
  { type: 'divider', key: 'divider' },
  { label: '清空全部任务记录', key: 'clear', disabled: dl.tasks.length === 0 }
])
function percent(task: DownloadTask): number {
  return task.total
    ? Math.min(100, Math.max(0, Math.round(((task.downloaded + task.skipped) / task.total) * 100)))
    : 0
}
function label(task: DownloadTask): string {
  return {
    pending: '排队中',
    running: '正在下载',
    done: '下载完成',
    failed: '下载失败',
    canceled: '已取消'
  }[task.status]
}
function speed(task: DownloadTask): string {
  const rate = dl.speedOf(task.id)
  const eta = dl.etaOf(task)
  return [
    rate > 0.01 ? `${rate.toFixed(1)} 页/秒` : '',
    eta !== null ? (eta < 60 ? `约 ${eta} 秒` : `约 ${Math.ceil(eta / 60)} 分钟`) : ''
  ]
    .filter(Boolean)
    .join(' · ')
}
async function action(run: () => Promise<unknown>, success?: string): Promise<void> {
  busy.value = true
  try {
    await run()
    await dl.refresh()
    if (success) message.success(success)
  } catch (cause) {
    message.error('操作失败：' + String(cause))
  } finally {
    busy.value = false
  }
}
function selectMenu(key: string): void {
  if (key === 'finished') {
    void action(() => window.mkk.removeFinished(), '已清除结束记录，下载文件仍在书架中')
    return
  }
  dialog.warning({
    title: key === 'cancel' ? '取消所有下载？' : '清空任务记录？',
    content:
      key === 'cancel'
        ? '已下载的图片会保留，可以之后重新排队继续。'
        : '进行中的下载也会取消。本地已下载的漫画会保留。',
    positiveText: key === 'cancel' ? '取消下载' : '清空记录',
    negativeText: '保留',
    onPositiveClick: () =>
      action(() => (key === 'cancel' ? window.mkk.cancelAll() : window.mkk.clear()))
  })
}
async function openFolder(): Promise<void> {
  try {
    if (!app.paths) await app.loadPaths()
    if (app.paths) {
      const error = await window.mkk.openPath(app.paths.out)
      if (error) message.error(error)
    }
  } catch (cause) {
    message.error(String(cause))
  }
}
onMounted(() => {
  void dl.refresh().catch((cause) => message.error('队列加载失败：' + String(cause)))
})
</script>

<template>
  <div class="page">
    <div class="content-width">
      <PageHeader
        title="下载管理"
        description="把章节交给队列，剩下的时间留给阅读。"
        eyebrow="DOWNLOAD CENTER"
      >
        <NButton @click="openFolder">
          <template #icon><NIcon :component="FolderOpenOutline" /></template>
          下载目录
        </NButton>
        <NButton
          v-if="dl.stats.failed"
          type="primary"
          :loading="busy"
          @click="action(() => api.retryFailed(), '失败章节已重新排队')"
        >
          <template #icon><NIcon :component="RefreshOutline" /></template>
          重试失败
        </NButton>
      </PageHeader>
      <div class="queue-overview surface">
        <div
          v-for="metric in [
            {
              label: '正在下载',
              value: dl.stats.running,
              icon: CloudDownloadOutline,
              color: 'accent'
            },
            {
              label: '等待下载',
              value: dl.stats.pending,
              icon: TimeOutline,
              color: ''
            },
            {
              label: '已完成',
              value: dl.stats.done,
              icon: CheckmarkCircleOutline,
              color: 'success'
            },
            {
              label: '下载失败',
              value: dl.stats.failed,
              icon: AlertCircleOutline,
              color: 'danger'
            }
          ]"
          :key="metric.label"
          class="queue-metric"
          :class="metric.color"
        >
          <NIcon :component="metric.icon" :size="22" />
          <div>
            <strong>{{ metric.value }}</strong>
            <span>{{ metric.label }}</span>
          </div>
        </div>
      </div>
      <div class="queue-toolbar">
        <div class="filter-tabs" role="tablist" aria-label="下载状态">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            type="button"
            role="tab"
            :aria-selected="filter === tab.key"
            @click="filter = tab.key"
          >
            {{ tab.label }}
            <span>{{ tab.count }}</span>
          </button>
        </div>
        <NDropdown :options="menu" @select="selectMenu">
          <NButton quaternary :disabled="busy">
            更多操作
            <template #icon><NIcon :component="EllipsisHorizontalOutline" /></template>
          </NButton>
        </NDropdown>
      </div>
      <NAlert v-if="dl.waiting" type="info" :bordered="false" style="margin-bottom: 18px">
        下一章将在 {{ Math.ceil(dl.waiting) }} 秒后开始，适当间隔有助于下载稳定。
      </NAlert>
      <div v-if="tasks.length" class="task-list">
        <article
          v-for="task in tasks"
          :key="task.id"
          class="task surface"
          :class="{ 'task--running': task.status === 'running' }"
        >
          <div class="task-icon" :class="task.status">
            <NIcon
              :component="
                task.status === 'done'
                  ? CheckmarkCircleOutline
                  : task.status === 'failed'
                    ? AlertCircleOutline
                    : CloudDownloadOutline
              "
              :size="25"
            />
          </div>
          <div class="task-body">
            <div class="task-heading">
              <h2>
                {{ task.comicName }}
                <span>{{ task.chapterName }}</span>
              </h2>
              <NTag
                size="small"
                :bordered="false"
                :type="
                  task.status === 'failed'
                    ? 'error'
                    : task.status === 'done'
                      ? 'success'
                      : task.status === 'running'
                        ? 'info'
                        : 'default'
                "
              >
                {{ label(task) }}
              </NTag>
            </div>
            <NProgress
              v-if="task.status !== 'done' && task.status !== 'canceled'"
              type="line"
              :percentage="percent(task)"
              :show-indicator="false"
              :height="5"
              :status="task.status === 'failed' ? 'error' : 'default'"
              style="margin: 13px 0 9px"
            />
            <div class="task-meta">
              <span>
                {{ task.downloaded + task.skipped }} / {{ task.total || '—' }} 页
                <template v-if="task.skipped">· {{ task.skipped }} 页已存在</template>
                <template v-if="task.failedPages.length">
                  · {{ task.failedPages.length }} 页待补全
                </template>
              </span>
              <span v-if="task.status === 'running'">
                {{ percent(task) }}%
                <template v-if="speed(task)">· {{ speed(task) }}</template>
              </span>
            </div>
            <p v-if="task.error" class="task-error">{{ task.error }}</p>
          </div>
          <div class="task-actions">
            <NButton
              v-if="task.status === 'pending'"
              size="small"
              quaternary
              :disabled="busy"
              @click="action(() => api.moveTop(task.id))"
            >
              优先下载
            </NButton>
            <NButton
              v-if="task.status === 'pending' || task.status === 'running'"
              size="small"
              :disabled="busy"
              @click="action(() => api.cancel(task.id))"
            >
              取消
            </NButton>
            <NButton
              v-else-if="task.status === 'failed' || task.status === 'canceled'"
              size="small"
              type="primary"
              secondary
              :disabled="busy"
              @click="action(() => api.retry(task.id))"
            >
              重新下载
            </NButton>
            <NButton
              v-else
              size="small"
              quaternary
              @click="router.push('/library/' + encodeURIComponent(task.comicName))"
            >
              前往书架 →
            </NButton>
          </div>
        </article>
      </div>
      <EmptyState
        v-else
        :icon="
          filter === 'done'
            ? CheckmarkCircleOutline
            : filter === 'failed'
              ? AlertCircleOutline
              : CloudDownloadOutline
        "
        :title="
          !dl.tasks.length
            ? '下一段故事，等待出发'
            : filter === 'active'
              ? '当前下载已告一段落'
              : filter === 'failed'
                ? '没有需要重试的任务'
                : '这里还没有任务'
        "
        :description="
          !dl.tasks.length
            ? '去发现喜欢的漫画，选择章节后就能开始下载。'
            : filter === 'active'
              ? '已下载的章节可以在书架中阅读，也可以查看完成记录。'
              : '新的任务状态会自动显示在这里。'
        "
      >
        <NButton v-if="filter === 'active' && dl.stats.done" @click="filter = 'done'">
          查看已完成
        </NButton>
        <NButton type="primary" @click="router.push(dl.stats.done ? '/library' : '/search')">
          <template #icon><NIcon :component="SearchOutline" /></template>
          {{ dl.stats.done ? '前往书架' : '发现漫画' }}
        </NButton>
      </EmptyState>
      <p class="queue-note">下载进度自动保存 · 已有图片会自动跳过 · 清除记录不会删除本地文件</p>
    </div>
  </div>
</template>

<style scoped>
.queue-overview {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  padding: 23px 8px;
}
.queue-metric {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: var(--c-text-3);
  border-right: 1px solid var(--c-border);
}
.queue-metric:last-child {
  border: 0;
}
.queue-metric > div {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.queue-metric strong {
  font-size: 27px;
  line-height: 1.2;
  color: var(--c-text-1);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.queue-metric span {
  font-size: 11px;
}
.queue-metric.accent > .n-icon {
  color: var(--c-accent);
}
.queue-metric.success > .n-icon {
  color: var(--c-success);
}
.queue-metric.danger > .n-icon {
  color: var(--c-danger);
}
.queue-toolbar {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  margin: 26px 0 20px;
}
.task-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.task {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 22px;
  border-radius: 12px;
}
.task--running {
  border-color: var(--c-accent-border);
}
.task-icon {
  display: grid;
  place-items: center;
  width: 48px;
  height: 58px;
  background: var(--c-elevated-hover);
  color: var(--c-text-3);
  border-radius: 9px;
  flex-shrink: 0;
}
.task-icon.running {
  background: var(--c-accent-soft);
  color: var(--c-accent);
}
.task-icon.done {
  background: var(--c-success-soft);
  color: var(--c-success);
}
.task-icon.failed {
  color: var(--c-danger);
}
.task-body {
  flex: 1;
  min-width: 0;
}
.task-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.task-heading h2 {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-heading h2 span {
  font-size: 12px;
  color: var(--c-text-2);
  margin-left: 12px;
  font-weight: 400;
}
.task-heading .n-tag {
  flex-shrink: 0;
}
.task-meta {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 5px 12px;
  font-size: 10px;
  color: var(--c-text-3);
  margin-top: 8px;
}
.task-actions {
  display: flex;
  gap: 7px;
  margin-left: 8px;
}
.task-error {
  font-size: 11px;
  color: var(--c-danger);
  margin: 8px 0 0;
  overflow-wrap: anywhere;
}
.queue-note {
  text-align: center;
  margin: 28px 0 0;
  font-size: 10px;
  color: var(--c-text-3);
  line-height: 1.8;
}
@media (max-width: 1050px) {
  .task {
    padding: 18px;
    gap: 12px;
    flex-wrap: wrap;
  }
  .task-actions {
    margin-left: auto;
  }
  .queue-metric {
    gap: 10px;
  }
}
</style>
