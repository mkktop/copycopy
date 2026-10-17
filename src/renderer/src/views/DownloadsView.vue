<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NEmpty,
  NPopconfirm,
  NProgress,
  NSpace,
  NTag,
  NText,
  useMessage
} from 'naive-ui'
import { useDownloadStore } from '../stores/download'
import type { DownloadTask } from '@shared/types'

const dl = useDownloadStore()
const message = useMessage()

const sorted = computed(() =>
  [...dl.tasks].sort((a, b) => {
    const w = (t: DownloadTask) => (t.status === 'running' ? 0 : t.status === 'pending' ? 1 : 2)
    return w(a) - w(b) || a.chapterIndex - b.chapterIndex
  })
)

/**
 * 已完成/已取消的任务折叠成一行。
 * 每张完整卡片约 90px，100 个任务就是 9000px 的滚动条，
 * 而翻完的任务没人会逐个去看。
 */
const showFinished = ref(false)
const finishedCount = computed(() => sorted.value.filter(isFinished).length)
const activeTasks = computed(() => sorted.value.filter((t) => !isFinished(t)))
const visibleTasks = computed(() =>
  showFinished.value ? sorted.value : activeTasks.value
)

function isFinished(t: DownloadTask): boolean {
  return t.status === 'done' || t.status === 'canceled'
}

/** 键盘上下移动的高亮下标 */
const cursor = ref(0)
// 任务被移除/清空时把光标收回范围内，否则 Enter 会打到不存在的行
watch(
  () => visibleTasks.value.length,
  (n) => {
    if (cursor.value >= n) cursor.value = Math.max(0, n - 1)
  }
)

function percent(t: DownloadTask): number {
  if (!t.total) return 0
  return Math.round(((t.downloaded + t.skipped) / t.total) * 100)
}

function statusType(t: DownloadTask): 'default' | 'info' | 'success' | 'warning' | 'error' {
  if (t.status === 'done') return 'success'
  if (t.status === 'failed') return 'error'
  if (t.status === 'running') return 'info'
  if (t.status === 'canceled') return 'warning'
  return 'default'
}

function statusText(t: DownloadTask): string {
  const map: Record<DownloadTask['status'], string> = {
    pending: '等待中',
    running: '下载中',
    done: '已完成',
    failed: '失败',
    canceled: '已取消'
  }
  return map[t.status]
}

function fmtSpeed(t: DownloadTask): string | null {
  if (t.status !== 'running') return null
  const v = dl.speedOf(t.id)
  return v > 0.01 ? `${v.toFixed(2)} 页/秒` : null
}

function fmtEta(t: DownloadTask): string | null {
  const s = dl.etaOf(t)
  if (s === null) return null
  if (s <= 0) return '即将完成'
  if (s < 60) return `剩 ${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `剩 ${m} 分 ${s % 60} 秒`
  return `剩 ${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

async function cancel(id: string): Promise<void> {
  await window.mkk.cancel(id)
}
async function retry(id: string): Promise<void> {
  await window.mkk.retry(id)
}
async function cancelAll(): Promise<void> {
  await window.mkk.cancelAll()
  message.info('已请求取消全部任务')
}
async function retryFailed(): Promise<void> {
  await window.mkk.retryFailed()
  message.info('已重新排队失败任务')
}
async function clearDone(): Promise<void> {
  await window.mkk.removeFinished()
}
async function clearAll(): Promise<void> {
  await window.mkk.clear()
  message.info('已清空队列')
}
async function moveTop(id: string): Promise<void> {
  await window.mkk.moveTop(id)
}

/** j/k 上下移动，Enter 重试或取消 */
function onKey(e: KeyboardEvent): void {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
  if (e.key === 'j' || e.key === 'ArrowDown') {
    e.preventDefault()
    cursor.value = Math.min(cursor.value + 1, sorted.value.length - 1)
  } else if (e.key === 'k' || e.key === 'ArrowUp') {
    e.preventDefault()
    cursor.value = Math.max(cursor.value - 1, 0)
  } else if (e.key === 'Enter') {
    const t = visibleTasks.value[cursor.value]
    if (!t) return
    e.preventDefault()
    if (isFinished(t) || t.status === 'failed') void retry(t.id)
    else void cancel(t.id)
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <NSpace align="center">
        <NTag type="info" :bordered="false">运行中 {{ dl.stats.running }}</NTag>
        <NTag :bordered="false">等待 {{ dl.stats.pending }}</NTag>
        <NTag type="success" :bordered="false">完成 {{ dl.stats.done }}</NTag>
        <NTag type="error" :bordered="false">失败 {{ dl.stats.failed }}</NTag>
      </NSpace>

      <NButton size="small" @click="cancelAll">全部取消</NButton>
      <NButton size="small" @click="retryFailed" :disabled="dl.stats.failed === 0">
        重试失败
      </NButton>
      <NButton size="small" @click="clearDone">清除已完成</NButton>
      <NPopconfirm @positive-click="clearAll">
        <template #trigger>
          <NButton size="small" quaternary type="error" :disabled="!sorted.length">
            清空队列
          </NButton>
        </template>
        确定清空整个下载队列？已完成和失败的任务都会一并移除。
      </NPopconfirm>

      <NText depth="3" style="font-size: 11px; margin-left: auto">
        j / k 移动 · Enter 取消或重试
      </NText>
    </div>

    <NAlert v-if="dl.waiting" type="info" style="margin-bottom: 12px" :bordered="false">
      章节之间随机等待 {{ dl.waiting.toFixed(1) }} 秒，避免触发站点限流
    </NAlert>

    <!-- 折叠开关：已完成的默认收起来 -->
    <div v-if="finishedCount > 0" class="finished-bar">
      <NText depth="3" style="font-size: 12px">
        已完成 {{ finishedCount }} 项
      </NText>
      <NButton size="tiny" quaternary @click="showFinished = !showFinished">
        {{ showFinished ? '收起' : '展开' }}
      </NButton>
    </div>

    <div v-if="visibleTasks.length" class="list">
      <div
        v-for="(t, i) in visibleTasks"
        :key="t.id"
        class="task"
        :class="{ active: i === cursor, compact: isFinished(t) }"
        @click="cursor = i"
      >
        <div class="task-head">
          <div class="title">
            <span class="comic">{{ t.comicName }}</span>
            <span class="chapter">{{ t.chapterName }}</span>
          </div>
          <NSpace :size="6" align="center">
            <NText v-if="fmtSpeed(t)" depth="3" class="meta-sm">
              {{ fmtSpeed(t) }}
            </NText>
            <NText v-if="fmtEta(t)" depth="3" class="meta-sm">{{ fmtEta(t) }}</NText>
            <NTag size="small" :type="statusType(t)" :bordered="false">{{ statusText(t) }}</NTag>
          </NSpace>
        </div>

        <NProgress
          v-if="!isFinished(t)"
          type="line"
          :percentage="percent(t)"
          :status="t.status === 'failed' ? 'error' : 'default'"
          :height="8"
          :show-indicator="false"
          style="margin: 8px 0"
        />

        <div class="task-foot" :class="{ inline: isFinished(t) }">
          <NText depth="3" style="font-size: 12px">
            {{ t.downloaded + t.skipped }} / {{ t.total || '?' }} 页
            <template v-if="t.skipped">（跳过已有 {{ t.skipped }}）</template>
            <template v-if="t.status === 'running' && dl.currentPage[t.id]">
              · 正在下载第 {{ dl.currentPage[t.id] }} 页
            </template>
            <template v-if="t.failedPages.length">
              · 失败 {{ t.failedPages.length }} 页
            </template>
          </NText>

          <NSpace :size="6">
            <NButton
              v-if="t.status === 'pending'"
              size="tiny"
              quaternary
              @click.stop="moveTop(t.id)"
            >
              置顶
            </NButton>
            <NButton
              v-if="t.status === 'pending' || t.status === 'running'"
              size="tiny"
              @click.stop="cancel(t.id)"
            >
              取消
            </NButton>
            <NButton
              v-if="t.status === 'failed' || isFinished(t)"
              size="tiny"
              type="primary"
              ghost
              @click.stop="retry(t.id)"
            >
              重试
            </NButton>
          </NSpace>
        </div>

        <NText v-if="t.error" depth="3" class="err-text">
          {{ t.error }}
        </NText>
      </div>
    </div>

    <NEmpty v-else description="下载队列为空，去搜索页添加章节吧" class="empty" />
  </div>
</template>

<style scoped>
.finished-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.task {
  background: var(--c-elevated);
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 12px 14px;
  transition: border-color 0.15s ease;
}
.task.active {
  border-color: var(--c-active-border);
}

/* 已完成/已取消：单行紧凑显示，别占一整屏 */
.task.compact {
  padding: 7px 12px;
  background: var(--c-surface);
}
.task.compact .title {
  font-size: 12px;
  color: var(--c-text-2);
}
.task-foot.inline {
  margin-top: 2px;
  opacity: 0.85;
}

.meta-sm {
  font-size: 11px;
}

.err-text {
  font-size: 12px;
  color: var(--c-error-text);
}

.task-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.title {
  min-width: 0;
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.comic {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
}

.chapter {
  color: var(--c-text-2);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
</style>
