<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue'
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from 'reka-ui'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  description: string
  confirmLabel: string
  pending?: boolean
}>(), {
  pending: false,
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: []
}>()

const submitting = ref(false)
const interactionLocked = computed(() => props.pending || submitting.value)

watch(() => props.pending, (pending, wasPending) => {
  if (wasPending && !pending) submitting.value = false
})

function updateOpen(value: boolean) {
  if (!interactionLocked.value) emit('update:open', value)
}

function handleContentClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element) || !target.closest('[data-confirm-action]') || interactionLocked.value) return
  event.preventDefault()
  submitting.value = true
  emit('confirm')
}
</script>

<template>
  <AlertDialogRoot :open="open" @update:open="updateOpen">
    <AlertDialogPortal>
      <AlertDialogOverlay class="ui-dialog-overlay fixed inset-0 z-[110] bg-black/40 backdrop-blur-[2px]" />
      <AlertDialogContent
        class="ui-dialog-content surface fixed left-1/2 top-1/2 z-[111] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl p-5 shadow-2xl sm:p-6"
        @click.capture="handleContentClick"
        @escape-key-down="interactionLocked && $event.preventDefault()"
        @pointer-down-outside="interactionLocked && $event.preventDefault()"
      >
        <AlertDialogTitle class="text-lg font-bold tracking-[-.025em]">{{ title }}</AlertDialogTitle>
        <AlertDialogDescription class="muted mt-2 whitespace-pre-line text-sm leading-relaxed">{{ description }}</AlertDialogDescription>
        <div class="mt-6 flex justify-end gap-2.5">
          <AlertDialogCancel as-child>
            <button type="button" :disabled="interactionLocked" class="focus-ring h-10 rounded-xl px-4 text-sm font-semibold hover:bg-[var(--panel-strong)] disabled:cursor-not-allowed disabled:opacity-50">Cancel</button>
          </AlertDialogCancel>
          <AlertDialogAction as-child>
            <button
              type="button"
              data-confirm-action
              :disabled="interactionLocked"
              class="focus-ring flex h-10 items-center gap-2 rounded-xl bg-rose-600 px-4 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <LoaderCircle v-if="interactionLocked" :size="16" class="animate-spin" aria-hidden="true" />
              {{ interactionLocked ? 'Please wait…' : confirmLabel }}
            </button>
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
