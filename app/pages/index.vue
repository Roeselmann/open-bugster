<script setup lang="ts">
import { RefreshCcw, Search, Settings2, X } from '@lucide/vue'
import type { Attachment, CategorySummary, SyncRun, Ticket, TicketPriority, TicketStatus, TicketTodoInput } from '~~/shared/types/domain'

type PendingConfirmation =
  | { kind: 'delete-category'; category: CategorySummary }
  | { kind: 'archive-ticket'; ticket: Ticket }
  | { kind: 'delete-attachment'; attachment: Attachment }

const { data, pending, error, refresh } = await useFetch<{ tickets: Ticket[] }>('/api/tickets')
const { data: syncData, refresh: refreshSync } = await useFetch<{ run: SyncRun | null }>('/api/import/latest')
const { data: categoryData, refresh: refreshCategories } = await useFetch<{ categories: CategorySummary[] }>('/api/categories')
const tickets = ref<Ticket[]>(data.value?.tickets || [])
watch(data, value => { if (value) tickets.value = value.tickets })
const categories = computed(() => categoryData.value?.categories || [])

const query = ref('')
const categoryFilter = ref('all')
const selected = ref<Ticket | null>(null)
const editorOpen = ref(false)
const categoryManagerOpen = ref(false)
const deletingCategoryId = ref<string | null>(null)
const deletingAttachmentId = ref<string | null>(null)
const saving = ref(false)
const syncing = ref(false)
const confirmation = ref<PendingConfirmation | null>(null)
const confirmationPending = ref(false)
const notice = ref<{ id: number; type: 'success' | 'error'; text: string } | null>(null)
let noticeId = 0

const categoryFilterOptions = computed(() => [
  { value: 'all', label: 'All categories' },
  { value: 'uncategorized', label: 'Uncategorized' },
  ...categories.value.map(category => ({ value: category.id, label: category.name })),
])

const confirmationCopy = computed(() => {
  const action = confirmation.value
  if (!action) return { title: '', description: '', confirmLabel: '' }
  if (action.kind === 'delete-category') {
    const count = action.category.ticketCount
    return {
      title: `Delete category “${action.category.name}”?`,
      description: count === 1 ? '1 ticket will lose this assignment.' : `${count} tickets will lose this assignment.`,
      confirmLabel: 'Delete category',
    }
  }
  if (action.kind === 'delete-attachment') {
    return {
      title: 'Delete attachment?',
      description: `“${action.attachment.filename}” will be permanently removed from the ticket.`,
      confirmLabel: 'Delete attachment',
    }
  }
  return {
    title: 'Archive ticket?',
    description: `“${action.ticket.title}” will be removed from the board.`,
    confirmLabel: 'Archive',
  }
})

const filteredTickets = computed(() => {
  const term = query.value.trim().toLocaleLowerCase('en')
  return tickets.value.filter((ticket) => {
    const matchesCategory = categoryFilter.value === 'all'
      || (categoryFilter.value === 'uncategorized' ? !ticket.category : ticket.category?.id === categoryFilter.value)
    const matchesText = !term || [
      ticket.title,
      ticket.description,
      ticket.comment,
      ticket.feedback?.comment || '',
      String(ticket.ticketNumber),
      `#${ticket.ticketNumber}`,
      ticket.author?.firstName || '',
      ticket.author?.lastName || '',
      ticket.author?.email || '',
      ticket.buildNumber || '',
      ...ticket.todos.map(todo => todo.text),
      ...ticket.labels.map(label => label.name),
    ].some(value => value.toLocaleLowerCase('en').includes(term))
    return matchesCategory && matchesText
  })
})
const hasImportTickets = computed(() => tickets.value.some(ticket => ticket.status === 'import'))

function notify(type: 'success' | 'error', text: string) {
  notice.value = { id: ++noticeId, type, text }
}

function closeNotice(id: number) {
  if (notice.value?.id === id) notice.value = null
}

function errorText(error: any) {
  return error?.data?.statusMessage || error?.statusMessage || 'Something went wrong.'
}

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await useUserSession().fetch()
  await navigateTo('/login')
}

function newTicket() {
  selected.value = null
  editorOpen.value = true
}

function openTicket(ticket: Ticket) {
  selected.value = ticket
  editorOpen.value = true
}

async function saveTicket(payload: { title?: string; description?: string; comment: string; priority?: TicketPriority; dueDate?: string | null; buildNumber?: string | null; labels?: string[]; categoryName?: string | null; todos: TicketTodoInput[]; attachments: File[] }) {
  saving.value = true
  const wasEdit = Boolean(selected.value)
  try {
    const { attachments, ...ticketPayload } = payload
    const response = selected.value
      ? await $fetch<{ ticket: Ticket }>(`/api/tickets/${selected.value.id}`, { method: 'PATCH', body: ticketPayload })
      : await $fetch<{ ticket: Ticket }>('/api/tickets', { method: 'POST', body: ticketPayload })
    selected.value = response.ticket
    const index = tickets.value.findIndex(ticket => ticket.id === response.ticket.id)
    if (index >= 0) tickets.value[index] = response.ticket
    else tickets.value.push(response.ticket)

    if (attachments.length) {
      const formData = new FormData()
      attachments.forEach(file => formData.append('files', file))
      const upload = await $fetch<{ ticket: Ticket }>(`/api/tickets/${response.ticket.id}/attachments`, { method: 'POST', body: formData })
      selected.value = upload.ticket
      const uploadedIndex = tickets.value.findIndex(ticket => ticket.id === upload.ticket.id)
      if (uploadedIndex >= 0) tickets.value[uploadedIndex] = upload.ticket
    }
    await refreshCategories()
    editorOpen.value = false
    notify('success', wasEdit ? 'Ticket updated.' : 'Ticket created.')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    saving.value = false
  }
}

function requestCategoryRemoval(category: CategorySummary) {
  confirmation.value = { kind: 'delete-category', category }
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
  if (action.kind === 'delete-category') deletingCategoryId.value = action.category.id
  if (action.kind === 'delete-attachment') deletingAttachmentId.value = action.attachment.id
  try {
    if (action.kind === 'delete-category') {
      const category = action.category
      await $fetch(`/api/categories/${category.id}`, { method: 'DELETE' })
      tickets.value = tickets.value.map(ticket => ticket.category?.id === category.id ? { ...ticket, category: null } : ticket)
      if (selected.value?.category?.id === category.id) selected.value = { ...selected.value, category: null }
      if (categoryFilter.value === category.id) categoryFilter.value = 'all'
      await refreshCategories()
      notify('success', 'Category deleted.')
    } else if (action.kind === 'archive-ticket') {
      await $fetch(`/api/tickets/${action.ticket.id}/archive`, { method: 'POST' })
      tickets.value = tickets.value.filter(item => item.id !== action.ticket.id)
      editorOpen.value = false
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
    deletingCategoryId.value = null
    deletingAttachmentId.value = null
    confirmationPending.value = false
  }
}

async function moveTicket(id: string, status: TicketStatus, index: number) {
  // Vue wraps the fetched tickets in reactive proxies. Those proxies cannot be
  // cloned with structuredClone and caused every drag operation to abort before
  // the API request was sent. Only status and position are changed optimistically,
  // so keeping these plain values is sufficient for a reliable rollback.
  const snapshot = tickets.value.map(ticket => ({
    id: ticket.id,
    status: ticket.status,
    position: ticket.position,
  }))
  const ticket = tickets.value.find(item => item.id === id)
  if (!ticket) return
  const source = ticket.status
  const sourceTickets = tickets.value.filter(item => item.status === source && item.id !== id).sort((a, b) => a.position - b.position)
  const targetTickets = source === status ? sourceTickets : tickets.value.filter(item => item.status === status && item.id !== id).sort((a, b) => a.position - b.position)
  targetTickets.splice(Math.max(0, Math.min(index, targetTickets.length)), 0, ticket)
  sourceTickets.forEach((item, itemIndex) => { item.position = itemIndex })
  targetTickets.forEach((item, itemIndex) => { item.status = status; item.position = itemIndex })
  try {
    await $fetch(`/api/tickets/${id}/position`, { method: 'PATCH', body: { status, index } })
  } catch (error) {
    const previousById = new Map(snapshot.map(item => [item.id, item]))
    tickets.value.forEach((item) => {
      const previous = previousById.get(item.id)
      if (!previous) return
      item.status = previous.status
      item.position = previous.position
    })
    notify('error', errorText(error))
  }
}

async function moveTicketFromEditor(ticket: Ticket, status: TicketStatus) {
  if (ticket.status === status) return
  const targetIndex = tickets.value.filter(item => item.status === status).length
  await moveTicket(ticket.id, status, targetIndex)
}

async function sync() {
  syncing.value = true
  try {
    const response = await $fetch<{ run: SyncRun }>('/api/import/testflight', { method: 'POST' })
    await Promise.all([refresh(), refreshSync()])
    notify(response.run.failedCount ? 'error' : 'success', `${response.run.importedCount} new tickets.`)
  } catch (error) {
    await refreshSync()
    notify('error', errorText(error))
  } finally {
    syncing.value = false
  }
}
</script>

<template>
  <div class="min-h-screen">
    <AppHeader :syncing="syncing" :latest-run="syncData?.run || null" @new-ticket="newTicket" @sync="sync" @logout="logout" />

    <main class="mx-auto max-w-[1800px] px-4 py-6 sm:px-6">
      <div class="mb-6 flex flex-col gap-4 md:flex-row md:items-end">
        <div>
          <h1 class="text-3xl font-bold tracking-[-.045em] sm:text-3xl">Workboard - {{ tickets.length }} tickets</h1>
        </div>
        <div class="flex flex-wrap gap-2 md:ml-auto md:justify-end">
          <div class="relative w-full sm:w-72">
            <Search :size="17" class="muted absolute left-3 top-1/2 -translate-y-1/2" />
            <input v-model="query" type="search" class="focus-ring surface h-10 w-full rounded-xl pl-10 pr-9 text-sm outline-none" placeholder="Search tickets">
            <button v-if="query" class="muted absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg hover:bg-[var(--panel-strong)]" aria-label="Clear search" @click="query = ''"><X :size="14" /></button>
          </div>
          <div class="min-w-44">
            <UiSelect v-model="categoryFilter" :options="categoryFilterOptions" aria-label="Filter by category" />
          </div>
          <button class="focus-ring surface grid size-10 place-items-center rounded-xl hover:bg-[var(--panel-strong)]" aria-label="Manage categories" title="Manage categories" @click="categoryManagerOpen = true"><Settings2 :size="17" /></button>
        </div>
      </div>

      <div v-if="pending" class="grid min-w-[1700px] grid-cols-6 gap-4">
        <div v-for="column in 6" :key="column" class="space-y-3"><div class="h-5 w-28 animate-pulse rounded bg-[var(--line)]" /><div v-for="card in 3" :key="card" class="surface h-36 animate-pulse rounded-2xl" /></div>
      </div>
      <div v-else-if="error" class="surface mx-auto mt-24 max-w-md rounded-2xl p-7 text-center">
        <h2 class="font-bold">Could not load the board</h2><p class="muted mt-2 text-sm">{{ errorText(error) }}</p>
        <button class="mt-5 inline-flex items-center gap-2 rounded-xl bg-[var(--ink)] px-4 py-2 text-sm font-semibold text-[var(--canvas)]" @click="refresh()"><RefreshCcw :size="15" /> Try again</button>
      </div>
      <div v-else class="scrollbar-thin overflow-x-auto"><KanbanBoard :tickets="filteredTickets" :show-import-lane="hasImportTickets" @open="openTicket" @move="moveTicket" /></div>
    </main>

    <TicketEditor v-if="editorOpen" :ticket="selected" :categories="categories" :saving="saving" :deleting-attachment-id="deletingAttachmentId" @close="editorOpen = false" @save="saveTicket" @move="moveTicketFromEditor" @archive="requestArchive" @remove-attachment="requestAttachmentRemoval" />
    <CategoryManager v-if="categoryManagerOpen" :categories="categories" :deleting-id="deletingCategoryId" @close="categoryManagerOpen = false" @delete="requestCategoryRemoval" />

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
