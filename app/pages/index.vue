<script setup lang="ts">
import { Plus } from '@lucide/vue'
import type { BoardSummary } from '~~/shared/types/domain'

definePageMeta({ middleware: 'home-board' })

// Only an empty workspace ever renders this page — the middleware forwards everyone else.
const { workspace } = useCurrentWorkspace()
const { refresh: refreshBoards } = useBoards()
const lastBoardId = useLastBoardId()

const canCreate = computed(() => workspace.value?.role === 'admin')

const newName = ref('')
const creating = ref(false)
const createError = ref('')

async function createBoard() {
  const name = newName.value.trim()
  if (!name || creating.value || !workspace.value) return
  creating.value = true
  createError.value = ''
  try {
    const response = await $fetch<{ board: BoardSummary }>('/api/boards', { method: 'POST', body: { name, workspaceId: workspace.value.id } })
    await refreshBoards()
    await loadWorkspaces(true)
    lastBoardId.value = response.board.id
    await navigateTo(`/b/${response.board.id}/settings/board`)
  } catch (error: any) {
    createError.value = error?.data?.statusMessage || error?.statusMessage || 'The board could not be created.'
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="min-h-screen">
    <AppHeader />
    <main class="grid place-items-center px-6 py-24">
      <div class="surface max-w-md rounded-2xl p-7 text-center">
        <h1 class="text-lg font-bold">{{ workspace ? `No board in ${workspace.name} yet` : 'No board yet' }}</h1>
        <template v-if="canCreate">
          <p class="muted mt-2 text-sm">
            This workspace is empty. Open its first board — it starts with an Import, Backlog,
            In Progress and Done lane.
          </p>
          <form class="mt-5 flex items-center gap-2.5" @submit.prevent="createBoard">
            <input
              v-model="newName"
              class="focus-ring surface-strong h-11 min-w-0 flex-1 rounded-xl px-3 text-sm outline-none"
              maxlength="40"
              placeholder="Board name"
              aria-label="Name for the first board"
            >
            <button
              type="submit"
              :disabled="creating || !newName.trim()"
              class="focus-ring flex h-11 shrink-0 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] disabled:opacity-50"
            >
              <Plus :size="16" aria-hidden="true" /> {{ creating ? 'Creating…' : 'Create board' }}
            </button>
          </form>
          <p v-if="createError" class="mt-2 text-sm text-rose-600">{{ createError }}</p>
        </template>
        <p v-else class="muted mt-2 text-sm">
          You are not a member of any board here yet. Ask an administrator to add you to one —
          they can do that under Board settings → Users.
        </p>
      </div>
    </main>
  </div>
</template>
