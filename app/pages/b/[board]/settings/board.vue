<script setup lang="ts">
import { Save, Trash2, TriangleAlert } from '@lucide/vue'
import type { BoardSummary, CategorySummary } from '~~/shared/types/domain'

type PendingConfirmation = { kind: 'delete-board'; board: BoardSummary }

const { boardId, board } = useCurrentBoard()
const { boards, refresh: refreshBoards } = useBoards()

const { data: categoryData, refresh: refreshCategories } = await useFetch<{ categories: CategorySummary[] }>('/api/categories', {
  query: { boardId },
  watch: [boardId],
})
const categories = computed(() => categoryData.value?.categories || [])
const isLastBoard = computed(() => boards.value.length <= 1)

const name = ref('')
const description = ref('')
watchEffect(() => {
  if (!board.value) return
  name.value = board.value.name
  description.value = board.value.description
})
const saving = ref(false)
const unsaved = computed(() => Boolean(board.value)
  && (name.value.trim() !== board.value!.name || description.value.trim() !== board.value!.description))

const confirmation = ref<PendingConfirmation | null>(null)
const confirmationPending = ref(false)
const { notify } = useNotify()

async function refreshAll() {
  await Promise.all([refreshBoards(), refreshCategories()])
}

async function saveDetails() {
  if (!board.value || !name.value.trim() || !unsaved.value || saving.value) return
  saving.value = true
  try {
    await $fetch(`/api/boards/${board.value.id}`, {
      method: 'PATCH',
      body: { name: name.value.trim(), description: description.value.trim() },
    })
    await refreshBoards()
    notify('success', 'Board saved.')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    saving.value = false
  }
}

const confirmationCopy = computed(() => {
  const action = confirmation.value
  if (!action) return { title: '', description: '', confirmLabel: '' }
  const total = action.board.ticketCount
  return {
    title: `Delete board “${action.board.name}”?`,
    description: `All lanes, ${total === 1 ? '1 ticket' : `${total} tickets`}, their attachments, categories, sync history and the stored App Store Connect key are removed for good. This cannot be undone.`,
    confirmLabel: 'Delete board',
  }
})

function updateConfirmationOpen(open: boolean) {
  if (!open && !confirmationPending.value) confirmation.value = null
}

async function executeConfirmation() {
  const action = confirmation.value
  if (!action || confirmationPending.value) return
  confirmationPending.value = true
  try {
    await $fetch(`/api/boards/${action.board.id}`, { method: 'DELETE' })
    await refreshBoards()
    confirmation.value = null
    await navigateTo(boards.value[0] ? `/b/${boards.value[0].id}` : '/')
    return
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    confirmationPending.value = false
  }
}
</script>

<template>
  <div v-if="board" class="space-y-6">
    <section class="surface rounded-2xl">
      <header class="border-b border-[var(--line)] px-5 py-4">
        <h2 class="text-lg font-bold">Name and description</h2>
        <p class="muted mt-1 text-sm">
          The description sits under the board title, so a line saying what this board is for reads best.
        </p>
      </header>
      <form class="px-5 py-5" @submit.prevent="saveDetails">
        <label class="block">
          <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Name</span>
          <input
            v-model="name"
            placeholder="Board name"
            class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm font-semibold outline-none"
            maxlength="40"
          >
        </label>
        <label class="mt-4 block">
          <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Description</span>
          <textarea
            v-model="description"
            rows="2"
            placeholder="What this board is for"
            class="focus-ring surface-strong w-full resize-none rounded-xl px-3 py-2.5 text-sm outline-none"
            maxlength="200"
          />
          <span class="muted mt-1.5 block text-xs">{{ description.trim().length }}/200 · leave it empty to show nothing under the title.</span>
        </label>
        <div class="mt-4 flex justify-end">
          <button
            type="submit"
            :disabled="saving || !name.trim() || !unsaved"
            class="focus-ring flex h-11 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] disabled:opacity-50"
          >
            <Save :size="16" />
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </form>
    </section>

    <BoardLaneSettings :board="board" @changed="refreshAll" @notify="notify" />

    <BoardCategorySettings :categories="categories" @changed="refreshCategories" @notify="notify" />

    <section class="rounded-2xl border border-rose-500/30 bg-rose-500/5">
      <header class="border-b border-rose-500/20 px-5 py-4">
        <p class="text-[10px] font-bold uppercase tracking-[.14em] text-rose-600">Irreversible</p>
        <h2 class="mt-0.5 text-lg font-bold">Delete board</h2>
      </header>
      <div class="flex flex-wrap items-center gap-3 px-5 py-5">
        <TriangleAlert :size="18" class="shrink-0 text-rose-600" />
        <p class="muted min-w-0 flex-1 text-sm">
          <template v-if="isLastBoard">This is the only board, so it cannot be deleted.</template>
          <template v-else>Removes the board with all its lanes, tickets, attachments, categories and its stored App Store Connect key.</template>
        </p>
        <button
          :disabled="isLastBoard"
          class="focus-ring flex h-10 items-center gap-2 rounded-xl bg-rose-600 px-4 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-40"
          @click="confirmation = { kind: 'delete-board', board }"
        ><Trash2 :size="16" /> Delete board</button>
      </div>
    </section>

    <UiConfirmDialog
      v-if="confirmation"
      :open="true"
      :title="confirmationCopy.title"
      :description="confirmationCopy.description"
      :confirm-label="confirmationCopy.confirmLabel"
      :pending="confirmationPending"
      @update:open="updateConfirmationOpen"
      @confirm="executeConfirmation"
    />
  </div>
</template>
