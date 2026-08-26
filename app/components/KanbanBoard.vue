<script setup lang="ts">
import { Image, Inbox } from '@lucide/vue'
import type { Ticket, TicketStatus } from '~~/shared/types/domain'
import { STATUS_LABELS } from '~~/shared/utils/constants'

const props = defineProps<{ tickets: Ticket[]; showImportLane?: boolean }>()
const emit = defineEmits<{ open: [ticket: Ticket]; move: [id: string, status: TicketStatus, index: number] }>()

const statuses = Object.keys(STATUS_LABELS) as TicketStatus[]
const showScreenshotByStatus = reactive<Record<TicketStatus, boolean>>({
  import: false,
  backlog: false,
  open: false,
  question: false,
  in_progress: false,
  done: false,
})
const screenshotVisibilityStorageKey = 'open-bugster-lane-screenshot-visibility'
let screenshotPreferencesLoaded = false
const cardGap = 10
const dragThreshold = 6
const draggedId = ref<string | null>(null)
const targetStatus = ref<TicketStatus | null>(null)
const targetIndex = ref<number | null>(null)
const draggedCardHeight = ref(0)
const dragPreview = ref<{ x: number; y: number; width: number } | null>(null)
const dragPreviewElement = ref<HTMLElement | null>(null)

const ticketsFor = (status: TicketStatus) => props.tickets
  .filter(ticket => ticket.status === status)
  .sort((a, b) => a.position - b.position)

const visibleStatuses = computed(() => statuses.filter(status => (
  status !== 'import' || (props.showImportLane ?? ticketsFor('import').length > 0)
)))

const draggedTicket = computed(() => props.tickets.find(ticket => ticket.id === draggedId.value) || null)

function sortItemsFor(status: TicketStatus): Array<Ticket | null> {
  const items: Array<Ticket | null> = ticketsFor(status).filter(ticket => ticket.id !== draggedId.value)
  if (targetStatus.value === status && targetIndex.value !== null) {
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

onMounted(() => {
  try {
    const storedPreferences = JSON.parse(localStorage.getItem(screenshotVisibilityStorageKey) || localStorage.getItem('bugster-lane-screenshot-visibility') || '{}') as Record<string, unknown>
    for (const status of statuses) {
      if (typeof storedPreferences[status] === 'boolean') {
        showScreenshotByStatus[status] = storedPreferences[status]
      }
    }
  } catch {
    // Ignore malformed or unavailable browser storage and keep the defaults.
  } finally {
    screenshotPreferencesLoaded = true
  }
})

watch(showScreenshotByStatus, (preferences) => {
  if (!screenshotPreferencesLoaded) return
  try {
    localStorage.setItem(screenshotVisibilityStorageKey, JSON.stringify(preferences))
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
  return document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-lane-status]') || null
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
  const status = lane?.dataset.laneStatus as TicketStatus | undefined
  if (!lane || !status) {
    targetStatus.value = null
    targetIndex.value = null
    return
  }

  const index = dropPosition(lane, y)
  if (targetStatus.value !== status) targetStatus.value = status
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
  const lane = laneAt(pointerX, pointerY)
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
    const status = lane?.dataset.laneStatus as TicketStatus | undefined
    if (lane && status) emit('move', pointerDrag.id, status, dropPosition(lane, event.clientY))
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
  targetStatus.value = null
  targetIndex.value = null
  draggedCardHeight.value = 0
  dragPreview.value = null
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
    class="scrollbar-thin grid gap-4 pb-6 xl:gap-5"
    :class="visibleStatuses.length === 6 ? 'min-w-[1700px] grid-cols-6' : 'min-w-[1400px] grid-cols-5'"
    @pointerdown="beginPointerDrag"
    @click.capture="preventClickAfterDrag"
  >
    <section v-for="status in visibleStatuses" :key="status" class="min-w-0">
      <header class="mb-3 flex items-center gap-2 px-1 transition-colors duration-150" :class="targetStatus === status ? 'text-[var(--accent)]' : ''">
        <span
          class="size-2 rounded-full transition-colors duration-150"
          :class="[
            ['bg-cyan-500', 'bg-slate-400', 'bg-blue-500', 'bg-violet-500', 'bg-amber-500', 'bg-emerald-500'][statuses.indexOf(status)],
            targetStatus === status ? '!bg-[var(--accent)]' : '',
          ]"
        />
        <h2 class="text-[13px] font-bold uppercase tracking-[.1em]">{{ STATUS_LABELS[status] }}</h2>
        <div class="ml-auto flex items-center gap-2">
          <button
            type="button"
            role="switch"
            :aria-checked="showScreenshotByStatus[status]"
            :aria-label="`${showScreenshotByStatus[status] ? 'Hide' : 'Show'} screenshots in ${STATUS_LABELS[status]}`"
            class="focus-ring muted flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[10px] font-semibold normal-case tracking-normal transition hover:bg-[var(--panel-strong)]"
            @click="showScreenshotByStatus[status] = !showScreenshotByStatus[status]"
          >
            <Image aria-hidden="true" class="size-4" />
            <span
              aria-hidden="true"
              class="relative h-4 w-7 rounded-full border transition-colors"
              :class="showScreenshotByStatus[status] ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--line)] bg-[var(--panel-strong)]'"
            >
              <span
                class="absolute left-0.5 top-0.5 size-2.5 rounded-full shadow-sm transition-transform"
                :class="showScreenshotByStatus[status] ? 'translate-x-3 bg-white' : 'bg-[var(--muted)]'"
              />
            </span>
          </button>
          <span class="muted rounded-full border border-[var(--line)] px-2 py-0.5 text-[11px] font-semibold">{{ ticketsFor(status).length }}</span>
        </div>
      </header>
      <div
        :data-lane-status="status"
        class="scrollbar-thin relative h-[calc(100vh-230px)] overflow-y-auto rounded-[18px] border border-dashed border-[var(--line)] bg-[color-mix(in_srgb,var(--panel)_45%,transparent)] p-2.5 transition-[border-color,background-color] duration-150"
        :class="targetStatus === status ? 'border-[color-mix(in_srgb,var(--accent)_48%,var(--line))] bg-[color-mix(in_srgb,var(--accent)_4%,var(--panel))]' : ''"
      >
        <TransitionGroup name="ticket-sort" tag="div" data-ticket-stack class="relative flex flex-col gap-2.5">
          <div
            v-for="(item, index) in sortItemsFor(status)"
            :key="item?.id || '__drop-placeholder'"
            :data-sort-ticket="item?.id"
          >
            <TicketCard
              v-if="item"
              :ticket="item"
              :index="index"
              :show-screenshot="showScreenshotByStatus[status]"
              @open="emit('open', $event)"
              @move="nextStatus => emit('move', item.id, nextStatus, ticketsFor(nextStatus).length)"
            />
            <div
              v-else
              data-drop-placeholder
              class="pointer-events-none rounded-[14px] bg-[color-mix(in_srgb,var(--accent)_9%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_22%,transparent)]"
              :style="{ height: `${draggedCardHeight}px` }"
              aria-hidden="true"
            />
          </div>
        </TransitionGroup>
        <div v-if="!ticketsFor(status).length && targetStatus !== status" class="muted grid min-h-36 place-items-center text-center">
          <div>
            <Inbox :size="21" class="mx-auto mb-2 opacity-50" />
            <p class="text-xs">No tickets</p>
          </div>
        </div>
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
      <TicketCard :ticket="draggedTicket" :index="0" :show-screenshot="showScreenshotByStatus[draggedTicket.status]" preview />
    </div>
  </Teleport>
</template>

<style scoped>
.ticket-sort-move {
  transition: transform 180ms cubic-bezier(.2, .8, .2, 1);
}
</style>
