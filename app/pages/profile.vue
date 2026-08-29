<script setup lang="ts">
import { KeyRound, LayoutGrid, Plug, UserRound } from '@lucide/vue'

const { user } = useAuth()
const { notice, closeNotice } = useNotify()

// This page runs no board middleware, so the shared list may still be empty here; the
// loader is a no-op once anything else has filled it. Done in the parent so every tab
// can read `useBoards()` without each one fetching again.
await loadBoards()

const sections = [
  { to: '/profile', label: 'Account', icon: UserRound },
  { to: '/profile/boards', label: 'Boards', icon: LayoutGrid },
  { to: '/profile/integrations', label: 'Integrations', icon: Plug },
  { to: '/profile/security', label: 'Security', icon: KeyRound },
]
</script>

<template>
  <div class="min-h-screen">
    <AppHeader />

    <main class="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <h1 class="text-3xl font-bold tracking-[-.045em]">Your profile</h1>
        <p class="muted mt-1 text-sm">{{ user?.email }} — the address you sign in with, and the one TestFlight imports are matched against.</p>
      </div>

      <nav class="surface flex flex-wrap gap-1 rounded-2xl p-1" aria-label="Profile sections">
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
