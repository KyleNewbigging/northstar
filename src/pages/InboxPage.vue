<script setup lang="ts">
import { ref } from 'vue'

type Task = {
  id: number
  title: string
  done: boolean
}

const nextId = ref(3)
const newTaskTitle = ref('')
const tasks = ref<Task[]>([
  { id: 1, title: 'Capture the top 3 priorities for today', done: false },
  { id: 2, title: 'Write a first pass project outline', done: true },
])

const addTask = () => {
  const title = newTaskTitle.value.trim()
  if (!title) {
    return
  }

  tasks.value.unshift({
    id: nextId.value++,
    title,
    done: false,
  })
  newTaskTitle.value = ''
}

const removeTask = (id: number) => {
  tasks.value = tasks.value.filter((task) => task.id !== id)
}
</script>

<template>
  <section class="inbox">
    <header class="heading">
      <h1>Inbox</h1>
      <p>Quick capture. Add anything that needs action.</p>
    </header>

    <form class="composer" @submit.prevent="addTask">
      <input
        v-model="newTaskTitle"
        type="text"
        placeholder="What needs to get done?"
        aria-label="New task title"
      />
      <button type="submit">Add</button>
    </form>

    <ul class="task-list">
      <li v-for="task in tasks" :key="task.id" class="task">
        <label>
          <input v-model="task.done" type="checkbox" />
          <span :class="{ done: task.done }">{{ task.title }}</span>
        </label>
        <button class="delete" type="button" @click="removeTask(task.id)">Delete</button>
      </li>
      <li v-if="tasks.length === 0" class="empty">No tasks yet. Add one above.</li>
    </ul>
  </section>
</template>

<style scoped>
.inbox {
  max-width: 760px;
}

.heading h1 {
  margin: 0;
}

.heading p {
  margin-top: 8px;
  color: #6b7280;
}

.composer {
  display: flex;
  gap: 10px;
  margin: 20px 0;
}

.composer input {
  flex: 1;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 10px 12px;
  font: inherit;
}

.composer button {
  border: 1px solid #111827;
  border-radius: 8px;
  padding: 10px 14px;
  background: #111827;
  color: #fff;
  cursor: pointer;
  font: inherit;
}

.task-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}

.task {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 10px 12px;
}

.task label {
  display: flex;
  align-items: center;
  gap: 10px;
}

.done {
  color: #6b7280;
  text-decoration: line-through;
}

.delete {
  border: 0;
  background: transparent;
  color: #dc2626;
  cursor: pointer;
  font: inherit;
}

.empty {
  color: #6b7280;
  padding: 6px 0;
}
</style>
