<script setup lang="ts">
import { ArrowLeft, GripVertical, Plus, Settings2, Trash2, UserPlus } from '@lucide/vue'
import type { BoardSummary, UserStatus, WorkspaceMember, WorkspaceRole } from '~~/shared/types/domain'

definePageMeta({ middleware: 'workspace' })

type Candidate = { id: string; email: string; firstName: string; lastName: string; status: UserStatus }

const route = useRoute()
const workspaceId = computed(() => String(route.params.workspace || ''))

// The `workspace` middleware has already checked that this id names a workspace the user
// administers.
const { workspaces, refresh: refreshWorkspaces } = useWorkspaces()
const workspace = computed(() => workspaces.value.find(item => item.id === workspaceId.value) || null)
const { boards, refresh: refreshBoards } = useBoards()
const workspaceBoards = computed(() => boards.value.filter(board => board.workspaceId === workspaceId.value))
// Reordering needs every board of the workspace exactly once, and a workspace admin is not
// necessarily on all of them — the arrows only appear when the list really is complete.
const orderable = computed(() => workspace.value !== null && workspaceBoards.value.length === workspace.value.boardCount && workspaceBoards.value.length > 1)

const lastBoardId = useLastBoardId()
const lastWorkspaceId = useLastWorkspaceId()
const { notice, notify, closeNotice } = useNotify()

/* ── name ───────────────────────────────────────────────────────────────── */

const name = ref('')
watchEffect(() => { name.value = workspace.value?.name || '' })
const savingName = ref(false)

async function saveName() {
  const value = name.value.trim()
  if (!value || savingName.value || !workspace.value) return
  savingName.value = true
  try {
    await $fetch(`/api/workspaces/${workspaceId.value}`, { method: 'PATCH', body: { name: value } })
    await refreshWorkspaces()
    notify('success', 'The workspace was renamed.')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    savingName.value = false
  }
}

/* ── boards ─────────────────────────────────────────────────────────────── */

const newBoardName = ref('')
const creatingBoard = ref(false)

async function createBoard() {
  const boardName = newBoardName.value.trim()
  if (!boardName || creatingBoard.value) return
  creatingBoard.value = true
  try {
    const response = await $fetch<{ board: BoardSummary }>('/api/boards', { method: 'POST', body: { name: boardName, workspaceId: workspaceId.value } })
    await Promise.all([refreshBoards(), refreshWorkspaces()])
    newBoardName.value = ''
    notify('success', `${response.board.name} was created.`)
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    creatingBoard.value = false
  }
}

/* ── board order ────────────────────────────────────────────────────────────
   The same pointer-drag sorting the ticket editor's to-dos use: the row is lifted into a
   floating preview, a dashed placeholder marks where it would land, and the handle keeps
   Alt+arrow keys for anybody not dragging. The order shown is local while a save is in
   flight and falls back to the server's on failure. */

const orderedBoards = ref<BoardSummary[]>([])
const draggingBoardId = ref<string | null>(null)
watch(workspaceBoards, (boards) => {
  // Mid-drag the local order is ahead of the store; syncing now would yank the list around.
  if (!draggingBoardId.value) orderedBoards.value = [...boards]
}, { immediate: true })

const boardTargetIndex = ref<number | null>(null)
const boardDragPreview = ref<{ x: number; y: number; width: number; height: number } | null>(null)
const boardDragPreviewElement = ref<HTMLElement | null>(null)
const boardListElement = ref<HTMLElement | null>(null)
const draggedBoard = computed(() => orderedBoards.value.find(board => board.id === draggingBoardId.value) || null)
const boardSortItems = computed<Array<BoardSummary | null>>(() => {
  if (!draggingBoardId.value || boardTargetIndex.value === null) return orderedBoards.value
  const items: Array<BoardSummary | null> = orderedBoards.value.filter(board => board.id !== draggingBoardId.value)
  items.splice(Math.min(boardTargetIndex.value, items.length), 0, null)
  return items
})

interface BoardPointerDrag {
  pointerId: number
  id: string
  offsetX: number
  offsetY: number
}

let boardPointer: BoardPointerDrag | null = null
let previousBodyUserSelect = ''
let previousBodyCursor = ''
let boardPointerX = 0
let boardPointerY = 0
let boardPreviewFrame: number | null = null
let boardScrollFrame: number | null = null

function beginBoardDrag(event: PointerEvent, id: string) {
  if (event.button !== 0 || !event.isPrimary || !orderable.value) return
  const row = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-board-row]')
  if (!row) return
  const bounds = row.getBoundingClientRect()
  boardPointer = { pointerId: event.pointerId, id, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top }
  boardPointerX = event.clientX
  boardPointerY = event.clientY
  draggingBoardId.value = id
  boardTargetIndex.value = orderedBoards.value.findIndex(board => board.id === id)
  boardDragPreview.value = { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height }
  previousBodyUserSelect = document.body.style.userSelect
  previousBodyCursor = document.body.style.cursor
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'grabbing'
  window.addEventListener('pointermove', moveBoardDrag, { passive: false })
  window.addEventListener('pointerup', finishBoardDrag)
  window.addEventListener('pointercancel', cancelBoardDrag)
  event.preventDefault()
}

function boardDropPosition(clientY: number) {
  const stack = boardListElement.value?.querySelector<HTMLElement>('[data-board-stack]')
  if (!stack) return 0
  const rows = Array.from(stack.querySelectorAll<HTMLElement>('[data-board-sort-item]'))
  const placeholder = stack.querySelector<HTMLElement>('[data-board-placeholder]')
  const localY = clientY - stack.getBoundingClientRect().top
  const placeholderTop = placeholder?.offsetTop
  const placeholderFootprint = placeholder ? placeholder.offsetHeight + 8 : 0
  const index = rows.findIndex((row) => {
    const followsPlaceholder = placeholderTop !== undefined && row.offsetTop > placeholderTop
    const compactedTop = row.offsetTop - (followsPlaceholder ? placeholderFootprint : 0)
    return localY < compactedTop + row.offsetHeight / 2
  })
  return index === -1 ? rows.length : index
}

function updateBoardDropTarget(clientY: number) {
  const index = boardDropPosition(clientY)
  if (boardTargetIndex.value !== index) boardTargetIndex.value = index
}

function scheduleBoardPreview() {
  if (boardPreviewFrame !== null) return
  boardPreviewFrame = window.requestAnimationFrame(() => {
    boardPreviewFrame = null
    if (!boardPointer || !boardDragPreviewElement.value) return
    boardDragPreviewElement.value.style.transform = `translate3d(${boardPointerX - boardPointer.offsetX}px, ${boardPointerY - boardPointer.offsetY}px, 0)`
  })
}

// The list scrolls with the page, so the edges to creep past are the viewport's own.
function runBoardAutoScroll() {
  boardScrollFrame = null
  if (!boardPointer) return
  const edge = Math.min(72, window.innerHeight / 4)
  let delta = 0
  if (boardPointerY < edge) delta = -Math.ceil(10 * (1 - Math.max(0, boardPointerY) / edge))
  else if (boardPointerY > window.innerHeight - edge) delta = Math.ceil(10 * (1 - Math.max(0, window.innerHeight - boardPointerY) / edge))
  if (delta !== 0) {
    const previousScrollY = window.scrollY
    window.scrollBy(0, delta)
    if (window.scrollY !== previousScrollY) {
      updateBoardDropTarget(boardPointerY)
      boardScrollFrame = window.requestAnimationFrame(runBoardAutoScroll)
    }
  }
}

function scheduleBoardAutoScroll() {
  if (boardScrollFrame === null) boardScrollFrame = window.requestAnimationFrame(runBoardAutoScroll)
}

function moveBoardDrag(event: PointerEvent) {
  if (!boardPointer || event.pointerId !== boardPointer.pointerId) return
  boardPointerX = event.clientX
  boardPointerY = event.clientY
  updateBoardDropTarget(event.clientY)
  scheduleBoardPreview()
  scheduleBoardAutoScroll()
  event.preventDefault()
}

function finishBoardDrag(event?: PointerEvent) {
  if (event && boardPointer && event.pointerId !== boardPointer.pointerId) return
  const id = boardPointer?.id
  const targetIndex = boardTargetIndex.value
  if (id && targetIndex !== null) {
    const sourceIndex = orderedBoards.value.findIndex(board => board.id === id)
    const [board] = sourceIndex >= 0 ? orderedBoards.value.splice(sourceIndex, 1) : []
    if (board) orderedBoards.value.splice(Math.max(0, Math.min(targetIndex, orderedBoards.value.length)), 0, board)
  }
  cleanupBoardDrag()
  persistBoardOrder()
}

function cancelBoardDrag(event?: PointerEvent) {
  if (event && boardPointer && event.pointerId !== boardPointer.pointerId) return
  cleanupBoardDrag()
}

function cleanupBoardDrag() {
  const wasDragging = Boolean(boardPointer)
  window.removeEventListener('pointermove', moveBoardDrag)
  window.removeEventListener('pointerup', finishBoardDrag)
  window.removeEventListener('pointercancel', cancelBoardDrag)
  if (boardPreviewFrame !== null) window.cancelAnimationFrame(boardPreviewFrame)
  if (boardScrollFrame !== null) window.cancelAnimationFrame(boardScrollFrame)
  if (wasDragging) {
    document.body.style.userSelect = previousBodyUserSelect
    document.body.style.cursor = previousBodyCursor
  }
  boardPointer = null
  boardPreviewFrame = null
  boardScrollFrame = null
  draggingBoardId.value = null
  boardTargetIndex.value = null
  boardDragPreview.value = null
}

onBeforeUnmount(cleanupBoardDrag)

/** The keyboard path to the same reorder, kept on the drag handle. */
function moveBoardBy(id: string, delta: number) {
  const index = orderedBoards.value.findIndex(board => board.id === id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= orderedBoards.value.length) return
  const [board] = orderedBoards.value.splice(index, 1)
  if (!board) return
  orderedBoards.value.splice(target, 0, board)
  nextTick(() => document.querySelector<HTMLButtonElement>(`[data-board-handle="${id}"]`)?.focus())
  persistBoardOrder()
}

async function persistBoardOrder() {
  const ids = orderedBoards.value.map(board => board.id)
  if (ids.join('\n') === workspaceBoards.value.map(board => board.id).join('\n')) return
  try {
    await $fetch(`/api/workspaces/${workspaceId.value}/board-order`, { method: 'PATCH', body: { boardIds: ids } })
    await refreshBoards()
  } catch (error) {
    notify('error', errorText(error))
    // The server kept its order, so the list goes back to it rather than lying.
    orderedBoards.value = [...workspaceBoards.value]
  }
}

/* ── members ────────────────────────────────────────────────────────────── */

const roleOptions = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Administrator' },
]

const candidates = ref<Candidate[]>([])
const selectedCandidate = ref('')
const selectedRole = ref<WorkspaceRole>('member')
const busyId = ref('')
const adding = ref(false)

const candidateOptions = computed(() => candidates.value.map(candidate => ({
  value: candidate.id,
  label: `${displayName(candidate)} · ${candidate.email}`,
})))

async function loadCandidates() {
  try {
    const response = await $fetch<{ candidates: Candidate[] }>(`/api/workspaces/${workspaceId.value}/members/candidates`)
    candidates.value = response.candidates
    if (!candidates.value.some(candidate => candidate.id === selectedCandidate.value)) {
      selectedCandidate.value = candidates.value[0]?.id || ''
    }
  } catch {
    candidates.value = []
  }
}

watch(() => [workspaceId.value, workspace.value?.members.length], loadCandidates, { immediate: true })

async function addMember() {
  if (!selectedCandidate.value) return
  adding.value = true
  try {
    await $fetch(`/api/workspaces/${workspaceId.value}/members/${selectedCandidate.value}`, { method: 'PUT', body: { role: selectedRole.value } })
    await refreshWorkspaces()
    notify('success', 'The member was added.')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    adding.value = false
  }
}

async function changeRole(member: WorkspaceMember, role: WorkspaceRole) {
  busyId.value = member.userId
  try {
    await $fetch(`/api/workspaces/${workspaceId.value}/members/${member.userId}`, { method: 'PUT', body: { role } })
    await refreshWorkspaces()
    notify('success', `${displayName(member)} is now ${role === 'admin' ? 'an administrator' : 'a member'} of this workspace.`)
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    busyId.value = ''
  }
}

async function removeMember(member: WorkspaceMember) {
  busyId.value = member.userId
  try {
    await $fetch(`/api/workspaces/${workspaceId.value}/members/${member.userId}`, { method: 'DELETE' })
    await refreshWorkspaces()
    notify('success', `${displayName(member)} is no longer on this workspace.`)
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    busyId.value = ''
  }
}

/* ── other workspaces ───────────────────────────────────────────────────── */

const { instanceAdmin } = useAuth()

// The switcher's own "New workspace" item only exists once there are two — the very first
// second workspace has to be creatable from here.
const newWorkspaceName = ref('')
const creatingWorkspace = ref(false)

async function createWorkspace() {
  const value = newWorkspaceName.value.trim()
  if (!value || creatingWorkspace.value) return
  creatingWorkspace.value = true
  try {
    const response = await $fetch<{ workspace: { id: string } }>('/api/workspaces', { method: 'POST', body: { name: value } })
    await refreshWorkspaces()
    lastWorkspaceId.value = response.workspace.id
    newWorkspaceName.value = ''
    await navigateTo(`/w/${response.workspace.id}/settings`)
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    creatingWorkspace.value = false
  }
}

/* ── danger zone ────────────────────────────────────────────────────────── */

const confirmingDelete = ref(false)
const deleting = ref(false)
const canDelete = computed(() => instanceAdmin.value && workspace.value?.boardCount === 0 && workspaces.value.length > 1)

async function deleteWorkspace() {
  if (!confirmingDelete.value) {
    confirmingDelete.value = true
    return
  }
  deleting.value = true
  try {
    await $fetch(`/api/workspaces/${workspaceId.value}`, { method: 'DELETE' })
    lastWorkspaceId.value = null
    lastBoardId.value = null
    await refreshWorkspaces()
    await navigateTo('/', { replace: true })
  } catch (error) {
    notify('error', errorText(error))
    confirmingDelete.value = false
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div v-if="workspace" class="min-h-screen">
    <AppHeader />

    <main class="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <NuxtLink to="/" class="focus-ring muted inline-flex items-center gap-1.5 rounded-lg text-sm font-semibold hover:text-[var(--ink)]">
          <ArrowLeft :size="15" /> Back to the boards
        </NuxtLink>
        <h1 class="mt-2 text-3xl font-bold tracking-[-.045em]">Workspace settings</h1>
      </div>

      <section class="surface rounded-2xl">
        <header class="border-b border-[var(--line)] px-5 py-4">
          <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Workspace</p>
          <h2 class="mt-0.5 text-lg font-bold">General</h2>
        </header>
        <form class="flex flex-wrap items-end gap-3 px-5 py-4" @submit.prevent="saveName">
          <div class="min-w-56 flex-1">
            <label class="mb-2 block text-xs font-bold uppercase tracking-[.08em]" for="workspace-name">Name</label>
            <input id="workspace-name" v-model="name" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none" maxlength="40">
          </div>
          <button
            type="submit"
            :disabled="savingName || !name.trim() || name.trim() === workspace.name"
            class="focus-ring h-11 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] disabled:opacity-50"
          >
            {{ savingName ? 'Saving…' : 'Save' }}
          </button>
        </form>
      </section>

      <section class="surface rounded-2xl">
        <header class="border-b border-[var(--line)] px-5 py-4">
          <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Content</p>
          <h2 class="mt-0.5 text-lg font-bold">Boards</h2>
          <p class="muted mt-1 text-sm">The order here is the order the board switcher offers them in.</p>
        </header>
        <div v-if="orderedBoards.length" ref="boardListElement" class="px-5 py-4">
          <TransitionGroup name="board-sort" tag="div" data-board-stack class="relative flex flex-col gap-2">
            <div v-for="item in boardSortItems" :key="item?.id || '__board-drop-placeholder'" :data-board-sort-item="item?.id">
              <div
                v-if="item"
                :data-board-row="item.id"
                class="surface-strong flex items-center gap-2 rounded-xl p-2 pr-2.5 transition-[border-color,background-color,box-shadow] duration-150"
                :class="orderable ? 'hover:border-[color-mix(in_srgb,var(--line)_60%,var(--accent))]' : ''"
              >
                <button
                  v-if="orderable"
                  type="button"
                  :data-board-handle="item.id"
                  class="focus-ring muted grid size-8 shrink-0 cursor-grab touch-none place-items-center rounded-lg hover:bg-[var(--panel)] active:cursor-grabbing"
                  :aria-label="`Reorder ${item.name}`"
                  title="Drag to reorder · Alt+arrow keys"
                  @pointerdown="beginBoardDrag($event, item.id)"
                  @keydown.alt.up.prevent="moveBoardBy(item.id, -1)"
                  @keydown.alt.down.prevent="moveBoardBy(item.id, 1)"
                ><GripVertical :size="17" /></button>
                <div class="min-w-0 flex-1 px-1">
                  <p class="truncate text-sm font-semibold">{{ item.name }}</p>
                  <p class="muted truncate text-xs">{{ item.ticketCount }} {{ item.ticketCount === 1 ? 'ticket' : 'tickets' }}</p>
                </div>
                <NuxtLink
                  v-if="item.role === 'admin'"
                  :to="`/b/${item.id}/settings/board`"
                  class="focus-ring grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-[var(--panel)]"
                  :aria-label="`Settings of ${item.name}`"
                >
                  <Settings2 :size="15" />
                </NuxtLink>
              </div>
              <div
                v-else
                data-board-placeholder
                class="pointer-events-none rounded-xl border border-dashed border-[color-mix(in_srgb,var(--accent)_38%,var(--line))] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_8%,transparent)]"
                :style="{ height: `${boardDragPreview?.height || 56}px` }"
                aria-hidden="true"
              />
            </div>
          </TransitionGroup>
        </div>
        <p v-else class="muted px-5 py-6 text-sm">This workspace has no boards yet.</p>
        <p v-if="!orderable && workspace.boardCount > workspaceBoards.length" class="muted border-t border-[var(--line)] px-5 py-3 text-xs">
          {{ workspace.boardCount - workspaceBoards.length }} more {{ workspace.boardCount - workspaceBoards.length === 1 ? 'board' : 'boards' }} you are not a member of. Reordering needs the whole list.
        </p>
        <form class="flex flex-wrap items-center gap-3 border-t border-[var(--line)] px-5 py-4" @submit.prevent="createBoard">
          <input
            v-model="newBoardName"
            class="focus-ring surface-strong h-11 min-w-56 flex-1 rounded-xl px-3 text-sm outline-none"
            maxlength="40"
            placeholder="New board name"
            aria-label="Name for a new board"
          >
          <button
            type="submit"
            :disabled="creatingBoard || !newBoardName.trim()"
            class="focus-ring flex h-11 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] disabled:opacity-50"
          >
            <Plus :size="16" aria-hidden="true" /> {{ creatingBoard ? 'Creating…' : 'Create board' }}
          </button>
        </form>
      </section>

      <section class="surface rounded-2xl">
        <header class="border-b border-[var(--line)] px-5 py-4">
          <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Access</p>
          <h2 class="mt-0.5 text-lg font-bold">Members</h2>
          <p class="muted mt-1 text-sm">
            Workspace administrators manage these settings and open boards here. Membership of the
            workspace grants nothing on its boards — each board keeps its own members. Instance
            administrators always have access.
          </p>
        </header>
        <ul v-if="workspace.members.length" class="divide-y divide-[var(--line)]">
          <li v-for="member in workspace.members" :key="member.userId" class="flex flex-wrap items-center gap-3 px-5 py-3.5">
            <UiAvatar :person="member" :muted="member.status !== 'active'" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold">{{ displayName(member) }}</p>
              <p class="muted truncate text-xs">
                {{ member.email }}<span v-if="member.status === 'invited'"> · invitation pending</span>
              </p>
            </div>
            <div class="w-40 shrink-0">
              <UiSelect
                :model-value="member.role"
                :options="roleOptions"
                :disabled="busyId === member.userId"
                compact
                :aria-label="`Role of ${displayName(member)} on this workspace`"
                @update:model-value="value => changeRole(member, value as WorkspaceRole)"
              />
            </div>
            <button
              class="focus-ring grid size-8 place-items-center rounded-lg text-rose-600 transition hover:bg-rose-500/10 disabled:opacity-40"
              :disabled="busyId === member.userId"
              :aria-label="`Remove ${displayName(member)} from this workspace`"
              @click="removeMember(member)"
            >
              <Trash2 :size="15" />
            </button>
          </li>
        </ul>
        <p v-else class="muted px-5 py-6 text-sm">Nobody has been added to this workspace yet — its boards decide who sees it.</p>
        <form class="flex flex-wrap items-center gap-3 border-t border-[var(--line)] px-5 py-4" @submit.prevent="addMember">
          <div v-if="candidateOptions.length" class="min-w-56 flex-1">
            <UiSelect v-model="selectedCandidate" :options="candidateOptions" aria-label="Account to add to this workspace" />
          </div>
          <p v-else class="muted flex-1 text-sm">Every account already belongs to this workspace. New people are created under Users.</p>
          <div v-if="candidateOptions.length" class="w-40 shrink-0">
            <UiSelect v-model="selectedRole" :options="roleOptions" aria-label="Role for the new member" />
          </div>
          <button
            v-if="candidateOptions.length"
            :disabled="adding || !selectedCandidate"
            class="focus-ring flex h-11 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] transition hover:opacity-85 disabled:opacity-50"
          >
            <UserPlus :size="16" aria-hidden="true" /> {{ adding ? 'Adding…' : 'Add member' }}
          </button>
        </form>
      </section>

      <section v-if="instanceAdmin" class="surface rounded-2xl">
        <header class="border-b border-[var(--line)] px-5 py-4">
          <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Instance</p>
          <h2 class="mt-0.5 text-lg font-bold">New workspace</h2>
          <p class="muted mt-1 text-sm">
            Another workspace gets its own boards and its own administrators. The switcher
            appears next to the logo as soon as a second one exists.
          </p>
        </header>
        <form class="flex flex-wrap items-center gap-3 px-5 py-4" @submit.prevent="createWorkspace">
          <input
            v-model="newWorkspaceName"
            class="focus-ring surface-strong h-11 min-w-56 flex-1 rounded-xl px-3 text-sm outline-none"
            maxlength="40"
            placeholder="Workspace name"
            aria-label="Name for a new workspace"
          >
          <button
            type="submit"
            :disabled="creatingWorkspace || !newWorkspaceName.trim()"
            class="focus-ring flex h-11 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] disabled:opacity-50"
          >
            <Plus :size="16" aria-hidden="true" /> {{ creatingWorkspace ? 'Creating…' : 'Create workspace' }}
          </button>
        </form>
      </section>

      <section v-if="instanceAdmin" class="surface rounded-2xl border border-rose-500/25">
        <header class="border-b border-[var(--line)] px-5 py-4">
          <p class="text-[10px] font-bold uppercase tracking-[.14em] text-rose-600">Danger zone</p>
          <h2 class="mt-0.5 text-lg font-bold">Delete this workspace</h2>
        </header>
        <div class="flex flex-wrap items-center gap-3 px-5 py-4">
          <p class="muted min-w-56 flex-1 text-sm">
            <template v-if="workspace.boardCount > 0">
              Still holding {{ workspace.boardCount }} {{ workspace.boardCount === 1 ? 'board' : 'boards' }} — move or delete them first.
            </template>
            <template v-else-if="workspaces.length <= 1">The last workspace cannot be deleted.</template>
            <template v-else-if="confirmingDelete">This cannot be undone.</template>
            <template v-else>The workspace is empty and can be deleted.</template>
          </p>
          <button
            :disabled="!canDelete || deleting"
            class="focus-ring h-10 rounded-xl px-4 text-sm font-semibold transition disabled:opacity-40"
            :class="confirmingDelete ? 'bg-rose-600 text-white hover:bg-rose-700' : 'border border-rose-500/40 text-rose-600 hover:bg-rose-500/10'"
            @click="deleteWorkspace"
          >
            {{ deleting ? 'Deleting…' : confirmingDelete ? 'Really delete' : 'Delete workspace' }}
          </button>
        </div>
      </section>
    </main>

    <UiToastHost :notice="notice" @close="closeNotice" />

    <Teleport to="body">
      <div
        v-if="draggedBoard && boardDragPreview"
        ref="boardDragPreviewElement"
        inert
        class="pointer-events-none fixed left-0 top-0 z-[110] will-change-transform"
        :style="{
          width: `${boardDragPreview.width}px`,
          transform: `translate3d(${boardDragPreview.x}px, ${boardDragPreview.y}px, 0)`,
        }"
        aria-hidden="true"
      >
        <div class="surface-strong flex items-center gap-2 rounded-xl border-[color-mix(in_srgb,var(--accent)_38%,var(--line))] p-2 pr-2.5 shadow-[0_16px_38px_rgba(0,0,0,.18),0_4px_12px_rgba(0,0,0,.1)] [scale:1.015]">
          <span class="grid size-8 shrink-0 place-items-center rounded-lg text-[var(--accent)]"><GripVertical :size="17" /></span>
          <div class="min-w-0 flex-1 px-1">
            <p class="truncate text-sm font-semibold">{{ draggedBoard.name }}</p>
            <p class="muted truncate text-xs">{{ draggedBoard.ticketCount }} {{ draggedBoard.ticketCount === 1 ? 'ticket' : 'tickets' }}</p>
          </div>
          <span class="grid size-8 shrink-0 place-items-center rounded-lg"><Settings2 :size="15" class="muted" /></span>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.board-sort-move {
  transition: transform 190ms cubic-bezier(.2, .8, .2, 1);
}
</style>
