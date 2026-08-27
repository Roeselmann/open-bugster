<script setup lang="ts">
import { Check, ChevronDown, Plus, Settings2 } from '@lucide/vue'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  VisuallyHidden,
} from 'reka-ui'
import type { BoardSummary } from '~~/shared/types/domain'

const props = defineProps<{ board: BoardSummary; boards: BoardSummary[] }>()
const emit = defineEmits<{ created: [] }>()

const { refresh: refreshBoards } = useBoards()
const lastBoardId = useLastBoardId()

const createOpen = ref(false)
const newName = ref('')
const creating = ref(false)
const createError = ref('')

// A single board needs no menu — the heading stays a plain title until a second one exists.
const hasChoice = computed(() => props.boards.length > 1)

function openCreate() {
  newName.value = ''
  createError.value = ''
  createOpen.value = true
}

async function createBoard() {
  const name = newName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  createError.value = ''
  try {
    const response = await $fetch<{ board: BoardSummary }>('/api/boards', { method: 'POST', body: { name } })
    // The `board` middleware validates the route against the shared board list, so that list
    // has to know the new board before we navigate — otherwise it bounces straight back to
    // the previous board. The cookie makes the new board the one "/" reopens.
    await refreshBoards()
    lastBoardId.value = response.board.id
    emit('created')
    createOpen.value = false
    await navigateTo(`/b/${response.board.id}/settings`)
  } catch (error: any) {
    createError.value = error?.data?.statusMessage || error?.statusMessage || 'The board could not be created.'
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="flex min-w-0 items-center gap-2">
    <h1 v-if="!hasChoice" class="truncate text-3xl font-bold tracking-[-.045em]">{{ board.name }}</h1>

    <DropdownMenuRoot v-else>
      <DropdownMenuTrigger
        class="focus-ring group flex min-w-0 items-center gap-2 rounded-xl px-1 text-left transition hover:bg-[var(--panel-strong)]"
        :aria-label="`Switch board, currently ${board.name}`"
      >
        <h1 class="truncate text-3xl font-bold tracking-[-.045em]">{{ board.name }}</h1>
        <ChevronDown :size="20" class="muted shrink-0 transition-transform duration-150 group-data-[state=open]:rotate-180" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent
          align="start"
          :side-offset="6"
          class="ui-popover z-[100] min-w-64 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel-strong)] p-1 text-[var(--ink)] shadow-[0_18px_45px_rgba(0,0,0,.16),0_3px_12px_rgba(0,0,0,.08)]"
        >
          <DropdownMenuItem
            v-for="item in boards"
            :key="item.id"
            class="relative flex h-10 cursor-default select-none items-center gap-2 rounded-lg py-0 pl-8 pr-3 text-sm outline-none data-[highlighted]:bg-[var(--accent-soft)]"
            @select="navigateTo(`/b/${item.id}`)"
          >
            <Check v-if="item.id === board.id" :size="15" stroke-width="2.5" class="absolute left-2.5 text-[var(--accent)]" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate font-medium">{{ item.name }}</span>
            <span class="muted shrink-0 text-[11px] font-semibold tabular-nums">{{ item.ticketCount }}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator class="my-1 h-px bg-[var(--line)]" />
          <DropdownMenuItem
            class="flex h-10 cursor-default select-none items-center gap-2 rounded-lg px-3 text-sm font-semibold outline-none data-[highlighted]:bg-[var(--accent-soft)]"
            @select="openCreate"
          >
            <Plus :size="15" aria-hidden="true" /> New board…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>

    <NuxtLink
      :to="`/b/${board.id}/settings`"
      class="focus-ring surface grid size-9 shrink-0 place-items-center rounded-xl hover:bg-[var(--panel-strong)]"
      aria-label="Board settings"
      title="Board settings"
    >
      <Settings2 :size="17" />
    </NuxtLink>

    <button
      v-if="!hasChoice"
      class="focus-ring surface grid size-9 shrink-0 place-items-center rounded-xl hover:bg-[var(--panel-strong)]"
      aria-label="New board"
      title="New board"
      @click="openCreate"
    >
      <Plus :size="17" />
    </button>

    <DialogRoot :open="createOpen" @update:open="open => !creating && (createOpen = open)">
      <DialogPortal>
        <DialogOverlay class="ui-dialog-overlay fixed inset-0 z-[70] bg-black/35 backdrop-blur-[2px]" />
        <DialogContent class="ui-dialog-content surface fixed left-1/2 top-1/2 z-[71] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl p-5 shadow-2xl sm:p-6">
          <VisuallyHidden>
            <DialogDescription>Create a board with its own lanes and TestFlight app.</DialogDescription>
          </VisuallyHidden>
          <DialogTitle as-child>
            <h2 class="text-lg font-bold tracking-[-.025em]">New board</h2>
          </DialogTitle>
          <p class="muted mt-2 text-sm">The board starts with an Import, Backlog, In Progress and Done lane. Add its TestFlight credentials in the board settings.</p>
          <form class="mt-5" @submit.prevent="createBoard">
            <label class="mb-2 block text-xs font-bold uppercase tracking-[.08em]" for="new-board-name">Name</label>
            <input
              id="new-board-name"
              v-model="newName"
              class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none"
              maxlength="40"
              placeholder="Radio app"
              autofocus
            >
            <p v-if="createError" class="mt-2 text-sm text-rose-600">{{ createError }}</p>
            <div class="mt-6 flex justify-end gap-2.5">
              <DialogClose as-child>
                <button type="button" :disabled="creating" class="focus-ring h-10 rounded-xl px-4 text-sm font-semibold hover:bg-[var(--panel-strong)] disabled:opacity-50">Cancel</button>
              </DialogClose>
              <button type="submit" :disabled="creating || !newName.trim()" class="focus-ring h-10 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] disabled:opacity-50">
                {{ creating ? 'Creating…' : 'Create board' }}
              </button>
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>
