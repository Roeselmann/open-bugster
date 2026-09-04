<script setup lang="ts">
import { ArrowLeft, Plug, ScrollText, SlidersHorizontal, SquareKanban, Users, Webhook } from '@lucide/vue'

definePageMeta({ middleware: 'board' })

const { board } = useCurrentBoard()
const { notice, closeNotice } = useNotify()

// Only the member roster is readable without the admin role; middleware turns the rest away.
const sections = computed(() => {
  const id = board.value?.id
  if (!id) return []
  const users = { to: `/b/${id}/settings/users`, label: 'Users', icon: Users }
  if (board.value?.role !== 'admin') return [users]
  return [
    { to: `/b/${id}/settings/board`, label: 'Board', icon: SlidersHorizontal },
    users,
    { to: `/b/${id}/settings/integration`, label: 'TestFlight', icon: Plug },
    { to: `/b/${id}/settings/jira`, label: 'Jira', icon: SquareKanban },
    { to: `/b/${id}/settings/automation`, label: 'Webhooks', icon: Webhook },
    { to: `/b/${id}/settings/audit`, label: 'Audit', icon: ScrollText },
  ]
})
</script>

<template>
  <div v-if="board" class="min-h-screen">
    <AppHeader :board-id="board.id" archive-mode />

    <main class="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <NuxtLink :to="`/b/${board.id}`" class="focus-ring muted inline-flex items-center gap-1.5 rounded-lg text-sm font-semibold hover:text-[var(--ink)]">
          <ArrowLeft :size="15" /> Back to {{ board.name }}
        </NuxtLink>
        <h1 class="mt-2 text-3xl font-bold tracking-[-.045em]">Board settings</h1>
      </div>

      <nav class="surface flex flex-wrap gap-1 rounded-2xl p-1" aria-label="Board settings sections">
        <NuxtLink
          v-for="section in sections"
          :key="section.to"
          :to="section.to"
          class="focus-ring flex h-10 flex-1 basis-28 items-center justify-center gap-2 rounded-xl text-sm font-semibold transition hover:bg-[var(--accent-soft)]"
          exact-active-class="bg-[var(--ink)] text-[var(--canvas)] hover:bg-[var(--ink)]"
        >
          <component :is="section.icon" :size="16" aria-hidden="true" />
          {{ section.label }}
        </NuxtLink>
      </nav>

      <NuxtPage />
    </main>

    <UiToastHost :notice="notice" @close="closeNotice" />
  </div>
</template>
