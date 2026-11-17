<script setup lang="ts">
import type { TodoLight } from '~~/shared/utils/todo-progress'
import { TODO_LIGHT_LABELS } from '~~/shared/utils/todo-progress'

/** The to-do traffic light: one lit dot, its meaning spelled out for screen readers. */
withDefaults(defineProps<{ light: TodoLight; size?: 'sm' | 'md' }>(), { size: 'md' })
</script>

<template>
  <span
    role="img"
    :aria-label="TODO_LIGHT_LABELS[light]"
    class="inline-block shrink-0 rounded-full ring-2"
    :class="[
      size === 'sm' ? 'size-2' : 'size-2.5',
      light === 'green' ? 'bg-emerald-500 ring-emerald-500/25'
      : light === 'orange' ? 'bg-orange-400 ring-orange-400/25'
        : 'bg-rose-600 ring-rose-600/25',
    ]"
  />
</template>
