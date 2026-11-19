<script setup lang="ts">
import { ChevronDown, ChevronRight, ChartGantt, Diamond, EyeOff, LoaderCircle, TriangleAlert } from '@lucide/vue'
import type { TimelineNode } from '~~/shared/types/domain'
import { boardToday, daysUntil } from '~~/shared/utils/due-date'
import { flattenTimeline, isMilestone, spanOf, timelineBounds, timelineWarnings } from '~~/shared/utils/timeline'

/**
 * The plan below a ticket: it and its subtickets, down through theirs, as bars across their
 * days. Read fresh from the server whenever `refreshKey` changes, because a subticket on
 * another board can move without this ticket knowing.
 */
const props = defineProps<{ ticketId: string; refreshKey?: string }>()

const timeline = ref<TimelineNode | null>(null)
const loading = ref(false)
const failed = ref(false)
const collapsed = ref(new Set<string>())
const today = boardToday()

async function load() {
  loading.value = true
  try {
    timeline.value = (await $fetch<{ timeline: TimelineNode }>(`/api/tickets/${props.ticketId}/timeline`)).timeline
    failed.value = false
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}
watch(() => [props.ticketId, props.refreshKey], load, { immediate: true })

const rows = computed(() => (timeline.value ? flattenTimeline(timeline.value, collapsed.value) : []))
const warnings = computed(() => (timeline.value ? timelineWarnings(timeline.value, today) : []))
const warned = computed(() => new Set(warnings.value.map(warning => warning.ticketId)))

// The visible range: everything dated, plus today when it is close, padded by a day each side.
const range = computed(() => {
  const bounds = timeline.value ? timelineBounds(timeline.value) : null
  if (!bounds) return null
  let start = bounds.start
  let end = bounds.end
  if (today < start && (daysUntil(start, today) ?? 0) <= 14) start = today
  if (today > end && (daysUntil(today, end) ?? 0) <= 14) end = today
  return { start: shift(start, -1), end: shift(end, 1) }
})
const totalDays = computed(() => (range.value ? (daysUntil(range.value.end, range.value.start) ?? 0) + 1 : 0))

function shift(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
/** Where a day sits across the chart, in percent; `end` puts it at the close of that day. */
function offset(date: string, end = false) {
  if (!range.value || !totalDays.value) return 0
  const days = (daysUntil(date, range.value.start) ?? 0) + (end ? 1 : 0)
  return Math.min(100, Math.max(0, (days / totalDays.value) * 100))
}

const monthFormatter = new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' })
const dayFormatter = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const dayOf = (date: string) => dayFormatter.format(new Date(`${date}T00:00:00Z`))

// Month starts as gridlines; with less than two months on screen, weeks (Mondays) as well.
const ticks = computed(() => {
  if (!range.value) return []
  const result: Array<{ date: string; label: string | null; major: boolean }> = []
  const weekly = totalDays.value <= 62
  for (let date = range.value.start; date <= range.value.end; date = shift(date, 1)) {
    const value = new Date(`${date}T00:00:00Z`)
    if (value.getUTCDate() === 1) result.push({ date, label: monthFormatter.format(value), major: true })
    else if (weekly && value.getUTCDay() === 1) result.push({ date, label: String(value.getUTCDate()), major: false })
  }
  return result
})
const todayVisible = computed(() => Boolean(range.value && today >= range.value.start && today <= range.value.end))

function toggle(path: string) {
  const next = new Set(collapsed.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  collapsed.value = next
}

function barClass(node: TimelineNode) {
  if (!node.readable) return 'border border-dashed border-[var(--muted)] bg-transparent'
  if (node.done) return 'bg-emerald-500/70'
  if (warned.value.has(node.id) && node.dueDate && node.dueDate < today) return 'bg-rose-600'
  if (warned.value.has(node.id)) return 'bg-orange-400'
  return 'bg-[var(--accent)]'
}
function spanLabel(node: TimelineNode) {
  const span = spanOf(node)
  if (!span) return 'No dates'
  return span.start === span.end ? dayOf(span.start) : `${dayOf(span.start)} – ${dayOf(span.end)}`
}
const hrefOf = (node: TimelineNode) => `/b/${node.boardId}?ticket=${node.ticketNumber}`
</script>

<template>
  <section class="space-y-3" aria-labelledby="ticket-timeline-heading">
    <div class="flex items-center gap-2">
      <h3 id="ticket-timeline-heading" class="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><ChartGantt :size="15" /> Timeline</h3>
      <LoaderCircle v-if="loading" :size="13" class="muted animate-spin" aria-label="Loading" />
      <span v-if="range" class="muted ml-auto text-[11px] font-semibold tabular-nums">{{ dayOf(shift(range.start, 1)) }} – {{ dayOf(shift(range.end, -1)) }}</span>
    </div>

    <p v-if="failed" class="muted text-sm">The timeline could not be loaded.</p>
    <template v-else-if="timeline">
      <ul v-if="warnings.length" class="space-y-1 rounded-xl bg-orange-400/10 p-2.5 text-xs text-orange-800 dark:text-orange-200">
        <li v-for="warning in warnings" :key="`${warning.kind}-${warning.ticketId}`" class="flex items-start gap-1.5">
          <TriangleAlert :size="13" class="mt-px shrink-0" aria-hidden="true" /> <span>{{ warning.message }}</span>
        </li>
      </ul>

      <p v-if="!range" class="muted text-sm">Nothing here has a start or due date yet. Give the subtickets dates to see them on a timeline.</p>
      <div v-else class="surface-strong overflow-hidden rounded-xl">
        <!-- The scale: month starts, and weeks when the range is short. -->
        <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] border-b border-[var(--line)] text-[10px] font-semibold uppercase tracking-wider">
          <div class="muted px-3 py-1.5">Ticket</div>
          <div class="relative h-6">
            <span
              v-for="tick in ticks"
              :key="tick.date"
              class="absolute top-1.5 -translate-x-1/2 whitespace-nowrap"
              :class="tick.major ? '' : 'muted font-medium normal-case tracking-normal'"
              :style="{ left: `${offset(tick.date)}%` }"
            >{{ tick.label }}</span>
          </div>
        </div>

        <div class="relative">
          <!-- Gridlines and today behind every row, drawn once for the whole chart. -->
          <div class="pointer-events-none absolute inset-y-0 right-0 w-1/2" aria-hidden="true">
            <span v-for="tick in ticks" :key="tick.date" class="absolute inset-y-0 w-px" :class="tick.major ? 'bg-[var(--line)]' : 'bg-[color-mix(in_srgb,var(--line)_45%,transparent)]'" :style="{ left: `${offset(tick.date)}%` }" />
            <span v-if="todayVisible" class="absolute inset-y-0 w-0.5 bg-rose-500/70" :style="{ left: `${offset(today)}%` }" title="Today" />
          </div>

          <div
            v-for="{ node, depth, path } in rows"
            :key="path"
            class="relative grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center border-b border-[var(--line)] last:border-b-0"
            :class="depth === 0 ? 'bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]' : ''"
          >
            <div class="flex min-w-0 items-center gap-1 py-1.5 pr-2" :style="{ paddingLeft: `${6 + depth * 12}px` }">
              <button
                v-if="node.children.length"
                type="button"
                class="focus-ring muted grid size-5 shrink-0 place-items-center rounded hover:bg-[var(--panel)]"
                :aria-label="collapsed.has(path) ? `Show subtickets of #${node.ticketNumber}` : `Hide subtickets of #${node.ticketNumber}`"
                :aria-expanded="!collapsed.has(path)"
                @click="toggle(path)"
              >
                <component :is="collapsed.has(path) ? ChevronRight : ChevronDown" :size="13" />
              </button>
              <span v-else class="size-5 shrink-0" />
              <TicketTypeBadge v-if="node.type" :type="node.type" size="sm" />
              <div class="min-w-0 flex-1">
                <NuxtLink
                  v-if="node.readable && depth > 0"
                  :to="hrefOf(node)"
                  class="focus-ring flex min-w-0 items-baseline gap-1.5 rounded text-xs font-semibold hover:text-[var(--accent)]"
                  :title="`Open #${node.ticketNumber}`"
                >
                  <span class="muted shrink-0 tabular-nums">#{{ node.ticketNumber }}</span>
                  <span class="truncate" :class="node.done ? 'muted line-through' : ''">{{ node.title }}</span>
                </NuxtLink>
                <span v-else class="flex min-w-0 items-baseline gap-1.5 text-xs font-semibold">
                  <span class="muted shrink-0 tabular-nums">#{{ node.ticketNumber }}</span>
                  <span class="truncate">{{ node.title }}</span>
                  <EyeOff v-if="!node.readable" :size="11" class="muted shrink-0 self-center" aria-label="On a board you cannot open" />
                </span>
                <span class="muted block truncate text-[10px]">{{ node.boardName }} · {{ node.laneName }}</span>
              </div>
            </div>

            <div class="relative h-9" :title="`#${node.ticketNumber} · ${spanLabel(node)} · ${node.laneName}`">
              <template v-if="spanOf(node)">
                <Diamond
                  v-if="isMilestone(node)"
                  :size="14"
                  class="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
                  :class="node.done ? 'fill-emerald-500 text-emerald-500' : 'fill-[var(--accent)] text-[var(--accent)]'"
                  :style="{ left: `${(offset(spanOf(node)!.start) + offset(spanOf(node)!.end, true)) / 2}%` }"
                />
                <span
                  v-else
                  class="absolute top-1/2 h-3.5 -translate-y-1/2 rounded-full"
                  :class="barClass(node)"
                  :style="{ left: `${offset(spanOf(node)!.start)}%`, width: `${Math.max(0.8, offset(spanOf(node)!.end, true) - offset(spanOf(node)!.start))}%` }"
                />
              </template>
              <span v-else class="muted absolute inset-0 flex items-center px-2 text-[10px] italic">No dates</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
