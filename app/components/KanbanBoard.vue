<script setup lang="ts">
import { Image, Inbox, Plus } from '@lucide/vue'
import type { Lane, Ticket } from '~~/shared/types/domain'

const props = withDefaults(defineProps<{
  boardId: string
  lanes: Lane[]
  tickets: Ticket[]
  canEdit?: boolean
  /** Phone layout: only this lane, full width, without the lane's own frame and scroll box. */
  laneId?: string | null
}>(), { canEdit: true, laneId: null })
const emit = defineEmits<{ open: [ticket: Ticket]; move: [id: string, laneId: string, index: number]; create: [laneId: string, placement: 'top' | 'bottom'] }>()

const showScreenshotByLane = reactive<Record<string, boolean>>({})
const screenshotVisibilityStorageKey = computed(() => `open-bugster-lane-screenshot-visibility:${props.boardId}`)
let screenshotPreferencesLoaded = false
const cardGap = 10
const dragThreshold = 6
const draggedId = ref<string | null>(null)
const targetLaneId = ref<string | null>(null)
const targetIndex = ref<number | null>(null)
const draggedCardHeight = ref(0)
const dragPreview = ref<{ x: number; y: number; width: number } | null>(null)
const dragPreviewElement = ref<HTMLElement | null>(null)

const ticketsFor = (laneId: string) => props.tickets
  .filter(ticket => ticket.laneId === laneId)
  .sort((a, b) => a.position - b.position)

// The import lane only earns its column once something has been imported into it.
const visibleLanes = computed(() => props.lanes.filter((lane) => {
  if (props.laneId) return lane.id === props.laneId
  return !lane.isImport || ticketsFor(lane.id).length > 0
}))
const compact = computed(() => Boolean(props.laneId))

const draggedTicket = computed(() => props.tickets.find(ticket => ticket.id === draggedId.value) || null)

function sortItemsFor(laneId: string): Array<Ticket | null> {
  const items: Array<Ticket | null> = ticketsFor(laneId).filter(ticket => ticket.id !== draggedId.value)
  if (targetLaneId.value === laneId && targetIndex.value !== null) {
    items.splice(Math.min(targetIndex.value, items.length), 0, null)
  }
  return items
}

interface PointerDrag {
  id: string
  pointerId: number
  startX: number
  startY: number
  offsetX: number
  offsetY: number
  width: number
  height: number
  active: boolean
}

let pointerDrag: PointerDrag | null = null
let suppressClick = false
let previewFrame: number | null = null
let scrollFrame: number | null = null
let pointerX = 0
let pointerY = 0
let previousBodyCursor = ''
let previousBodyUserSelect = ''

function loadScreenshotPreferences() {
  screenshotPreferencesLoaded = false
  for (const key of Object.keys(showScreenshotByLane)) delete showScreenshotByLane[key]
  try {
    const storedPreferences = JSON.parse(localStorage.getItem(screenshotVisibilityStorageKey.value) || '{}') as Record<string, unknown>
    for (const lane of props.lanes) {
      showScreenshotByLane[lane.id] = typeof storedPreferences[lane.id] === 'boolean' ? storedPreferences[lane.id] as boolean : false
    }
  } catch {
    // Ignore malformed or unavailable browser storage and keep the defaults.
    for (const lane of props.lanes) showScreenshotByLane[lane.id] = false
  } finally {
    screenshotPreferencesLoaded = true
  }
}

onMounted(loadScreenshotPreferences)
watch(() => props.boardId, loadScreenshotPreferences)
watch(() => props.lanes.map(lane => lane.id).join(','), () => {
  // Lanes can be added or removed from the settings page while the board stays open.
  for (const lane of props.lanes) {
    if (!(lane.id in showScreenshotByLane)) showScreenshotByLane[lane.id] = false
  }
})

watch(showScreenshotByLane, (preferences) => {
  if (!screenshotPreferencesLoaded) return
  try {
    localStorage.setItem(screenshotVisibilityStorageKey.value, JSON.stringify(preferences))
  } catch {
    // The toggle should still work when browser storage is unavailable.
  }
}, { deep: true })

function beginPointerDrag(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary) return
  const element = event.target as Element
  if (element.closest('select, option, label')) return
  const card = element.closest<HTMLElement>('[data-ticket-id]')
  const id = card?.dataset.ticketId
  if (!id) return
  const bounds = card.getBoundingClientRect()

  pointerDrag = {
    id,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    offsetX: event.clientX - bounds.left,
    offsetY: event.clientY - bounds.top,
    width: bounds.width,
    height: bounds.height,
    active: false,
  }
  pointerX = event.clientX
  pointerY = event.clientY
  window.addEventListener('pointermove', movePointerDrag, { passive: false })
  window.addEventListener('pointerup', finishPointerDrag)
  window.addEventListener('pointercancel', cancelPointerDrag)
}

function laneAt(x: number, y: number) {
  return document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-lane-id]') || null
}

function dropPosition(lane: HTMLElement, clientY: number) {
  const stack = lane.querySelector<HTMLElement>('[data-ticket-stack]')
  if (!stack) return 0

  const cards = Array.from(stack.querySelectorAll<HTMLElement>('[data-sort-ticket]'))
  const placeholder = stack.querySelector<HTMLElement>('[data-drop-placeholder]')
  const stackTop = stack.getBoundingClientRect().top
  const localY = clientY - stackTop
  const placeholderTop = placeholder?.offsetTop
  const placeholderFootprint = placeholder ? placeholder.offsetHeight + cardGap : 0

  const index = cards.findIndex((card) => {
    // offsetTop describes the final layout and is unaffected by the FLIP transform
    // that Vue applies while cards glide into their new positions.
    const followsPlaceholder = placeholderTop !== undefined && card.offsetTop > placeholderTop
    const compactedTop = card.offsetTop - (followsPlaceholder ? placeholderFootprint : 0)
    return localY < compactedTop + card.offsetHeight / 2
  })

  return index === -1 ? cards.length : index
}

function updateDropTarget(x: number, y: number) {
  const lane = laneAt(x, y)
  const laneId = lane?.dataset.laneId
  if (!lane || !laneId) {
    targetLaneId.value = null
    targetIndex.value = null
    return
  }

  const index = dropPosition(lane, y)
  if (targetLaneId.value !== laneId) targetLaneId.value = laneId
  if (targetIndex.value !== index) targetIndex.value = index
}

function schedulePreviewPosition() {
  if (previewFrame !== null) return
  previewFrame = window.requestAnimationFrame(() => {
    previewFrame = null
    if (!pointerDrag || !dragPreviewElement.value) return
    const x = pointerX - pointerDrag.offsetX
    const y = pointerY - pointerDrag.offsetY
    dragPreviewElement.value.style.transform = `translate3d(${x}px, ${y}px, 0)`
  })
}

function runAutoScroll() {
  scrollFrame = null
  if (!pointerDrag?.active) return
  const lane = laneAt(pointerX, pointerY)?.querySelector<HTMLElement>('[data-lane-scroll]')
  if (!lane) return

  const bounds = lane.getBoundingClientRect()
  const edge = Math.min(64, bounds.height / 4)
  let delta = 0
  if (pointerY < bounds.top + edge) {
    delta = -Math.ceil(12 * (1 - Math.max(0, pointerY - bounds.top) / edge))
  } else if (pointerY > bounds.bottom - edge) {
    delta = Math.ceil(12 * (1 - Math.max(0, bounds.bottom - pointerY) / edge))
  }

  if (delta !== 0) {
    const previousScrollTop = lane.scrollTop
    lane.scrollTop += delta
    if (lane.scrollTop !== previousScrollTop) {
      updateDropTarget(pointerX, pointerY)
      scrollFrame = window.requestAnimationFrame(runAutoScroll)
    }
  }
}

function scheduleAutoScroll() {
  if (scrollFrame === null) scrollFrame = window.requestAnimationFrame(runAutoScroll)
}

function activatePointerDrag(event: PointerEvent) {
  if (!pointerDrag) return
  pointerDrag.active = true
  draggedId.value = pointerDrag.id
  draggedCardHeight.value = pointerDrag.height
  dragPreview.value = {
    x: event.clientX - pointerDrag.offsetX,
    y: event.clientY - pointerDrag.offsetY,
    width: pointerDrag.width,
  }

  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  previousBodyCursor = document.body.style.cursor
  previousBodyUserSelect = document.body.style.userSelect
  document.body.style.cursor = 'grabbing'
  document.body.style.userSelect = 'none'
}

function movePointerDrag(event: PointerEvent) {
  if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return
  pointerX = event.clientX
  pointerY = event.clientY

  if (!pointerDrag.active) {
    if (Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY) < dragThreshold) return
    activatePointerDrag(event)
  }

  updateDropTarget(event.clientX, event.clientY)
  schedulePreviewPosition()
  scheduleAutoScroll()
  event.preventDefault()
}

function finishPointerDrag(event: PointerEvent) {
  if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return
  if (pointerDrag.active) {
    const lane = laneAt(event.clientX, event.clientY)
    const laneId = lane?.dataset.laneId
    if (lane && laneId) emit('move', pointerDrag.id, laneId, dropPosition(lane, event.clientY))
    suppressClick = true
    window.setTimeout(() => { suppressClick = false }, 0)
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    event.preventDefault()
  }
  cleanupPointerDrag()
}

function cancelPointerDrag() {
  cleanupPointerDrag()
}

function cleanupPointerDrag() {
  const wasActive = pointerDrag?.active === true
  window.removeEventListener('pointermove', movePointerDrag)
  window.removeEventListener('pointerup', finishPointerDrag)
  window.removeEventListener('pointercancel', cancelPointerDrag)
  if (previewFrame !== null) window.cancelAnimationFrame(previewFrame)
  if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame)
  if (wasActive) {
    document.body.style.cursor = previousBodyCursor
    document.body.style.userSelect = previousBodyUserSelect
  }
  pointerDrag = null
  previewFrame = null
  scrollFrame = null
  draggedId.value = null
  targetLaneId.value = null
  targetIndex.value = null
  draggedCardHeight.value = 0
  dragPreview.value = null
}

// The card's reorder buttons: the target index counts within the lane after the ticket leaves its slot.
function reorderTicket(ticket: Ticket, placement: 'top' | 'up' | 'down' | 'bottom') {
  const laneTickets = ticketsFor(ticket.laneId)
  const index = laneTickets.findIndex(item => item.id === ticket.id)
  const last = laneTickets.length - 1
  const target = placement === 'top' ? 0 : placement === 'bottom' ? last : placement === 'up' ? index - 1 : index + 1
  const clamped = Math.max(0, Math.min(last, target))
  if (clamped !== index) emit('move', ticket.id, ticket.laneId, clamped)
}

function preventClickAfterDrag(event: MouseEvent) {
  if (!suppressClick) return
  event.preventDefault()
  event.stopPropagation()
}

onBeforeUnmount(cleanupPointerDrag)
</script>

<template>
  <div
    class="scrollbar-thin grid items-start gap-4 pb-6 xl:gap-5"
    :style="compact ? undefined : {
      minWidth: `${visibleLanes.length * 280}px`,
      gridTemplateColumns: `repeat(${visibleLanes.length}, minmax(260px, 1fr))`,
    }"
    @pointerdown="canEdit && beginPointerDrag($event)"
    @click.capture="preventClickAfterDrag"
  >
    <section v-for="lane in visibleLanes" :key="lane.id" class="min-w-0">
      <div
        :data-lane-id="lane.id"
        class="flex flex-col transition-colors duration-150"
        :class="[
          compact
            ? ''
            : 'max-h-[calc(100vh-230px)] rounded-[12px] bg-[color-mix(in_srgb,var(--panel)_70%,transparent)] dark:bg-[color-mix(in_srgb,var(--panel-strong)_50%,var(--canvas))]',
          !compact && targetLaneId === lane.id ? 'bg-[color-mix(in_srgb,var(--accent)_7%,var(--panel))] dark:bg-[color-mix(in_srgb,var(--accent)_16%,var(--panel-strong))]' : '',
        ]"
      >
        <header
          class="flex shrink-0 items-center gap-2 transition-colors duration-150"
          :class="[compact ? 'px-1 pb-2' : 'px-3.5 pb-1.5 pt-3', targetLaneId === lane.id ? 'text-[var(--accent)]' : '']"
        >
          <h2 class="truncate text-[13px] font-bold uppercase tracking-[.1em]">{{ lane.name }}</h2>
          <div class="ml-auto flex items-center gap-2">
            <button
              v-if="canEdit"
              type="button"
              :aria-label="`Add a ticket to the top of ${lane.name}`"
              :title="`Add a ticket to the top of ${lane.name}`"
              class="focus-ring muted flex items-center rounded-lg p-1 transition hover:bg-[var(--panel-strong)] hover:text-[var(--ink)]"
              @click="emit('create', lane.id, 'top')"
            >
              <Plus aria-hidden="true" class="size-4" />
            </button>
            <button
              type="button"
              role="switch"
              :aria-checked="showScreenshotByLane[lane.id] === true"
              :aria-label="`${showScreenshotByLane[lane.id] ? 'Hide' : 'Show'} screenshots in ${lane.name}`"
              class="focus-ring muted flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[10px] font-semibold normal-case tracking-normal transition hover:bg-[var(--panel-strong)]"
              @click="showScreenshotByLane[lane.id] = !showScreenshotByLane[lane.id]"
            >
              <Image aria-hidden="true" class="size-4" />
              <span
                aria-hidden="true"
                class="relative h-4 w-7 rounded-full border transition-colors"
                :class="showScreenshotByLane[lane.id] ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--line)] bg-[var(--panel-strong)]'"
              >
                <span
                  class="absolute left-0.5 top-0.5 size-2.5 rounded-full shadow-sm transition-transform"
                  :class="showScreenshotByLane[lane.id] ? 'translate-x-3 bg-white' : 'bg-[var(--muted)]'"
                />
              </span>
            </button>
            <span class="muted text-[13px] font-semibold tabular-nums">{{ ticketsFor(lane.id).length }}</span>
          </div>
        </header>
        <!-- On a phone the page scrolls instead of the lane; a scroll box would cap it at a few cards. -->
        <div data-lane-scroll class="relative min-h-0 flex-1" :class="compact ? '' : 'scrollbar-thin overflow-y-auto px-2.5 pb-2.5 pt-1'">
          <TransitionGroup name="ticket-sort" tag="div" data-ticket-stack class="relative flex flex-col gap-2.5">
            <div
              v-for="(item, index) in sortItemsFor(lane.id)"
              :key="item?.id || '__drop-placeholder'"
              :data-sort-ticket="item?.id"
            >
              <TicketCard
                v-if="item"
                :ticket="item"
                :index="index"
                :lanes="lanes"
                :show-screenshot="showScreenshotByLane[lane.id]"
                :lane-count="ticketsFor(lane.id).length"
                @open="emit('open', $event)"
                @move="nextLaneId => emit('move', item.id, nextLaneId, ticketsFor(nextLaneId).length)"
                @reorder="placement => reorderTicket(item, placement)"
              />
              <div
                v-else
                data-drop-placeholder
                class="pointer-events-none rounded-[10px] bg-[color-mix(in_srgb,var(--accent)_9%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_22%,transparent)]"
                :style="{ height: `${draggedCardHeight}px` }"
                aria-hidden="true"
              />
            </div>
          </TransitionGroup>
          <div v-if="!ticketsFor(lane.id).length && targetLaneId !== lane.id" class="muted grid min-h-28 place-items-center text-center">
            <div>
              <Inbox :size="21" class="mx-auto mb-2 opacity-50" />
              <p class="text-xs">No tickets</p>
            </div>
          </div>
        </div>

        <footer v-if="canEdit" class="shrink-0" :class="compact ? 'pt-2' : 'px-2.5 pb-2.5 pt-1'">
          <button
            type="button"
            class="focus-ring muted flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-sm font-semibold transition hover:bg-[var(--panel-strong)] hover:text-[var(--ink)]"
            :aria-label="`Add a ticket to ${lane.name}`"
            @click="emit('create', lane.id, 'bottom')"
          >
            <Plus :size="16" aria-hidden="true" /> Add ticket
          </button>
        </footer>
      </div>
    </section>
  </div>

  <Teleport to="body">
    <div
      v-if="draggedTicket && dragPreview"
      ref="dragPreviewElement"
      inert
      class="pointer-events-none fixed left-0 top-0 z-[100] will-change-transform"
      :style="{
        width: `${dragPreview.width}px`,
        transform: `translate3d(${dragPreview.x}px, ${dragPreview.y}px, 0)`,
      }"
      aria-hidden="true"
    >
      <TicketCard :ticket="draggedTicket" :index="0" :lanes="lanes" :show-screenshot="showScreenshotByLane[draggedTicket.laneId]" preview />
    </div>
  </Teleport>
</template>

<style scoped>
.ticket-sort-move {
  transition: transform 180ms cubic-bezier(.2, .8, .2, 1);
}
</style>
