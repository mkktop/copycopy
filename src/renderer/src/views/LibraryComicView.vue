<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NCheckbox,
  NDivider,
  NDropdown,
  NEmpty,
  NInput,
  NModal,
  NProgress,
  NSpace,
  NSpin,
  NTag,
  NText,
  useDialog,
  useMessage,
  type DropdownOption
} from 'naive-ui'
import type { LibraryChapter, LibraryComic } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useAiStore } from '../stores/ai'
import ComicCover from '../components/ComicCover.vue'
import { BookOutline } from '@vicons/ionicons5'
import { NIcon } from 'naive-ui'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const app = useAppStore()

const comic = ref<LibraryComic | null>(null)
const loading = ref(false)
const lastReadChapter = ref('')
const syncing = ref(false)

const previewOpen = ref(false)
const previewLoading = ref(false)
const previewSrc = ref<string | null>(null)
const previewChapter = ref<LibraryChapter | null>(null)

const pdfOpen = ref(false)
const pdfUseGlobal = ref(true)
const pdfPassword = ref('')
const pdfTargets = ref<LibraryChapter[]>([])
const pdfBusy = ref(false)

/** 批量操作选中的章节（存章节目录名） */
const selected = ref<Set<string>>(new Set())
const selectMode = ref(false)
const batchBusy = ref(false)

/** 哪些章节还没生成 PDF */
const withoutPdf = computed(() => comic.value?.chapters.filter((c) => !c.pdfPath) ?? [])
/** 已知下缺页的章节 */
const incomplete = computed(() => comic.value?.chapters.filter((c) => c.complete === false) ?? [])
/** 只显示缺页的 */
const onlyIncomplete = ref(false)
const shown = computed(() =>
  onlyIncomplete.value ? incomplete.value : (comic.value?.chapters ?? [])
)
const selectedChapters = computed(() =>
  (comic.value?.chapters ?? []).filter((c) => selected.value.has(c.name))
)

const comicName = computed(() => String(route.params.name ?? ''))

function toggleSelect(name: string): void {
  const next = new Set(selected.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  selected.value = next
}

function selectAll(): void {
  selected.value = new Set(shown.value.map((c) => c.name))
}

function clearSelect(): void {
  selected.value = new Set()
}

/** 头部「更多」下拉：整部级别的操作 */
const comicMenu = computed<DropdownOption[]>(() => {
  const c = comic.value
  const items: DropdownOption[] = [
    { label: '打开所在目录', key: 'dir', disabled: !c?.chapters.length },
    { label: '获取封面', key: 'cover', disabled: !!c?.cover }
  ]
  if (c?.meta?.pathWord) {
    items.push({ type: 'divider', key: 'd1' }, { label: '复制站点 ID', key: 'copyid' })
  }
  items.push({ type: 'divider', key: 'd2' }, { label: '删除整部漫画', key: 'delall' })
  return items
})

async function onComicMenu(key: string): Promise<void> {
  const c = comic.value
  if (!c) return
  switch (key) {
    case 'dir':
      await openFolder(c.chapters[0]?.dir ?? '')
      break
    case 'cover':
      await syncCover()
      break
    case 'copyid':
      if (c.meta?.pathWord) {
        await navigator.clipboard.writeText(c.meta.pathWord)
        message.success('站点 ID 已复制')
      }
      break
    case 'delall':
      confirmDeleteComic()
      break
  }
}

function openReader(ch: LibraryChapter): void {
  router.push(`/library/${encodeURIComponent(comicName.value)}/${encodeURIComponent(ch.name)}`)
}

/**
 * 每一行原本摊着 6 个按钮（阅读/预览/打开/重导/目录/删），
 * 最小窗口宽度下已经挤爆，而且主次不分。
 * 收成「主操作 + 更多菜单」：阅读是主操作，其余进下拉。
 */
function menuFor(ch: LibraryChapter): DropdownOption[] {
  const opts: DropdownOption[] = [
    { label: '预览首页', key: 'preview' },
    { label: '打开所在目录', key: 'dir' }
  ]
  if (ch.pdfPath) {
    opts.push(
      { label: '用系统阅读器打开 PDF', key: 'openpdf' },
      { label: '重新导出 PDF', key: 'pdf' }
    )
  } else {
    opts.push({ label: '导出 PDF', key: 'pdf' })
  }
  if (aiReady.value) {
    opts.push({ type: 'divider', key: 'dai' })
    opts.push({
      label: ch.adChecked ? '重新检测广告' : '检测广告',
      key: 'ai'
    })
    if (ch.adCount) {
      opts.push({ label: `撤销归档（${ch.adCount} 页）`, key: 'aiundo' })
    }
  }
  opts.push({ type: 'divider', key: 'd' }, { label: '删除该章节', key: 'del' })
  return opts
}

function onMenu(ch: LibraryChapter, key: string): void {
  switch (key) {
    case 'preview':
      preview(ch)
      break
    case 'dir':
      void openFolder(ch.dir)
      break
    case 'openpdf':
      if (ch.pdfPath) void openPdf(ch.pdfPath)
      break
    case 'pdf':
      openPdfDialog([ch])
      break
    case 'ai':
      void detectOne(ch)
      break
    case 'aiundo':
      confirmUndoAds(ch)
      break
    case 'del':
      confirmDeleteChapter(ch)
      break
  }
}

async function batchDelete(): Promise<void> {
  const targets = selectedChapters.value
  if (targets.length === 0) return
  const pages = targets.reduce((s, c) => s + c.pageCount, 0)
  dialog.warning({
    title: '批量删除',
    content: `确定删除选中的 ${targets.length} 个章节（共 ${pages} 页）？此操作不可撤销。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      batchBusy.value = true
      try {
        const res = await window.mkk.deleteChapters(
          targets.map((c) => ({
            comicName: comicName.value,
            chapterName: c.name
          }))
        )
        if (res.failed > 0) {
          message.warning(`成功 ${res.ok} 个，失败 ${res.failed} 个`)
        } else {
          message.success(`已删除 ${res.ok} 个章节`)
        }
        clearSelect()
        await load()
      } finally {
        batchBusy.value = false
      }
    }
  })
}

async function openPdf(pdfPath: string): Promise<void> {
  const err = await window.mkk.openPdf(pdfPath)
  if (err) message.error(err)
}

/** 把缺页章节全选上，方便直接批量补下 */
function selectIncomplete(): void {
  onlyIncomplete.value = true
  selectMode.value = true
  selected.value = new Set(incomplete.value.map((c) => c.name))
}

async function retryMissing(): Promise<void> {
  const n = await window.mkk.retryMissing()
  if (n > 0) message.success(`已把 ${n} 个缺页章节加入下载队列`)
  else message.info('没有需要补下的章节')
}

/* ---------------- AI 广告识别 ---------------- */

const aiReady = ref(false)
const aiConcurrency = ref(3)
/**
 * 检测进度放在全局 ai store：检测没跑完就离开本页时，
 * 后台循环继续跑、标签栏药丸和重新进来的进度条都能看到实时状态。
 * 之前存在组件 ref 里，一离开页面进度就"消失"了。
 */
const ai = useAiStore()
const aiRun = computed(() => ai.runs.find((r) => r.comicName === comicName.value) ?? null)
/** 本部正在检测（含单章检测的 1/1 批次） */
const aiBusy = computed(() => aiRun.value !== null && aiRun.value.finishedAt === null)
/** 批量检测才有进度条；单章检测用按钮 loading */
const aiProgress = computed(() => {
  const r = aiRun.value
  if (!r || r.finishedAt !== null || r.items.length <= 1) return null
  const done = r.items.filter((i) => i.status !== 'pending' && i.status !== 'running').length
  return { done, total: r.items.length }
})

const adTotal = computed(() =>
  (comic.value?.chapters ?? []).reduce((s, c) => s + (c.adCount ?? 0), 0)
)
const uncheckedCount = computed(
  () => (comic.value?.chapters ?? []).filter((c) => c.adChecked !== true).length
)

async function refreshAi(): Promise<void> {
  try {
    aiReady.value = (await window.mkk.aiStatus()).hasKey
    aiConcurrency.value = app.config?.global.ai_concurrency ?? 3
  } catch {
    aiReady.value = false
  }
}

/**
 * 批量检测。队列状态和 worker 都在全局 ai store 里：
 * 检测中途离开本页，后台照常推进，检测队列页和标签栏药丸都能看到进度；
 * 回到本页时进度条从 store 续上，不会再"消失"。
 * 并发按设置的 ai_concurrency 开 worker，主进程另有全局闸门兜底。
 */
async function detectUnchecked(): Promise<void> {
  // 漫画名必须在开始时捕获：comicName 取自当前路由，
  // 检测中途用户离开本页它会变成空串，剩余章节就全拿空名去调主进程了
  const name = comicName.value
  if (!name) return
  if (ai.isActive(name)) {
    message.info('这一部正在检测中，可到「检测队列」页查看')
    return
  }

  const targets = (comic.value?.chapters ?? []).filter((c) => c.adChecked !== true)
  if (targets.length === 0) {
    message.info('这一部的章节都检测过了')
    return
  }

  const t0 = Date.now()
  const run = await ai.runDetection(
    name,
    targets.map((c) => c.name)
  )
  await load()
  if (!run) return

  const moved = run.items.reduce((s, i) => s + i.moved, 0)
  const failed = run.items.filter((i) => i.status === 'failed').length
  const secs = Math.round((Date.now() - t0) / 1000)
  if (run.canceled) {
    message.info(`已取消，本次移走 ${moved} 页广告`)
  } else if (failed > 0) {
    message.warning(
      `完成，移走 ${moved} 页广告，${failed} 章检测失败（原图已保留，可在检测队列页重试），耗时 ${secs}s`
    )
  } else {
    message.success(
      moved > 0 ? `已归档 ${moved} 页广告，耗时 ${secs}s` : `检测完成，没有发现广告，耗时 ${secs}s`
    )
  }
}

async function detectOne(ch: LibraryChapter): Promise<void> {
  const name = comicName.value
  if (!name) return
  if (ai.isActive(name)) {
    message.info('这一部正在检测中，可到「检测队列」页查看')
    return
  }
  // 也走 store 批次（1 章）：标签栏药丸、检测队列页和按钮 loading 都由它驱动
  const run = await ai.runDetection(name, [ch.name], { force: true })
  await load()
  const item = run?.items[0]
  if (!item) return
  if (item.status === 'failed' || item.status === 'skipped') {
    message.warning(item.error ?? '检测失败，已保留原图')
  } else if (item.moved > 0) {
    message.success(`已归档 ${item.moved} 页广告`)
  } else {
    message.info('没有发现广告')
  }
}

function confirmUndoAds(ch: LibraryChapter): void {
  dialog.info({
    title: '撤销广告归档',
    content: `把《${comicName.value}》${ch.name} 的 ${ch.adCount} 页广告移回正文目录？`,
    positiveText: '移回',
    negativeText: '取消',
    onPositiveClick: async () => {
      const n = await window.mkk.aiUndo(comicName.value, ch.name)
      await load()
      message.success(n > 0 ? `已恢复 ${n} 页` : '没有可恢复的页')
    }
  })
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const list = await window.mkk.libraryList()
    comic.value = list.find((c) => c.name === comicName.value) ?? null
    try {
      lastReadChapter.value = localStorage.getItem('copycopy.lastChapter:' + comicName.value) || ''
    } catch {
      lastReadChapter.value = ''
    }
  } catch (cause) {
    message.error('漫画加载失败：' + String(cause))
  } finally {
    loading.value = false
  }
}

async function syncCover(): Promise<void> {
  syncing.value = true
  try {
    const ok = await window.mkk.syncCover(comicName.value)
    if (ok) {
      message.success('封面已更新')
      await load()
    } else {
      message.warning('没找到对应漫画，无法获取封面')
    }
  } finally {
    syncing.value = false
  }
}

async function preview(ch: LibraryChapter): Promise<void> {
  previewChapter.value = ch
  previewOpen.value = true
  previewLoading.value = true
  previewSrc.value = null
  try {
    // 列表里不带每页文件名，用到再单独取首页
    const files = await window.mkk.chapterFiles(ch.dir)
    previewSrc.value = app.imgUrl(files[0])
  } finally {
    previewLoading.value = false
  }
}

async function openFolder(target: string): Promise<void> {
  const err = await window.mkk.openPath(target)
  if (err) message.error(err)
}

function confirmDeleteChapter(ch: LibraryChapter): void {
  dialog.warning({
    title: '删除章节',
    content: `确定删除《${comicName.value}》的 ${ch.name}（${ch.pageCount} 页）？此操作不可撤销。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      const ok = await window.mkk.deleteChapter(comicName.value, ch.name)
      if (!ok) {
        message.error('删除失败')
        return
      }
      message.success('已删除')
      await load()
    }
  })
}

function confirmDeleteComic(): void {
  const c = comic.value
  if (!c) return
  dialog.error({
    title: '删除整部漫画',
    content: `确定删除《${c.name}》？包含 ${c.chapters.length} 个章节、${c.totalPages} 页图片和全部 PDF，删除后无法恢复。`,
    positiveText: '全部删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await window.mkk.deleteComic(c.name)
      message.success('已删除')
      router.push('/library')
    }
  })
}

function openPdfDialog(targets: LibraryChapter[]): void {
  if (targets.length === 0) {
    message.warning('没有可导出的章节')
    return
  }
  pdfTargets.value = targets
  pdfPassword.value = ''
  pdfUseGlobal.value = true
  pdfOpen.value = true
}

async function doExport(): Promise<void> {
  pdfBusy.value = true
  try {
    const res = await window.mkk.exportPdfBatch(
      pdfTargets.value.map((c) => c.dir),
      { password: pdfPassword.value, useGlobalPassword: pdfUseGlobal.value }
    )
    if (res.failed === 0) {
      message.success(`已生成 ${res.ok} 个 PDF`)
      pdfOpen.value = false
    } else {
      message.warning(`成功 ${res.ok} 个，失败 ${res.failed} 个：${res.error ?? ''}`)
    }
    await load()
  } finally {
    pdfBusy.value = false
  }
}

watch(comicName, load)
onMounted(() => {
  void load()
  void refreshAi()
})
</script>

<template>
  <div class="page">
    <NSpin :show="loading">
      <div v-if="comic" class="head">
        <div class="head-cover">
          <ComicCover :src="app.imgUrl(comic.cover)" :name="comic.name" />
        </div>

        <div class="head-info">
          <NSpace align="center" :size="10">
            <NButton size="tiny" quaternary @click="router.push('/library')">
              ← 返回我的书架
            </NButton>
          </NSpace>
          <h2 class="page-title" style="margin: 6px 0 4px">{{ comic.name }}</h2>
          <NText depth="3" style="font-size: 12px">
            {{ comic.chapters.length }} 章 · 共 {{ comic.totalPages }} 页 ·
            {{ comic.chapters.filter((c) => c.pdfPath).length }} 个已生成 PDF
          </NText>

          <!--
            头部只留这部漫画的整体操作，章节级的都收进下面的工具条，
            之前上下两排工具功能重叠，用户得猜哪个管哪个。
          -->
          <NSpace style="margin-top: 12px">
            <NButton
              v-if="comic.chapters.length"
              type="primary"
              @click="
                openReader(
                  comic.chapters.find((chapter) => chapter.name === lastReadChapter) ||
                    comic.chapters[0]
                )
              "
            >
              <template #icon><NIcon :component="BookOutline" /></template>
              {{ lastReadChapter ? '继续阅读' : '开始阅读' }}
            </NButton>
            <NButton
              v-if="comic.meta?.pathWord"
              @click="router.push('/comic/' + encodeURIComponent(comic.meta.pathWord))"
            >
              查看站点章节
            </NButton>
            <NButton size="small" @click="retryMissing" :disabled="incomplete.length === 0">
              补下缺页
              <template v-if="incomplete.length">（{{ incomplete.length }}）</template>
            </NButton>
            <NDropdown :options="comicMenu" @select="onComicMenu">
              <NButton size="small" quaternary>更多 ▾</NButton>
            </NDropdown>
          </NSpace>
        </div>
      </div>

      <div v-else-if="!loading" class="empty">
        没有找到《{{ comicName }}》，可能已被删除。
        <a @click="router.push('/library')">返回漫画库</a>
      </div>
    </NSpin>

    <NDivider v-if="comic && comic.chapters.length" />

    <!-- 统一的章节工具条：多选 / 筛选 / 批量操作都在这一行 -->
    <div v-if="comic" class="toolbar">
      <NCheckbox v-model:checked="onlyIncomplete">
        只看缺页
        <template v-if="incomplete.length">（{{ incomplete.length }}）</template>
      </NCheckbox>

      <!-- AI 广告识别入口 -->
      <NButton
        v-if="aiReady"
        size="small"
        :loading="aiBusy && !aiProgress"
        :disabled="uncheckedCount === 0 || aiBusy"
        @click="detectUnchecked"
      >
        检测广告
        <template v-if="uncheckedCount">（{{ uncheckedCount }} 章待检测）</template>
      </NButton>
      <NTag v-if="aiReady && adTotal" size="tiny" type="info" :bordered="false">
        已归档 {{ adTotal }} 页
      </NTag>
      <NProgress
        v-if="aiProgress"
        type="line"
        :percentage="Math.round((aiProgress.done / aiProgress.total) * 100)"
        :height="6"
        :show-indicator="false"
        style="width: 140px"
      />
      <NText v-if="aiProgress" depth="3" style="font-size: 11px">
        {{ aiProgress.done }}/{{ aiProgress.total }} · 并发 {{ aiConcurrency }}
      </NText>

      <NButton
        size="small"
        :type="selectMode ? 'primary' : 'default'"
        @click="selectMode = !selectMode"
      >
        {{ selectMode ? '退出多选' : '多选' }}
      </NButton>
      <NButton v-if="selectMode" size="small" @click="selectAll">全选</NButton>
      <NButton
        v-if="selectMode"
        size="small"
        :disabled="!incomplete.length"
        @click="selectIncomplete"
      >
        选中缺页
      </NButton>
      <NButton v-if="selectMode" size="small" quaternary @click="clearSelect">清除</NButton>

      <template v-if="selectMode">
        <NText depth="3" style="font-size: 12px">已选 {{ selected.size }} 章</NText>
        <NButton
          size="small"
          :disabled="selected.size === 0"
          @click="openPdfDialog(selectedChapters)"
        >
          批量导出 PDF
        </NButton>
        <NButton
          size="small"
          type="error"
          quaternary
          :loading="batchBusy"
          :disabled="selected.size === 0"
          @click="batchDelete"
        >
          批量删除
        </NButton>
      </template>

      <NButton
        v-else
        size="small"
        quaternary
        :disabled="withoutPdf.length === 0"
        @click="openPdfDialog(withoutPdf)"
      >
        批量导出缺失 PDF
        <template v-if="withoutPdf.length">（{{ withoutPdf.length }}）</template>
      </NButton>
    </div>

    <div v-if="comic" class="chapter-list">
      <div
        v-for="ch in shown"
        :key="ch.dir"
        class="chapter"
        :class="{ picked: selected.has(ch.name) }"
        tabindex="0"
        :aria-label="`${selectMode ? '选择' : '阅读'} ${ch.name}`"
        @keydown.enter.self.prevent="selectMode ? toggleSelect(ch.name) : openReader(ch)"
        @keydown.space.self.prevent="selectMode ? toggleSelect(ch.name) : openReader(ch)"
        @click="selectMode ? toggleSelect(ch.name) : openReader(ch)"
      >
        <NCheckbox
          v-if="selectMode"
          :checked="selected.has(ch.name)"
          style="margin-right: 2px"
          @update:checked="toggleSelect(ch.name)"
          @click.stop
        />
        <span class="idx">第 {{ ch.index }} 章</span>
        <span class="name" :title="ch.name">{{ ch.name }}</span>
        <NTag v-if="ch.pdfPath" size="tiny" type="success" :bordered="false">PDF</NTag>
        <NTag v-if="ch.complete === false" size="tiny" type="warning" :bordered="false">缺页</NTag>
        <NTag v-if="ch.adCount" size="tiny" type="info" :bordered="false">
          广告 {{ ch.adCount }}
        </NTag>
        <NText depth="3" class="pages">
          {{ ch.pageCount }}
          <template v-if="ch.expectedPages">/{{ ch.expectedPages }}</template>
          P
        </NText>
        <!-- 非多选态才显示行内操作；多选时整行就是开关 -->
        <NSpace v-if="!selectMode" :size="4" class="row-actions" @click.stop>
          <NButton size="tiny" type="primary" ghost @click="openReader(ch)">阅读</NButton>
          <NDropdown trigger="click" :options="menuFor(ch)" @select="(k: string) => onMenu(ch, k)">
            <NButton size="tiny" quaternary class="more-btn">更多 ▾</NButton>
          </NDropdown>
        </NSpace>
      </div>
      <NEmpty
        v-if="!shown.length"
        :description="onlyIncomplete ? '没有缺页的章节，很好' : '还没有下载任何章节'"
        style="margin: 40px 0"
      />
    </div>

    <NModal v-model:show="previewOpen" preset="card" style="width: 720px" :bordered="false">
      <div class="preview-title">{{ previewChapter?.name }}</div>
      <NSpin :show="previewLoading">
        <img v-if="previewSrc" :src="previewSrc" class="preview-img" alt="" />
        <NEmpty v-else-if="!previewLoading" description="无法预览该图片" />
      </NSpin>
    </NModal>

    <NModal
      v-model:show="pdfOpen"
      preset="card"
      title="导出 PDF"
      style="width: 460px"
      :bordered="false"
    >
      <NSpace vertical size="large">
        <NText depth="3" style="font-size: 13px">
          将把
          <b>{{ pdfTargets.length }}</b>
          个章节分别合并为 PDF，输出到各自章节目录的同级位置。
        </NText>
        <NSpace vertical size="small">
          <NCheckbox v-model:checked="pdfUseGlobal">使用全局设置中的密码</NCheckbox>
          <NInput
            v-if="!pdfUseGlobal"
            v-model:value="pdfPassword"
            type="password"
            show-password-on="click"
            placeholder="留空则不加密"
          />
        </NSpace>
        <NAlert type="warning" :bordered="false" style="font-size: 12px">
          章节页数较多时导出会比较慢，请耐心等待
        </NAlert>
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="pdfOpen = false">取消</NButton>
          <NButton type="primary" :loading="pdfBusy" @click="doExport">开始生成</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  gap: 20px;
  padding: 26px;
  border: 1px solid var(--c-border);
  border-radius: 16px;
  background: var(--c-surface);
  align-items: center;
}

.head-cover {
  width: 136px;
  flex: 0 0 136px;
  aspect-ratio: 3 / 4;
  border-radius: 8px;
  overflow: hidden;
  background: var(--c-placeholder);
}

.head-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cover-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--c-text-4);
  font-size: 32px;
  font-weight: 600;
}

.head-info {
  flex: 1;
  min-width: 0;
}

.chapter-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.chapter {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 9px;
  border: 1px solid var(--c-border);
  background: var(--c-elevated);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.chapter:hover {
  background: var(--c-elevated-hover);
}
.chapter.picked {
  background: var(--c-picked);
  box-shadow: inset 2px 0 0 var(--c-accent);
}

.pages {
  font-size: 11px;
  width: 58px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.row-actions {
  justify-content: flex-end;
}
.more-btn {
  min-width: 56px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.idx {
  color: var(--c-text-3);
  font-variant-numeric: tabular-nums;
  width: 65px;
  flex-shrink: 0;
}

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-title {
  font-size: 14px;
  margin-bottom: 10px;
}

.preview-img {
  width: 100%;
  display: block;
  border-radius: 6px;
}
</style>
