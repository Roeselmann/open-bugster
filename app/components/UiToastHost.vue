<script setup lang="ts">
import { CircleCheck, CircleX, X } from '@lucide/vue'
import { ToastClose, ToastDescription, ToastPortal, ToastProvider, ToastRoot, ToastViewport } from 'reka-ui'

export interface UiNotice {
  id: number
  type: 'success' | 'error'
  text: string
}

const props = defineProps<{ notice: UiNotice | null }>()
const emit = defineEmits<{ close: [id: number] }>()

function handleOpenChange(open: boolean) {
  const id = props.notice?.id
  if (!open && id !== undefined) emit('close', id)
}
</script>

<template>
  <ToastProvider :duration="4500" swipe-direction="right">
    <ToastPortal>
      <ToastViewport class="fixed inset-x-0 bottom-5 z-[120] flex list-none justify-center px-4 outline-none">
        <ToastRoot
          v-if="notice"
          :key="notice.id"
          default-open
          type="foreground"
          class="ui-toast pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold text-white shadow-xl"
          :class="notice.type === 'success' ? 'bg-emerald-600' : 'bg-rose-600'"
          @update:open="handleOpenChange"
        >
          <CircleCheck v-if="notice.type === 'success'" :size="18" class="shrink-0" aria-hidden="true" />
          <CircleX v-else :size="18" class="shrink-0" aria-hidden="true" />
          <ToastDescription class="min-w-0 flex-1">{{ notice.text }}</ToastDescription>
          <ToastClose as-child>
            <button type="button" class="focus-ring grid size-8 shrink-0 place-items-center rounded-lg hover:bg-white/15" aria-label="Dismiss notification">
              <X :size="15" aria-hidden="true" />
            </button>
          </ToastClose>
        </ToastRoot>
      </ToastViewport>
    </ToastPortal>
  </ToastProvider>
</template>
