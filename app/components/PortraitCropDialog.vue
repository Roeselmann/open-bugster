<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'

/**
 * Picks the part of a photo that becomes the round portrait.
 *
 * The circle always spans the photo's shorter side, so the only choice left is where along
 * the longer side it sits: left to right for a landscape photo, top to bottom for a portrait
 * one. Only that position leaves the dialog: the server keeps the original and cuts the
 * square from it, so the cut can be moved again later. The rounding is CSS.
 */
const props = defineProps<{
  /** The photo: a data URL for a new file, or the stored original's address. Null closes the dialog. */
  source: string | null
  /** Where the circle sat last time, 0–1 along the long side; centred when null. */
  initialPosition?: number | null
  /** Offers to pick a different photo, for an existing portrait. */
  canReplace?: boolean
  pending: boolean
}>()
const emit = defineEmits<{ cancel: []; replace: []; confirm: [position: number] }>()
/** Longest side of the photo on screen, narrower on a phone so the dialog never scrolls sideways. */
const STAGE = 420
const stage = ref(STAGE)

const natural = reactive({ width: 0, height: 0 })
const failed = ref(false)
/** Where the circle starts along the long axis, in screen pixels. */
const offset = ref(0)

const scale = computed(() => (natural.width && natural.height ? Math.min(stage.value / natural.width, stage.value / natural.height, 1) : 1))
const display = computed(() => ({ width: Math.round(natural.width * scale.value), height: Math.round(natural.height * scale.value) }))
const diameter = computed(() => Math.min(display.value.width, display.value.height))
const landscape = computed(() => display.value.width > display.value.height)
const travel = computed(() => Math.max(0, (landscape.value ? display.value.width : display.value.height) - diameter.value))
const circleStyle = computed(() => ({
  width: `${diameter.value}px`,
  height: `${diameter.value}px`,
  left: `${landscape.value ? offset.value : 0}px`,
  top: `${landscape.value ? 0 : offset.value}px`,
}))

watch(() => props.source, (source) => {
  failed.value = false
  natural.width = 0
  natural.height = 0
  if (!source) return
  stage.value = Math.min(STAGE, window.innerWidth - 72)
  const loader = new Image()
  loader.onload = () => {
    natural.width = loader.naturalWidth
    natural.height = loader.naturalHeight
    // Where it was left, or centred: usually where the face is.
    offset.value = travel.value * (props.initialPosition ?? 0.5)
  }
  loader.onerror = () => { failed.value = true }
  loader.src = source
}, { immediate: true })

const clamp = (value: number) => Math.min(travel.value, Math.max(0, value))

/* Dragging: the circle follows the pointer along the long axis only. */
let dragStart: { pointer: number; offset: number } | null = null
function startDrag(event: PointerEvent) {
  if (!travel.value) return
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  dragStart = { pointer: landscape.value ? event.clientX : event.clientY, offset: offset.value }
}
function drag(event: PointerEvent) {
  if (!dragStart) return
  const position = landscape.value ? event.clientX : event.clientY
  offset.value = clamp(dragStart.offset + position - dragStart.pointer)
}
function endDrag() { dragStart = null }

/** Arrow keys for anyone not using a pointer; Shift moves in larger steps. */
function nudge(event: KeyboardEvent) {
  const back = landscape.value ? 'ArrowLeft' : 'ArrowUp'
  const forward = landscape.value ? 'ArrowRight' : 'ArrowDown'
  if (event.key !== back && event.key !== forward) return
  event.preventDefault()
  const step = event.shiftKey ? 20 : 4
  offset.value = clamp(offset.value + (event.key === forward ? step : -step))
}

function confirm() {
  if (!diameter.value) return
  emit('confirm', travel.value ? offset.value / travel.value : 0.5)
}
</script>

<template>
  <DialogRoot :open="Boolean(source)" @update:open="open => !open && !pending && emit('cancel')">
    <DialogPortal>
      <DialogOverlay class="ui-dialog-overlay fixed inset-0 z-[110] bg-black/40 backdrop-blur-[2px]" />
      <DialogContent
        class="ui-dialog-content surface fixed left-1/2 top-1/2 z-[111] w-[calc(100%-2rem)] max-w-[30rem] -translate-x-1/2 -translate-y-1/2 rounded-2xl p-5 shadow-2xl sm:p-6"
        @escape-key-down="pending && $event.preventDefault()"
        @pointer-down-outside="pending && $event.preventDefault()"
      >
        <DialogTitle class="text-lg font-bold tracking-[-.025em]">Choose your portrait</DialogTitle>
        <DialogDescription class="muted mt-1 text-sm">
          <template v-if="travel">Drag the circle {{ landscape ? 'left or right' : 'up or down' }} until your face sits in it.</template>
          <template v-else-if="canReplace">
            This picture is square, so the circle already covers all of it. For a different cut,
            choose another photo.
          </template>
          <template v-else>The whole picture fits the circle.</template>
        </DialogDescription>

        <p v-if="failed" class="mt-5 rounded-xl bg-rose-500/10 px-3.5 py-3 text-sm text-rose-700">
          This file could not be opened as a picture. Try a JPEG or PNG.
        </p>
        <div v-else-if="display.width" class="mt-5 flex justify-center">
          <!-- The photo, darkened outside the circle by the circle's own oversized shadow. -->
          <div class="relative select-none overflow-hidden rounded-lg" :style="{ width: `${display.width}px`, height: `${display.height}px` }">
            <img :src="source!" alt="" draggable="false" class="block size-full">
            <div
              role="slider"
              tabindex="0"
              :aria-label="landscape ? 'Horizontal position of the portrait' : 'Vertical position of the portrait'"
              :aria-orientation="landscape ? 'horizontal' : 'vertical'"
              :aria-valuemin="0"
              :aria-valuemax="Math.round(travel)"
              :aria-valuenow="Math.round(offset)"
              class="focus-ring absolute touch-none rounded-full shadow-[0_0_0_9999px_rgba(0,0,0,.55)] outline outline-2 outline-white/90"
              :class="travel ? (landscape ? 'cursor-ew-resize' : 'cursor-ns-resize') : ''"
              :style="circleStyle"
              @pointerdown="startDrag"
              @pointermove="drag"
              @pointerup="endDrag"
              @pointercancel="endDrag"
              @keydown="nudge"
            />
          </div>
        </div>
        <div v-else class="mt-5 grid h-40 place-items-center"><LoaderCircle class="muted animate-spin" :size="20" aria-hidden="true" /></div>

        <div class="mt-6 flex items-center justify-end gap-2.5">
          <button
            v-if="canReplace"
            type="button"
            :disabled="pending"
            class="focus-ring mr-auto h-10 rounded-xl px-3 text-sm font-semibold hover:bg-[var(--panel-strong)] disabled:opacity-50"
            @click="emit('replace')"
          >
            Choose another photo
          </button>
          <button type="button" :disabled="pending" class="focus-ring h-10 rounded-xl px-4 text-sm font-semibold hover:bg-[var(--panel-strong)] disabled:opacity-50" @click="emit('cancel')">Cancel</button>
          <button
            type="button"
            :disabled="pending || failed || !display.width"
            class="focus-ring flex h-10 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] hover:opacity-85 disabled:opacity-50"
            @click="confirm"
          >
            <LoaderCircle v-if="pending" :size="16" class="animate-spin" aria-hidden="true" />
            {{ pending ? 'Saving…' : 'OK' }}
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
