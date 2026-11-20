<script setup lang="ts">
import { History } from '@lucide/vue'
import type { ActivityKind, RecurrenceFrequency, TicketActivityEntry } from '~~/shared/types/domain'
import { describeRecurrence } from '~~/shared/utils/recurrence'
import { providerLabel } from '~~/shared/utils/ticket-source'

const props = defineProps<{ ticketId: string; refreshKey?: number }>()

const entries = ref<TicketActivityEntry[]>([])

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
  start_date: entry => (entry.payload.to ? `set the start date to ${entry.payload.to}` : 'removed the start date'),
  live_from: entry => (entry.payload.to ? `set the live window to start ${entry.payload.to}` : 'removed the start of the live window'),
  live_until: entry => (entry.payload.to ? `set the live window to end ${entry.payload.to}` : 'removed the end of the live window'),
  schedule: entry => ({ none: 'removed the schedule', milestone: 'made it a milestone', lifecycle: 'gave it a lifecycle', recurring: 'made it recurring' } as Record<string, string>)[entry.payload.to ?? ''] ?? 'changed the schedule',
  due_date: entry => (entry.payload.to ? `set the due date to ${entry.payload.to}` : 'removed the due date'),
  type: entry => (entry.payload.to ? `set the type to ${entry.payload.to}` : 'removed the type'),
  archived: () => 'archived it',
  restored: entry => `restored it to ${entry.payload.lane || 'the board'}`,
  commented: () => 'wrote a comment',
  subticket: entry => `added subticket #${entry.payload.number} “${entry.payload.title}” on ${entry.payload.board || 'a board'}`,
  waits_on: entry => entry.payload.change === 'removed' ? `no longer waits on #${entry.payload.number} “${entry.payload.title}”` : `now waits on #${entry.payload.number} “${entry.payload.title}”`,
  decided: entry => `decided “${entry.payload.question}”: ${entry.payload.answer}`,
  reopened: entry => `reopened the decision “${entry.payload.question}”`,
  strict_order: entry => (entry.payload.to === 'strict' ? 'set the to-dos to strict order' : 'set the to-dos to loose order'),
  went_live: entry => `The live window opened on ${entry.payload.date}`,
  live_ending: entry => `The live window ends on ${entry.payload.date}`,
  live_ended: entry => `The live window ended on ${entry.payload.date}, but the ticket is still live`,
  recurrence: entry => `set it to repeat ${describeRecurrence({ frequency: (entry.payload.frequency ?? 'weekly') as RecurrenceFrequency, interval: Number(entry.payload.interval) || 1, anchor: entry.payload.anchor ?? '' }).replace(/^./, letter => letter.toLowerCase())}, from ${entry.payload.anchor}${entry.payload.until ? ` until ${entry.payload.until}` : ''}`,
  new_round: entry => {
    const how = entry.payload.outcome === 'skipped' ? 'skipped' : 'done'
    const next = entry.payload.next ? `; the next round is due ${entry.payload.next}` : '; that was the last round of the series'
    return entry.channel === 'system'
      ? `The round of ${entry.payload.date} was ${how}${next}`
      : `closed the round of ${entry.payload.date} as ${how}${next}`
  },
  round_missed: entry => `The round of ${entry.payload.date} was missed${entry.payload.next ? `; the next round is due ${entry.payload.next}` : ''}`,
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
// entries from before there was a choice were all TestFlight. The server's own notes about a
// live window have nobody to name and read as a plain sentence.
function actor(entry: TicketActivityEntry) {
  if (entry.channel === 'system') return ''
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
  <!-- It has a tab of its own now, so the list is simply there. -->
  <section>
    <h3 class="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]">
      <History :size="14" aria-hidden="true" /> Activity
      <span v-if="entries.length" class="muted font-semibold tabular-nums">{{ entries.length }}</span>
    </h3>
    <p v-if="!entries.length" class="muted mt-3 text-xs">Nothing recorded yet.</p>

    <ol v-else class="mt-3 space-y-2">
      <li v-for="entry in entries" :key="entry.id" class="muted flex items-baseline gap-2 text-xs leading-relaxed">
        <span class="shrink-0 tabular-nums">{{ timeFormat.format(new Date(entry.createdAt)) }}</span>
        <span>
          <strong v-if="actor(entry)" class="font-semibold text-[var(--ink)]">{{ actor(entry) }}</strong>
          <span v-if="entry.actor?.isService" class="muted"> (agent)</span>
          <span v-if="via(entry)" class="muted" :title="`Performed by ${via(entry)} on their behalf`"> via {{ via(entry) }}</span>
          {{ sentence(entry) }}
        </span>
      </li>
    </ol>
  </section>
</template>
