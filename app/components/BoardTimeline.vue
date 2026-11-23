<script setup lang="ts">
import { ChevronDown, LoaderCircle, TriangleAlert } from '@lucide/vue'
import type { TimelineNode } from '~~/shared/types/domain'
import { boardToday } from '~~/shared/utils/due-date'
import { flattenForest, timelineBounds, timelineWarnings } from '~~/shared/utils/timeline'

/**
 * The board as one timeline: every ticket on it that has a date somewhere below it, the
 * earliest first, each the head of its subtickets. The heads start folded so the board reads as
 * one row per ticket; a click opens a ticket's subtickets, and deeper branches open with it.
 * `visibleIds` carries the board's search and filters: a ticket they hide drops out with its
 * tree. Read fresh whenever `refreshKey` changes, since subtickets elsewhere move on their own.
 */
const props = defineProps<{
  boardId: string
  visibleIds: ReadonlySet<string>
  refreshKey?: string
}>()

const roots = ref<TimelineNode[]>([])
const loaded = ref(false)
const loading = ref(false)
const failed = ref(false)
const today = boardToday()

async function load() {
  loading.value = true
  try {
    roots.value = (await $fetch<{ timeline: TimelineNode[] }>(`/api/boards/${props.boardId}/timeline`)).timeline
    failed.value = false
  } catch {
    failed.value = true
  } finally {
    loading.value = false
    loaded.value = true
  }
}
watch(() => [props.boardId, props.refreshKey], load, { immediate: true })

// Done work stays on by default: the timeline is the whole plan. Off, it shows what is ahead.
// The choice is remembered per board in this browser.
const showDoneKey = computed(() => `open-bugster-timeline-show-done:${props.boardId}`)
const showDone = ref(true)
function loadShowDone() {
  try {
    showDone.value = localStorage.getItem(showDoneKey.value) !== 'false'
  } catch {
    showDone.value = true
  }
}
onMounted(loadShowDone)
watch(showDoneKey, loadShowDone)
watch(showDone, (value) => {
  try {
    localStorage.setItem(showDoneKey.value, String(value))
  } catch { /* A private window keeps it for the visit only. */ }
})
const shown = computed(() => roots.value
  .filter(root => props.visibleIds.has(root.id) && (showDone.value || !root.done))
  .map(root => ({ root, start: timelineBounds(root)?.start ?? '9999-12-31' }))
  .sort((a, b) => a.start.localeCompare(b.start) || a.root.ticketNumber - b.root.ticketNumber)
  .map(({ root }) => root))

// A head is folded until opened; a branch below it is open until folded. One set holds the
// exceptions both ways, so a board refreshed with new tickets folds those too.
const toggled = ref(new Set<string>())
watch(() => props.boardId, () => { toggled.value = new Set() })
const branches = computed(() => flattenForest(shown.value).filter(({ node }) => node.children.length))
const collapsed = computed(() => new Set(branches.value
  .filter(({ depth, path }) => (depth === 0) !== toggled.value.has(path))
  .map(({ path }) => path)))
function toggle(path: string) {
  const next = new Set(toggled.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  toggled.value = next
}
const anyOpen = computed(() => branches.value.some(({ path }) => !collapsed.value.has(path)))
function toggleAll() {
  // Folded: back to the heads alone. Open: every head, and every branch below it, unfolded.
  toggled.value = anyOpen.value ? new Set() : new Set(branches.value.filter(({ depth }) => depth === 0).map(({ path }) => path))
}

// Each tree warns against its own head's dates, as on the ticket's timeline; a subticket under
// two heads says so once.
const warnings = computed(() => {
  const seen = new Set<string>()
  return shown.value.flatMap(root => timelineWarnings(root, today)).filter((warning) => {
    if (seen.has(warning.message)) return false
    seen.add(warning.message)
    return true
  })
})
const warned = computed(() => new Set(warnings.value.map(warning => warning.ticketId)))
const warningsOpen = ref(false)

const dayFormatter = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const rangeText = computed(() => {
  const bounds = shown.value.length ? timelineBounds(shown.value) : null
  if (!bounds) return null
  const format = (date: string) => dayFormatter.format(new Date(`${date}T00:00:00Z`))
  return `${format(bounds.start)} – ${format(bounds.end)}`
})
</script>

<template>
  <section class="space-y-3" aria-label="Board timeline" data-board-timeline>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <LoaderCircle v-if="loading" :size="14" class="muted animate-spin" aria-label="Loading" />
      <span class="muted text-xs font-semibold tabular-nums">{{ shown.length }} {{ shown.length === 1 ? 'ticket' : 'tickets' }}<template v-if="rangeText"> · {{ rangeText }}</template></span>
      <button
        v-if="warnings.length"
        type="button"
        class="focus-ring flex items-center gap-1 rounded-md px-1 text-xs font-semibold text-orange-700 hover:underline"
        :aria-expanded="warningsOpen"
        aria-controls="board-timeline-warnings"
        @click="warningsOpen = !warningsOpen"
      >
        <TriangleAlert :size="13" aria-hidden="true" />
        {{ warnings.length }} {{ warnings.length === 1 ? 'warning' : 'warnings' }}
        <ChevronDown :size="12" class="transition-transform" :class="warningsOpen && 'rotate-180'" aria-hidden="true" />
      </button>
      <div class="ml-auto flex items-center gap-3">
        <label class="muted flex cursor-pointer items-center gap-1.5 text-xs font-semibold">
          <input v-model="showDone" type="checkbox" class="accent-[var(--accent)]"> Show done
        </label>
        <button v-if="branches.length" type="button" class="focus-ring muted rounded-md px-1.5 py-0.5 text-xs font-semibold hover:text-[var(--ink)]" @click="toggleAll">
          {{ anyOpen ? 'Collapse all' : 'Expand all' }}
        </button>
      </div>
    </div>

    <ul v-if="warnings.length && warningsOpen" id="board-timeline-warnings" class="space-y-1 rounded-xl bg-orange-400/10 p-3 text-sm text-orange-800">
      <li v-for="warning in warnings" :key="warning.message" class="flex items-start gap-2">
        <TriangleAlert :size="15" class="mt-0.5 shrink-0" aria-hidden="true" /> <span>{{ warning.message }}</span>
      </li>
    </ul>

    <p v-if="failed" class="muted py-16 text-center text-sm">The timeline could not be loaded.</p>
    <div v-else-if="!loaded" class="surface h-64 animate-pulse rounded-2xl" />
    <p v-else-if="!shown.length" class="muted py-16 text-center text-sm">
      {{ roots.length ? 'No scheduled ticket matches the search and filters.' : 'Nothing on this board has a start or due date yet. Give tickets dates to see them here.' }}
    </p>
    <!-- The chart zooms and scrolls sideways on its own, on a phone as on a wide screen. -->
    <TimelineChart v-else :timeline="shown" :warned="warned" :collapsed="collapsed" size="full" @toggle="toggle" />
  </section>
</template>
