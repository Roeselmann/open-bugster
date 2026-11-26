<script setup lang="ts">
import { ChartGantt, ChevronDown, LoaderCircle, Maximize2, Minimize2, TriangleAlert } from '@lucide/vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import type { TimelineNode } from '~~/shared/types/domain'
import { boardToday } from '~~/shared/utils/due-date'
import { timelineBounds, timelineWarnings } from '~~/shared/utils/timeline'

/**
 * The plan below a ticket: it and its subtickets, down through theirs, as bars across their
 * days. The editor shows only its range, a button into it and, folded behind a link, the warnings; the chart itself
 * opens full screen. Read fresh from the server whenever `refreshKey` changes, because a subticket on
 * another board can move without this ticket knowing. It opens full screen in a dialog of its
 * own, nested in the editor's, so Escape and a click beside it close the chart, not the ticket.
 */
const props = defineProps<{ ticketId: string; refreshKey?: string }>()

const timeline = ref<TimelineNode | null>(null)
const loading = ref(false)
const failed = ref(false)
// Shared by both views: a branch folded in the editor stays folded full screen, and back.
const collapsed = ref(new Set<string>())
const expanded = ref(false)
// The warnings sit folded behind a small link; the editor stays calm until someone asks.
const warningsOpen = ref(false)
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
// Another ticket in the same editor starts folded open and on the small view.
watch(() => props.ticketId, () => {
  collapsed.value = new Set()
  expanded.value = false
  warningsOpen.value = false
})

const warnings = computed(() => (timeline.value ? timelineWarnings(timeline.value, today) : []))
const warned = computed(() => new Set(warnings.value.map(warning => warning.ticketId)))
const bounds = computed(() => (timeline.value ? timelineBounds(timeline.value) : null))

const dayFormatter = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const rangeText = computed(() => {
  if (!bounds.value) return null
  const format = (date: string) => dayFormatter.format(new Date(`${date}T00:00:00Z`))
  return `${format(bounds.value.start)} – ${format(bounds.value.end)}`
})

function toggle(path: string) {
  const next = new Set(collapsed.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  collapsed.value = next
}
</script>

<template>
  <section class="space-y-3" aria-labelledby="ticket-timeline-heading">
    <!-- Two columns: the heading, its warnings and the dates on the left; the way into the
         full-screen chart on the right, as a primary button. On a phone the button goes under. -->
    <div class="flex items-center gap-3 max-sm:flex-col max-sm:items-stretch">
      <div class="min-w-0 flex-1 space-y-1">
        <div class="flex items-center gap-2">
          <h3 id="ticket-timeline-heading" class="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><ChartGantt :size="15" /> Timeline</h3>
          <LoaderCircle v-if="loading" :size="13" class="muted animate-spin" aria-label="Loading" />
          <button
            v-if="!failed && warnings.length"
            type="button"
            class="focus-ring flex items-center gap-1 rounded-md px-1 text-[11px] font-semibold text-orange-700 hover:underline"
            :aria-expanded="warningsOpen"
            aria-controls="ticket-timeline-warnings"
            data-timeline-warnings-toggle
            @click="warningsOpen = !warningsOpen"
          >
            <TriangleAlert :size="13" aria-hidden="true" />
            {{ warnings.length }} {{ warnings.length === 1 ? 'warning' : 'warnings' }}
            <ChevronDown :size="12" class="transition-transform" :class="warningsOpen && 'rotate-180'" aria-hidden="true" />
          </button>
        </div>
        <p v-if="rangeText" class="muted whitespace-nowrap text-[11px] font-semibold tabular-nums">{{ rangeText }}</p>
      </div>
      <!-- In the editor only the way in; the chart needs the whole window to be read. -->
      <button
        v-if="!failed && timeline && bounds"
        type="button"
        class="focus-ring flex h-10 w-1/2 shrink-0 items-center max-sm:w-full justify-center gap-2 rounded-xl bg-[var(--primary)] px-3 text-sm font-semibold text-[var(--primary-ink)] transition hover:opacity-85"
        @click="expanded = true"
      >
        <Maximize2 :size="15" aria-hidden="true" /> Open timeline
      </button>
    </div>

    <p v-if="failed" class="muted text-sm">The timeline could not be loaded.</p>
    <template v-else-if="timeline">
      <p v-if="!bounds" class="muted text-sm">Nothing here has a start or due date yet. Give the subtickets dates to see them on a timeline.</p>
      <ul v-if="warnings.length && warningsOpen" id="ticket-timeline-warnings" class="space-y-1 rounded-xl bg-orange-400/10 p-2.5 text-xs text-orange-800">
        <li v-for="warning in warnings" :key="warning.message" class="flex items-start gap-1.5">
          <TriangleAlert :size="13" class="mt-px shrink-0" aria-hidden="true" /> <span>{{ warning.message }}</span>
        </li>
      </ul>
    </template>

    <DialogRoot v-model:open="expanded">
      <DialogPortal>
        <DialogOverlay class="ui-dialog-overlay fixed inset-0 z-[60] bg-black/40 backdrop-blur-[2px]" />
        <DialogContent
          v-if="timeline"
          class="ui-dialog-content surface fixed inset-2 z-[61] flex flex-col overflow-hidden rounded-2xl shadow-2xl sm:inset-4"
        >
          <header class="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3 sm:px-6">
            <ChartGantt :size="18" class="shrink-0 text-[var(--accent)]" aria-hidden="true" />
            <div class="min-w-0 flex-1">
              <DialogTitle class="truncate text-base font-bold">
                <span class="muted tabular-nums">#{{ timeline.ticketNumber }}</span> {{ timeline.title }}
              </DialogTitle>
              <DialogDescription class="muted truncate text-xs">
                Timeline<template v-if="rangeText"> · {{ rangeText }}</template> · {{ timeline.boardName }} · {{ timeline.laneName }}
              </DialogDescription>
            </div>
            <LoaderCircle v-if="loading" :size="15" class="muted animate-spin" aria-label="Loading" />
            <button
              type="button"
              class="focus-ring flex h-9 shrink-0 items-center gap-2 rounded-xl border border-[var(--line)] px-3 text-sm font-semibold hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
              title="Back to the ticket · Esc"
              @click="expanded = false"
            >
              <Minimize2 :size="15" /> <span class="hidden sm:inline">Close full screen</span>
            </button>
          </header>
          <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 sm:p-6">
            <!-- Folded to one bar by default, so the chart is what greets you; the same switch as the editor's link. -->
            <div v-if="warnings.length" class="rounded-xl bg-orange-400/10 text-sm text-orange-800" :class="!warningsOpen && 'w-fit'" data-timeline-full-warnings>
              <button
                type="button"
                class="focus-ring flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left font-semibold hover:bg-orange-400/10"
                :aria-expanded="warningsOpen"
                aria-controls="ticket-timeline-full-warnings"
                @click="warningsOpen = !warningsOpen"
              >
                <TriangleAlert :size="15" class="shrink-0" aria-hidden="true" />
                <span>{{ warnings.length }} {{ warnings.length === 1 ? 'warning' : 'warnings' }}</span>
                <ChevronDown :size="15" class="shrink-0 transition-transform" :class="warningsOpen && 'rotate-180'" aria-hidden="true" />
              </button>
              <ul v-if="warningsOpen" id="ticket-timeline-full-warnings" class="space-y-1 px-3 pb-3">
                <li v-for="warning in warnings" :key="warning.message" class="flex items-start gap-2">
                  <TriangleAlert :size="15" class="mt-0.5 shrink-0" aria-hidden="true" /> <span>{{ warning.message }}</span>
                </li>
              </ul>
            </div>
            <TimelineChart :timeline="timeline" :warned="warned" :collapsed="collapsed" size="full" @toggle="toggle" />
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </section>
</template>
