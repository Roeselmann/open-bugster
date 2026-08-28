<script setup lang="ts">
import { GripVertical, Lock, LoaderCircle, Plus, Trash2 } from '@lucide/vue'
import {
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from 'reka-ui'
import type { BoardSummary, LaneSummary } from '~~/shared/types/domain'

const props = defineProps<{ board: BoardSummary }>()
const emit = defineEmits<{ changed: []; notify: [type: 'success' | 'error', text: string] }>()

// A reorder shows up immediately and is saved in the background, so the list never waits
// for the round trip. While the override is set it wins over the board prop.
const localOrder = ref<string[] | null>(null)

const lanes = computed(() => {
  const order = localOrder.value
  if (!order) return props.board.lanes
  const byId = new Map(props.board.lanes.map(lane => [lane.id, lane]))
  const reordered = order.map(id => byId.get(id)).filter(Boolean) as LaneSummary[]
  // A lane added or deleted elsewhere invalidates the override.
  return reordered.length === props.board.lanes.length ? reordered : props.board.lanes
})

// Hand the list back to the prop only once the server agrees, so the refetch cannot flicker.
watch(() => props.board.lanes.map(lane => lane.id).join(','), (serverOrder) => {
  if (localOrder.value && serverOrder === localOrder.value.join(',')) localOrder.value = null
})

const newLaneName = ref('')
const busyLaneId = ref<string | null>(null)
const adding = ref(false)
const liveMessage = ref('')

const doomed = ref<LaneSummary | null>(null)
const deleteMode = ref<'move' | 'archive'>('move')
const deleteTargetId = ref('')
const deleting = ref(false)

const moveTargets = computed(() => lanes.value
  .filter(lane => lane.id !== doomed.value?.id)
  .map(lane => ({ value: lane.id, label: lane.name })))

async function addLane() {
  const name = newLaneName.value.trim()
  if (!name || adding.value) return
  adding.value = true
  try {
    await $fetch(`/api/boards/${props.board.id}/lanes`, { method: 'POST', body: { name } })
    newLaneName.value = ''
    emit('changed')
    emit('notify', 'success', `Lane “${name}” added.`)
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    adding.value = false
  }
}

async function renameLane(lane: LaneSummary, event: Event) {
  const name = (event.target as HTMLInputElement).value.trim()
  if (!name || name === lane.name) {
    ;(event.target as HTMLInputElement).value = lane.name
    return
  }
  await patchLane(lane, { name })
}

async function patchLane(lane: LaneSummary, body: { name?: string }) {
  busyLaneId.value = lane.id
  try {
    await $fetch(`/api/boards/${props.board.id}/lanes/${lane.id}`, { method: 'PATCH', body })
    emit('changed')
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    busyLaneId.value = null
  }
}

// Every request carries the complete order, so chaining them keeps two quick reorders
// from landing out of sequence.
let pending: Promise<unknown> = Promise.resolve()

function commitOrder(order: string[], announcement: string) {
  localOrder.value = order
  liveMessage.value = announcement
  pending = pending.then(async () => {
    try {
      await $fetch(`/api/boards/${props.board.id}/lane-order`, { method: 'PATCH', body: { laneIds: order } })
      emit('changed')
    } catch (error) {
      localOrder.value = null
      emit('notify', 'error', errorText(error))
    }
  })
}

function movedText(lane: LaneSummary | undefined, index: number, total: number) {
  return `“${lane?.name || 'Lane'}” moved to position ${index + 1} of ${total}.`
}

/** Keyboard path: the grip handle answers to arrow up and arrow down. */
function moveLane(lane: LaneSummary, offset: number) {
  const order = lanes.value.map(item => item.id)
  const from = order.indexOf(lane.id)
  const to = from + offset
  if (from < 0 || to < 0 || to >= order.length) return
  order.splice(to, 0, ...order.splice(from, 1))
  commitOrder(order, movedText(lane, to, order.length))
}

const dragThreshold = 6
const draggedId = ref<string | null>(null)
const targetIndex = ref<number | null>(null)
const draggedRowHeight = ref(0)
const dragPreview = ref<{ x: number; y: number; width: number } | null>(null)
const dragPreviewElement = ref<HTMLElement | null>(null)

const draggedLane = computed(() => lanes.value.find(lane => lane.id === draggedId.value) || null)

function positionOf(lane: LaneSummary) {
  return lanes.value.findIndex(item => item.id === lane.id)
}

/** The dragged row leaves the list and a null placeholder takes the spot it would land in. */
const sortItems = computed<Array<LaneSummary | null>>(() => {
  const items: Array<LaneSummary | null> = lanes.value.filter(lane => lane.id !== draggedId.value)
  if (draggedId.value && targetIndex.value !== null) {
    items.splice(Math.min(targetIndex.value, items.length), 0, null)
  }
  return items
})

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
let listElement: HTMLElement | null = null
let suppressClick = false
let previewFrame: number | null = null
let scrollFrame: number | null = null
let pointerX = 0
let pointerY = 0
let previousBodyCursor = ''
let previousBodyUserSelect = ''

function beginPointerDrag(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary) return
  const element = event.target as Element
  // Only the grip starts a drag; the name input and the colour select stay clickable.
  if (!element.closest('[data-lane-handle]')) return
  const row = element.closest<HTMLElement>('[data-lane-row]')
  const id = row?.dataset.laneId
  if (!row || !id) return
  const bounds = row.getBoundingClientRect()

  listElement = event.currentTarget as HTMLElement
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
  window.addEventListener('keydown', handleDragKeydown)
}

function dropPosition(clientY: number) {
  if (!listElement) return 0
  const rows = Array.from(listElement.querySelectorAll<HTMLElement>('[data-lane-row]'))
  const placeholder = listElement.querySelector<HTMLElement>('[data-drop-placeholder]')
  const localY = clientY - listElement.getBoundingClientRect().top
  const placeholderTop = placeholder?.offsetTop
  const placeholderFootprint = placeholder ? placeholder.offsetHeight : 0

  const index = rows.findIndex((row) => {
    // offsetTop describes the final layout and is unaffected by the FLIP transform
    // that Vue applies while rows glide into their new positions.
    const followsPlaceholder = placeholderTop !== undefined && row.offsetTop > placeholderTop
    const compactedTop = row.offsetTop - (followsPlaceholder ? placeholderFootprint : 0)
    return localY < compactedTop + row.offsetHeight / 2
  })

  return index === -1 ? rows.length : index
}

function updateDropTarget(clientY: number) {
  const index = dropPosition(clientY)
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

/** The settings page scrolls the window, so the edges of the viewport pull the list along. */
function runAutoScroll() {
  scrollFrame = null
  if (!pointerDrag?.active) return
  const viewport = window.innerHeight
  const edge = Math.min(64, viewport / 4)
  let delta = 0
  if (pointerY < edge) {
    delta = -Math.ceil(12 * (1 - Math.max(0, pointerY) / edge))
  } else if (pointerY > viewport - edge) {
    delta = Math.ceil(12 * (1 - Math.max(0, viewport - pointerY) / edge))
  }

  if (delta !== 0) {
    const previousScrollY = window.scrollY
    window.scrollBy(0, delta)
    if (window.scrollY !== previousScrollY) {
      updateDropTarget(pointerY)
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
  draggedRowHeight.value = pointerDrag.height
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

  updateDropTarget(event.clientY)
  schedulePreviewPosition()
  scheduleAutoScroll()
  event.preventDefault()
}

function finishPointerDrag(event: PointerEvent) {
  if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return
  if (pointerDrag.active) {
    const id = pointerDrag.id
    const index = targetIndex.value
    const current = lanes.value.map(lane => lane.id)
    if (index !== null) {
      const order = current.filter(laneId => laneId !== id)
      order.splice(Math.min(index, order.length), 0, id)
      if (order.join(',') !== current.join(',')) {
        commitOrder(order, movedText(draggedLane.value || undefined, order.indexOf(id), order.length))
      }
    }
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

function handleDragKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  cleanupPointerDrag()
}

function cleanupPointerDrag() {
  const wasActive = pointerDrag?.active === true
  window.removeEventListener('pointermove', movePointerDrag)
  window.removeEventListener('pointerup', finishPointerDrag)
  window.removeEventListener('pointercancel', cancelPointerDrag)
  window.removeEventListener('keydown', handleDragKeydown)
  if (previewFrame !== null) window.cancelAnimationFrame(previewFrame)
  if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame)
  if (wasActive) {
    document.body.style.cursor = previousBodyCursor
    document.body.style.userSelect = previousBodyUserSelect
  }
  pointerDrag = null
  listElement = null
  previewFrame = null
  scrollFrame = null
  draggedId.value = null
  targetIndex.value = null
  draggedRowHeight.value = 0
  dragPreview.value = null
}

function preventClickAfterDrag(event: MouseEvent) {
  if (!suppressClick) return
  event.preventDefault()
  event.stopPropagation()
}

onBeforeUnmount(cleanupPointerDrag)

function requestDelete(lane: LaneSummary) {
  doomed.value = lane
  // Moving keeps the tickets on the board, so it is the safer default.
  deleteMode.value = 'move'
  deleteTargetId.value = lanes.value.find(item => item.id !== lane.id && !item.isImport)?.id || lanes.value.find(item => item.id !== lane.id)?.id || ''
}

const doomedTicketCount = computed(() => (doomed.value?.ticketCount || 0) + (doomed.value?.archivedCount || 0))

// The lane list shows active tickets only, so name the archived ones separately here
// rather than letting a larger number appear out of nowhere.
const doomedTicketText = computed(() => {
  const active = doomed.value?.ticketCount || 0
  const archived = doomed.value?.archivedCount || 0
  const activeText = `${active === 1 ? '1 ticket is' : `${active} tickets are`} on this lane`
  if (!archived) return activeText
  if (!active) return `${archived === 1 ? '1 archived ticket belongs' : `${archived} archived tickets belong`} to this lane`
  return `${activeText}, plus ${archived === 1 ? '1 archived ticket' : `${archived} archived tickets`}`
})

async function confirmDelete() {
  const lane = doomed.value
  if (!lane || deleting.value) return
  deleting.value = true
  try {
    await $fetch(`/api/boards/${props.board.id}/lanes/${lane.id}`, {
      method: 'DELETE',
      body: deleteMode.value === 'move' ? { mode: 'move', targetLaneId: deleteTargetId.value } : { mode: 'archive' },
    })
    doomed.value = null
    emit('changed')
    emit('notify', 'success', `Lane “${lane.name}” deleted.`)
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <section class="surface rounded-2xl">
    <header class="border-b border-[var(--line)] px-5 py-4">
      <h2 class="mt-0.5 text-lg font-bold">Lanes</h2>
      <p class="muted mt-1 text-sm">Top to bottom is left to right on the board — drag a lane by its handle to reorder, or focus a handle and use the arrow keys. The import lane always stays: every TestFlight ticket lands there. It can be renamed and reordered, but not removed.</p>
    </header>

    <TransitionGroup
      tag="ul"
      name="lane-sort"
      data-lane-list
      class="relative divide-y divide-[var(--line)]"
      @pointerdown="beginPointerDrag"
      @click.capture="preventClickAfterDrag"
    >
      <li
        v-for="item in sortItems"
        :key="item?.id || '__drop-placeholder'"
        :data-lane-row="item ? '' : null"
        :data-lane-id="item?.id"
        :data-drop-placeholder="item ? null : ''"
        :class="item ? 'flex flex-wrap items-center gap-2 px-5 py-3 sm:gap-3' : 'px-5 py-1.5'"
        :style="item ? undefined : { height: `${draggedRowHeight}px` }"
        :aria-hidden="item ? undefined : 'true'"
      >
        <template v-if="item">
          <button
            type="button"
            data-lane-handle
            class="focus-ring muted grid size-9 shrink-0 cursor-grab touch-none place-items-center rounded-xl hover:bg-[var(--panel-strong)] hover:text-[var(--ink)] active:cursor-grabbing"
            :aria-label="`Reorder ${item.name}, position ${positionOf(item) + 1} of ${lanes.length}. Use the arrow up and arrow down keys to move it.`"
            @keydown.up.prevent="moveLane(item, -1)"
            @keydown.down.prevent="moveLane(item, 1)"
          ><GripVertical :size="20" /></button>
          <input
            :value="item.name"
            :disabled="busyLaneId === item.id"
            class="focus-ring surface-strong h-10 min-w-0 flex-1 rounded-xl px-3 text-sm font-semibold outline-none disabled:opacity-50"
            maxlength="30"
            :aria-label="`Name of lane ${item.name}`"
            @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
            @blur="renameLane(item, $event)"
          >
          <span class="muted w-24 shrink-0 text-[11px] font-semibold tabular-nums">{{ item.ticketCount }} {{ item.ticketCount === 1 ? 'ticket' : 'tickets' }}</span>
          <div class="ml-auto flex shrink-0 items-center gap-1">
            <span
              v-if="item.isImport"
              class="muted grid size-9 place-items-center"
              title="The import lane cannot be deleted"
            >
              <Lock :size="16" aria-hidden="true" />
              <span class="sr-only">The import lane cannot be deleted</span>
            </span>
            <button
              v-else
              class="focus-ring grid size-9 place-items-center rounded-xl text-rose-600 hover:bg-rose-500/10 disabled:opacity-40"
              :disabled="lanes.length <= 2 || busyLaneId === item.id"
              :aria-label="`Delete lane ${item.name}`"
              @click="requestDelete(item)"
            ><Trash2 :size="16" /></button>
          </div>
        </template>
        <div
          v-else
          class="h-full rounded-xl bg-[color-mix(in_srgb,var(--accent)_9%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_22%,transparent)]"
        />
      </li>
    </TransitionGroup>

    <p class="sr-only" aria-live="polite">{{ liveMessage }}</p>

    <form class="flex flex-wrap items-center gap-3 border-t border-[var(--line)] px-5 py-4" @submit.prevent="addLane">
      <input
        v-model="newLaneName"
        class="focus-ring surface-strong h-10 min-w-0 flex-1 rounded-xl px-3 text-sm outline-none"
        maxlength="30"
        placeholder="New lane name"
        aria-label="New lane name"
      >
      <button
        type="submit"
        :disabled="adding || !newLaneName.trim()"
        class="focus-ring flex h-10 items-center gap-2 rounded-xl bg-[var(--ink)] px-3.5 text-sm font-semibold text-[var(--canvas)] disabled:opacity-50"
      ><Plus :size="16" /> Add lane</button>
    </form>

    <AlertDialogRoot :open="Boolean(doomed)" @update:open="open => !open && !deleting && (doomed = null)">
      <AlertDialogPortal>
        <AlertDialogOverlay class="ui-dialog-overlay fixed inset-0 z-[110] bg-black/40 backdrop-blur-[2px]" />
        <AlertDialogContent class="ui-dialog-content surface fixed left-1/2 top-1/2 z-[111] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl p-5 shadow-2xl sm:p-6">
          <AlertDialogTitle class="text-lg font-bold tracking-[-.025em]">Delete lane “{{ doomed?.name }}”?</AlertDialogTitle>
          <AlertDialogDescription class="muted mt-2 text-sm leading-relaxed">
            <template v-if="doomedTicketCount">
              {{ doomedTicketText }}. Choose what happens to {{ doomedTicketCount === 1 ? 'it' : 'them' }}.
            </template>
            <template v-else>This lane is empty and can be removed right away.</template>
          </AlertDialogDescription>

          <fieldset v-if="doomedTicketCount" class="mt-5 space-y-3">
            <legend class="sr-only">What happens to the tickets</legend>
            <label class="surface-strong flex cursor-pointer items-start gap-3 rounded-xl p-3.5" :class="deleteMode === 'move' ? 'ring-2 ring-[var(--accent)]' : ''">
              <input v-model="deleteMode" type="radio" value="move" class="mt-1" name="lane-delete-mode">
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-semibold">Move them to another lane</span>
                <span class="muted block text-xs">The tickets stay on the board.</span>
                <span class="mt-2 block">
                  <UiSelect v-model="deleteTargetId" :options="moveTargets" :disabled="deleteMode !== 'move'" compact aria-label="Target lane" />
                </span>
              </span>
            </label>
            <label class="surface-strong flex cursor-pointer items-start gap-3 rounded-xl p-3.5" :class="deleteMode === 'archive' ? 'ring-2 ring-[var(--accent)]' : ''">
              <input v-model="deleteMode" type="radio" value="archive" class="mt-1" name="lane-delete-mode">
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-semibold">Archive them</span>
                <span class="muted block text-xs">The tickets leave the board but stay restorable in the archive.</span>
              </span>
            </label>
          </fieldset>

          <div class="mt-6 flex justify-end gap-2.5">
            <AlertDialogCancel as-child>
              <button type="button" :disabled="deleting" class="focus-ring h-10 rounded-xl px-4 text-sm font-semibold hover:bg-[var(--panel-strong)] disabled:opacity-50">Cancel</button>
            </AlertDialogCancel>
            <button
              type="button"
              :disabled="deleting || (deleteMode === 'move' && !deleteTargetId)"
              class="focus-ring flex h-10 items-center gap-2 rounded-xl bg-rose-600 px-4 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
              @click="confirmDelete"
            >
              <LoaderCircle v-if="deleting" :size="16" class="animate-spin" aria-hidden="true" />
              {{ deleting ? 'Please wait…' : 'Delete lane' }}
            </button>
          </div>
        </AlertDialogContent>
      </AlertDialogPortal>
    </AlertDialogRoot>
  </section>

  <Teleport to="body">
    <div
      v-if="draggedLane && dragPreview"
      ref="dragPreviewElement"
      inert
      class="pointer-events-none fixed left-0 top-0 z-[100] will-change-transform"
      :style="{
        width: `${dragPreview.width}px`,
        transform: `translate3d(${dragPreview.x}px, ${dragPreview.y}px, 0)`,
      }"
      aria-hidden="true"
    >
      <div class="surface flex flex-wrap items-center gap-2 rounded-xl px-5 py-3 shadow-2xl ring-1 ring-[color-mix(in_srgb,var(--accent)_35%,transparent)] sm:gap-3">
        <span class="muted grid size-9 shrink-0 place-items-center"><GripVertical :size="16" /></span>
        <span class="surface-strong flex h-10 min-w-0 flex-1 items-center rounded-xl px-3 text-sm font-semibold">{{ draggedLane.name }}</span>
        <span class="muted w-24 shrink-0 text-[11px] font-semibold tabular-nums">{{ draggedLane.ticketCount }} {{ draggedLane.ticketCount === 1 ? 'ticket' : 'tickets' }}</span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.lane-sort-move {
  transition: transform 180ms cubic-bezier(.2, .8, .2, 1);
}

@media (prefers-reduced-motion: reduce) {
  .lane-sort-move {
    transition: none;
  }
}
</style>
