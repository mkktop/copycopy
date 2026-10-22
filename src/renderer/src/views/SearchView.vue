<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NIcon, NSelect, NSkeleton, useMessage } from 'naive-ui'
import {
  SearchOutline,
  CloseOutline,
  ArrowForwardOutline,
  CloudDownloadOutline,
  BookOutline,
  BookmarkOutline
} from '@vicons/ionicons5'
import type { SearchComicItem } from '@shared/types'
import { useAppStore } from '../stores/app'
import PageHeader from '../components/PageHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import ComicCard from '../components/ComicCard.vue'

defineOptions({ name: 'SearchView' })
const router = useRouter()
const app = useAppStore()
const message = useMessage()
const RECENT_KEY = 'copycopy.recentSearch'
const suggestions = ['葬送的芙莉莲', '海贼王', '迷宫饭', '蓝色时期', '夏目友人帐']
const keyword = ref('')
const lastQuery = ref('')
const searchType = ref('')
const loading = ref(false)
const searched = ref(false)
const error = ref('')
const items = ref<SearchComicItem[]>([])
const page = ref(1)
const total = ref(0)
const downloaded = ref<Record<string, number>>({})
const recent = ref<string[]>([])
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / 24)))
const typeOptions = [
  { label: '全部', value: '' },
  { label: '漫画名称', value: 'name' },
  { label: '作者', value: 'author' }
]
let sequence = 0

try {
  const stored: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
  recent.value = Array.isArray(stored)
    ? stored.filter((word): word is string => typeof word === 'string').slice(0, 8)
    : []
} catch {
  /* 历史损坏时从空列表开始 */
}
function storeRecent(): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.value))
  } catch {
    /* 搜索不依赖历史写入 */
  }
}
function removeRecent(word: string): void {
  recent.value = recent.value.filter((item) => item !== word)
  storeRecent()
}
function clearRecent(): void {
  recent.value = []
  storeRecent()
}
async function search(next = 1, query = keyword.value.trim()): Promise<void> {
  if (!query) {
    message.info('输入漫画名称或作者，开始搜索')
    return
  }
  const request = ++sequence
  loading.value = true
  error.value = ''
  searched.value = true
  lastQuery.value = query
  try {
    const result = await window.mkk.search(query, next, searchType.value)
    if (request !== sequence) return
    if (!result.ok) throw new Error(result.error)
    items.value = result.data.list || []
    total.value = result.data.total || 0
    page.value = next
    recent.value = [query, ...recent.value.filter((word) => word !== query)].slice(0, 8)
    storeRecent()
  } catch (cause) {
    if (request !== sequence) return
    error.value = cause instanceof Error ? cause.message : String(cause)
    items.value = []
    total.value = 0
  } finally {
    if (request === sequence) loading.value = false
  }
}
function reset(): void {
  sequence++
  loading.value = false
  searched.value = false
  items.value = []
  error.value = ''
  keyword.value = ''
  total.value = 0
}
function useWord(word: string): void {
  keyword.value = word
  void search()
}
watch(
  () => app.config?.global.search_type,
  (value) => {
    if (!searched.value) searchType.value = value || ''
  },
  { immediate: true }
)
onActivated(async () => {
  try {
    const library = await window.mkk.libraryList()
    downloaded.value = Object.fromEntries(
      library.map((comic) => [comic.name, comic.chapters.length])
    )
  } catch {
    /* 本地书架不可用不阻塞站点搜索 */
  }
})
onBeforeUnmount(() => {
  sequence++
})
</script>

<template>
  <div class="page search-page">
    <div class="content-width">
      <PageHeader
        title="发现漫画"
        description="找到喜欢的故事，下载后随时离线阅读。"
        eyebrow="EXPLORE YOUR NEXT STORY"
      >
        <NButton quaternary @click="router.push('/library')">
          我的书架
          <template #icon><NIcon :component="ArrowForwardOutline" /></template>
        </NButton>
      </PageHeader>
      <section class="search-panel surface" :class="{ 'search-panel--compact': searched }">
        <div v-if="!searched" class="search-intro">
          <span class="search-intro__line" />
          每一个好故事，都值得慢慢读。
        </div>
        <form class="search-form" role="search" @submit.prevent="search()">
          <NIcon :component="SearchOutline" :size="22" class="search-symbol" />
          <input
            v-model="keyword"
            data-search-input
            aria-label="漫画名称或作者"
            placeholder="搜索漫画名称或作者…"
            spellcheck="false"
            autocomplete="off"
          />
          <button
            v-if="keyword"
            type="button"
            class="clear-input"
            aria-label="清空搜索文字"
            @click="keyword = ''"
          >
            <NIcon :component="CloseOutline" :size="17" />
          </button>
          <NSelect
            v-model:value="searchType"
            :options="typeOptions"
            class="search-type"
            :consistent-menu-width="false"
            aria-label="搜索范围"
          />
          <NButton attr-type="submit" type="primary" :loading="loading" class="search-submit">
            搜索漫画
          </NButton>
        </form>
        <div v-if="!searched" class="suggestions">
          <span>试试搜索</span>
          <button v-for="word in suggestions" :key="word" type="button" @click="useWord(word)">
            {{ word }}
          </button>
        </div>
      </section>
      <template v-if="!searched">
        <section v-if="recent.length" class="recent-section">
          <div class="section-heading">
            <h2>最近搜索</h2>
            <button type="button" class="text-button muted" @click="clearRecent">清空记录</button>
          </div>
          <div class="recent-list">
            <div v-for="word in recent" :key="word" class="recent-chip">
              <button type="button" @click="useWord(word)">{{ word }}</button>
              <button
                type="button"
                :aria-label="`移除搜索记录 ${word}`"
                @click="removeRecent(word)"
              >
                <NIcon :component="CloseOutline" :size="13" />
              </button>
            </div>
          </div>
        </section>
        <section class="start-section">
          <div class="section-heading">
            <h2>把喜欢的漫画，变成自己的书架</h2>
            <span class="start-caption">简单三步，故事随行</span>
          </div>
          <div class="workflow">
            <div
              v-for="(step, index) in [
                {
                  icon: SearchOutline,
                  title: '发现喜欢的漫画',
                  text: '按名称或作者搜索，查看简介和章节。'
                },
                {
                  icon: CloudDownloadOutline,
                  title: '选好章节，交给队列',
                  text: '批量下载，退出后也能接着完成。'
                },
                {
                  icon: BookOutline,
                  title: '回到书架，开始阅读',
                  text: '离线阅读、导出 PDF，收藏每个故事。'
                }
              ]"
              :key="index"
              class="workflow-step surface"
            >
              <div class="workflow-top">
                <span><NIcon :component="step.icon" :size="21" /></span>
                <small>0{{ index + 1 }}</small>
              </div>
              <h3>{{ step.title }}</h3>
              <p>{{ step.text }}</p>
            </div>
          </div>
          <div class="subscription-tip">
            <NIcon :component="BookmarkOutline" :size="17" />
            <span>遇见连载中的好故事？在漫画详情页加入追更，新章节会自动来到你的书架。</span>
            <button class="text-button" type="button" @click="router.push('/subscriptions')">
              查看订阅 →
            </button>
          </div>
        </section>
      </template>
      <template v-else>
        <div class="section-heading result-heading">
          <h2>
            “{{ lastQuery }}”
            <span class="result-count">{{ loading ? '搜索中…' : `找到 ${total} 部漫画` }}</span>
          </h2>
          <button type="button" class="text-button" @click="reset">返回发现</button>
        </div>
        <div v-if="loading" class="book-grid" aria-busy="true" aria-label="正在搜索">
          <div v-for="index in 12" :key="index">
            <NSkeleton height="auto" style="aspect-ratio: 3 / 4; border-radius: 10px" />
            <NSkeleton text style="margin-top: 12px; width: 80%" />
            <NSkeleton text style="width: 55%" />
          </div>
        </div>
        <EmptyState
          v-else-if="error"
          title="暂时无法完成搜索"
          :description="error"
          :icon="SearchOutline"
        >
          <NButton type="primary" @click="search(1, lastQuery)">重新搜索</NButton>
          <NButton @click="router.push('/settings?tab=storage')">检查网络设置</NButton>
        </EmptyState>
        <div v-else-if="items.length" class="book-grid">
          <ComicCard
            v-for="comic in items"
            :key="comic.path_word"
            :name="comic.name"
            :cover="app.remoteImg(comic.cover)"
            :subtitle="comic.author?.map((author) => author.name).join(' / ') || '未知作者'"
            :badge="downloaded[comic.name] ? `书架已有 ${downloaded[comic.name]} 章` : undefined"
            @open="router.push('/comic/' + encodeURIComponent(comic.path_word))"
          />
        </div>
        <EmptyState
          v-else
          title="还没找到这个故事"
          description="试试更短的名称、作品别名，或者切换为按作者搜索。"
          :icon="SearchOutline"
        >
          <NButton @click="reset">换个关键词</NButton>
        </EmptyState>
        <div v-if="!loading && !error && items.length && pageCount > 1" class="pager">
          <NButton :disabled="page <= 1" @click="search(page - 1, lastQuery)">上一页</NButton>
          <span>{{ page }} / {{ pageCount }}</span>
          <NButton :disabled="page >= pageCount" @click="search(page + 1, lastQuery)">
            下一页
          </NButton>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.search-panel {
  padding: 28px;
  background:
    radial-gradient(ellipse at 100% 0, var(--c-hero-a), transparent 70%), var(--c-surface);
}
.search-intro {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 12px;
  color: var(--c-text-2);
  margin-bottom: 18px;
}
.search-intro__line {
  width: 18px;
  border-top: 2px solid var(--c-accent);
}
.search-form {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 7px 7px 18px;
  border: 1px solid var(--c-border-strong);
  border-radius: 11px;
  background: var(--c-surface);
}
.search-form:focus-within {
  border-color: var(--c-accent);
  box-shadow: 0 0 0 3px var(--c-accent-soft);
}
.search-symbol {
  color: var(--c-accent);
  flex-shrink: 0;
}
.search-form input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--c-text-1);
  height: 36px;
  font-size: 14px;
}
.search-form input::placeholder {
  color: var(--c-text-3);
}
.clear-input {
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--c-text-3);
  cursor: pointer;
  padding: 5px;
}
.search-type {
  width: 118px;
  flex-shrink: 0;
}
.search-submit {
  height: 40px;
  padding: 0 24px;
}
.suggestions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 18px;
  font-size: 11px;
}
.suggestions > span {
  color: var(--c-text-3);
}
.suggestions > button {
  border: 0;
  background: transparent;
  color: var(--c-text-2);
  cursor: pointer;
  padding: 0;
  font-size: 11px;
}
.suggestions > button:hover {
  color: var(--c-accent);
}
.search-panel--compact {
  padding: 16px;
}
.recent-section {
  padding: 0 4px;
}
.recent-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.recent-chip {
  display: flex;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: 7px;
  align-items: center;
}
.recent-chip button {
  border: 0;
  background: none;
  cursor: pointer;
  color: var(--c-text-2);
  padding: 7px 11px;
  font-size: 12px;
}
.recent-chip button + button {
  display: grid;
  place-items: center;
  padding: 9px 9px 9px 0;
  color: var(--c-text-3);
}
.start-section {
  margin-top: 34px;
}
.start-caption {
  font-size: 11px;
  color: var(--c-text-3);
}
.workflow {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.workflow-step {
  padding: 24px 22px;
}
.workflow-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.workflow-top > span {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 11px;
  background: var(--c-accent-soft);
  color: var(--c-accent);
}
.workflow-top small {
  color: var(--c-border-strong);
  font-size: 26px;
  font-weight: 300;
}
.workflow-step h3 {
  font-size: 13px;
  margin: 18px 0 9px;
  font-weight: 600;
}
.workflow-step p {
  font-size: 11px;
  line-height: 1.9;
  color: var(--c-text-2);
  margin: 0;
}
.subscription-tip {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 24px;
  color: var(--c-text-3);
  font-size: 11px;
  line-height: 1.8;
}
.subscription-tip > .n-icon {
  flex-shrink: 0;
  color: var(--c-accent);
}
.subscription-tip .text-button {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 11px;
}
.result-count {
  font-size: 11px;
  color: var(--c-text-3);
  font-weight: 400;
  margin-left: 14px;
}
@media (max-width: 1050px) {
  .search-panel {
    padding: 22px;
  }
  .search-panel--compact {
    padding: 12px;
  }
  .workflow-step {
    padding: 18px;
  }
  .subscription-tip {
    flex-wrap: wrap;
  }
}
</style>
