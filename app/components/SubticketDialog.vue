<script setup lang="ts">
import { LoaderCircle, X } from '@lucide/vue'
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import type { BoardSummary } from '~~/shared/types/domain'

/**
 * Asks for what a subticket is filed with: a title, a description, and the board and lane it
 * lands on — the parent's board or another one of the workspace the user may edit.
 */
const props = withDefaults(defineProps<{
  open: boolean
  /** Boards of the workspace the user may file on, the parent's own among them. */
  boards: BoardSummary[]
  /** The parent's board, picked first. */
  defaultBoardId: string
  pending?: boolean
}>(), { pending: false })

const emit = defineEmits<{
  'update:open': [value: boolean]
  create: [input: { boardId: string; laneId: string; title: string; description: string }]
}>()

const form = reactive({ title: '', description: '', boardId: '', laneId: '' })

const boardOptions = computed(() => props.boards.map(board => ({ value: board.id, label: board.name })))
const lanes = computed(() => props.boards.find(board => board.id === form.boardId)?.lanes || [])
const laneOptions = computed(() => lanes.value.map(lane => ({ value: lane.id, label: lane.isDone && !/done/i.test(lane.name) ? `${lane.name} · done lane` : lane.name })))

// Where a new ticket would usually start: the first lane that is neither the import nor a done lane.
function defaultLaneId() {
  return (lanes.value.find(lane => !lane.isImport && !lane.isDone) || lanes.value.find(lane => !lane.isImport) || lanes.value[0])?.id || ''
}

watch(() => props.open, (open) => {
  if (!open) return
  form.title = ''
  form.description = ''
  form.boardId = props.boards.some(board => board.id === props.defaultBoardId) ? props.defaultBoardId : props.boards[0]?.id || ''
  form.laneId = defaultLaneId()
}, { immediate: true })

watch(() => form.boardId, () => {
  if (!lanes.value.some(lane => lane.id === form.laneId)) form.laneId = defaultLaneId()
})

const canSubmit = computed(() => Boolean(form.title.trim() && form.boardId && form.laneId) && !props.pending)

function submit() {
  if (!canSubmit.value) return
  emit('create', { boardId: form.boardId, laneId: form.laneId, title: form.title.trim(), description: form.description })
}

// The dialog would focus its first button, the close one; the title is what comes first to type.
function focusTitle(event: Event) {
  event.preventDefault()
  nextTick(() => document.querySelector<HTMLInputElement>('[data-subticket-title]')?.focus())
}

function updateOpen(value: boolean) {
  if (!props.pending) emit('update:open', value)
}
</script>

<template>
  <DialogRoot :open="open" @update:open="updateOpen">
    <DialogPortal>
      <DialogOverlay class="ui-dialog-overlay fixed inset-0 z-[60] bg-black/40 backdrop-blur-[2px]" />
      <DialogContent
        class="ui-dialog-content surface fixed left-1/2 top-1/2 z-[61] max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl p-5 shadow-2xl sm:p-6"
        @open-auto-focus="focusTitle"
        @escape-key-down="pending && $event.preventDefault()"
        @pointer-down-outside="pending && $event.preventDefault()"
      >
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <DialogTitle class="text-lg font-bold tracking-[-.025em]">New subticket</DialogTitle>
            <DialogDescription class="muted mt-1 text-sm leading-relaxed">A ticket of its own that shows up in this ticket’s to-do list. It is ticked off once it reaches a done lane of its board.</DialogDescription>
          </div>
          <DialogClose as-child>
            <button type="button" :disabled="pending" class="focus-ring muted grid size-8 shrink-0 place-items-center rounded-lg hover:bg-[var(--panel-strong)]" aria-label="Close"><X :size="17" /></button>
          </DialogClose>
        </div>

        <form class="mt-5 space-y-4" @submit.prevent="submit">
          <label class="block">
            <span class="mb-1.5 block text-xs font-bold uppercase tracking-[.08em]">Title</span>
            <input v-model="form.title" data-subticket-title maxlength="160" required class="focus-ring surface-strong h-10 w-full rounded-xl px-3 text-sm outline-none" placeholder="What is the subticket about?">
          </label>
          <label class="block">
            <span class="mb-1.5 block text-xs font-bold uppercase tracking-[.08em]">Description</span>
            <textarea v-model="form.description" maxlength="10000" rows="5" class="focus-ring surface-strong w-full resize-y rounded-xl px-3 py-2 text-sm leading-relaxed outline-none" placeholder="Details, in Markdown" />
          </label>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <span class="mb-1.5 block text-xs font-bold uppercase tracking-[.08em]">Board</span>
              <UiSelect v-model="form.boardId" :options="boardOptions" aria-label="Board of the subticket" :disabled="pending" />
            </div>
            <div>
              <span class="mb-1.5 block text-xs font-bold uppercase tracking-[.08em]">Lane</span>
              <UiSelect v-model="form.laneId" :options="laneOptions" aria-label="Lane of the subticket" :disabled="pending || !laneOptions.length" />
            </div>
          </div>
          <div class="flex justify-end gap-2.5 pt-2">
            <DialogClose as-child>
              <button type="button" :disabled="pending" class="focus-ring h-10 rounded-xl px-4 text-sm font-semibold hover:bg-[var(--panel-strong)] disabled:cursor-not-allowed disabled:opacity-50">Cancel</button>
            </DialogClose>
            <button type="submit" :disabled="!canSubmit" class="focus-ring flex h-10 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50">
              <LoaderCircle v-if="pending" :size="16" class="animate-spin" aria-hidden="true" />
              {{ pending ? 'Creating…' : 'Create subticket' }}
            </button>
          </div>
        </form>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
