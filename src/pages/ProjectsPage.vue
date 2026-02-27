<script setup lang="ts">
import { RouterLink } from 'vue-router'

const projects = [
  { id: 'alpha', name: 'Alpha Launch' },
  { id: 'beta', name: 'Beta Cleanup' },
]
</script>

<template>
  <section>
    <h1>Projects</h1>
    <ul class="projects">
      <li v-for="project in projects" :key="project.id">
        <RouterLink :to="`/projects/${project.id}`">{{ project.name }}</RouterLink>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.projects {
  padding-left: 18px;
}
</style>
