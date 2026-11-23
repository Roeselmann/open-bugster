<script setup lang="ts">
import { ArrowRightToLine, ChevronDown, ChevronRight, Diamond, EyeOff, LocateFixed, ZoomIn, ZoomOut } from '@lucide/vue'
import type { TimelineNode } from '~~/shared/types/domain'
import { boardToday, daysUntil } from '~~/shared/utils/due-date'
import { flattenForest, flattenTimeline, isMilestone, liveSpanOf, roundMarks, spanOf, timelineBounds } from '~~/shared/utils/timeline'

/**
 * The chart of a timeline: one row per ticket, its bar across the days. Drawn the same in the
 * ticket editor and full screen; `size` only changes how much room the names get. Which
 * branches are folded belongs to the caller, so both views stay in step.
 *
 * On its own it fits everything dated into the width it has. Zoomed, it draws a fixed number of
 * pixels per day instead and scrolls sideways under the names, which stay put; Auto fits again.
 */
const props = withDefaults(defineProps<{
  /** One ticket's tree, its root on top; or a board's tickets, each the root of its own. */
  timeline: TimelineNode | readonly TimelineNode[]
  /** Tickets with a warning on them, drawn orange — red when overdue. */
  warned: ReadonlySet<string>
  collapsed: ReadonlySet<string>
  size?: 'compact' | 'full'
}>(), { size: 'compact' })
const emit = defineEmits<{ toggle: [path: string] }>()

const today = boardToday()
const full = computed(() => props.size === 'full')

// --- Zoom ---------------------------------------------------------------------------------
// The width the chart is given, measured; the name column takes its share and the days the rest.
const viewport = ref<HTMLElement | null>(null)
const viewportWidth = ref(0)
/** Pixels per day while zoomed; null fits everything into the width, as the chart opens. */
const pxPerDay = ref<number | null>(null)
const MIN_PX_PER_DAY = 0.5
const MAX_PX_PER_DAY = 80
const ZOOM_STEP = 1.6
const labelPx = computed(() => (viewportWidth.value ? (full.value ? Math.min(384, viewportWidth.value * 0.38) : viewportWidth.value * 0.5) : 0))
const available = computed(() => Math.max(0, viewportWidth.value - labelPx.value))
// One width for the name column, shared by the rows and the gridlines behind them.
const labelColumn = computed(() => (labelPx.value ? `${labelPx.value}px` : full.value ? 'min(24rem, 38%)' : '50%'))

// A board's timeline has no ticket above the rest: every tree's root is a ticket to open.
const forest = computed(() => Array.isArray(props.timeline))
const flatten = (collapsed?: ReadonlySet<string>) => (Array.isArray(props.timeline)
  ? flattenForest(props.timeline, collapsed)
  : flattenTimeline(props.timeline as TimelineNode, collapsed))
const rows = computed(() => flatten(props.collapsed))

// The fitted range: everything dated, plus today when it is close, padded by a day each side.
const fitRange = computed(() => {
  const bounds = timelineBounds(props.timeline)
  if (!bounds) return null
  let start = bounds.start
  let end = bounds.end
  if (today < start && (daysUntil(start, today) ?? 0) <= 14) start = today
  if (today > end && (daysUntil(today, end) ?? 0) <= 14) end = today
  return { start: shift(start, -1), end: shift(end, 1) }
})
// Zoomed, the range takes in today as well and half a screen beyond either end, so there is
// somewhere to scroll to; zoomed far out it widens until it fills the width.
const range = computed(() => {
  const fit = fitRange.value
  if (!fit || !pxPerDay.value || !available.value) return fit
  const visibleDays = Math.ceil(available.value / pxPerDay.value)
  const margin = Math.max(7, Math.ceil(visibleDays / 2))
  let start = shift(fit.start < today ? fit.start : today, -margin)
  let end = shift(fit.end > today ? fit.end : today, margin)
  const days = (daysUntil(end, start) ?? 0) + 1
  if (days < visibleDays) {
    const extra = Math.ceil((visibleDays - days) / 2)
    start = shift(start, -extra)
    end = shift(end, extra)
  }
  return { start, end }
})
// A recurring ticket's other rounds in view: past ones by how they went, coming ones hollow.
function marksOf(node: TimelineNode) {
  return range.value ? roundMarks(node, range.value.start, range.value.end) : []
}
const ROUND_MARK_CLASSES = {
  done: 'fill-emerald-500 text-emerald-500',
  missed: 'fill-rose-600 text-rose-600',
  skipped: 'fill-transparent text-[var(--muted,currentColor)] opacity-60',
  upcoming: 'fill-transparent text-[var(--accent)] opacity-70'
} as const
const ROUND_MARK_TITLES = { done: 'Round done', missed: 'Round missed', skipped: 'Round skipped', upcoming: 'Coming round' } as const

const totalDays = computed(() => (range.value ? (daysUntil(range.value.end, range.value.start) ?? 0) + 1 : 0))
/** How many pixels a day gets right now, zoomed or fitted; null until the chart is measured. */
const effectivePxPerDay = computed(() => pxPerDay.value ?? (available.value && totalDays.value ? available.value / totalDays.value : null))
const contentWidth = computed(() => (pxPerDay.value && labelPx.value ? `${labelPx.value + totalDays.value * pxPerDay.value}px` : undefined))

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000
/**
 * Zooms to `next` pixels per day, or back to fitting with null, keeping the day under `anchorX`
 * (a point across the chart, the middle of the days by default) where it is on screen.
 */
function setZoom(next: number | null, anchorX?: number) {
  const element = viewport.value
  const before = effectivePxPerDay.value
  const target = next === null ? null : Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, next))
  if (!element || !range.value || !before) {
    pxPerDay.value = target
    return
  }
  const x = anchorX ?? labelPx.value + available.value / 2
  const anchorDay = dayNumber(range.value.start) + (element.scrollLeft + x - labelPx.value) / before
  pxPerDay.value = target
  nextTick(() => {
    if (!pxPerDay.value || !range.value) {
      element.scrollLeft = 0
      return
    }
    element.scrollLeft = labelPx.value + (anchorDay - dayNumber(range.value.start)) * pxPerDay.value - x
  })
}
// The buttons zoom around today while it is on screen, where planning usually starts; once
// it has scrolled out of sight, around the middle of what is.
function buttonAnchor() {
  const perDay = effectivePxPerDay.value
  if (!range.value || !perDay || !todayVisible.value) return undefined
  const x = labelPx.value + (dayNumber(today) + 0.5 - dayNumber(range.value.start)) * perDay - (viewport.value?.scrollLeft ?? 0)
  return x >= labelPx.value && x <= viewportWidth.value ? x : undefined
}
const zoomIn = () => setZoom((effectivePxPerDay.value ?? 1) * ZOOM_STEP, buttonAnchor())
const zoomOut = () => setZoom((effectivePxPerDay.value ?? 1) / ZOOM_STEP, buttonAnchor())
const fitAll = () => setZoom(null)
/** Puts today in the middle of the days, zooming in from the fitted view as it stands. */
function goToToday() {
  if (!pxPerDay.value) pxPerDay.value = effectivePxPerDay.value ?? 4
  nextTick(() => {
    const element = viewport.value
    if (!element || !range.value || !pxPerDay.value) return
    element.scrollLeft = labelPx.value + (dayNumber(today) + 0.5 - dayNumber(range.value.start)) * pxPerDay.value - (labelPx.value + available.value / 2)
  })
}
// A pinch on a trackpad arrives as a wheel with Ctrl held; so does Ctrl or ⌘ with a mouse wheel.
function onWheel(event: WheelEvent) {
  if (!(event.ctrlKey || event.metaKey) || !viewport.value) return
  event.preventDefault()
  const x = event.clientX - viewport.value.getBoundingClientRect().left
  setZoom((effectivePxPerDay.value ?? 1) * Math.exp(-event.deltaY * 0.01), x > labelPx.value ? x : undefined)
}
// Zoomed, the days can be dragged sideways with the mouse; links, buttons and the names keep their clicks.
let pan: { x: number; left: number } | null = null
const panning = ref(false)
function startPan(event: PointerEvent) {
  const element = viewport.value
  if (!element || !pxPerDay.value || event.button !== 0 || event.pointerType !== 'mouse') return
  if ((event.target as HTMLElement).closest('a, button, input')) return
  if (event.clientX - element.getBoundingClientRect().left < labelPx.value) return
  pan = { x: event.clientX, left: element.scrollLeft }
  panning.value = true
  element.setPointerCapture(event.pointerId)
  event.preventDefault()
}
function movePan(event: PointerEvent) {
  if (pan && viewport.value) viewport.value.scrollLeft = pan.left - (event.clientX - pan.x)
}
function endPan() {
  pan = null
  panning.value = false
}

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

// With room for it every day gets its number, centred over the day it names, the month beside
// the first and on the 1st. Less room gets month starts as gridlines, and weeks (Mondays) as
// well when a week is wide enough for its number. Very tight, only every quarter is named, and
// a January by its year. Before the chart is measured, its length decides as a stand-in.
const daily = computed(() => (effectivePxPerDay.value ? effectivePxPerDay.value >= 18 : totalDays.value <= (full.value ? 31 : 16)))
const ticks = computed(() => {
  if (!range.value) return []
  const result: Array<{ date: string; label: string | null; major: boolean }> = []
  if (daily.value) {
    for (let date = range.value.start; date <= range.value.end; date = shift(date, 1)) {
      const value = new Date(`${date}T00:00:00Z`)
      const named = date === range.value.start || value.getUTCDate() === 1
      // A named day is wider than one day; on narrow days its neighbours make room for it.
      const crowded = (effectivePxPerDay.value ?? 40) < 34 && !named
        && (value.getUTCDate() === 2 || shift(date, 1).endsWith('-01') || date === shift(range.value.start, 1))
      result.push({ date, label: named ? dayOf(date) : crowded ? null : String(value.getUTCDate()), major: value.getUTCDate() === 1 })
    }
    return result
  }
  const perDay = effectivePxPerDay.value
  const weekly = perDay ? perDay * 7 >= 34 : totalDays.value <= (full.value ? 183 : 62)
  const quarterly = perDay ? perDay * 30 < 30 : false
  // A week's number keeps clear of the month's name beside it: about 40 pixels, or three days.
  const clearance = perDay ? Math.ceil(40 / perDay) : 3
  for (let date = range.value.start; date <= range.value.end; date = shift(date, 1)) {
    const value = new Date(`${date}T00:00:00Z`)
    if (value.getUTCDate() === 1) {
      const month = value.getUTCMonth()
      const label = month === 0 && (quarterly || totalDays.value > 300) ? String(value.getUTCFullYear()) : monthFormatter.format(value)
      result.push({ date, label: quarterly && month % 3 !== 0 ? null : label, major: true })
    }
    else if (weekly && value.getUTCDay() === 1 && clearOfMonthStart(value, clearance)) result.push({ date, label: String(value.getUTCDate()), major: false })
  }
  return result
})
/** A week label within `days` of a month's first would print over the month's name. */
function clearOfMonthStart(value: Date, days: number) {
  const day = value.getUTCDate()
  const daysInMonth = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate()
  return day > days && day < daysInMonth + 1 - days
}
const hasLiveWindows = computed(() => flatten().some(({ node }) => liveSpanOf(node)))
const todayVisible = computed(() => Boolean(range.value && today >= range.value.start && today <= range.value.end))
/** Today's line runs down the middle of its day, where that day's milestones and rounds sit. */
const todayAt = computed(() => (offset(today) + offset(today, true)) / 2)

/** A due date with no start: a deadline, drawn as an arrow up to a line at the close of its day. */
function isDeadline(node: TimelineNode) {
  return !isMilestone(node) && !node.startDate && Boolean(node.dueDate)
}
function deadlineClass(node: TimelineNode) {
  if (!node.readable) return 'text-[var(--muted)]'
  if (node.done) return 'text-emerald-500'
  if (props.warned.has(node.id) && node.dueDate && node.dueDate < today) return 'text-rose-600'
  if (props.warned.has(node.id)) return 'text-orange-500'
  return 'text-[var(--accent)]'
}

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
// A due date alone is a deadline; with a start it is a span of work; a milestone is its day.
function dateLabel(node: TimelineNode) {
  const span = spanOf(node)!
  if (isMilestone(node)) return dayOf(span.start)
  if (!node.startDate) return `due ${dayOf(span.end)}`
  return span.start === span.end ? dayOf(span.start) : `${dayOf(span.start)} – ${dayOf(span.end)}`
}
// The live window sits behind the work as a thin, pale band: sky while running or ahead,
// rose once it has ended and the ticket is still in a live lane.
function liveClass(node: TimelineNode) {
  if (node.live && node.liveUntil && node.liveUntil < today) return 'bg-rose-500/40'
  return node.live ? 'bg-sky-500/55' : 'bg-sky-500/30'
}
// On the board already shown the link keeps what the page is set to — its view, its lane —
// and only opens the ticket; another board opens on its own defaults.
const route = useRoute()
const hrefOf = (node: TimelineNode) => (route.params.board === node.boardId
  ? { path: route.path, query: { ...route.query, ticket: String(node.ticketNumber) } }
  : `/b/${node.boardId}?ticket=${node.ticketNumber}`)

// Dependencies as arrows, from the end of what a ticket waits on to its own start. Rows grow
// with their names, so where each bar sits is measured rather than assumed.
const body = ref<HTMLElement | null>(null)
const layout = ref<{ left: number; width: number; height: number; centers: number[] } | null>(null)
const markerId = `timeline-arrow-${useId()}`
function measure() {
  if (viewport.value) viewportWidth.value = viewport.value.clientWidth
  const element = body.value
  const cells = element ? [...element.querySelectorAll<HTMLElement>('[data-bar-cell]')] : []
  if (!element || !cells.length) {
    layout.value = null
    return
  }
  const box = element.getBoundingClientRect()
  const first = cells[0]!.getBoundingClientRect()
  layout.value = {
    left: first.left - box.left,
    width: first.width,
    height: box.height,
    centers: cells.map((cell) => {
      const rect = cell.getBoundingClientRect()
      return rect.top - box.top + rect.height / 2
    })
  }
}
let observer: ResizeObserver | null = null
onMounted(() => {
  observer = new ResizeObserver(() => measure())
  if (body.value) observer.observe(body.value)
  if (viewport.value) observer.observe(viewport.value)
  measure()
})
onBeforeUnmount(() => observer?.disconnect())
watch([rows, range, pxPerDay], () => nextTick(measure))

/** Where a ticket's bar or diamond starts and ends across the chart, in pixels, as it is drawn. */
function barEdges(node: TimelineNode, frame: { left: number; width: number }) {
  const span = spanOf(node)
  if (!span) return null
  const x = (percent: number) => frame.left + (percent / 100) * frame.width
  if (isDeadline(node)) {
    const line = x(offset(span.end, true))
    return { start: line - 20, end: line, half: 8 }
  }
  if (isMilestone(node)) {
    const center = x((offset(span.start) + offset(span.end, true)) / 2)
    return { start: center - 6, end: center + 6, half: 6 }
  }
  const from = offset(span.start)
  const width = Math.max(0.8, offset(span.end, true) - from)
  return { start: x(from), end: x(from + width), half: full.value ? 8 : 7 }
}

// Each arrow leaves the blocker's bar from underneath, just inside its end, runs straight down
// (or up) to the waiting ticket's row and turns into the start of its bar. When the waiting
// ticket starts before that end, the line drops straight onto it instead: there is where it
// should have started.
const arrows = computed(() => {
  const frame = layout.value
  if (!frame || frame.centers.length !== rows.value.length) return []
  const rowsOf = new Map<string, number[]>()
  rows.value.forEach(({ node }, index) => rowsOf.set(node.id, [...(rowsOf.get(node.id) ?? []), index]))
  const result: Array<{ key: string; d: string; conflict: boolean }> = []
  rows.value.forEach(({ node }, index) => {
    const target = barEdges(node, frame)
    if (!target) return
    for (const blocker of node.waitsOn) {
      // The blocker's nearest row, when it is under two parents.
      const at = (rowsOf.get(blocker.id) ?? []).reduce<number | null>((best, row) => (best === null || Math.abs(row - index) < Math.abs(best - index) ? row : best), null)
      if (at === null || at === index) continue
      const source = barEdges(rows.value[at]!.node, frame)
      if (!source) continue
      const down = index > at ? 1 : -1
      const x1 = Math.max(source.start + 2, source.end - 5)
      const y1 = frame.centers[at]! + down * source.half
      const y2 = frame.centers[index]!
      const conflict = !blocker.done && !node.done && spanOf(node)!.start < spanOf(rows.value[at]!.node)!.end
      let d: string
      if (target.start - x1 >= 10) {
        const radius = Math.min(6, Math.abs(y2 - y1))
        d = `M ${x1} ${y1} V ${y2 - down * radius} Q ${x1} ${y2} ${x1 + radius} ${y2} H ${target.start - 1}`
      } else {
        d = `M ${x1} ${y1} V ${y2 - down * (target.half + 1)}`
      }
      result.push({ key: `${at}-${index}-${blocker.id}`, d, conflict })
    }
  })
  return result
})

</script>

<template>
  <p v-if="!range" class="muted text-sm">Nothing here has a start or due date yet. Give the subtickets dates to see them on a timeline.</p>
  <div v-else class="surface-strong overflow-hidden rounded-xl" :style="{ '--timeline-label': labelColumn }">
    <!-- Zoomed, this scrolls sideways; the names stick to its left edge and the days pass under them. -->
    <div
      ref="viewport"
      class="relative"
      :class="[pxPerDay ? 'scrollbar-thin overflow-x-auto' : 'overflow-hidden', pxPerDay ? (panning ? 'cursor-grabbing select-none' : 'cursor-grab') : '']"
      data-timeline-viewport
      @wheel="onWheel"
      @pointerdown="startPan"
      @pointermove="movePan"
      @pointerup="endPan"
      @pointercancel="endPan"
    >
    <div :style="{ width: contentWidth }">
    <!-- The scale: month starts, and weeks when there is room. -->
    <div class="sticky top-0 z-10 grid grid-cols-[var(--timeline-label)_minmax(0,1fr)] border-b-2 border-[var(--line)] bg-[var(--panel-strong)] font-bold uppercase tracking-wider text-[var(--ink)]" :class="full ? 'text-xs' : 'text-[11px]'">
      <div class="sticky left-0 z-20 flex cursor-default items-center gap-1 bg-[var(--panel-strong)] py-1 pr-1 pl-1 sm:pr-2 sm:pl-3">
        <span class="max-sm:sr-only">Ticket</span>
        <!-- Zoom: out, in, back to fitting everything, and today in the middle. -->
        <div class="ml-auto flex items-center gap-1 normal-case tracking-normal" role="group" aria-label="Zoom">
          <button type="button" class="focus-ring grid size-7 place-items-center rounded-md border border-[var(--line)] bg-[var(--panel)] text-[var(--ink)] shadow-sm hover:border-[var(--accent)] hover:text-[var(--accent)] active:translate-y-px disabled:opacity-40" :disabled="Boolean(pxPerDay && pxPerDay <= MIN_PX_PER_DAY)" aria-label="Zoom out" title="Zoom out · Ctrl/⌘ + scroll" data-zoom-out @click="zoomOut"><ZoomOut :size="14" /></button>
          <button type="button" class="focus-ring grid size-7 place-items-center rounded-md border border-[var(--line)] bg-[var(--panel)] text-[var(--ink)] shadow-sm hover:border-[var(--accent)] hover:text-[var(--accent)] active:translate-y-px disabled:opacity-40" :disabled="Boolean(pxPerDay && pxPerDay >= MAX_PX_PER_DAY)" aria-label="Zoom in" title="Zoom in · Ctrl/⌘ + scroll" data-zoom-in @click="zoomIn"><ZoomIn :size="14" /></button>
          <button
            type="button"
            class="focus-ring h-7 rounded-md border px-2 text-[11px] font-bold shadow-sm active:translate-y-px"
            :class="pxPerDay ? 'border-[var(--line)] bg-[var(--panel)] text-[var(--ink)] hover:border-[var(--accent)] hover:text-[var(--accent)]' : 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'"
            :aria-pressed="!pxPerDay"
            title="Fit everything into the width"
            data-zoom-auto
            @click="fitAll"
          >Auto</button>
          <button type="button" class="focus-ring grid size-7 place-items-center rounded-md border border-[var(--line)] bg-[var(--panel)] text-[var(--ink)] shadow-sm hover:border-[var(--accent)] hover:text-[var(--accent)] active:translate-y-px" aria-label="Go to today" title="Go to today" data-zoom-today @click="goToToday"><LocateFixed :size="14" /></button>
        </div>
      </div>
      <div class="relative h-9">
        <span
          v-for="tick in ticks"
          :key="tick.date"
          class="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap"
          :class="[tick.major ? '' : 'font-semibold normal-case tracking-normal opacity-70', tick.date === today ? '!text-rose-600' : '']"
          :style="{ left: `${daily ? (offset(tick.date) + offset(tick.date, true)) / 2 : offset(tick.date)}%` }"
        >{{ tick.label }}</span>
      </div>
    </div>

    <div ref="body" class="relative">
      <!-- Gridlines and today behind every row, drawn once for the whole chart. -->
      <div class="pointer-events-none absolute inset-y-0 right-0 left-[var(--timeline-label)]" aria-hidden="true">
        <span v-for="tick in ticks" :key="tick.date" class="absolute inset-y-0 w-px" :class="tick.major ? 'bg-[var(--line)]' : 'bg-[color-mix(in_srgb,var(--line)_45%,transparent)]'" :style="{ left: `${offset(tick.date)}%` }" />
        <span v-if="todayVisible" class="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-rose-500/70" :style="{ left: `${todayAt}%` }" title="Today" data-today-line />
      </div>

      <div
        v-for="{ node, depth, path } in rows"
        :key="path"
        class="relative grid grid-cols-[var(--timeline-label)_minmax(0,1fr)] items-center border-b border-[var(--line)] last:border-b-0"
        :class="depth === 0 && !forest ? 'bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]' : ''"
      >
        <!-- Opaque, so the days scroll under the names rather than through them. -->
        <div
          class="sticky left-0 z-[3] flex min-w-0 cursor-default items-center gap-1 self-stretch pr-2"
          :class="[full ? 'py-2' : 'py-1.5', depth === 0 && !forest ? 'bg-[color-mix(in_srgb,var(--accent)_6%,var(--panel-strong))]' : 'bg-[var(--panel-strong)]']"
          :style="{ paddingLeft: `${6 + depth * (full ? 16 : 12)}px` }"
        >
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
            <!-- The title opens the ticket; a "…" beside a title cut short unfolds the rest. -->
            <ExpandableTitle v-if="node.readable && (depth > 0 || forest)" :text="node.title" class="font-semibold" :class="full ? 'text-sm' : 'text-xs'">
              <NuxtLink
                :to="hrefOf(node)"
                class="focus-ring rounded hover:text-[var(--accent)]"
                :class="node.done ? 'muted line-through' : ''"
                :title="`Open #${node.ticketNumber}`"
              >{{ node.title }}</NuxtLink>
            </ExpandableTitle>
            <span v-else class="flex min-w-0 items-baseline gap-1.5 font-semibold" :class="full ? 'text-sm' : 'text-xs'">
              <ExpandableTitle :text="node.title">{{ node.title }}</ExpandableTitle>
              <EyeOff v-if="!node.readable" :size="11" class="muted shrink-0 self-center" aria-label="On a board you cannot open" />
            </span>
            <!-- The number leads the second line, as in the to-dos, so the titles line up. -->
            <span class="muted block truncate" :class="full ? 'text-xs' : 'text-[10px]'"><span class="font-semibold tabular-nums">#{{ node.ticketNumber }}</span> · {{ node.boardName }} · {{ node.laneName }}<template v-if="full"> · {{ spanLabel(node) }}</template></span>
          </div>
        </div>

        <div data-bar-cell class="relative" :class="full ? 'h-11' : 'h-9'" :title="`#${node.ticketNumber} · ${spanLabel(node)} · ${node.laneName}`">
          <span
            v-if="liveSpanOf(node)"
            class="absolute top-1/2 h-2 -translate-y-1/2 rounded-full"
            :class="liveClass(node)"
            :style="{ left: `${offset(liveSpanOf(node)!.start)}%`, width: `${Math.max(0.8, offset(liveSpanOf(node)!.end, true) - offset(liveSpanOf(node)!.start))}%` }"
          />
          <span
            v-for="mark in marksOf(node)"
            :key="mark.date"
            class="absolute top-1/2 grid -translate-x-1/2 -translate-y-1/2 place-items-center"
            :style="{ left: `${(offset(mark.date) + offset(mark.date, true)) / 2}%` }"
            :title="`${ROUND_MARK_TITLES[mark.kind]} · ${mark.date}`"
            :data-round-mark="mark.kind"
          ><Diamond :size="full ? 11 : 9" :class="ROUND_MARK_CLASSES[mark.kind]" aria-hidden="true" /></span>
          <template v-if="spanOf(node)">
            <!-- The icon's line sits on the close of the due day; the arrow runs into it. -->
            <ArrowRightToLine
              v-if="isDeadline(node)"
              :size="full ? 26 : 22"
              :stroke-width="3"
              class="absolute top-1/2 -translate-y-1/2"
              :class="deadlineClass(node)"
              :style="{ left: `calc(${offset(spanOf(node)!.end, true)}% - ${full ? 23 : 20}px)` }"
            />
            <Diamond
              v-if="!isDeadline(node) && isMilestone(node)"
              :size="full ? 16 : 14"
              class="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
              :class="node.done ? 'fill-emerald-500 text-emerald-500' : 'fill-[var(--accent)] text-[var(--accent)]'"
              :style="{ left: `${(offset(spanOf(node)!.start) + offset(spanOf(node)!.end, true)) / 2}%` }"
            />
            <span
              v-else-if="!isDeadline(node)"
              class="absolute top-1/2 -translate-y-1/2 rounded-full"
              :class="[barClass(node), full ? 'h-4' : 'h-3.5']"
              :style="{ left: `${offset(spanOf(node)!.start)}%`, width: `${Math.max(0.8, offset(spanOf(node)!.end, true) - offset(spanOf(node)!.start))}%` }"
            />
            <!-- Its days in words beside it, so nobody has to read them off the scale. -->
            <span
              v-if="full"
              class="muted absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-[11px] font-medium"
              :class="offset(spanOf(node)!.end, true) > 80 ? '-translate-x-full pr-2' : 'pl-2'"
              :style="{ left: `${offset(spanOf(node)!.end, true) > 80 ? offset(spanOf(node)!.start) : offset(spanOf(node)!.end, true)}%` }"
            >{{ dateLabel(node) }}</span>
          </template>
          <span v-else-if="!liveSpanOf(node)" class="muted absolute inset-0 flex items-center px-2 text-[10px] italic">No dates</span>
        </div>
      </div>

      <svg v-if="arrows.length && layout" class="pointer-events-none absolute inset-0 z-[2] overflow-visible" :width="'100%'" :height="layout.height" aria-hidden="true">
        <defs>
          <marker :id="`${markerId}-plain`" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" class="fill-[color-mix(in_srgb,var(--ink)_45%,transparent)]" />
          </marker>
          <marker :id="`${markerId}-conflict`" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" class="fill-orange-500" />
          </marker>
        </defs>
        <path
          v-for="arrow in arrows"
          :key="arrow.key"
          :d="arrow.d"
          fill="none"
          stroke-width="1.5"
          stroke-linejoin="round"
          :class="arrow.conflict ? 'stroke-orange-500' : 'stroke-[color-mix(in_srgb,var(--ink)_45%,transparent)]'"
          :stroke-dasharray="arrow.conflict ? '4 3' : undefined"
          :marker-end="`url(#${markerId}-${arrow.conflict ? 'conflict' : 'plain'})`"
        />
      </svg>
    </div>
    </div>
    </div>
    <!-- Two kinds of bar once any ticket is out in the world; worth saying which is which. -->
    <div v-if="hasLiveWindows || arrows.length" class="muted flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--line)] px-3 py-1.5 text-[10px] font-semibold">
      <span class="flex items-center gap-1.5"><span class="h-2.5 w-5 rounded-full bg-[var(--accent)]" /> Work: start to due date</span>
      <span v-if="hasLiveWindows" class="flex items-center gap-1.5"><span class="h-1.5 w-5 rounded-full bg-sky-500/55" /> Live window</span>
      <span v-if="arrows.length" class="flex items-center gap-1.5"><span class="relative h-px w-5 bg-[color-mix(in_srgb,var(--ink)_45%,transparent)]"><span class="absolute -right-0.5 -top-[3px] border-y-[3.5px] border-l-[5px] border-y-transparent border-l-[color-mix(in_srgb,var(--ink)_45%,transparent)]" /></span> Waits on</span>
      <span class="flex items-center gap-1.5"><span class="h-0.5 w-3 bg-rose-500/70" /> Today</span>
    </div>
  </div>
</template>
