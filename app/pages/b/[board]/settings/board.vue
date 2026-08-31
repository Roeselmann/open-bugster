<script setup lang="ts">
import { Copy, FolderInput, Save, Trash2, TriangleAlert } from '@lucide/vue'
import type { BoardSummary, CategorySummary } from '~~/shared/types/domain'

type PendingConfirmation =
  | { kind: 'delete-board'; board: BoardSummary }
  | { kind: 'move-board'; board: BoardSummary; workspaceId: string; workspaceName: string }

const { boardId, board } = useCurrentBoard()
const { boards, refresh: refreshBoards } = useBoards()
const { workspaces, refresh: refreshWorkspaces } = useWorkspaces()
const lastBoardId = useLastBoardId()

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

/* ── move & duplicate ─────────────────────────────────────────────────────
   Both targets are limited to workspaces the caller administers — the same right
   `board.create` asks for, and exactly what the server enforces. */

const adminWorkspaces = computed(() => workspaces.value.filter(workspace => workspace.role === 'admin'))

const moveTargets = computed(() => adminWorkspaces.value
  .filter(workspace => workspace.id !== board.value?.workspaceId)
  .map(workspace => ({ value: workspace.id, label: workspace.name })))
const moveTarget = ref('')
watchEffect(() => {
  if (!moveTargets.value.some(option => option.value === moveTarget.value)) moveTarget.value = moveTargets.value[0]?.value || ''
})
function requestMove() {
  if (!board.value || !moveTarget.value) return
  confirmation.value = {
    kind: 'move-board',
    board: board.value,
    workspaceId: moveTarget.value,
    workspaceName: workspaces.value.find(workspace => workspace.id === moveTarget.value)?.name || 'the workspace',
  }
}

const duplicateTargets = computed(() => adminWorkspaces.value.map(workspace => ({
  value: workspace.id,
  label: workspace.id === board.value?.workspaceId ? `${workspace.name} (current)` : workspace.name,
})))
const duplicateTarget = ref('')
// The selection follows the board home: after a move the old workspace is still a valid
// option, so waiting for it to become invalid would leave the form pointing at where the
// board used to live.
watch(() => board.value?.workspaceId, (workspaceId) => {
  duplicateTarget.value = workspaceId && duplicateTargets.value.some(option => option.value === workspaceId)
    ? workspaceId
    : duplicateTargets.value[0]?.value || ''
}, { immediate: true })
// And stays valid when the workspace list itself arrives or changes.
watchEffect(() => {
  if (!duplicateTargets.value.some(option => option.value === duplicateTarget.value)) {
    duplicateTarget.value = duplicateTargets.value.find(option => option.value === board.value?.workspaceId)?.value
      || duplicateTargets.value[0]?.value || ''
  }
})
const duplicateName = ref('')
watch(boardId, () => { duplicateName.value = `${board.value?.name || ''} (copy)`.slice(0, 40) }, { immediate: true })
const includeTickets = ref(false)
const duplicating = ref(false)

async function duplicateBoard() {
  if (!board.value || !duplicateName.value.trim() || !duplicateTarget.value || duplicating.value) return
  duplicating.value = true
  try {
    const response = await $fetch<{ board: BoardSummary }>(`/api/boards/${board.value.id}/duplicate`, {
      method: 'POST',
      body: { name: duplicateName.value.trim(), workspaceId: duplicateTarget.value, includeTickets: includeTickets.value },
    })
    // The board list has to know the copy before we navigate, or the middleware bounces.
    await Promise.all([refreshBoards(), refreshWorkspaces()])
    lastBoardId.value = response.board.id
    notify('success', `${response.board.name} was created.`)
    await navigateTo(`/b/${response.board.id}/settings/board`)
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    duplicating.value = false
  }
}

const confirmationCopy = computed(() => {
  const action = confirmation.value
  if (!action) return { title: '', description: '', confirmLabel: '', tone: 'danger' as const }
  if (action.kind === 'move-board') {
    return {
      title: `Move “${action.board.name}” to ${action.workspaceName}?`,
      description: `The board keeps its members, tickets and TestFlight key — it only appears under ${action.workspaceName} from now on. It can be moved back at any time.`,
      confirmLabel: 'Move board',
      tone: 'neutral' as const,
    }
  }
  const total = action.board.ticketCount
  return {
    title: `Delete board “${action.board.name}”?`,
    description: `All lanes, ${total === 1 ? '1 ticket' : `${total} tickets`}, their attachments, categories, sync history and the stored App Store Connect key are removed for good. This cannot be undone.`,
    confirmLabel: 'Delete board',
    tone: 'danger' as const,
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
    if (action.kind === 'move-board') {
      await $fetch(`/api/boards/${action.board.id}/move`, { method: 'POST', body: { workspaceId: action.workspaceId } })
      await Promise.all([refreshBoards(), refreshWorkspaces()])
      confirmation.value = null
      notify('success', `Moved to ${action.workspaceName}.`)
      return
    }
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

    <section class="surface rounded-2xl">
      <header class="border-b border-[var(--line)] px-5 py-4">
        <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Workspace</p>
        <h2 class="mt-0.5 text-lg font-bold">Move &amp; duplicate</h2>
      </header>

      <div class="flex flex-wrap items-center gap-3 border-b border-[var(--line)] px-5 py-4">
        <div class="min-w-56 flex-1">
          <p class="text-sm font-semibold">Move to another workspace</p>
          <p class="muted mt-0.5 text-xs">The board keeps everything — members, tickets, key. Only where it hangs changes.</p>
        </div>
        <template v-if="moveTargets.length">
          <div class="w-48 shrink-0">
            <UiSelect v-model="moveTarget" :options="moveTargets" aria-label="Workspace to move this board to" />
          </div>
          <button
            :disabled="!moveTarget"
            class="focus-ring flex h-11 shrink-0 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] disabled:opacity-50"
            @click="requestMove"
          ><FolderInput :size="16" /> Move board</button>
        </template>
        <p v-else class="muted shrink-0 text-sm">There is no other workspace you administer.</p>
      </div>

      <div class="px-5 py-4">
        <p class="text-sm font-semibold">Duplicate this board</p>
        <p class="muted mt-0.5 text-xs">
          Copies lanes, categories, labels and members. TestFlight credentials and webhooks stay behind;
          comments and history stay with the original.
        </p>
        <template v-if="duplicateTargets.length">
          <div class="mt-3 flex flex-wrap items-center gap-3">
            <input
              v-model="duplicateName"
              maxlength="40"
              placeholder="Name of the copy"
              aria-label="Name of the duplicated board"
              class="focus-ring surface-strong h-11 min-w-48 flex-1 rounded-xl px-3 text-sm outline-none"
            >
            <div class="w-48 shrink-0">
              <!-- Re-mounted per workspace: the trigger caches its label, and after a move
                   the “(current)” marker belongs to a different option. -->
              <UiSelect :key="board.workspaceId" v-model="duplicateTarget" :options="duplicateTargets" aria-label="Workspace for the duplicate" />
            </div>
            <button
              :disabled="duplicating || !duplicateName.trim() || !duplicateTarget"
              class="focus-ring flex h-11 shrink-0 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] disabled:opacity-50"
              @click="duplicateBoard"
            ><Copy :size="16" /> {{ duplicating ? 'Duplicating…' : 'Duplicate' }}</button>
          </div>
          <label class="mt-3 flex w-fit cursor-pointer items-center gap-2">
            <input v-model="includeTickets" type="checkbox" class="focus-ring size-4 rounded accent-[var(--accent)]">
            <span class="text-sm">Include tickets<span class="muted"> — with their to-dos, labels and attachments</span></span>
          </label>
        </template>
        <p v-else class="muted mt-3 text-sm">Duplicating needs a workspace you administer.</p>
      </div>
    </section>

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
      :tone="confirmationCopy.tone"
      :pending="confirmationPending"
      @update:open="updateConfirmationOpen"
      @confirm="executeConfirmation"
    />
  </div>
</template>
