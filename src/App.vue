<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'

const navItems = [
  { label: 'Today', to: '/today' },
  { label: 'Inbox', to: '/inbox' },
  { label: 'Projects', to: '/projects' },
  { label: 'Timeline', to: '/timeline' },
]
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">North Star</div>
      <nav class="nav">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="nav-link"
          active-class="is-active"
        >
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>

    <main class="content">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 100vh;
}

.sidebar {
  border-right: 1px solid #e5e7eb;
  background: #f9fafb;
  padding: 20px 14px;
}

.brand {
  font-weight: 700;
  font-size: 1.1rem;
  margin-bottom: 18px;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.nav-link {
  display: block;
  border-radius: 8px;
  padding: 8px 10px;
  color: #374151;
  text-decoration: none;
}

.nav-link:hover {
  background: #eef2ff;
}

.nav-link.is-active {
  background: #e0e7ff;
  color: #312e81;
  font-weight: 600;
}

.content {
  padding: 24px;
}
</style>
