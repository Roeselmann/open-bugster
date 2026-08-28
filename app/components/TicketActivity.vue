<script setup lang="ts">
import { History } from '@lucide/vue'
import type { ActivityKind, TicketActivityEntry } from '~~/shared/types/domain'

const props = defineProps<{ ticketId: string; refreshKey?: number }>()

const entries = ref<TicketActivityEntry[]>([])
const open = ref(false)

const timeFormat = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

async function load() {
  try {
    const response = await $fetch<{ activity: TicketActivityEntry[] }>(`/api/tickets/${props.ticketId}/activity`)
    entries.value = response.activity
  } catch {
    entries.value = []
  }
}

watch(() => [props.ticketId, props.refreshKey], load, { immediate: true })

const sentences: Record<ActivityKind, (entry: TicketActivityEntry) => string> = {
  created: entry => (entry.payload.source ? `imported this ${entry.payload.source} from TestFlight` : `created this ticket in ${entry.payload.lane || 'the board'}`),
  moved: entry => `moved it from ${entry.payload.from || 'a lane'} to ${entry.payload.to || 'another lane'}`,
  assigned: entry => `assigned it to ${entry.payload.to}`,
  unassigned: () => 'removed the assignee',
  priority: entry => `changed the priority from ${entry.payload.from} to ${entry.payload.to}`,
  due_date: entry => (entry.payload.to ? `set the due date to ${entry.payload.to}` : 'removed the due date'),
  archived: () => 'archived it',
  restored: entry => `restored it to ${entry.payload.lane || 'the board'}`,
  commented: () => 'wrote a comment',
}

function sentence(entry: TicketActivityEntry) {
  return sentences[entry.kind]?.(entry) || entry.kind
}

function actor(entry: TicketActivityEntry) {
  return entry.actor ? displayName(entry.actor) : 'TestFlight'
}
</script>

<template>
  <section v-if="entries.length" class="border-t border-[var(--line)] pt-6">
    <button
      type="button"
      class="focus-ring flex items-center gap-1.5 rounded-lg text-xs font-bold uppercase tracking-[.08em]"
      :aria-expanded="open"
      @click="open = !open"
    >
      <History :size="14" aria-hidden="true" /> History
      <span class="muted font-semibold tabular-nums">{{ entries.length }}</span>
      <span class="muted font-medium normal-case tracking-normal">{{ open ? '· hide' : '· show' }}</span>
    </button>

    <ol v-if="open" class="mt-3 space-y-2">
      <li v-for="entry in entries" :key="entry.id" class="muted flex items-baseline gap-2 text-xs leading-relaxed">
        <span class="shrink-0 tabular-nums">{{ timeFormat.format(new Date(entry.createdAt)) }}</span>
        <span><strong class="font-semibold text-[var(--ink)]">{{ actor(entry) }}</strong> {{ sentence(entry) }}</span>
      </li>
    </ol>
  </section>
</template>
