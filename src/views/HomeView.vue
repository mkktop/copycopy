<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../services/api'
import type { Comic } from '../types'
import { useAppStore } from '../stores/app'
import AppIcon from '../components/AppIcon.vue'
import ComicCard from '../components/ComicCard.vue'
import ComicSkeleton from '../components/ComicSkeleton.vue'
import EmptyState from '../components/EmptyState.vue'
defineOptions({ name: 'HomeView' })
const app = useAppStore()
const router = useRouter()
const keywords = ['冒险', '奇幻', '校园', '悬疑', '日常']
const active = ref('冒险')
const comics = ref<Comic[]>([])
const loading = ref(false)
const error = ref('')
let request = 0
const subtitle = computed(() => active.value + '故事')
// KeepAlive 首次挂载时 onMounted 与 onActivated 都会触发，用标记跳过首次 activated 避免重复加载。
let skipFirstActivation = true
async function load(keyword = active.value) {
  const current = ++request
  const switched = keyword !== active.value
  active.value = keyword
  // 切换分类先清空旧卡片，否则骨架屏条件不成立，标题变了内容还是旧分类。
  if (switched) comics.value = []
  loading.value = true
  error.value = ''
  try {
    const result = await api.search(keyword)
    if (current === request) comics.value = result.items
  } catch (cause) {
    if (current === request) error.value = String(cause)
  } finally {
    if (current === request) loading.value = false
  }
}
onMounted(() => load())
onActivated(() => {
  // 切回本页时刷新数据；跳过挂载时的首次 activated（onMounted 已加载）。
  if (skipFirstActivation) {
    skipFirstActivation = false
    return
  }
  void load()
})
</script>
<template>
  <div class="page home-view">
    <div class="page-header">
      <div>
        <div class="eyebrow">COPYCOPY · STORIES TO KEEP</div>
        <h1>发现故事</h1>
        <p>从一个关键词开始，把喜欢的故事留在身边。</p>
      </div>
      <RouterLink to="/library" class="btn btn-secondary btn-sm">
        <AppIcon name="library" :size="15" />
        打开本地书库
      </RouterLink>
    </div>
    <nav class="discovery-tabs" aria-label="探索主题">
      <button
        v-for="keyword in keywords"
        :key="keyword"
        :class="{ active: active === keyword }"
        :aria-pressed="active === keyword"
        @click="load(keyword)"
      >
        {{ keyword }}
      </button>
      <button class="refresh-button" :disabled="loading" @click="load()">
        <AppIcon name="refresh" :size="15" />
        刷新灵感
      </button>
    </nav>
    <div class="section-heading">
      <h2>
        {{ subtitle }}
        <small>EXPLORE BY KEYWORD</small>
      </h2>
      <div class="section-controls">
        <span class="hint">给今天留一点想象力</span>
        <button
          class="icon-btn"
          title="切换卡片密度"
          @click="app.run(() => app.save({ compactCards: !app.settings.compactCards }))"
        >
          <AppIcon name="grid" :size="16" />
        </button>
      </div>
    </div>
    <ComicSkeleton v-if="loading && !comics.length" />
    <EmptyState v-else-if="error" title="故事暂时没有抵达" :description="error" error>
      <button class="btn btn-primary" @click="load()">重新加载</button>
      <RouterLink to="/settings?tab=network" class="btn btn-secondary">检查网络设置</RouterLink>
    </EmptyState>
    <EmptyState
      v-else-if="!comics.length"
      title="换个关键词，遇见新故事"
      description="试试其他主题，或搜索喜欢的作品与作者。"
    >
      <RouterLink to="/search" class="btn btn-primary">去搜索</RouterLink>
    </EmptyState>
    <div v-else class="comic-grid" :aria-busy="loading">
      <ComicCard
        v-for="comic in comics"
        :key="comic.id"
        :comic="comic"
        @click="router.push('/comic/' + encodeURIComponent(comic.id))"
      />
    </div>
    <footer class="page-footer">
      <span>COPYCOPY · 漫画桌面客户端</span>
      <span>DISCOVER · DOWNLOAD · READ</span>
    </footer>
  </div>
</template>
