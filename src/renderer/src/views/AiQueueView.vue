<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import {
  NButton,
  NEmpty,
  NPopconfirm,
  NProgress,
  NScrollbar,
  NSpace,
  NTag,
  NText,
  useMessage
} from 'naive-ui'
import { useAiStore, type AiItemStatus, type AiQueueItem, type AiRun } from '../stores/ai'

/**
 * AI 广告检测队列页。
 *
 * 检测在后台跑、批次和章节状态都来自全局 ai store：
 * 从漫画库发起检测后切到这里能实时看到每章的检测结果，
 * 失败的章节带着原因列出来，可以整批重试或取消。
 */
const ai = useAiStore()
const router = useRouter()
const message = useMessage()

/** 新批次在前 */
const runs = computed(() => [...ai.runs].sort((a, b) => b.startedAt - a.startedAt))

interface RunStats {
  done: number
  failed: number
  skipped: number
  canceled: number
  pending: number
  running: number
  moved: number
  finished: number
  total: number
}

function statsOf(run: AiRun): RunStats {
  const s: RunStats = {
    done: 0, failed: 0, skipped: 0, canceled: 0, pending: 0, running: 0,
    moved: 0, finished: 0, total: run.items.length
  }
  for (const i of run.items) {
    if (i.status === 'done') s.done++
    else if (i.status === 'failed') s.failed++
    else if (i.status === 'skipped') s.skipped++
    else if (i.status === 'canceled') s.canceled++
    else if (i.status === 'running') s.running++
    else s.pending++
    s.moved += i.moved
  }
  s.finished = s.done + s.failed + s.skipped + s.canceled
  return s
}

const agg = computed<RunStats>(() => {
  const s: RunStats = {
    done: 0, failed: 0, skipped: 0, canceled: 0, pending: 0, running: 0,
    moved: 0, finished: 0, total: 0
  }
  for (const r of ai.runs) {
    const t = statsOf(r)
    s.done += t.done; s.failed += t.failed; s.skipped += t.skipped
    s.canceled += t.canceled; s.pending += t.pending; s.running += t.running
    s.moved += t.moved; s.finished += t.finished; s.total += t.total
  }
  return s
})

function percentOf(run: AiRun): number {
  const s = statsOf(run)
  return s.total === 0 ? 0 : Math.round((s.finished / s.total) * 100)
}

function fmtElapsed(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  return m < 60 ? `${m}m${sec % 60}s` : `${Math.floor(m / 60)}h${m % 60}m`
}

function statusType(st: AiItemStatus): 'default' | 'info' | 'success' | 'warning' | 'error' {
  if (st === 'done') return 'success'
  if (st === 'failed') return 'error'
  if (st === 'running') return 'info'
  if (st === 'canceled') return 'warning'
  return 'default'
}

function statusText(st: AiItemStatus): string {
  const map: Record<AiItemStatus, string> = {
    pending: '等待中',
    running: '检测中',
    done: '无广告',
    failed: '失败',
    skipped: '跳过',
    canceled: '已取消'
  }
  return map[st]
}

function itemDetail(i: AiQueueItem): string {
  if (i.status === 'done') return i.moved > 0 ? `归档了 ${i.moved} 页广告` : '没有发现广告'
  if (i.error) return i.error
  return ''
}

async function cancelRun(run: AiRun): Promise<void> {
  ai.cancel(run.comicName)
  message.info(`已取消《${run.comicName}》剩余章节的检测（进行中的几章会跑完）`)
}

async function retryRun(run: AiRun): Promise<void> {
  void ai.retryFailed(run.comicName).then(() => message.success(`《${run.comicName}》重试完成`))
}

function removeRun(run: AiRun): void {
  ai.removeRun(run.comicName)
}

function goLibrary(): void {
  router.push('/library')
}
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <NSpace align="center">
        <NTag type="info" :bordered="false">检测中 {{ agg.running }}</NTag>
        <NTag :bordered="false">等待 {{ agg.pending }}</NTag>
        <NTag type="success" :bordered="false">无广告 {{ agg.done }}</NTag>
        <NTag type="error" :bordered="false">失败 {{ agg.failed }}</NTag>
        <NTag type="warning" :bordered="false">已归档 {{ agg.moved }} 页</NTag>
      </NSpace>

      <NPopconfirm @positive-click="ai.clearFinished()">
        <template #trigger>
          <NButton size="small" quaternary type="error" :disabled="!runs.some((r) => r.finishedAt !== null)">
            清除已结束批次
          </NButton>
        </template>
        确定移除所有已结束批次的记录？检测结果不影响磁盘上已归档的广告页。
      </NPopconfirm>

      <NText depth="3" style="font-size: 11px; margin-left: auto">
        检测从「漫画库 → 打开漫画 → 检测广告」发起，退出应用会中断
      </NText>
    </div>

    <NEmpty
      v-if="runs.length === 0"
      description="暂无检测任务"
      style="margin-top: 15vh"
    >
      <template #extra>
        <NButton size="small" @click="goLibrary">去漫画库</NButton>
      </template>
    </NEmpty>

    <div v-else class="runs">
      <section v-for="run in runs" :key="run.comicName" class="run">
        <div class="run-head">
          <div class="run-title">
            <span class="comic">{{ run.comicName }}</span>
            <NTag v-if="run.finishedAt === null" size="small" type="info" :bordered="false">
              检测中
            </NTag>
            <NTag v-else-if="run.canceled" size="small" type="warning" :bordered="false">
              已取消
            </NTag>
            <NTag v-else size="small" type="success" :bordered="false">已完成</NTag>
            <NText depth="3" class="meta">
              {{ statsOf(run).finished }} / {{ statsOf(run).total }} 章
              · 归档 {{ statsOf(run).moved }} 页
              · {{ fmtElapsed((run.finishedAt ?? Date.now()) - run.startedAt) }}
            </NText>
          </div>

          <NSpace :size="6">
            <NButton
              v-if="run.finishedAt === null"
              size="tiny"
              @click="cancelRun(run)"
            >
              取消
            </NButton>
            <NButton
              v-if="run.finishedAt !== null && statsOf(run).failed + statsOf(run).canceled > 0"
              size="tiny"
              @click="retryRun(run)"
            >
              重试失败
            </NButton>
            <NButton
              v-if="run.finishedAt !== null"
              size="tiny"
              quaternary
              @click="removeRun(run)"
            >
              清除
            </NButton>
          </NSpace>
        </div>

        <NProgress
          type="line"
          :percentage="percentOf(run)"
          :status="statsOf(run).failed > 0 ? 'error' : 'default'"
          :height="8"
          :show-indicator="false"
          style="margin: 8px 0"
        />

        <!-- 章节多的批次（80+ 章）内部滚动，别把页面拉成几千像素 -->
        <NScrollbar class="items" :style="{ maxHeight: Math.min(400, 36 + run.items.length * 30) + 'px' }">
          <div
            v-for="item in run.items"
            :key="item.chapterName"
            class="item"
            :class="{ dim: run.finishedAt !== null && item.status === 'done' && item.moved === 0 }"
          >
            <span class="chapter">{{ item.chapterName }}</span>
            <NText depth="3" class="detail">{{ itemDetail(item) }}</NText>
            <NTag size="small" :type="statusType(item.status)" :bordered="false">
              {{ statusText(item.status) }}
            </NTag>
          </div>
        </NScrollbar>
      </section>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.runs {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.run {
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  padding: 14px 16px;
}

.run-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.run-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.comic {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta {
  font-size: 12px;
  white-space: nowrap;
}

.items {
  border-top: 1px solid var(--c-border);
}

.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 2px;
  border-bottom: 1px solid var(--c-border);
  font-size: 13px;
}

.item:last-child {
  border-bottom: none;
}

.item.dim {
  opacity: 0.55;
}

.chapter {
  flex: 0 0 auto;
  min-width: 90px;
}

.detail {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
