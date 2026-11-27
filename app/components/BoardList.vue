<script setup lang="ts">
import { AlarmClock, ChevronDown, ChevronRight, Diamond, ListTodo, MessageSquare, Radio, Repeat, Tag } from '@lucide/vue'
import type { Lane, Ticket } from '~~/shared/types/domain'
import { CATEGORY_TONE_CLASSES } from '~~/shared/utils/constants'
import { dueLevel } from '~~/shared/utils/due-date'
import { todoLight } from '~~/shared/utils/todo-progress'

/**
 * The board as a list: each lane a section that folds, its tickets as rows with what a planner
 * scans for — title and the start of the description, type, priority, category, labels, who
 * has it, its dates and to-dos. A row opens the ticket, as a card does. Which lanes are folded
 * is remembered per board in this browser.
 */
const props = withDefaults(defineProps<{
  boardId: string
  lanes: Lane[]
  tickets: Ticket[]
  dueWarningDays?: number
  dueAlertDays?: number
  /** The ticket open in the detail panel, marked on its row. */
  selectedId?: string | null
}>(), { selectedId: null, dueWarningDays: 7, dueAlertDays: 1 })
const emit = defineEmits<{ open: [ticket: Ticket] }>()

const today = useBoardToday()

const ticketsFor = (laneId: string) => props.tickets
  .filter(ticket => ticket.laneId === laneId)
  .sort((a, b) => a.position - b.position)
// The import lane only earns a section once something has landed in it, as on the board.
const sections = computed(() => props.lanes
  .map(lane => ({ lane, tickets: ticketsFor(lane.id) }))
  .filter(({ lane, tickets }) => !lane.isImport || tickets.length > 0))

const storageKey = computed(() => `open-bugster-list-collapsed:${props.boardId}`)
const collapsed = ref(new Set<string>())
function loadCollapsed() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey.value) || '[]')
    collapsed.value = new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    collapsed.value = new Set()
  }
}
onMounted(loadCollapsed)
watch(storageKey, loadCollapsed)
function toggle(laneId: string) {
  const next = new Set(collapsed.value)
  if (next.has(laneId)) next.delete(laneId)
  else next.add(laneId)
  collapsed.value = next
  try {
    localStorage.setItem(storageKey.value, JSON.stringify([...next]))
  } catch { /* A private window keeps it for the visit only. */ }
}
const allCollapsed = computed(() => sections.value.every(({ lane }) => collapsed.value.has(lane.id)))
function toggleAll() {
  const next = allCollapsed.value ? new Set<string>() : new Set(sections.value.map(({ lane }) => lane.id))
  collapsed.value = next
  try {
    localStorage.setItem(storageKey.value, JSON.stringify([...next]))
  } catch { /* As above. */ }
}

/** The description as one line of plain words: Markdown's marks and links' addresses left out. */
function summaryOf(description: string) {
  return description
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const dayFormatter = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const dayOf = (date: string) => dayFormatter.format(new Date(`${date}T00:00:00Z`))

/** What kind of date a ticket carries and its days in words, as the card tells it. */
function scheduleOf(ticket: Ticket, lane: Lane) {
  const { schedule, startDate, dueDate, liveFrom, liveUntil, dueTime, liveFromTime, liveUntilTime } = ticket
  const at = (day: string, time: string | null) => (time ? `${dayOf(day)}, ${time}` : dayOf(day))
  if (lane.isLive && (liveFrom || liveUntil)) return { icon: Radio, text: `Live ${liveFrom ? at(liveFrom, liveFromTime) : '…'} – ${liveUntil ? at(liveUntil, liveUntilTime) : '…'}`, level: 'none' as const }
  if (!dueDate && !startDate) return null
  const level = lane.isDone || lane.isLive ? 'none' : dueLevel(dueDate, today, { warningDays: props.dueWarningDays, alertDays: props.dueAlertDays })
  if (schedule === 'recurring') return { icon: Repeat, text: dueDate ? at(dueDate, dueTime) : '', level }
  if (schedule === 'milestone') return { icon: Diamond, text: dueDate ? at(dueDate, dueTime) : '', level }
  const text = startDate && dueDate && startDate !== dueDate
    ? `${dayOf(startDate)} – ${dayOf(dueDate)}`
    : dueDate ? `Due ${dayOf(dueDate)}` : `Starts ${dayOf(startDate!)}`
  return { icon: liveFrom || liveUntil ? Radio : AlarmClock, text, level }
}
const LEVEL_CLASSES = { none: 'muted', warning: 'text-orange-600', alert: 'text-rose-600' } as const
const PRIORITY_DOT = { low: 'bg-slate-400', medium: 'bg-blue-500', high: 'bg-amber-500', urgent: 'bg-rose-600' } as const
</script>

<template>
  <div class="space-y-3" :style="{ '--list-columns': 'minmax(0,1fr) 3.5rem 9rem minmax(0,11rem) 9.5rem 4.5rem 2rem' }" data-board-list>
    <div class="flex items-center justify-end">
      <button type="button" class="focus-ring muted shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold hover:text-[var(--ink)]" @click="toggleAll">
        {{ allCollapsed ? 'Expand all lanes' : 'Collapse all lanes' }}
      </button>
    </div>
    <!-- The columns named once, over every lane; the rows below share the same grid. -->
    <div class="muted hidden gap-x-4 px-[calc(1rem+1px)] text-[10px] font-semibold uppercase tracking-wider md:grid md:grid-cols-[var(--list-columns)]" aria-hidden="true">
      <span>Ticket</span><span>No.</span><span>Priority · Category</span><span>Labels</span><span>Dates</span><span>To-dos</span><span />
    </div>
    <p v-if="!sections.length" class="muted py-16 text-center text-sm">This board has no lanes yet.</p>
    <section v-for="{ lane, tickets: laneTickets } in sections" :key="lane.id" class="surface overflow-hidden rounded-2xl" :data-list-lane="lane.id">
      <h2>
        <button
          type="button"
          class="focus-ring flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-[var(--panel-strong)]"
          :aria-expanded="!collapsed.has(lane.id)"
          @click="toggle(lane.id)"
        >
          <component :is="collapsed.has(lane.id) ? ChevronRight : ChevronDown" :size="16" class="muted shrink-0" aria-hidden="true" />
          <span class="truncate text-[13px] font-bold uppercase tracking-[.1em]">{{ lane.name }}</span>
          <span class="muted text-xs font-semibold tabular-nums">{{ laneTickets.length }}</span>
        </button>
      </h2>
      <template v-if="!collapsed.has(lane.id)">
        <p v-if="!laneTickets.length" class="muted border-t border-[var(--line)] px-4 py-3 text-sm">No tickets in this lane.</p>
        <ul v-else class="border-t border-[var(--line)]">
          <li v-for="ticket in laneTickets" :key="ticket.id" class="border-b border-[var(--line)] last:border-b-0">
            <!-- The whole row opens the ticket to a pointer; the title is the way in by keyboard. -->
            <div
              class="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-left hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] md:grid md:gap-x-4 md:grid-cols-[var(--list-columns)]"
              :class="ticket.id === selectedId && 'bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] shadow-[inset_3px_0_0_var(--accent)]'"
              :aria-current="ticket.id === selectedId ? 'true' : undefined"
              :data-list-ticket="ticket.ticketNumber"
              @click="emit('open', ticket)"
            >
              <!-- Title and description -->
              <span class="flex min-w-0 flex-1 basis-[calc(100%-4.5rem)] items-start gap-2 md:basis-auto">
                <TicketTypeBadge v-if="ticket.type" :type="ticket.type" size="sm" class="mt-0.5 shrink-0" />
                <span class="min-w-0 flex-1">
                  <ExpandableTitle :text="ticket.title" class="text-sm font-semibold">
                    <button type="button" class="focus-ring rounded text-left hover:text-[var(--accent)]" :title="`Open #${ticket.ticketNumber}`" @click.stop="emit('open', ticket)">{{ ticket.title }}</button>
                  </ExpandableTitle>
                  <span v-if="summaryOf(ticket.description)" class="muted block truncate text-xs">{{ summaryOf(ticket.description) }}</span>
                </span>
              </span>
              <!-- The number in a column of its own, beside the title -->
              <span class="muted shrink-0 self-start pt-px text-xs font-semibold tabular-nums">#{{ ticket.ticketNumber }}</span>
              <!-- Priority and category -->
              <span class="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] font-semibold">
                <span class="inline-flex items-center gap-1"><span class="size-2 rounded-full" :class="PRIORITY_DOT[ticket.priority]" aria-hidden="true" /><span class="capitalize">{{ ticket.priority }}</span></span>
                <span v-if="ticket.category" class="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px]" :class="CATEGORY_TONE_CLASSES[ticket.category.color]"><Tag :size="11" class="shrink-0" /> <span class="truncate">{{ ticket.category.name }}</span></span>
              </span>
              <!-- Labels -->
              <span class="flex min-w-0 flex-wrap gap-1 empty:hidden md:empty:flex">
                <span v-for="label in ticket.labels.slice(0, 3)" :key="label.id" class="max-w-full truncate rounded-md border border-[var(--line)] px-1.5 py-0.5 text-[10px] font-semibold">{{ label.name }}</span>
                <span v-if="ticket.labels.length > 3" class="muted text-[10px] font-semibold" :title="ticket.labels.slice(3).map(label => label.name).join(', ')">+{{ ticket.labels.length - 3 }}</span>
              </span>
              <!-- Dates -->
              <span class="flex min-w-0 items-center gap-1 text-xs font-semibold" :class="scheduleOf(ticket, lane) ? LEVEL_CLASSES[scheduleOf(ticket, lane)!.level] : 'muted'">
                <template v-if="scheduleOf(ticket, lane)">
                  <component :is="scheduleOf(ticket, lane)!.icon" :size="12" class="shrink-0" aria-hidden="true" />
                  <span class="truncate tabular-nums">{{ scheduleOf(ticket, lane)!.text }}</span>
                </template>
              </span>
              <!-- To-dos and comments -->
              <span class="muted flex items-center gap-2.5 text-[11px] font-semibold tabular-nums">
                <span v-if="ticket.todos.length" class="inline-flex items-center gap-1" :title="`${ticket.todos.filter(todo => todo.completed).length} of ${ticket.todos.length} to-dos done`">
                  <TodoLight :light="todoLight(ticket.todos)!" size="sm" /><ListTodo :size="12" aria-hidden="true" />{{ ticket.todos.filter(todo => todo.completed).length }}/{{ ticket.todos.length }}
                </span>
                <span v-if="ticket.commentCount" class="inline-flex items-center gap-1" :title="`${ticket.commentCount} comments`"><MessageSquare :size="12" aria-hidden="true" />{{ ticket.commentCount }}</span>
              </span>
              <!-- Assignee -->
              <span class="ml-auto flex md:ml-0 md:justify-end">
                <UiAvatar v-if="ticket.assignee" :person="ticket.assignee" size="sm" :muted="ticket.assignee.status !== 'active'" :title="displayName(ticket.assignee)" />
              </span>
            </div>
          </li>
        </ul>
      </template>
    </section>
  </div>
</template>
