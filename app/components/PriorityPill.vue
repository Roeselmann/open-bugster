<script setup lang="ts">
import type { TicketPriority } from '~~/shared/types/domain'
import { PRIORITY_LABELS } from '~~/shared/utils/constants'

defineProps<{ priority: TicketPriority }>()
const classes: Record<TicketPriority, string> = {
  low: 'bg-slate-500/10 text-slate-600 dark:text-slate-300',
  medium: 'bg-blue-500/10 text-blue-650 dark:text-blue-300',
  high: 'bg-amber-500/12 text-amber-700 dark:text-amber-300',
  urgent: 'bg-rose-500/12 text-rose-700 dark:text-rose-300'
}
</script>

<template>
  <span class="rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-[.08em]" :class="classes[priority]">
    {{ PRIORITY_LABELS[priority] }}
  </span>
</template>
