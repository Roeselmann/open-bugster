<script setup lang="ts">
import { ArrowLeft, Save, Trash2, TriangleAlert } from '@lucide/vue'
import type { BoardSummary, CategorySummary } from '~~/shared/types/domain'

type PendingConfirmation = { kind: 'delete-board'; board: BoardSummary }

definePageMeta({ middleware: 'board' })

const route = useRoute()
const boardId = computed(() => String(route.params.board || ''))

const { boards, refresh: refreshBoards } = useBoards()
const board = computed(() => boards.value.find(item => item.id === boardId.value) || null)

const { data: categoryData, refresh: refreshCategories } = await useFetch<{ categories: CategorySummary[] }>('/api/categories', {
  query: { boardId },
  watch: [boardId],
})
const categories = computed(() => categoryData.value?.categories || [])
const isLastBoard = computed(() => boards.value.length <= 1)

const name = ref('')
watchEffect(() => { if (board.value) name.value = board.value.name })
const renaming = ref(false)

const confirmation = ref<PendingConfirmation | null>(null)
const confirmationPending = ref(false)
const { notice, notify, closeNotice } = useNotify()

// Everything on this page except the member list belongs to board administrators.
const canManage = computed(() => board.value?.role === 'admin')

async function refreshAll() {
  await Promise.all([refreshBoards(), refreshCategories()])
}

async function renameBoard() {
  const value = name.value.trim()
  if (!value || !board.value || value === board.value.name || renaming.value) return
  renaming.value = true
  try {
    await $fetch(`/api/boards/${board.value.id}`, { method: 'PATCH', body: { name: value } })
    await refreshBoards()
    notify('success', 'Board renamed.')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    renaming.value = false
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
  <div v-if="board" class="min-h-screen">
    <AppHeader :board-id="board.id" :syncing="false" :latest-run="null" archive-mode />

    <main class="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <NuxtLink :to="`/b/${board.id}`" class="focus-ring muted inline-flex items-center gap-1.5 rounded-lg text-sm font-semibold hover:text-[var(--ink)]">
          <ArrowLeft :size="15" /> Back to {{ board.name }}
        </NuxtLink>
        <h1 class="mt-2 text-3xl font-bold tracking-[-.045em]">Board settings</h1>
      </div>

        <section v-if="canManage" class="surface rounded-2xl">
            <form class="flex flex-wrap items-end gap-3 px-5 py-5" @submit.prevent="renameBoard">
                <label class="min-w-0 flex-1">
                    <span class="sr-only">Board name</span>
                    <input v-model="name"
                           placeholder="Board name"
                           class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm font-semibold outline-none"
                           maxlength="40">
                </label>
                <button type="submit" :disabled="renaming || !name.trim() || name.trim() === board.name"
                        class="focus-ring flex h-11 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] disabled:opacity-50">
                    <Save :size="16"/>
                    {{ renaming ? 'Saving…' : 'Save' }}
                </button>
            </form>
        </section>

      <BoardMemberSettings :board="board" @changed="refreshBoards" @notify="notify" />

      <template v-if="canManage">
        <BoardLaneSettings :board="board" @changed="refreshAll" @notify="notify" />

        <BoardTestFlightSettings :board="board" @changed="refreshBoards" @notify="notify" />

        <BoardCategorySettings :categories="categories" @changed="refreshCategories" @notify="notify" />
      </template>
      <section v-else class="surface rounded-2xl px-5 py-6">
        <p class="muted text-sm">
          Lanes, categories and the App Store Connect key are managed by this board's administrators.
        </p>
      </section>

      <section v-if="canManage" class="rounded-2xl border border-rose-500/30 bg-rose-500/5">
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
    </main>

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
    <UiToastHost :notice="notice" @close="closeNotice" />
  </div>
</template>
