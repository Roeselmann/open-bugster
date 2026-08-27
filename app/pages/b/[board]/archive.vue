<script setup lang="ts">
import { ArchiveRestore, ArrowLeft, Inbox, Tag } from '@lucide/vue'
import type { Ticket } from '~~/shared/types/domain'
import { CATEGORY_TONE_CLASSES } from '~~/shared/utils/constants'

definePageMeta({ middleware: 'board' })

const route = useRoute()
const boardId = computed(() => String(route.params.board || ''))

const { boards } = useBoards()
const board = computed(() => boards.value.find(item => item.id === boardId.value) || null)

const { data, pending, refresh } = await useFetch<{ tickets: Ticket[] }>('/api/tickets', {
  query: { boardId, archived: 'true' },
  watch: [boardId],
})
const tickets = computed(() => data.value?.tickets || [])
const laneName = computed(() => new Map((board.value?.lanes || []).map(lane => [lane.id, lane.name])))
const restoring = ref<string | null>(null)

async function restore(ticket: Ticket) {
  restoring.value = ticket.id
  try {
    await $fetch(`/api/tickets/${ticket.id}/restore`, { method: 'POST' })
    await refresh()
  } finally {
    restoring.value = null
  }
}

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await useUserSession().fetch()
  await navigateTo('/login')
}
</script>

<template>
  <div v-if="board" class="min-h-screen">
    <AppHeader :board-id="board.id" :syncing="false" :latest-run="null" archive-mode @logout="logout" />
    <main class="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <NuxtLink :to="`/b/${board.id}`" class="focus-ring muted inline-flex items-center gap-1.5 rounded-lg text-sm font-semibold hover:text-[var(--ink)]">
        <ArrowLeft :size="15" /> Back to {{ board.name }}
      </NuxtLink>
      <h1 class="mt-2 text-3xl font-bold tracking-[-.045em]">Archive</h1>
      <p class="muted mt-2 text-sm">Archived TestFlight tickets are not imported again during a sync. Restoring puts a ticket back into its own lane.</p>

      <div v-if="pending" class="mt-8 space-y-3"><div v-for="item in 4" :key="item" class="surface h-24 animate-pulse rounded-2xl" /></div>
      <div v-else-if="!tickets.length" class="surface mt-10 grid min-h-64 place-items-center rounded-3xl text-center"><div class="muted"><Inbox :size="28" class="mx-auto mb-3 opacity-50" /><p class="font-semibold">The archive is empty.</p></div></div>
      <div v-else class="mt-8 space-y-3">
        <article v-for="ticket in tickets" :key="ticket.id" class="surface-strong flex items-center gap-4 rounded-2xl p-4 sm:p-5">
          <div class="min-w-0 flex-1"><div class="mb-1 flex items-center gap-2"><PriorityPill :priority="ticket.priority" /><span v-if="ticket.source !== 'manual'" class="muted text-[11px] font-semibold">TestFlight</span><span v-if="laneName.get(ticket.laneId)" class="muted text-[11px] font-semibold">{{ laneName.get(ticket.laneId) }}</span><span v-if="ticket.category" class="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold" :class="CATEGORY_TONE_CLASSES[ticket.category.color]"><Tag :size="11" class="shrink-0" /><span class="truncate">{{ ticket.category.name }}</span></span></div><h2 class="truncate font-semibold">{{ ticket.title }}</h2><p v-if="ticket.description" class="muted mt-1 line-clamp-1 text-sm">{{ ticket.description }}</p></div>
          <button :disabled="restoring === ticket.id" class="focus-ring flex h-10 shrink-0 items-center gap-2 rounded-xl border border-[var(--line)] px-3 text-sm font-semibold hover:bg-[var(--panel)] disabled:opacity-50" @click="restore(ticket)"><ArchiveRestore :size="16" /> <span class="hidden sm:inline">Restore</span></button>
        </article>
      </div>
    </main>
  </div>
</template>
