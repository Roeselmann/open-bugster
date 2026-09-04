<script setup lang="ts">
import { Check, RefreshCcw, Search, Settings2, X } from '@lucide/vue'
import type { Attachment, CategorySummary, IntegrationProvider, LabelSummary, SyncRun, Ticket, TicketPriority, TicketTodoInput, TicketTypeSummary } from '~~/shared/types/domain'
import { PROVIDER_LABELS } from '~~/shared/utils/ticket-source'
import { TICKET_TYPES_KEY } from '~/utils/ticketTypes'

type PendingConfirmation =
  | { kind: 'archive-ticket'; ticket: Ticket }
  | { kind: 'delete-attachment'; attachment: Attachment }

definePageMeta({ middleware: 'board' })

const route = useRoute()
const router = useRouter()
const boardId = computed(() => String(route.params.board || ''))
const isMobile = useIsMobile()

// The `board` middleware has already checked that this id exists.
const { boards, refresh: refreshBoards } = useBoards()
const board = computed(() => boards.value.find(item => item.id === boardId.value) || null)

const lastBoardId = useLastBoardId()
const lastWorkspaceId = useLastWorkspaceId()
watchEffect(() => {
  if (!board.value) return
  lastBoardId.value = board.value.id
  // The board decides the workspace, so the two cookies can never point apart.
  lastWorkspaceId.value = board.value.workspaceId
})

// The switcher offers the boards around this one; other workspaces have their own.
const workspaceBoards = computed(() => boards.value.filter(item => item.workspaceId === board.value?.workspaceId))
// Where a ticket may be moved to: the workspace's other boards the user can edit.
const transferableBoards = computed(() => workspaceBoards.value.filter(item => item.id !== board.value?.id && item.role !== 'viewer'))

const lanes = computed(() => board.value?.lanes || [])

const { data, pending, error, refresh } = await useFetch<{ tickets: Ticket[] }>('/api/tickets', {
  query: { boardId },
  watch: [boardId],
})
// One last-run line per connection; a board may have both.
const { data: testflightSync, refresh: refreshTestflightSync } = await useFetch<{ run: SyncRun | null }>('/api/import/latest', {
  query: { boardId, provider: 'testflight' },
  watch: [boardId],
})
const { data: jiraSync, refresh: refreshJiraSync } = await useFetch<{ run: SyncRun | null }>('/api/import/latest', {
  query: { boardId, provider: 'jira' },
  watch: [boardId],
})
const refreshSync = () => Promise.all([refreshTestflightSync(), refreshJiraSync()])
const latestRuns = computed<Record<IntegrationProvider, SyncRun | null>>(() => ({
  testflight: testflightSync.value?.run || null,
  jira: jiraSync.value?.run || null,
}))
const { data: categoryData, refresh: refreshCategories } = await useFetch<{ categories: CategorySummary[] }>('/api/categories', {
  query: { boardId },
  watch: [boardId],
})
const tickets = ref<Ticket[]>(data.value?.tickets || [])
watch(data, value => { if (value) tickets.value = value.tickets })
const categories = computed(() => categoryData.value?.categories || [])

const { data: labelData, refresh: refreshLabels } = await useFetch<{ labels: LabelSummary[] }>('/api/labels', {
  query: { boardId },
  watch: [boardId],
})
const labels = computed(() => labelData.value?.labels || [])
const labelFilterOptions = computed(() => labels.value.map(label => ({ value: label.id, label: label.name })))

// The workspace's vocabulary, reached through the board so a board-only member gets it too.
const { data: typeData } = await useFetch<{ types: TicketTypeSummary[] }>('/api/ticket-types', {
  query: { boardId },
  watch: [boardId],
})
const ticketTypes = computed(() => typeData.value?.types || [])
// Cards carry their type without the image; the badge finds it here by id.
provide(TICKET_TYPES_KEY, ticketTypes)

const query = ref('')
const searchOpen = ref(false)
const categoryFilter = ref('all')
const typeFilter = ref('all')
const labelFilter = ref<string[]>([])
const selected = ref<Ticket | null>(null)
const editorOpen = ref(false)
const deletingAttachmentId = ref<string | null>(null)
const saving = ref(false)
/** Which connection is syncing right now; one at a time keeps the counts readable. */
const syncing = ref<IntegrationProvider | null>(null)
const confirmation = ref<PendingConfirmation | null>(null)
const confirmationPending = ref(false)
const { notice, notify, closeNotice } = useNotify()
const { user } = useAuth()
const ownId = computed(() => user.value?.id || '')

// Viewers read and comment; changing the board itself needs at least `editor`.
const canEdit = computed(() => board.value?.role !== 'viewer')
const canModerate = computed(() => board.value?.role === 'admin')
const assigneeFilter = ref('all')

watch(boardId, () => {
  query.value = ''
  searchOpen.value = false
  categoryFilter.value = 'all'
  typeFilter.value = 'all'
  labelFilter.value = []
  assigneeFilter.value = 'all'
  editorOpen.value = false
  selected.value = null
})

// A label disappears the moment its last ticket drops it — a stale id left in the filter
// would silently empty the board.
watch(labels, (value) => {
  const known = new Set(value.map(label => label.id))
  const kept = labelFilter.value.filter(id => known.has(id))
  if (kept.length !== labelFilter.value.length) labelFilter.value = kept
})

const assigneeFilterOptions = computed(() => [
  { value: 'all', label: 'All assignees' },
  { value: 'mine', label: 'Assigned to me' },
  { value: 'unassigned', label: 'Unassigned' },
  ...(board.value?.members || [])
    .filter(member => member.userId !== ownId.value)
    .map(member => ({ value: member.userId, label: displayName(member) })),
])

// Losing a member would otherwise leave a filter selected that matches nothing.
watch(assigneeFilterOptions, (options) => {
  if (!options.some(option => option.value === assigneeFilter.value)) assigneeFilter.value = 'all'
})

const categoryFilterOptions = computed(() => [
  { value: 'all', label: 'All categories' },
  { value: 'uncategorized', label: 'Uncategorized' },
  ...categories.value.map(category => ({ value: category.id, label: category.name })),
])

const typeFilterOptions = computed(() => [
  { value: 'all', label: 'All types' },
  { value: 'untyped', label: 'Untyped' },
  ...ticketTypes.value.map(type => ({ value: type.id, label: type.name })),
])

// A type deleted in the workspace settings must not leave a filter that matches nothing.
watch(typeFilterOptions, (options) => {
  if (!options.some(option => option.value === typeFilter.value)) typeFilter.value = 'all'
})

const confirmationCopy = computed(() => {
  const action = confirmation.value
  if (!action) return { title: '', description: '', confirmLabel: '' }
  if (action.kind === 'delete-attachment') {
    return {
      title: 'Delete attachment?',
      description: `“${action.attachment.filename}” will be permanently removed from the ticket.`,
      confirmLabel: 'Delete attachment',
    }
  }
  return {
    title: 'Archive ticket?',
    // Archiving is no longer something an editor can walk back on their own, so the dialog
    // says who can, rather than letting the ticket simply vanish.
    description: canModerate.value
      ? `“${action.ticket.title}” will be removed from the board. You can restore it from the archive.`
      : `“${action.ticket.title}” will be removed from the board and moves into the archive, which a board administrator can restore it from.`,
    confirmLabel: 'Archive',
  }
})

const filteredTickets = computed(() => {
  const term = query.value.trim().toLocaleLowerCase('en')
  return tickets.value.filter((ticket) => {
    const matchesCategory = categoryFilter.value === 'all'
      || (categoryFilter.value === 'uncategorized' ? !ticket.category : ticket.category?.id === categoryFilter.value)
    const matchesType = typeFilter.value === 'all'
      || (typeFilter.value === 'untyped' ? !ticket.type : ticket.type?.id === typeFilter.value)
    // A ticket qualifies when it carries any of the picked labels.
    const matchesLabels = !labelFilter.value.length
      || ticket.labels.some(label => labelFilter.value.includes(label.id))
    const assignee = ticket.assignee?.id || null
    const matchesAssignee = assigneeFilter.value === 'all'
      || (assigneeFilter.value === 'unassigned' && !assignee)
      || (assigneeFilter.value === 'mine' ? assignee === ownId.value : assignee === assigneeFilter.value)
    const matchesText = !term || [
      ticket.title,
      ticket.description,
      ticket.feedback?.comment || '',
      String(ticket.ticketNumber),
      `#${ticket.ticketNumber}`,
      ticket.author?.firstName || '',
      ticket.author?.lastName || '',
      ticket.author?.email || '',
      ticket.assignee?.firstName || '',
      ticket.assignee?.lastName || '',
      ticket.assignee?.email || '',
      ticket.buildNumber || '',
      ticket.link || '',
      ticket.jira?.issueKey || '',
      ticket.type?.name || '',
      ...ticket.todos.map(todo => todo.text),
      ...ticket.labels.map(label => label.name),
    ].some(value => value.toLocaleLowerCase('en').includes(term))
    return matchesCategory && matchesType && matchesLabels && matchesAssignee && matchesText
  })
})

// --- Phone layout: one lane at a time, picked from a chip row -------------------------------

// Same rule as the board: the import lane only shows once something has landed in it.
const laneCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const ticket of filteredTickets.value) counts[ticket.laneId] = (counts[ticket.laneId] || 0) + 1
  return counts
})
const mobileLanes = computed(() => lanes.value.filter(lane => !lane.isImport || (laneCounts.value[lane.id] || 0) > 0))

// Kept in the URL so a reload or the back button lands on the same lane.
const selectedLaneId = computed(() => {
  const requested = typeof route.query.lane === 'string' ? route.query.lane : ''
  if (mobileLanes.value.some(lane => lane.id === requested)) return requested
  return (mobileLanes.value.find(lane => (laneCounts.value[lane.id] || 0) > 0) || mobileLanes.value[0])?.id || null
})
function selectLane(laneId: string) {
  if (laneId === selectedLaneId.value) return
  router.replace({ query: { ...route.query, lane: laneId } })
}

// A sideways swipe over the cards steps to the neighbouring lane.
let swipeStart: { x: number; y: number } | null = null
function beginSwipe(event: TouchEvent) {
  const touch = event.touches[0]
  swipeStart = touch ? { x: touch.clientX, y: touch.clientY } : null
}
function endSwipe(event: TouchEvent) {
  const touch = event.changedTouches[0]
  if (!swipeStart || !touch || !selectedLaneId.value) return
  const dx = touch.clientX - swipeStart.x
  const dy = touch.clientY - swipeStart.y
  swipeStart = null
  if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) / 2) return
  const index = mobileLanes.value.findIndex(lane => lane.id === selectedLaneId.value)
  const next = mobileLanes.value[index + (dx < 0 ? 1 : -1)]
  if (next) selectLane(next.id)
}

// The search field folds away behind the header's magnifier until it is wanted.
const searchInput = ref<HTMLInputElement | null>(null)
function toggleSearch() {
  searchOpen.value = !searchOpen.value
  if (!searchOpen.value) query.value = ''
  else nextTick(() => searchInput.value?.focus())
}

// The connections a sync button exists for: importing needs an administrator and complete
// credentials, and each complete connection gets its own button.
const syncProviders = computed<IntegrationProvider[]>(() => {
  if (!canModerate.value || !board.value) return []
  const providers: IntegrationProvider[] = []
  if (board.value.credentials.complete) providers.push('testflight')
  if (board.value.jira.complete) providers.push('jira')
  return providers
})

// The lane the "Add ticket" button was pressed in; the server falls back to the first lane.
const newTicketLaneId = ref<string | null>(null)
// Top for the plus in a lane's header, bottom for the button under its cards; the editor may still change it.
const newTicketPlacement = ref<'top' | 'bottom'>('bottom')

function newTicket(laneId: string, placement: 'top' | 'bottom' = 'bottom') {
  selected.value = null
  newTicketLaneId.value = laneId
  newTicketPlacement.value = placement
  editorOpen.value = true
}

function openTicket(ticket: Ticket) {
  selected.value = ticket
  newTicketLaneId.value = null
  newTicketPlacement.value = 'bottom'
  editorOpen.value = true
}

async function saveTicket(payload: { title?: string; description?: string; priority?: TicketPriority; dueDate?: string | null; buildNumber?: string | null; link?: string | null; assigneeId?: string | null; authorId?: string | null; labels?: string[]; categoryName?: string | null; typeId?: string | null; laneId?: string; placement?: 'top' | 'bottom'; todos: TicketTodoInput[]; attachments: File[]; stayOpen?: boolean }) {
  saving.value = true
  const wasEdit = Boolean(selected.value)
  try {
    const { attachments, laneId, placement, stayOpen, ...ticketPayload } = payload
    const response = selected.value
      ? await $fetch<{ ticket: Ticket }>(`/api/tickets/${selected.value.id}`, { method: 'PATCH', body: ticketPayload })
      : await $fetch<{ ticket: Ticket }>('/api/tickets', { method: 'POST', body: { ...ticketPayload, boardId: boardId.value, laneId: laneId || newTicketLaneId.value || undefined, placement: placement || newTicketPlacement.value } })
    selected.value = response.ticket
    const index = tickets.value.findIndex(ticket => ticket.id === response.ticket.id)
    if (index >= 0) {
      tickets.value[index] = response.ticket
    } else {
      tickets.value.push(response.ticket)
      // A ticket placed at the top made the server renumber its lane; mirror that here, as moveTicket does.
      if (response.ticket.position === 0) {
        tickets.value
          .filter(item => item.laneId === response.ticket.laneId && item.id !== response.ticket.id)
          .sort((a, b) => a.position - b.position)
          .forEach((item, itemIndex) => { item.position = itemIndex + 1 })
      }
    }

    if (attachments.length) {
      const formData = new FormData()
      attachments.forEach(file => formData.append('files', file))
      const upload = await $fetch<{ ticket: Ticket }>(`/api/tickets/${response.ticket.id}/attachments`, { method: 'POST', body: formData })
      selected.value = upload.ticket
      const uploadedIndex = tickets.value.findIndex(ticket => ticket.id === upload.ticket.id)
      if (uploadedIndex >= 0) tickets.value[uploadedIndex] = upload.ticket
    }
    await Promise.all([refreshCategories(), refreshLabels(), refreshBoards()])
    // The small Save beside the description keeps the editor on the ticket it just created.
    if (!stayOpen) editorOpen.value = false
    notify('success', wasEdit ? 'Ticket updated.' : 'Ticket created.')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    saving.value = false
  }
}

function requestArchive(ticket: Ticket) {
  confirmation.value = { kind: 'archive-ticket', ticket }
}

function requestAttachmentRemoval(attachment: Attachment) {
  confirmation.value = { kind: 'delete-attachment', attachment }
}

function updateConfirmationOpen(open: boolean) {
  if (!open && !confirmationPending.value) confirmation.value = null
}

async function executeConfirmation() {
  const action = confirmation.value
  if (!action || confirmationPending.value) return
  confirmationPending.value = true
  if (action.kind === 'delete-attachment') deletingAttachmentId.value = action.attachment.id
  try {
    if (action.kind === 'archive-ticket') {
      await $fetch(`/api/tickets/${action.ticket.id}/archive`, { method: 'POST' })
      tickets.value = tickets.value.filter(item => item.id !== action.ticket.id)
      editorOpen.value = false
      await refreshBoards()
      notify('success', 'Ticket archived.')
    } else {
      const response = await $fetch<{ ticket: Ticket }>(`/api/attachments/${action.attachment.id}`, { method: 'DELETE' })
      const index = tickets.value.findIndex(ticket => ticket.id === response.ticket.id)
      if (index >= 0) tickets.value[index] = response.ticket
      if (selected.value?.id === response.ticket.id) selected.value = response.ticket
      notify('success', 'Attachment deleted.')
    }
    confirmation.value = null
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    deletingAttachmentId.value = null
    confirmationPending.value = false
  }
}

/** Moves optimistically and reports whether the server agreed. */
async function moveTicket(id: string, laneId: string, index: number): Promise<boolean> {
  // Vue wraps the fetched tickets in reactive proxies. Those proxies cannot be
  // cloned with structuredClone and caused every drag operation to abort before
  // the API request was sent. Only lane and position are changed optimistically,
  // so keeping these plain values is sufficient for a reliable rollback.
  const snapshot = tickets.value.map(ticket => ({
    id: ticket.id,
    laneId: ticket.laneId,
    position: ticket.position,
  }))
  const ticket = tickets.value.find(item => item.id === id)
  if (!ticket) return false
  const source = ticket.laneId
  const sourceTickets = tickets.value.filter(item => item.laneId === source && item.id !== id).sort((a, b) => a.position - b.position)
  const targetTickets = source === laneId ? sourceTickets : tickets.value.filter(item => item.laneId === laneId && item.id !== id).sort((a, b) => a.position - b.position)
  targetTickets.splice(Math.max(0, Math.min(index, targetTickets.length)), 0, ticket)
  sourceTickets.forEach((item, itemIndex) => { item.position = itemIndex })
  targetTickets.forEach((item, itemIndex) => { item.laneId = laneId; item.position = itemIndex })
  try {
    await $fetch(`/api/tickets/${id}/position`, { method: 'PATCH', body: { laneId, index } })
    return true
  } catch (error) {
    const previousById = new Map(snapshot.map(item => [item.id, item]))
    tickets.value.forEach((item) => {
      const previous = previousById.get(item.id)
      if (!previous) return
      item.laneId = previous.laneId
      item.position = previous.position
    })
    notify('error', errorText(error))
    return false
  }
}

// Moves from the editor bypass its Save button, so each one says out loud that it already happened.
async function moveTicketFromEditor(ticket: Ticket, laneId: string) {
  if (ticket.laneId === laneId) return
  const targetIndex = tickets.value.filter(item => item.laneId === laneId).length
  const laneName = lanes.value.find(lane => lane.id === laneId)?.name || 'the lane'
  if (await moveTicket(ticket.id, laneId, targetIndex)) notify('success', `Moved to ${laneName}. Saved right away.`)
}

// A ticket that moves to another board leaves this page like an archived one does.
async function transferTicketFromEditor(ticket: Ticket, targetBoardId: string, laneId: string) {
  saving.value = true
  try {
    const { assigneeCleared } = await $fetch<{ ticket: Ticket; assigneeCleared: boolean }>(`/api/tickets/${ticket.id}/transfer`, { method: 'POST', body: { boardId: targetBoardId, laneId } })
    tickets.value = tickets.value.filter(item => item.id !== ticket.id)
    editorOpen.value = false
    const target = boards.value.find(item => item.id === targetBoardId)
    const laneName = target?.lanes.find(lane => lane.id === laneId)?.name
    await Promise.all([refreshBoards(), refreshLabels(), refreshCategories()])
    notify('success', `Moved to ${target?.name || 'the other board'}${laneName ? ` · ${laneName}` : ''}.${assigneeCleared ? ' The assignee is no member there and was removed.' : ''}`)
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    saving.value = false
  }
}

// The Save beside the description field: only that field, and the dialog stays open showing the rendered result.
async function saveDescriptionFromEditor(ticket: Ticket, description: string) {
  saving.value = true
  try {
    const response = await $fetch<{ ticket: Ticket }>(`/api/tickets/${ticket.id}`, { method: 'PATCH', body: { description } })
    if (selected.value?.id === response.ticket.id) selected.value = response.ticket
    const index = tickets.value.findIndex(item => item.id === response.ticket.id)
    if (index >= 0) tickets.value[index] = response.ticket
    notify('success', 'Description saved.')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    saving.value = false
  }
}

// How many tickets share the open ticket's lane; the editor greys out a reorder that would change nothing.
const selectedLaneTicketCount = computed(() => selected.value ? tickets.value.filter(item => item.laneId === selected.value!.laneId).length : 0)

// The reorder buttons beside the editor's lane select: same lane, first or last place.
async function reorderTicketFromEditor(ticket: Ticket, placement: 'top' | 'bottom') {
  const targetIndex = placement === 'top' ? 0 : tickets.value.filter(item => item.laneId === ticket.laneId).length - 1
  if (await moveTicket(ticket.id, ticket.laneId, Math.max(0, targetIndex))) notify('success', `Moved to the ${placement} of the lane. Saved right away.`)
}

async function sync(provider: IntegrationProvider) {
  if (syncing.value) return
  syncing.value = provider
  try {
    const response = await $fetch<{ run: SyncRun }>('/api/import/run', { method: 'POST', body: { boardId: boardId.value, provider } })
    await Promise.all([refresh(), refreshSync(), refreshLabels(), refreshBoards()])
    notify(response.run.failedCount ? 'error' : 'success', `${response.run.importedCount} new tickets from ${PROVIDER_LABELS[provider]}.`)
  } catch (error) {
    await refreshSync()
    notify('error', errorText(error))
  } finally {
    syncing.value = null
  }
}
</script>

<template>
  <div v-if="board" class="min-h-screen">
    <AppHeader :board-id="board.id" :can-view-archive="canModerate">
      <template #title>
        <h1 class="truncate text-[15px] font-bold tracking-[-0.02em]">{{ board.name }}</h1>
      </template>
      <template #actions>
        <button
          type="button"
          class="focus-ring grid size-10 shrink-0 place-items-center rounded-xl border border-[var(--line)] transition hover:bg-[var(--panel-strong)]"
          :class="searchOpen || query ? 'border-[color-mix(in_srgb,var(--line)_35%,var(--accent))] text-[var(--accent)]' : ''"
          :aria-pressed="searchOpen"
          aria-label="Search tickets"
          @click="toggleSearch"
        >
          <Search :size="18" />
        </button>
        <BoardFilterPane
          v-model:labels="labelFilter"
          v-model:category="categoryFilter"
          v-model:type="typeFilter"
          v-model:assignee="assigneeFilter"
          compact
          :label-options="labelFilterOptions"
          :category-options="categoryFilterOptions"
          :type-options="typeFilterOptions"
          :assignee-options="assigneeFilterOptions"
        />
      </template>
      <template #menu="{ close }">
        <p class="sheet-heading">Boards</p>
        <NuxtLink v-for="item in workspaceBoards" :key="item.id" :to="`/b/${item.id}`" class="sheet-item" @click="close">
          <Check v-if="item.id === board.id" :size="15" stroke-width="2.5" class="text-[var(--accent)]" aria-hidden="true" />
          <span v-else class="size-[15px]" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate">{{ item.name }}</span>
          <span class="muted shrink-0 text-[11px] font-semibold tabular-nums">{{ item.ticketCount }}</span>
        </NuxtLink>
        <template v-if="board.role === 'admin' || syncProviders.length">
          <div class="my-1 h-px bg-[var(--line)]" />
          <NuxtLink v-if="board.role === 'admin'" :to="`/b/${board.id}/settings/board`" class="sheet-item" @click="close">
            <Settings2 :size="15" aria-hidden="true" /> Board settings
          </NuxtLink>
          <button v-for="provider in syncProviders" :key="provider" type="button" class="sheet-item" :disabled="Boolean(syncing)" @click="close(); sync(provider)">
            <RefreshCcw :size="15" :class="syncing === provider ? 'animate-spin' : ''" aria-hidden="true" /> {{ PROVIDER_LABELS[provider] }} sync
          </button>
        </template>
      </template>
    </AppHeader>

    <main class="mx-auto max-w-[1800px] px-4 py-6 sm:px-6 max-md:px-3 max-md:py-3">
      <!-- Phone: the header carries the title and actions; only the search field and lane chips live here. -->
      <div class="md:hidden">
        <div v-if="searchOpen" class="relative mb-3">
          <Search :size="17" class="muted absolute left-3 top-1/2 -translate-y-1/2" />
          <input ref="searchInput" v-model="query" type="search" class="focus-ring surface h-11 w-full rounded-xl pl-10 pr-9 text-sm outline-none [&::-webkit-search-cancel-button]:appearance-none" placeholder="Search tickets">
          <button v-if="query" class="muted absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg hover:bg-[var(--panel-strong)]" aria-label="Clear search" @click="query = ''"><X :size="14" /></button>
        </div>
        <div v-if="mobileLanes.length" role="tablist" aria-label="Lanes" class="scrollbar-none -mx-3 mb-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5">
          <button
            v-for="lane in mobileLanes"
            :key="lane.id"
            type="button"
            role="tab"
            :aria-selected="lane.id === selectedLaneId"
            class="focus-ring flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-[13px] font-semibold transition"
            :class="lane.id === selectedLaneId
              ? 'border-[var(--ink)] bg-[var(--ink)] text-[var(--canvas)]'
              : 'border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--panel-strong)]'"
            @click="selectLane(lane.id)"
          >
            {{ lane.name }}
            <span class="tabular-nums" :class="lane.id === selectedLaneId ? 'opacity-70' : 'muted'">{{ laneCounts[lane.id] || 0 }}</span>
          </button>
        </div>
      </div>

      <div class="mb-6 flex-col gap-4 max-md:hidden md:flex md:flex-row md:items-end">
        <BoardSwitcher :board="board" :boards="workspaceBoards" :syncing="syncing" :latest-runs="latestRuns" :sync-providers="syncProviders" @sync="sync" />
        <div class="flex flex-wrap gap-2 md:ml-auto md:justify-end">
          <div class="relative w-full sm:w-72">
            <Search :size="17" class="muted absolute left-3 top-1/2 -translate-y-1/2" />
            <input v-model="query" type="search" class="focus-ring surface h-11 w-full rounded-xl pl-10 pr-9 text-sm outline-none [&::-webkit-search-cancel-button]:appearance-none" placeholder="Search tickets">
            <button v-if="query" class="muted absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg hover:bg-[var(--panel-strong)]" aria-label="Clear search" @click="query = ''"><X :size="14" /></button>
          </div>
          <BoardFilterPane
            v-model:labels="labelFilter"
            v-model:category="categoryFilter"
            v-model:type="typeFilter"
            v-model:assignee="assigneeFilter"
            :label-options="labelFilterOptions"
            :category-options="categoryFilterOptions"
            :type-options="typeFilterOptions"
            :assignee-options="assigneeFilterOptions"
          />
        </div>
      </div>

      <div v-if="pending" class="grid gap-4" :style="isMobile ? undefined : { minWidth: `${lanes.length * 280}px`, gridTemplateColumns: `repeat(${lanes.length}, minmax(260px, 1fr))` }">
        <div v-for="lane in (isMobile ? lanes.slice(0, 1) : lanes)" :key="lane.id" class="space-y-3"><div class="h-5 w-28 animate-pulse rounded bg-[var(--line)]" /><div v-for="card in 3" :key="card" class="surface h-36 animate-pulse rounded-2xl" /></div>
      </div>
      <div v-else-if="error" class="surface mx-auto mt-24 max-w-md rounded-2xl p-7 text-center">
        <h2 class="font-bold">Could not load the board</h2><p class="muted mt-2 text-sm">{{ errorText(error) }}</p>
        <button class="mt-5 inline-flex items-center gap-2 rounded-xl bg-[var(--ink)] px-4 py-2 text-sm font-semibold text-[var(--canvas)]" @click="refresh()"><RefreshCcw :size="15" /> Try again</button>
      </div>
      <!-- The server renders the desktop board; the phone view takes over once the viewport is known. -->
      <div v-else-if="isMobile" class="md:hidden" @touchstart.passive="beginSwipe" @touchend.passive="endSwipe">
        <KanbanBoard v-if="selectedLaneId" :board-id="board.id" :lanes="lanes" :tickets="filteredTickets" :can-edit="canEdit" :lane-id="selectedLaneId" @open="openTicket" @move="moveTicket" @create="newTicket" />
        <p v-else class="muted py-16 text-center text-sm">This board has no lanes yet.</p>
      </div>
      <div v-else class="scrollbar-thin overflow-x-auto max-md:hidden"><KanbanBoard :board-id="board.id" :lanes="lanes" :tickets="filteredTickets" :can-edit="canEdit" @open="openTicket" @move="moveTicket" @create="newTicket" /></div>
    </main>

    <TicketEditor v-if="editorOpen" :ticket="selected" :lanes="lanes" :members="board.members" :can-edit="canEdit" :can-moderate="canModerate" :categories="categories" :labels="labels" :ticket-types="ticketTypes" :saving="saving" :deleting-attachment-id="deletingAttachmentId" :initial-lane-id="newTicketLaneId" :initial-placement="newTicketPlacement" :lane-ticket-count="selectedLaneTicketCount" :boards="transferableBoards" @close="editorOpen = false" @save="saveTicket" @move="moveTicketFromEditor" @reorder="reorderTicketFromEditor" @transfer="transferTicketFromEditor" @archive="requestArchive" @remove-attachment="requestAttachmentRemoval" @save-description="saveDescriptionFromEditor" @commented="refresh()" @notify="notify" />

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
