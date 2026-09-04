<script setup lang="ts">
import { Layers, Plus, Settings2 } from '@lucide/vue'
import type { WorkspaceSummary } from '~~/shared/types/domain'

// Instance level, like the user administration: every workspace of the server, side by side.
const { user: currentUser, instanceAdmin } = useAuth()
const { notice, notify, closeNotice } = useNotify()

// The account menu only offers this page to administrators; a typed-in URL still has to bounce.
watchEffect(() => { if (currentUser.value && !instanceAdmin.value) navigateTo('/') })

// An instance administrator's list is the complete one, so the cached state serves here too.
await loadWorkspaces()
const { workspaces, refresh: refreshWorkspaces } = useWorkspaces()
const lastWorkspaceId = useLastWorkspaceId()

function memberCount(workspace: WorkspaceSummary): string {
  const admins = workspace.members.filter(member => member.role === 'admin').length
  const total = workspace.members.length
  if (!total) return 'No members'
  return `${total} ${total === 1 ? 'member' : 'members'}${admins ? ` · ${admins} ${admins === 1 ? 'admin' : 'admins'}` : ''}`
}

const newName = ref('')
const creating = ref(false)

async function createWorkspace() {
  const name = newName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  try {
    const response = await $fetch<{ workspace: { id: string } }>('/api/workspaces', { method: 'POST', body: { name } })
    await refreshWorkspaces()
    lastWorkspaceId.value = response.workspace.id
    newName.value = ''
    // Straight on to the new workspace: its first board and administrators are set up there.
    await navigateTo(`/w/${response.workspace.id}/settings`)
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="min-h-screen">
    <AppHeader />
    <main class="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <h1 class="text-3xl font-bold tracking-[-.045em]">Workspaces</h1>
        <p class="muted mt-1 text-sm">
          A workspace groups boards, one per team, client or department, with its own
          administrators. Each one is managed on its own settings page.
        </p>
      </div>

      <section class="surface rounded-2xl">
        <header class="border-b border-[var(--line)] px-5 py-4">
          <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Instance</p>
          <h2 class="mt-0.5 text-lg font-bold">All workspaces</h2>
          <p class="muted mt-1 text-sm">The order here is the order the workspace switcher offers them in.</p>
        </header>
        <ul class="divide-y divide-[var(--line)]">
          <li v-for="item in workspaces" :key="item.id" class="flex flex-wrap items-center gap-3 px-5 py-4">
            <span class="surface-strong grid size-10 shrink-0 place-items-center rounded-xl" aria-hidden="true">
              <Layers :size="17" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold">{{ item.name }}</p>
              <p class="muted truncate text-xs">
                {{ item.boardCount }} {{ item.boardCount === 1 ? 'board' : 'boards' }} · {{ memberCount(item) }}<template v-if="item.description"> · {{ item.description }}</template>
              </p>
            </div>
            <NuxtLink
              :to="`/w/${item.id}/settings`"
              class="focus-ring flex h-10 items-center gap-2 rounded-xl border border-[var(--line)] px-3.5 text-sm font-semibold transition hover:bg-[var(--panel-strong)]"
            >
              <Settings2 :size="15" aria-hidden="true" /> Settings
            </NuxtLink>
          </li>
        </ul>
      </section>

      <section class="surface rounded-2xl">
        <header class="border-b border-[var(--line)] px-5 py-4">
          <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Instance</p>
          <h2 class="mt-0.5 text-lg font-bold">New workspace</h2>
          <p class="muted mt-1 text-sm">
            It starts empty. You are taken to its settings to open the first board and name its
            administrators. The switcher appears next to the logo as soon as a second workspace exists.
          </p>
        </header>
        <form class="flex flex-wrap items-center gap-3 px-5 py-4" @submit.prevent="createWorkspace">
          <input
            v-model="newName"
            class="focus-ring surface-strong h-11 min-w-56 flex-1 rounded-xl px-3 text-sm outline-none"
            maxlength="40"
            placeholder="Workspace name"
            aria-label="Name for a new workspace"
          >
          <button
            type="submit"
            :disabled="creating || !newName.trim()"
            class="focus-ring flex h-11 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] disabled:opacity-50"
          >
            <Plus :size="16" aria-hidden="true" /> {{ creating ? 'Creating…' : 'Create workspace' }}
          </button>
        </form>
      </section>
    </main>

    <UiToastHost :notice="notice" @close="closeNotice" />
  </div>
</template>
