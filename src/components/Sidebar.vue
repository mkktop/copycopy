<script setup lang="ts">
import { useAppStore } from '../stores/app'
import { useDownloadStore } from '../stores/downloads'
import AppIcon from './AppIcon.vue'
import BrandMark from './BrandMark.vue'
const app = useAppStore()
const downloads = useDownloadStore()
const version = __APP_VERSION__
const groups = [
  {
    label: '探索 / EXPLORE',
    items: [
      { path: '/', icon: 'compass', label: '发现故事' },
      { path: '/search', icon: 'search', label: '搜索与探索' }
    ]
  },
  {
    label: '我的 / COLLECTION',
    items: [
      { path: '/library', icon: 'library', label: '本地书库' },
      { path: '/subscriptions', icon: 'heart', label: '追更订阅' },
      { path: '/downloads', icon: 'download', label: '下载管理' }
    ]
  }
]
</script>
<template>
  <aside class="sidebar" :class="{ collapsed: app.settings.sidebarCollapsed }">
    <RouterLink to="/" class="sidebar-brand" title="CopyCopy 首页">
      <BrandMark />
      <span class="brand-type brand-copy">
        copy
        <span>COPYCOPY · MANGA DESKTOP</span>
      </span>
    </RouterLink>
    <nav class="sidebar-navigation" aria-label="主导航">
      <div v-for="group in groups" :key="group.label" class="nav-group">
        <span class="nav-heading">{{ group.label }}</span>
        <RouterLink
          v-for="item in group.items"
          :key="item.path"
          :to="item.path"
          class="nav-item"
          :title="item.label"
          exact-active-class="active"
        >
          <AppIcon :name="item.icon" />
          <span>{{ item.label }}</span>
          <span v-if="item.path === '/downloads' && downloads.busy" class="queue-count">
            {{ downloads.counts.pending + downloads.counts.running }}
          </span>
          <span v-else class="nav-active-dot" />
        </RouterLink>
      </div>
    </nav>
    <div class="sidebar-note">
      <AppIcon name="book" :size="24" />
      <p>把好故事留在身边。</p>
      <span>发现灵感 · 收藏本地 · 随时阅读</span>
      <div class="note-line" />
    </div>
    <div class="sidebar-bottom">
      <RouterLink to="/settings" class="nav-item" active-class="active" title="偏好设置">
        <AppIcon name="settings" />
        <span>偏好设置</span>
      </RouterLink>
      <button
        class="nav-item collapse-btn"
        :title="app.settings.sidebarCollapsed ? '展开导航' : '收起导航'"
        @click="app.run(() => app.save({ sidebarCollapsed: !app.settings.sidebarCollapsed }))"
      >
        <AppIcon :name="app.settings.sidebarCollapsed ? 'chevron-right' : 'chevron-left'" />
        <span>收起导航</span>
      </button>
    </div>
    <div class="sidebar-profile sidebar-version">
      <span class="avatar"><AppIcon name="book" :size="19" /></span>
      <span class="profile-info">
        <strong>CopyCopy Desktop</strong>
        <small>v{{ version }} · 让阅读更简单</small>
      </span>
    </div>
  </aside>
</template>
