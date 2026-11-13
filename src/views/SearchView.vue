<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../services/api'
import type { Comic } from '../types'
import AppIcon from '../components/AppIcon.vue'
import ComicCard from '../components/ComicCard.vue'
import ComicSkeleton from '../components/ComicSkeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import Paginator from '../components/Paginator.vue'
defineOptions({ name: 'SearchView' })
const route = useRoute()
const router = useRouter()
const query = ref('')
const kind = ref('')
const committed = ref('')
const committedKind = ref('')
const comics = ref<Comic[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(24)
const loading = ref(false)
const error = ref('')
const pages = computed(() => Math.ceil(total.value / pageSize.value))
let generation = 0
async function load(target = 1) {
  if (!committed.value) return
  const request = ++generation
  loading.value = true
  error.value = ''
  try {
    const result = await api.search(committed.value, target, committedKind.value)
    if (request === generation) {
      comics.value = result.items
      total.value = result.total
      pageSize.value = result.pageSize || 24
      page.value = target
    }
  } catch (cause) {
    if (request === generation) error.value = String(cause)
  } finally {
    if (request === generation) loading.value = false
  }
}
function submit() {
  if (!query.value.trim()) return
  if (query.value.trim() === committed.value && kind.value === committedKind.value) {
    void load(1)
    return
  }
  void router.push({
    path: '/search',
    query: { q: query.value.trim(), ...(kind.value ? { kind: kind.value } : {}) }
  })
}
watch(
  () => [route.query.q, route.query.kind],
  () => {
    if (route.name !== 'search') return
    const keyword = String(route.query.q || '').trim()
    const nextKind = String(route.query.kind || '')
    if (committed.value === keyword && committedKind.value === nextKind) return
    query.value = keyword
    kind.value = nextKind
    committed.value = query.value.trim()
    committedKind.value = kind.value
    if (committed.value) void load()
    else {
      generation++
      comics.value = []
      total.value = 0
      loading.value = false
      error.value = ''
    }
  },
  { immediate: true }
)
</script>
<template>
  <div class="page">
    <div class="page-header">
      <div>
        <div class="eyebrow">FIND YOUR NEXT FAVORITE</div>
        <h1>搜索与探索</h1>
        <p>一本漫画、一位作者，或一个突然想到的词。</p>
      </div>
    </div>
    <form class="search-panel" @submit.prevent="submit">
      <AppIcon name="search" :size="22" />
      <input v-model="query" aria-label="漫画搜索词" placeholder="输入漫画名或作者，开始探索" />
      <select v-model="kind" aria-label="搜索类型">
        <option value="">全部</option>
        <option value="name">漫画名</option>
        <option value="author">作者</option>
      </select>
      <button class="btn btn-primary" :disabled="!query.trim()">搜索作品</button>
    </form>
    <template v-if="committed">
      <div class="section-heading">
        <h2>
          「{{ committed }}」的搜索结果
          <small>{{ total.toLocaleString() }} RESULTS</small>
        </h2>
        <span v-if="loading" class="hint">正在寻找…</span>
      </div>
      <ComicSkeleton v-if="loading && !comics.length" />
      <EmptyState v-else-if="error" title="搜索暂时不可用" :description="error" error>
        <button class="btn btn-primary" @click="load(page)">重试搜索</button>
      </EmptyState>
      <EmptyState
        v-else-if="!comics.length"
        title="还没有找到这段故事"
        description="换一个名称、作者，或更短的关键词试试。"
      />
      <div v-else class="comic-grid" :aria-busy="loading">
        <ComicCard
          v-for="comic in comics"
          :key="comic.id"
          :comic="comic"
          @click="router.push('/comic/' + encodeURIComponent(comic.id))"
        />
      </div>
      <Paginator :page="page" :pages="pages" :loading="loading" @change="load" />
    </template>
    <EmptyState
      v-else
      title="每个故事，都从寻找开始"
      description="输入关键词搜索作品。也可以从这些主题开始。"
      icon="search"
    >
      <RouterLink
        v-for="word in ['冒险', '奇幻', '日常']"
        :key="word"
        :to="{ path: '/search', query: { q: word } }"
        class="btn btn-secondary btn-sm"
      >
        {{ word }}
      </RouterLink>
    </EmptyState>
  </div>
</template>
