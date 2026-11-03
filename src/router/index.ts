import { createRouter, createWebHashHistory } from 'vue-router'
export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('../views/HomeView.vue') },
    { path: '/search', name: 'search', component: () => import('../views/SearchView.vue') },
    { path: '/comic/:id', name: 'comic', component: () => import('../views/ComicDetailView.vue') },
    { path: '/library', name: 'library', component: () => import('../views/LibraryView.vue') },
    { path: '/library/:id', name: 'book', component: () => import('../views/LibraryBookView.vue') },
    { path: '/downloads', name: 'downloads', component: () => import('../views/DownloadsView.vue') },
    { path: '/subscriptions', name: 'subscriptions', component: () => import('../views/SubscriptionsView.vue') },
    { path: '/reader/:comicId/:chapterId', name: 'reader', component: () => import('../views/ReaderView.vue') },
    { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})
