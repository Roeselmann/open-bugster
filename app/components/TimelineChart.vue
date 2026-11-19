<script setup lang="ts">
import { ChevronDown, ChevronRight, Diamond, EyeOff } from '@lucide/vue'
import type { TimelineNode } from '~~/shared/types/domain'
import { boardToday, daysUntil } from '~~/shared/utils/due-date'
import { flattenTimeline, isMilestone, liveSpanOf, spanOf, timelineBounds } from '~~/shared/utils/timeline'

/**
 * The chart of a timeline: one row per ticket, its bar across the days. Drawn the same in the
 * ticket editor and full screen; `size` only changes how much room the names get. Which
 * branches are folded belongs to the caller, so both views stay in step.
 */
const props = withDefaults(defineProps<{
  timeline: TimelineNode
  /** Tickets with a warning on them, drawn orange — red when overdue. */
  warned: ReadonlySet<string>
  collapsed: ReadonlySet<string>
  size?: 'compact' | 'full'
}>(), { size: 'compact' })
const emit = defineEmits<{ toggle: [path: string] }>()

const today = boardToday()
const full = computed(() => props.size === 'full')
// One width for the name column, shared by the rows and the gridlines behind them.
const labelColumn = computed(() => (full.value ? 'min(24rem, 38%)' : '50%'))

const rows = computed(() => flattenTimeline(props.timeline, props.collapsed))

// The visible range: everything dated, plus today when it is close, padded by a day each side.
const range = computed(() => {
  const bounds = timelineBounds(props.timeline)
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

// Month starts as gridlines; weeks (Mondays) as well when there is room for them: under two
// months in the editor, under six full screen.
const ticks = computed(() => {
  if (!range.value) return []
  const result: Array<{ date: string; label: string | null; major: boolean }> = []
  const weekly = totalDays.value <= (full.value ? 183 : 62)
  for (let date = range.value.start; date <= range.value.end; date = shift(date, 1)) {
    const value = new Date(`${date}T00:00:00Z`)
    if (value.getUTCDate() === 1) result.push({ date, label: monthFormatter.format(value), major: true })
    else if (weekly && value.getUTCDay() === 1 && clearOfMonthStart(value)) result.push({ date, label: String(value.getUTCDate()), major: false })
  }
  return result
})
/** A week label within three days of a month's first would print over the month's name. */
function clearOfMonthStart(value: Date) {
  const day = value.getUTCDate()
  const daysInMonth = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate()
  return day > 3 && day < daysInMonth - 2
}
const hasLiveWindows = computed(() => flattenTimeline(props.timeline).some(({ node }) => liveSpanOf(node)))
const todayVisible = computed(() => Boolean(range.value && today >= range.value.start && today <= range.value.end))

function barClass(node: TimelineNode) {
  if (!node.readable) return 'border border-dashed border-[var(--muted)] bg-transparent'
  if (node.done) return 'bg-emerald-500/70'
  if (props.warned.has(node.id) && node.dueDate && node.dueDate < today) return 'bg-rose-600'
  if (props.warned.has(node.id)) return 'bg-orange-400'
  return 'bg-[var(--accent)]'
}
function spanLabel(node: TimelineNode) {
  const span = spanOf(node)
  const live = liveSpanOf(node)
  const work = span ? (span.start === span.end ? dayOf(span.start) : `${dayOf(span.start)} – ${dayOf(span.end)}`) : null
  const out = live ? `live ${dayOf(live.start)} – ${dayOf(live.end)}` : null
  return [work, out].filter(Boolean).join(' · ') || 'No dates'
}
// The live window sits behind the work as a thin, pale band: sky while running or ahead,
// rose once it has ended and the ticket is still in a live lane.
function liveClass(node: TimelineNode) {
  if (node.live && node.liveUntil && node.liveUntil < today) return 'bg-rose-500/40'
  return node.live ? 'bg-sky-500/55' : 'bg-sky-500/30'
}
const hrefOf = (node: TimelineNode) => `/b/${node.boardId}?ticket=${node.ticketNumber}`

</script>

<template>
  <p v-if="!range" class="muted text-sm">Nothing here has a start or due date yet. Give the subtickets dates to see them on a timeline.</p>
  <div v-else class="surface-strong overflow-hidden rounded-xl" :style="{ '--timeline-label': labelColumn }">
    <!-- The scale: month starts, and weeks when there is room. -->
    <div class="sticky top-0 z-10 grid grid-cols-[var(--timeline-label)_minmax(0,1fr)] border-b border-[var(--line)] bg-[var(--panel-strong)] font-semibold uppercase tracking-wider" :class="full ? 'text-[11px]' : 'text-[10px]'">
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
      <div class="pointer-events-none absolute inset-y-0 right-0 left-[var(--timeline-label)]" aria-hidden="true">
        <span v-for="tick in ticks" :key="tick.date" class="absolute inset-y-0 w-px" :class="tick.major ? 'bg-[var(--line)]' : 'bg-[color-mix(in_srgb,var(--line)_45%,transparent)]'" :style="{ left: `${offset(tick.date)}%` }" />
        <span v-if="todayVisible" class="absolute inset-y-0 w-0.5 bg-rose-500/70" :style="{ left: `${offset(today)}%` }" title="Today" />
      </div>

      <div
        v-for="{ node, depth, path } in rows"
        :key="path"
        class="relative grid grid-cols-[var(--timeline-label)_minmax(0,1fr)] items-center border-b border-[var(--line)] last:border-b-0"
        :class="depth === 0 ? 'bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]' : ''"
      >
        <div class="flex min-w-0 items-center gap-1 pr-2" :class="full ? 'py-2' : 'py-1.5'" :style="{ paddingLeft: `${6 + depth * (full ? 16 : 12)}px` }">
          <button
            v-if="node.children.length"
            type="button"
            class="focus-ring muted grid size-5 shrink-0 place-items-center rounded hover:bg-[var(--panel)]"
            :aria-label="collapsed.has(path) ? `Show subtickets of #${node.ticketNumber}` : `Hide subtickets of #${node.ticketNumber}`"
            :aria-expanded="!collapsed.has(path)"
            @click="emit('toggle', path)"
          >
            <component :is="collapsed.has(path) ? ChevronRight : ChevronDown" :size="13" />
          </button>
          <span v-else class="size-5 shrink-0" />
          <TicketTypeBadge v-if="node.type" :type="node.type" size="sm" />
          <div class="min-w-0 flex-1">
            <NuxtLink
              v-if="node.readable && depth > 0"
              :to="hrefOf(node)"
              class="focus-ring flex min-w-0 items-baseline gap-1.5 rounded font-semibold hover:text-[var(--accent)]"
              :class="full ? 'text-sm' : 'text-xs'"
              :title="`Open #${node.ticketNumber}`"
            >
              <span class="truncate" :class="node.done ? 'muted line-through' : ''">{{ node.title }}</span>
            </NuxtLink>
            <span v-else class="flex min-w-0 items-baseline gap-1.5 font-semibold" :class="full ? 'text-sm' : 'text-xs'">
              <span class="truncate">{{ node.title }}</span>
              <EyeOff v-if="!node.readable" :size="11" class="muted shrink-0 self-center" aria-label="On a board you cannot open" />
            </span>
            <!-- The number leads the second line, as in the to-dos, so the titles line up. -->
            <span class="muted block truncate" :class="full ? 'text-xs' : 'text-[10px]'"><span class="font-semibold tabular-nums">#{{ node.ticketNumber }}</span> · {{ node.boardName }} · {{ node.laneName }}<template v-if="full"> · {{ spanLabel(node) }}</template></span>
          </div>
        </div>

        <div class="relative" :class="full ? 'h-11' : 'h-9'" :title="`#${node.ticketNumber} · ${spanLabel(node)} · ${node.laneName}`">
          <span
            v-if="liveSpanOf(node)"
            class="absolute top-1/2 h-2 -translate-y-1/2 rounded-full"
            :class="liveClass(node)"
            :style="{ left: `${offset(liveSpanOf(node)!.start)}%`, width: `${Math.max(0.8, offset(liveSpanOf(node)!.end, true) - offset(liveSpanOf(node)!.start))}%` }"
          />
          <template v-if="spanOf(node)">
            <Diamond
              v-if="isMilestone(node)"
              :size="full ? 16 : 14"
              class="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
              :class="node.done ? 'fill-emerald-500 text-emerald-500' : 'fill-[var(--accent)] text-[var(--accent)]'"
              :style="{ left: `${(offset(spanOf(node)!.start) + offset(spanOf(node)!.end, true)) / 2}%` }"
            />
            <span
              v-else
              class="absolute top-1/2 -translate-y-1/2 rounded-full"
              :class="[barClass(node), full ? 'h-4' : 'h-3.5']"
              :style="{ left: `${offset(spanOf(node)!.start)}%`, width: `${Math.max(0.8, offset(spanOf(node)!.end, true) - offset(spanOf(node)!.start))}%` }"
            />
          </template>
          <span v-else-if="!liveSpanOf(node)" class="muted absolute inset-0 flex items-center px-2 text-[10px] italic">No dates</span>
        </div>
      </div>
    </div>
    <!-- Two kinds of bar once any ticket is out in the world; worth saying which is which. -->
    <div v-if="hasLiveWindows" class="muted flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--line)] px-3 py-1.5 text-[10px] font-semibold">
      <span class="flex items-center gap-1.5"><span class="h-2.5 w-5 rounded-full bg-[var(--accent)]" /> Work: start to due date</span>
      <span class="flex items-center gap-1.5"><span class="h-1.5 w-5 rounded-full bg-sky-500/55" /> Live window</span>
      <span class="flex items-center gap-1.5"><span class="h-0.5 w-3 bg-rose-500/70" /> Today</span>
    </div>
  </div>
</template>
