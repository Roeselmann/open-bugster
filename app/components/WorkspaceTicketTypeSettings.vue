<script setup lang="ts">
import { Check, GripVertical, Pencil, Plus, Trash2, X } from '@lucide/vue'
import type { TicketTypeColor, TicketTypeIcon, TicketTypeSummary } from '~~/shared/types/domain'
import { categoryColors } from '~~/shared/types/domain'
import { CATEGORY_COLOR_LABELS, CATEGORY_TONE_CLASSES } from '~~/shared/utils/constants'

const props = defineProps<{ workspaceId: string }>()
const emit = defineEmits<{ notify: [type: 'success' | 'error', text: string] }>()

const workspaceId = computed(() => props.workspaceId)
const { data, refresh } = await useFetch<{ types: TicketTypeSummary[] }>('/api/ticket-types', {
  query: { workspaceId },
  watch: [workspaceId],
})
const types = computed(() => data.value?.types || [])

// "None" leaves the card in its ordinary colour, so its swatch shows exactly that.
const toneOptions = [
  { value: 'none', label: 'None', toneClass: 'bg-[var(--panel-strong)]' },
  ...categoryColors.map(color => ({
    value: color,
    label: CATEGORY_COLOR_LABELS[color],
    toneClass: CATEGORY_TONE_CLASSES[color],
  })),
]

/* ── editing a row ──────────────────────────────────────────────────────── */

const busyId = ref<string | null>(null)
const editingId = ref<string | null>(null)
const draftName = ref('')
const nameInput = ref<HTMLInputElement | null>(null)

function startEdit(type: TicketTypeSummary) {
  editingId.value = type.id
  draftName.value = type.name
  nextTick(() => nameInput.value?.select())
}

function cancelEdit() {
  // Clearing the id first makes the blur that follows a no-op.
  editingId.value = null
  draftName.value = ''
}

async function saveEdit(type: TicketTypeSummary) {
  if (editingId.value !== type.id) return
  const name = draftName.value.trim()
  editingId.value = null
  if (!name || name === type.name) return
  await patchType(type, { name }, `Type renamed to “${name}”.`)
}

async function patchType(type: TicketTypeSummary, body: { name?: string; color?: TicketTypeColor; icon?: TicketTypeIcon }, success?: string) {
  busyId.value = type.id
  try {
    await $fetch(`/api/ticket-types/${type.id}`, { method: 'PATCH', body })
    await refresh()
    if (success) emit('notify', 'success', success)
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    busyId.value = null
  }
}

/* ── order ──────────────────────────────────────────────────────────────────
   The same pointer-drag sorting the workspace's board list uses: the row is lifted into a
   floating preview, a dashed placeholder marks where it would land, and the handle keeps
   Alt+arrow keys for anybody not dragging. The order shown is local while a save is in
   flight and falls back to the server's on failure. */

const orderedTypes = ref<TicketTypeSummary[]>([])
const draggingId = ref<string | null>(null)
watch(types, (value) => {
  // Mid-drag the local order is ahead of the server; syncing now would yank the list around.
  if (!draggingId.value) orderedTypes.value = [...value]
}, { immediate: true })

const targetIndex = ref<number | null>(null)
const dragPreview = ref<{ x: number; y: number; width: number; height: number } | null>(null)
const dragPreviewElement = ref<HTMLElement | null>(null)
const listElement = ref<HTMLElement | null>(null)
const draggedType = computed(() => orderedTypes.value.find(type => type.id === draggingId.value) || null)
const sortItems = computed<Array<TicketTypeSummary | null>>(() => {
  if (!draggingId.value || targetIndex.value === null) return orderedTypes.value
  const items: Array<TicketTypeSummary | null> = orderedTypes.value.filter(type => type.id !== draggingId.value)
  items.splice(Math.min(targetIndex.value, items.length), 0, null)
  return items
})

interface PointerDrag {
  pointerId: number
  id: string
  offsetX: number
  offsetY: number
}

let pointer: PointerDrag | null = null
let previousBodyUserSelect = ''
let previousBodyCursor = ''
let pointerX = 0
let pointerY = 0
let previewFrame: number | null = null
let scrollFrame: number | null = null

function beginDrag(event: PointerEvent, id: string) {
  if (event.button !== 0 || !event.isPrimary || busyId.value || editingId.value) return
  const row = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-type-row]')
  if (!row) return
  const bounds = row.getBoundingClientRect()
  pointer = { pointerId: event.pointerId, id, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top }
  pointerX = event.clientX
  pointerY = event.clientY
  draggingId.value = id
  targetIndex.value = orderedTypes.value.findIndex(type => type.id === id)
  dragPreview.value = { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height }
  previousBodyUserSelect = document.body.style.userSelect
  previousBodyCursor = document.body.style.cursor
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'grabbing'
  window.addEventListener('pointermove', moveDrag, { passive: false })
  window.addEventListener('pointerup', finishDrag)
  window.addEventListener('pointercancel', cancelDrag)
  event.preventDefault()
}

function dropPosition(clientY: number) {
  const stack = listElement.value?.querySelector<HTMLElement>('[data-type-stack]')
  if (!stack) return 0
  const rows = Array.from(stack.querySelectorAll<HTMLElement>('[data-type-sort-item]'))
  const placeholder = stack.querySelector<HTMLElement>('[data-type-placeholder]')
  const localY = clientY - stack.getBoundingClientRect().top
  const placeholderTop = placeholder?.offsetTop
  const placeholderFootprint = placeholder ? placeholder.offsetHeight + 8 : 0
  const index = rows.findIndex((row) => {
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

function schedulePreview() {
  if (previewFrame !== null) return
  previewFrame = window.requestAnimationFrame(() => {
    previewFrame = null
    if (!pointer || !dragPreviewElement.value) return
    dragPreviewElement.value.style.transform = `translate3d(${pointerX - pointer.offsetX}px, ${pointerY - pointer.offsetY}px, 0)`
  })
}

// The list scrolls with the page, so the edges to creep past are the viewport's own.
function runAutoScroll() {
  scrollFrame = null
  if (!pointer) return
  const edge = Math.min(72, window.innerHeight / 4)
  let delta = 0
  if (pointerY < edge) delta = -Math.ceil(10 * (1 - Math.max(0, pointerY) / edge))
  else if (pointerY > window.innerHeight - edge) delta = Math.ceil(10 * (1 - Math.max(0, window.innerHeight - pointerY) / edge))
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

function moveDrag(event: PointerEvent) {
  if (!pointer || event.pointerId !== pointer.pointerId) return
  pointerX = event.clientX
  pointerY = event.clientY
  updateDropTarget(event.clientY)
  schedulePreview()
  scheduleAutoScroll()
  event.preventDefault()
}

function finishDrag(event?: PointerEvent) {
  if (event && pointer && event.pointerId !== pointer.pointerId) return
  const id = pointer?.id
  const target = targetIndex.value
  if (id && target !== null) {
    const sourceIndex = orderedTypes.value.findIndex(type => type.id === id)
    const [type] = sourceIndex >= 0 ? orderedTypes.value.splice(sourceIndex, 1) : []
    if (type) orderedTypes.value.splice(Math.max(0, Math.min(target, orderedTypes.value.length)), 0, type)
  }
  cleanupDrag()
  persistOrder()
}

function cancelDrag(event?: PointerEvent) {
  if (event && pointer && event.pointerId !== pointer.pointerId) return
  cleanupDrag()
}

function cleanupDrag() {
  const wasDragging = Boolean(pointer)
  window.removeEventListener('pointermove', moveDrag)
  window.removeEventListener('pointerup', finishDrag)
  window.removeEventListener('pointercancel', cancelDrag)
  if (previewFrame !== null) window.cancelAnimationFrame(previewFrame)
  if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame)
  if (wasDragging) {
    document.body.style.userSelect = previousBodyUserSelect
    document.body.style.cursor = previousBodyCursor
  }
  pointer = null
  previewFrame = null
  scrollFrame = null
  draggingId.value = null
  targetIndex.value = null
  dragPreview.value = null
}

onBeforeUnmount(cleanupDrag)

/** The keyboard path to the same reorder, kept on the drag handle. */
function moveBy(id: string, delta: number) {
  const index = orderedTypes.value.findIndex(type => type.id === id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= orderedTypes.value.length) return
  const [type] = orderedTypes.value.splice(index, 1)
  if (!type) return
  orderedTypes.value.splice(target, 0, type)
  nextTick(() => document.querySelector<HTMLButtonElement>(`[data-type-handle="${id}"]`)?.focus())
  persistOrder()
}

async function persistOrder() {
  const ids = orderedTypes.value.map(type => type.id)
  if (ids.join('\n') === types.value.map(type => type.id).join('\n')) return
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/ticket-type-order`, { method: 'PATCH', body: { typeIds: ids } })
    await refresh()
  } catch (error) {
    emit('notify', 'error', errorText(error))
    // The server kept its order, so the list goes back to it rather than lying.
    orderedTypes.value = [...types.value]
  }
}

/* ── deleting ───────────────────────────────────────────────────────────── */

const doomed = ref<TicketTypeSummary | null>(null)
const deleting = ref(false)

async function confirmDelete() {
  const type = doomed.value
  if (!type || deleting.value) return
  deleting.value = true
  try {
    await $fetch(`/api/ticket-types/${type.id}`, { method: 'DELETE' })
    doomed.value = null
    await refresh()
    emit('notify', 'success', `Type “${type.name}” deleted.`)
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    deleting.value = false
  }
}

const deleteDescription = computed(() => {
  const count = doomed.value?.ticketCount || 0
  if (!count) return 'No ticket carries this type.'
  return count === 1 ? '1 ticket will become untyped.' : `${count} tickets will become untyped.`
})

/* ── creating ───────────────────────────────────────────────────────────── */

const newName = ref('')
const newColor = ref<TicketTypeColor>('neutral')
const newIcon = ref<TicketTypeIcon>({ kind: 'lucide', name: 'Ticket' })
const creating = ref(false)

async function createType() {
  const name = newName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  try {
    await $fetch('/api/ticket-types', { method: 'POST', body: { workspaceId: props.workspaceId, name, color: newColor.value, icon: newIcon.value } })
    newName.value = ''
    newColor.value = 'neutral'
    newIcon.value = { kind: 'lucide', name: 'Ticket' }
    await refresh()
    emit('notify', 'success', `Type “${name}” was created.`)
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <section class="surface rounded-2xl">
    <header class="border-b border-[var(--line)] px-5 py-4">
      <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Vocabulary</p>
      <h2 class="mt-0.5 text-lg font-bold">Ticket types</h2>
      <p class="muted mt-1 text-sm">
        What kind of thing a ticket is — an email, a social post, a to-do. Types belong to the
        workspace, so every board in it shares them. A ticket may also have none.
      </p>
    </header>

    <div v-if="orderedTypes.length" ref="listElement" class="px-5 py-4">
      <TransitionGroup name="type-sort" tag="div" data-type-stack class="relative flex flex-col gap-2">
        <div v-for="item in sortItems" :key="item?.id || '__type-drop-placeholder'" :data-type-sort-item="item?.id">
          <div
            v-if="item"
            :data-type-row="item.id"
            class="surface-strong flex flex-wrap items-center gap-2 rounded-xl p-2 pr-2.5 transition-[border-color,background-color,box-shadow] duration-150 hover:border-[color-mix(in_srgb,var(--line)_60%,var(--accent))]"
          >
            <button
              type="button"
              :data-type-handle="item.id"
              class="focus-ring muted grid size-8 shrink-0 cursor-grab touch-none place-items-center rounded-lg hover:bg-[var(--panel)] active:cursor-grabbing"
              :aria-label="`Reorder ${item.name}`"
              title="Drag to reorder · Alt+arrow keys"
              @pointerdown="beginDrag($event, item.id)"
              @keydown.alt.up.prevent="moveBy(item.id, -1)"
              @keydown.alt.down.prevent="moveBy(item.id, 1)"
            ><GripVertical :size="17" /></button>
            <TicketTypeBadge :type="item" untitled />

            <div class="min-w-0 flex-1 px-1">
              <template v-if="editingId === item.id">
                <input
                  :ref="element => (nameInput = element as HTMLInputElement | null)"
                  v-model="draftName"
                  class="focus-ring surface h-9 w-full min-w-0 rounded-lg px-3 text-sm font-semibold outline-none"
                  maxlength="30"
                  :aria-label="`Name of type ${item.name}`"
                  @keydown.enter.prevent="saveEdit(item)"
                  @keydown.esc.prevent="cancelEdit"
                  @blur="saveEdit(item)"
                >
              </template>
              <template v-else>
                <p class="truncate text-sm font-semibold">{{ item.name }}</p>
                <p class="muted truncate text-xs">{{ item.ticketCount }} {{ item.ticketCount === 1 ? 'ticket' : 'tickets' }}</p>
              </template>
            </div>

            <div class="w-36 shrink-0">
              <UiToneSelect
                :model-value="item.color"
                :options="toneOptions"
                :disabled="busyId === item.id"
                compact
                :aria-label="`Colour of type ${item.name}`"
                @update:model-value="value => patchType(item, { color: value as TicketTypeColor })"
              />
            </div>

            <TicketTypeIconPicker
              :model-value="item.icon"
              :color="item.color"
              :name="item.name"
              :disabled="busyId === item.id"
              @update:model-value="icon => patchType(item, { icon })"
              @error="text => emit('notify', 'error', text)"
            />

            <div class="flex shrink-0 items-center gap-1">
              <button
                v-if="editingId === item.id"
                type="button"
                class="focus-ring grid size-8 place-items-center rounded-lg text-emerald-600 hover:bg-emerald-500/10"
                :aria-label="`Save name of ${item.name}`"
                @mousedown.prevent
                @click="saveEdit(item)"
              ><Check :size="16" /></button>
              <button
                v-if="editingId === item.id"
                type="button"
                class="focus-ring muted grid size-8 place-items-center rounded-lg hover:bg-[var(--panel)]"
                :aria-label="`Discard the new name of ${item.name}`"
                @mousedown.prevent
                @click="cancelEdit"
              ><X :size="16" /></button>
              <button
                v-else
                type="button"
                class="focus-ring muted grid size-8 place-items-center rounded-lg hover:bg-[var(--panel)] hover:text-[var(--ink)] disabled:opacity-40"
                :disabled="busyId === item.id"
                :aria-label="`Rename ${item.name}`"
                @click="startEdit(item)"
              ><Pencil :size="16" /></button>
              <button
                type="button"
                class="focus-ring grid size-8 place-items-center rounded-lg text-rose-600 hover:bg-rose-500/10 disabled:opacity-40"
                :disabled="busyId === item.id"
                :aria-label="`Delete ${item.name}`"
                @click="doomed = item"
              ><Trash2 :size="16" /></button>
            </div>
          </div>
          <div
            v-else
            data-type-placeholder
            class="pointer-events-none rounded-xl border border-dashed border-[color-mix(in_srgb,var(--accent)_38%,var(--line))] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_8%,transparent)]"
            :style="{ height: `${dragPreview?.height || 52}px` }"
            aria-hidden="true"
          />
        </div>
      </TransitionGroup>
    </div>
    <p v-else class="muted px-5 py-6 text-sm">No types yet. Tickets on this workspace's boards stay untyped until you add one.</p>

    <form class="flex flex-wrap items-center gap-3 border-t border-[var(--line)] px-5 py-4" @submit.prevent="createType">
      <input
        v-model="newName"
        class="focus-ring surface-strong h-11 min-w-0 flex-1 rounded-xl px-3 text-sm outline-none"
        maxlength="30"
        placeholder="New type name"
        aria-label="Name for a new type"
      >
      <div class="w-36 shrink-0">
        <UiToneSelect v-model="newColor" :options="toneOptions" aria-label="Colour for the new type" />
      </div>
      <TicketTypeIconPicker v-model="newIcon" :color="newColor" :name="newName || 'New type'" @error="text => emit('notify', 'error', text)" />
      <button
        type="submit"
        :disabled="creating || !newName.trim()"
        class="focus-ring flex h-11 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] disabled:opacity-50"
      >
        <Plus :size="16" aria-hidden="true" /> {{ creating ? 'Creating…' : 'Create type' }}
      </button>
    </form>

    <UiConfirmDialog
      v-if="doomed"
      :open="true"
      :title="`Delete type “${doomed.name}”?`"
      :description="deleteDescription"
      confirm-label="Delete type"
      :pending="deleting"
      @update:open="open => !open && !deleting && (doomed = null)"
      @confirm="confirmDelete"
    />

    <Teleport to="body">
      <div
        v-if="draggedType && dragPreview"
        ref="dragPreviewElement"
        inert
        class="pointer-events-none fixed left-0 top-0 z-[110] will-change-transform"
        :style="{
          width: `${dragPreview.width}px`,
          transform: `translate3d(${dragPreview.x}px, ${dragPreview.y}px, 0)`,
        }"
        aria-hidden="true"
      >
        <div class="surface-strong flex items-center gap-2 rounded-xl border-[color-mix(in_srgb,var(--accent)_38%,var(--line))] p-2 pr-2.5 shadow-[0_16px_38px_rgba(0,0,0,.18),0_4px_12px_rgba(0,0,0,.1)] [scale:1.015]">
          <span class="grid size-8 shrink-0 place-items-center rounded-lg text-[var(--accent)]"><GripVertical :size="17" /></span>
          <TicketTypeBadge :type="draggedType" untitled />
          <div class="min-w-0 flex-1 px-1">
            <p class="truncate text-sm font-semibold">{{ draggedType.name }}</p>
            <p class="muted truncate text-xs">{{ draggedType.ticketCount }} {{ draggedType.ticketCount === 1 ? 'ticket' : 'tickets' }}</p>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.type-sort-move {
  transition: transform 190ms cubic-bezier(.2, .8, .2, 1);
}
</style>
