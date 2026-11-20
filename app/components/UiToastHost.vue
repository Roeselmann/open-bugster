<script setup lang="ts">
import { CircleCheck, CircleX, X } from '@lucide/vue'
import { ToastAction, ToastClose, ToastDescription, ToastPortal, ToastProvider, ToastRoot, ToastViewport } from 'reka-ui'

export interface UiNotice {
  id: number
  type: 'success' | 'error'
  text: string
  /** A button beside the text, an Undo; the toast closes when it is pressed. Client-side only. */
  action?: { label: string; run: () => void }
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
          <ToastAction v-if="notice.action" :alt-text="notice.action.label" as-child>
            <button type="button" class="focus-ring shrink-0 rounded-lg border border-white/40 px-2.5 py-1 text-xs font-bold hover:bg-white/15" data-toast-action @click="notice.action.run()">{{ notice.action.label }}</button>
          </ToastAction>
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
