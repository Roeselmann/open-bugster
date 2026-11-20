<script setup lang="ts">
import { CircleCheck, Link2, LoaderCircle, Plus, Search, X } from '@lucide/vue'
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import type { BoardSummary, SubticketRef } from '~~/shared/types/domain'

/**
 * Adds a subticket, one of two ways. A new one asks for a title, a description, and the board
 * and lane it lands on — the parent's board or another one of the workspace the user may edit.
 * An existing one is searched for by title or number across the workspace's boards the user
 * can read, and linked as it is.
 */
const props = withDefaults(defineProps<{
  open: boolean
  /** The parent, whose workspace the search covers. */
  ticketId: string
  /** Boards of the workspace the user may file on, the parent's own among them. */
  boards: BoardSummary[]
  /** The parent's board, picked first. */
  defaultBoardId: string
  pending?: boolean
}>(), { pending: false })

const emit = defineEmits<{
  'update:open': [value: boolean]
  create: [input: { boardId: string; laneId: string; title: string; description: string }]
  link: [subticket: SubticketRef]
}>()

const mode = ref<'new' | 'existing'>('new')
const modes = [
  { value: 'new' as const, label: 'New ticket', icon: Plus },
  { value: 'existing' as const, label: 'Existing ticket', icon: Link2 },
]

// The search asks the server, which knows which boards the user may read; a short pause
// keeps typing from turning into a request per key, and a newer answer always wins.
const query = ref('')
const candidates = ref<SubticketRef[]>([])
const searching = ref(false)
const searchError = ref('')
// What is picked, by a click or the arrow keys — never by the pointer passing over. Kept by
// id, so a new search keeps it as long as the ticket is still among the results.
const selectedId = ref<string | null>(null)
const selected = computed(() => candidates.value.find(candidate => candidate.id === selectedId.value) || null)
const selectedIndex = computed(() => candidates.value.findIndex(candidate => candidate.id === selectedId.value))
let searchTimer: ReturnType<typeof setTimeout> | null = null
let searchSequence = 0

async function search() {
  const sequence = ++searchSequence
  searching.value = true
  searchError.value = ''
  try {
    const result = await $fetch<{ candidates: SubticketRef[] }>(`/api/tickets/${props.ticketId}/subticket-candidates`, { query: { query: query.value.trim() } })
    if (sequence !== searchSequence) return
    candidates.value = result.candidates
  } catch (error) {
    if (sequence !== searchSequence) return
    candidates.value = []
    searchError.value = (error as { statusMessage?: string })?.statusMessage || 'The search failed.'
  } finally {
    if (sequence === searchSequence) searching.value = false
  }
}

watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(search, 200)
})
onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer) })

watch(mode, (next) => {
  if (next === 'existing' && !candidates.value.length && !searching.value) void search()
  nextTick(() => document.querySelector<HTMLInputElement>(next === 'existing' ? '[data-subticket-search]' : '[data-subticket-title]')?.focus())
})

function moveActive(delta: number) {
  if (!candidates.value.length) return
  const from = selectedIndex.value
  const index = from < 0 ? (delta > 0 ? 0 : candidates.value.length - 1) : (from + delta + candidates.value.length) % candidates.value.length
  selectedId.value = candidates.value[index]!.id
  nextTick(() => document.querySelector(`[data-candidate-index="${index}"]`)?.scrollIntoView({ block: 'nearest' }))
}

function link(candidate = selected.value) {
  if (candidate && !props.pending) emit('link', candidate)
}

const form = reactive({ title: '', description: '', boardId: '', laneId: '' })

const boardOptions = computed(() => props.boards.map(board => ({ value: board.id, label: board.name })))
const lanes = computed(() => props.boards.find(board => board.id === form.boardId)?.lanes || [])
const laneOptions = computed(() => lanes.value.map(lane => ({ value: lane.id, label: lane.isDone && !/done/i.test(lane.name) ? `${lane.name} · done lane` : lane.isLive && !/live/i.test(lane.name) ? `${lane.name} · live lane` : lane.name })))

// Where a new ticket would usually start: the first lane that is neither the import nor a done lane.
function defaultLaneId() {
  return (lanes.value.find(lane => !lane.isImport && !lane.isDone && !lane.isLive) || lanes.value.find(lane => !lane.isImport) || lanes.value[0])?.id || ''
}

watch(() => props.open, (open) => {
  if (!open) return
  mode.value = 'new'
  query.value = ''
  candidates.value = []
  selectedId.value = null
  searchError.value = ''
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
            <DialogTitle class="text-lg font-bold tracking-[-.025em]">Add subticket</DialogTitle>
            <DialogDescription class="muted mt-1 text-sm leading-relaxed">A ticket of its own that shows up in this ticket’s to-do list. It is ticked off once it reaches a done lane of its board.</DialogDescription>
          </div>
          <DialogClose as-child>
            <button type="button" :disabled="pending" class="focus-ring muted grid size-8 shrink-0 place-items-center rounded-lg hover:bg-[var(--panel-strong)]" aria-label="Close"><X :size="17" /></button>
          </DialogClose>
        </div>

        <div class="mt-5 grid grid-cols-2 gap-1 rounded-xl bg-[var(--panel)] p-1" role="tablist" aria-label="Kind of subticket">
          <button
            v-for="option in modes"
            :key="option.value"
            type="button"
            role="tab"
            :aria-selected="mode === option.value"
            :disabled="pending"
            class="focus-ring flex h-9 items-center justify-center gap-1.5 rounded-lg text-sm font-semibold transition-colors"
            :class="mode === option.value ? 'bg-[var(--panel-strong)] shadow-sm' : 'muted hover:text-[var(--ink)]'"
            @click="mode = option.value"
          ><component :is="option.icon" :size="15" aria-hidden="true" /> {{ option.label }}</button>
        </div>

        <form v-if="mode === 'existing'" class="mt-4 space-y-3" @submit.prevent="link()">
          <label class="relative block">
            <span class="sr-only">Search tickets</span>
            <Search :size="16" class="muted pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              v-model="query"
              data-subticket-search
              maxlength="160"
              autocomplete="off"
              role="combobox"
              aria-controls="subticket-candidates"
              :aria-expanded="candidates.length > 0"
              :aria-activedescendant="selectedIndex >= 0 ? `subticket-candidate-${selectedIndex}` : undefined"
              class="focus-ring surface-strong h-10 w-full rounded-xl pl-9 pr-9 text-sm outline-none"
              placeholder="Search by title or #number"
              @keydown.down.prevent="moveActive(1)"
              @keydown.up.prevent="moveActive(-1)"
            >
            <LoaderCircle v-if="searching" :size="15" class="muted absolute right-3 top-1/2 -translate-y-1/2 animate-spin" aria-hidden="true" />
          </label>
          <div id="subticket-candidates" role="listbox" aria-label="Tickets to link" class="max-h-72 space-y-1 overflow-y-auto">
            <button
              v-for="(candidate, index) in candidates"
              :id="`subticket-candidate-${index}`"
              :key="candidate.id"
              type="button"
              role="option"
              :data-candidate-index="index"
              :aria-selected="candidate.id === selectedId"
              class="focus-ring flex w-full items-center gap-2.5 rounded-xl border px-3 py-2 text-left"
              :class="candidate.id === selectedId ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-transparent hover:border-[var(--line)]'"
              @click="selectedId = candidate.id"
              @dblclick="link(candidate)"
            >
              <span class="muted w-10 shrink-0 text-xs font-semibold tabular-nums">#{{ candidate.ticketNumber }}</span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium">{{ candidate.title }}</span>
                <span class="muted block truncate text-[11px]">{{ candidate.boardName }} · {{ candidate.laneName }}</span>
              </span>
              <CircleCheck v-if="candidate.done" :size="15" class="shrink-0 text-[var(--accent)]" aria-label="Already in a done lane" />
            </button>
            <p v-if="searchError" class="px-1 py-3 text-sm text-rose-600">{{ searchError }}</p>
            <p v-else-if="!searching && !candidates.length" class="muted px-1 py-3 text-sm">{{ query.trim() ? 'No open ticket of this workspace matches.' : 'No other open tickets in this workspace.' }}</p>
          </div>
          <div class="flex justify-end gap-2.5 pt-2">
            <DialogClose as-child>
              <button type="button" :disabled="pending" class="focus-ring h-10 rounded-xl px-4 text-sm font-semibold hover:bg-[var(--panel-strong)] disabled:cursor-not-allowed disabled:opacity-50">Cancel</button>
            </DialogClose>
            <button type="submit" :disabled="!selected || pending" class="focus-ring flex h-10 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50">
              <Link2 :size="16" aria-hidden="true" />
              {{ selected ? `Link #${selected.ticketNumber}` : 'Pick a ticket' }}
            </button>
          </div>
        </form>

        <form v-else class="mt-4 space-y-4" @submit.prevent="submit">
          <label class="block">
            <span class="mb-1.5 block text-xs font-bold uppercase tracking-[.08em]">Title</span>
            <input v-model="form.title" data-subticket-title maxlength="160" required class="focus-ring surface-strong h-10 w-full rounded-xl px-3 text-sm outline-none" placeholder="What is the subticket about?">
          </label>
          <label class="block">
            <span class="mb-1.5 block text-xs font-bold uppercase tracking-[.08em]">Description</span>
            <textarea v-model="form.description" v-autosize="'40vh'" maxlength="10000" rows="5" class="focus-ring surface-strong w-full resize-none rounded-xl px-3 py-2 text-sm leading-relaxed outline-none" placeholder="Details, in Markdown" />
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
