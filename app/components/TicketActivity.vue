<script setup lang="ts">
import { History } from '@lucide/vue'
import type { ActivityKind, TicketActivityEntry } from '~~/shared/types/domain'
import { providerLabel } from '~~/shared/utils/ticket-source'

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
  created: entry => (entry.payload.source ? `imported this ${entry.payload.source} from ${providerLabel(entry.payload.provider)}` : `created this ticket in ${entry.payload.lane || 'the board'}`),
  moved: entry => `moved it from ${entry.payload.from || 'a lane'} to ${entry.payload.to || 'another lane'}`,
  assigned: entry => `assigned it to ${personName(entry, 'to')}`,
  unassigned: () => 'removed the assignee',
  author: entry => (entry.payload.to ? `attributed it to ${personName(entry, 'to')}` : 'removed the attribution'),
  priority: entry => `changed the priority from ${entry.payload.from} to ${entry.payload.to}`,
  due_date: entry => (entry.payload.to ? `set the due date to ${entry.payload.to}` : 'removed the due date'),
  type: entry => (entry.payload.to ? `set the type to ${entry.payload.to}` : 'removed the type'),
  archived: () => 'archived it',
  restored: entry => `restored it to ${entry.payload.lane || 'the board'}`,
  commented: () => 'wrote a comment',
}

/**
 * A person-valued payload key holds an id; the entry carries the resolved person beside it,
 * so an account that has since been erased reads as such instead of leaking an address.
 */
function personName(entry: TicketActivityEntry, key: string) {
  const person = entry.payloadPeople?.[key]
  return person ? displayName(person) : 'somebody'
}

function sentence(entry: TicketActivityEntry) {
  return sentences[entry.kind]?.(entry) || entry.kind
}

// An entry without an actor was written by an import; the payload says which one, and the
// entries from before there was a choice were all TestFlight.
function actor(entry: TicketActivityEntry) {
  return entry.actor ? displayName(entry.actor) : providerLabel(entry.payload.provider)
}

/**
 * What performed the change, when that was not a person at a keyboard.
 *
 * The person still answers for it — an agent's reach is exactly its principal's — so this
 * reads as a quiet aside rather than as a second actor. Everything written before agents
 * existed has no label and shows nothing.
 */
function via(entry: TicketActivityEntry): string | null {
  if (!entry.agentId) return null
  return entry.agentId
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
        <span>
          <strong class="font-semibold text-[var(--ink)]">{{ actor(entry) }}</strong>
          <span v-if="via(entry)" class="muted" :title="`Performed by ${via(entry)} on their behalf`"> via {{ via(entry) }}</span>
          {{ sentence(entry) }}
        </span>
      </li>
    </ol>
  </section>
</template>
