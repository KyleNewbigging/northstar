<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const projectId = computed(() => String(route.params.id ?? 'unknown'))
</script>

<template>
  <section>
    <h1>Project Detail</h1>
    <p>Project ID: <strong>{{ projectId }}</strong></p>
  </section>
</template>
