import { createRouter, createWebHistory } from 'vue-router'

import TodayPage from './pages/TodayPage.vue'
import InboxPage from './pages/InboxPage.vue'
import ProjectsPage from './pages/ProjectsPage.vue'
import ProjectDetailPage from './pages/ProjectDetailPage.vue'
import TimelinePage from './pages/TimelinePage.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/today' },
    { path: '/today', component: TodayPage },
    { path: '/inbox', component: InboxPage },
    { path: '/projects', component: ProjectsPage },
    { path: '/projects/:id', component: ProjectDetailPage },
    { path: '/timeline', component: TimelinePage },
  ],
})

export default router