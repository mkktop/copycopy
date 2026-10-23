import { createRouter, createWebHashHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/search' },
    { path: '/search', component: () => import('../views/SearchView.vue') },
    {
      path: '/comic/:pathWord',
      component: () => import('../views/DetailView.vue')
    },
    {
      path: '/downloads',
      component: () => import('../views/DownloadsView.vue')
    },
    { path: '/ai-queue', component: () => import('../views/AiQueueView.vue') },
    {
      path: '/subscriptions',
      component: () => import('../views/SubscriptionsView.vue')
    },
    { path: '/library', component: () => import('../views/LibraryView.vue') },
    {
      path: '/library/:name',
      component: () => import('../views/LibraryComicView.vue')
    },
    {
      path: '/library/:name/:chapter',
      name: 'reader',
      component: () => import('../views/ReaderView.vue')
    },
    { path: '/settings', component: () => import('../views/SettingsView.vue') }
  ]
})
