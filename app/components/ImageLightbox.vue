<script setup lang="ts">
import { ChevronLeft, ChevronRight, RotateCcw, X, ZoomIn, ZoomOut } from '@lucide/vue'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  VisuallyHidden,
} from 'reka-ui'
import type { Attachment } from '~~/shared/types/domain'

const props = defineProps<{ images: Attachment[]; initialId: string }>()
const emit = defineEmits<{ close: [] }>()
const index = ref(Math.max(0, props.images.findIndex(image => image.id === props.initialId)))
const scale = ref(1)
const active = computed(() => props.images[index.value])

function select(nextIndex: number) {
  index.value = (nextIndex + props.images.length) % props.images.length
  scale.value = 1
}

function keydown(event: KeyboardEvent) {
  if (event.key === 'ArrowLeft' && props.images.length > 1) select(index.value - 1)
  if (event.key === 'ArrowRight' && props.images.length > 1) select(index.value + 1)
  if (event.key === '+' || event.key === '=') scale.value = Math.min(4, scale.value + 0.25)
  if (event.key === '-') scale.value = Math.max(1, scale.value - 0.25)
  if (event.key === '0') scale.value = 1
}

onMounted(() => window.addEventListener('keydown', keydown))
onBeforeUnmount(() => window.removeEventListener('keydown', keydown))
</script>

<template>
  <DialogRoot :open="true" @update:open="open => !open && emit('close')">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-[80] bg-black/85 backdrop-blur-sm" />
      <DialogContent class="fixed inset-0 z-[81] flex flex-col outline-none">
        <VisuallyHidden>
          <DialogTitle>Image preview</DialogTitle>
          <DialogDescription>{{ active?.filename }}</DialogDescription>
        </VisuallyHidden>

        <header class="flex h-16 shrink-0 items-center gap-2 px-4 text-white sm:px-6">
          <p class="min-w-0 truncate text-sm font-semibold">{{ active?.filename }}</p>
          <span v-if="images.length > 1" class="text-xs text-white/60">{{ index + 1 }} / {{ images.length }}</span>
          <div class="ml-auto flex items-center gap-1 rounded-xl bg-white/10 p-1">
            <button type="button" class="grid size-9 place-items-center rounded-lg hover:bg-white/15 disabled:opacity-40" :disabled="scale <= 1" aria-label="Zoom out" @click="scale = Math.max(1, scale - 0.25)"><ZoomOut :size="18" /></button>
            <button type="button" class="min-w-14 px-1 text-xs font-semibold" aria-label="Reset zoom" @click="scale = 1">{{ Math.round(scale * 100) }} %</button>
            <button type="button" class="grid size-9 place-items-center rounded-lg hover:bg-white/15 disabled:opacity-40" :disabled="scale >= 4" aria-label="Zoom in" @click="scale = Math.min(4, scale + 0.25)"><ZoomIn :size="18" /></button>
            <button type="button" class="grid size-9 place-items-center rounded-lg hover:bg-white/15 disabled:opacity-40" :disabled="scale === 1" aria-label="Reset zoom" @click="scale = 1"><RotateCcw :size="17" /></button>
          </div>
          <DialogClose as-child>
            <button type="button" class="grid size-10 place-items-center rounded-xl bg-white/10 hover:bg-white/20" aria-label="Close image preview"><X :size="20" /></button>
          </DialogClose>
        </header>

        <div class="relative min-h-0 flex-1 overflow-auto">
          <button v-if="images.length > 1" type="button" class="fixed left-3 top-1/2 z-10 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white hover:bg-black/70 sm:left-6" aria-label="Previous image" @click="select(index - 1)"><ChevronLeft :size="25" /></button>
          <div class="flex min-h-full min-w-full items-center justify-center p-5 transition-[width,height] duration-150" :style="{ width: `${scale * 100}%`, height: `${scale * 100}%` }">
            <img v-if="active" :src="active.url" :alt="active.filename" class="max-h-[calc(100vh-7rem)] max-w-[calc(100vw-3rem)] object-contain shadow-2xl transition-transform duration-150" :style="{ transform: `scale(${scale})` }">
          </div>
          <button v-if="images.length > 1" type="button" class="fixed right-3 top-1/2 z-10 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white hover:bg-black/70 sm:right-6" aria-label="Next image" @click="select(index + 1)"><ChevronRight :size="25" /></button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
