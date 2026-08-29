<script setup lang="ts">
import { Bot, ChevronRight, KeyRound, LayoutGrid, Terminal, UserRound } from '@lucide/vue'
import type { BoardRole, BoardSummary } from '~~/shared/types/domain'

const { user, instanceAdmin } = useAuth()
const { notice, notify, closeNotice } = useNotify()
const session = useUserSession()

// This page runs no board middleware, so the shared list may still be empty here; the
// loader is a no-op once anything else has filled it.
await loadBoards()
const { boards } = useBoards()

const boardRoleLabels: Record<BoardRole, string> = { viewer: 'Viewer', editor: 'Editor', admin: 'Administrator' }

/**
 * An instance administrator is handed `admin` on every board whether or not anybody added
 * them, so the row has to say which of the two it is — a membership can be taken away, the
 * instance role cannot.
 */
function viaInstanceRole(board: BoardSummary): boolean {
  return instanceAdmin.value && !board.members.some(member => member.userId === user.value?.id)
}

const profile = reactive({ email: '', firstName: '', lastName: '' })
watchEffect(() => {
  profile.email = user.value?.email || ''
  profile.firstName = user.value?.firstName || ''
  profile.lastName = user.value?.lastName || ''
})

const savingProfile = ref(false)
async function saveProfile() {
  savingProfile.value = true
  try {
    await $fetch('/api/profile', { method: 'PATCH', body: { ...profile } })
    await session.fetch()
    notify('success', 'Your profile was saved.')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    savingProfile.value = false
  }
}

const passwords = reactive({ currentPassword: '', newPassword: '', repeatPassword: '' })
const savingPassword = ref(false)
const passwordMismatch = computed(() => Boolean(passwords.repeatPassword) && passwords.newPassword !== passwords.repeatPassword)

async function savePassword() {
  if (passwordMismatch.value) return
  savingPassword.value = true
  try {
    await $fetch('/api/profile/password', {
      method: 'POST',
      body: { currentPassword: passwords.currentPassword, newPassword: passwords.newPassword },
    })
    passwords.currentPassword = ''
    passwords.newPassword = ''
    passwords.repeatPassword = ''
    await session.fetch()
    notify('success', 'Your password was changed. Other devices have been signed out.')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    savingPassword.value = false
  }
}
</script>

<template>
  <div class="min-h-screen">
    <AppHeader />
    <main class="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <h1 class="text-3xl font-bold tracking-[-.045em]">Your profile</h1>
        <p class="muted mt-1 text-sm">{{ user?.email }} — the address you sign in with, and the one TestFlight imports are matched against.</p>
      </div>

      <section class="surface rounded-2xl">
        <header class="border-b border-[var(--line)] px-5 py-4">
          <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Account</p>
          <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold"><UserRound :size="18" aria-hidden="true" /> Name and address</h2>
          <p class="muted mt-1 text-sm">Shown on the tickets you create and the comments you write, everywhere at once.</p>
        </header>
        <form class="space-y-4 px-5 py-5" @submit.prevent="saveProfile">
          <label class="block">
            <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Email</span>
            <input v-model="profile.email" required type="email" maxlength="160" autocomplete="email" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
            <span class="muted mt-1.5 block text-xs">Everything you have filed, written or been assigned follows you to the new address.</span>
          </label>
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="block">
              <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">First name</span>
              <input v-model="profile.firstName" required maxlength="60" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
            </label>
            <label class="block">
              <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Last name</span>
              <input v-model="profile.lastName" maxlength="60" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
            </label>
          </div>
          <div class="flex justify-end">
            <button :disabled="savingProfile" class="focus-ring h-10 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] transition hover:opacity-85 disabled:opacity-50">
              {{ savingProfile ? 'Saving…' : 'Save profile' }}
            </button>
          </div>
        </form>
      </section>

      <section class="surface rounded-2xl">
        <header class="border-b border-[var(--line)] px-5 py-4">
          <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Access</p>
          <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold"><LayoutGrid :size="18" aria-hidden="true" /> Your boards</h2>
          <p class="muted mt-1 text-sm">
            Viewers read and comment, editors work the board, administrators also change its settings
            and the App Store Connect key. Only a board administrator can change who is on a board.
          </p>
        </header>

        <ul v-if="boards.length" class="divide-y divide-[var(--line)]">
          <li v-for="board in boards" :key="board.id">
            <NuxtLink
              :to="`/b/${board.id}`"
              class="focus-ring flex items-center gap-3 px-5 py-3.5 transition hover:bg-[var(--panel-strong)]"
            >
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-semibold">{{ board.name }}</p>
                <p class="muted mt-0.5 text-xs">
                  {{ board.ticketCount }} open {{ board.ticketCount === 1 ? 'ticket' : 'tickets' }} ·
                  {{ board.members.length }} {{ board.members.length === 1 ? 'member' : 'members' }}
                  <template v-if="viaInstanceRole(board)"> · through your instance role, not a membership</template>
                </p>
              </div>
              <span class="tone tone-neutral shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide">
                {{ boardRoleLabels[board.role] }}
              </span>
              <ChevronRight class="muted shrink-0" :size="16" aria-hidden="true" />
            </NuxtLink>
          </li>
        </ul>
        <p v-else class="muted px-5 py-6 text-sm">
          You are not on any board yet — a board administrator has to add you.
        </p>
      </section>

      <section class="surface rounded-2xl">
        <header class="border-b border-[var(--line)] px-5 py-4">
          <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Integrations</p>
          <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold"><Terminal :size="18" aria-hidden="true" /> API tokens</h2>
          <p class="muted mt-1 text-sm">
            For the API, for a workflow tool, or for connecting an agent. Everything a token does is
            recorded against you, with its label beside it.
            <NuxtLink to="/api/v1/docs" target="_blank" class="focus-ring rounded font-semibold underline underline-offset-2">API reference</NuxtLink>
          </p>
        </header>
        <ApiTokenManager :boards="boards" />
      </section>

      <section class="surface rounded-2xl">
        <header class="border-b border-[var(--line)] px-5 py-4">
          <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Integrations</p>
          <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold"><Bot :size="18" aria-hidden="true" /> Connect an AI agent</h2>
          <p class="muted mt-1 text-sm">
            Point Claude, Cursor or anything else that speaks MCP at this instance, and it can read
            and work the boards you can.
          </p>
        </header>
        <McpConnection />
      </section>

      <section class="surface rounded-2xl">
        <header class="border-b border-[var(--line)] px-5 py-4">
          <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Security</p>
          <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold"><KeyRound :size="18" aria-hidden="true" /> Password</h2>
          <p class="muted mt-1 text-sm">Changing it signs you out everywhere else.</p>
        </header>
        <form class="space-y-4 px-5 py-5" @submit.prevent="savePassword">
          <label class="block">
            <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Current password</span>
            <input v-model="passwords.currentPassword" required type="password" autocomplete="current-password" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
          </label>
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="block">
              <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">New password</span>
              <input v-model="passwords.newPassword" required type="password" minlength="12" autocomplete="new-password" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
              <span class="muted mt-1.5 block text-xs">At least 12 characters.</span>
            </label>
            <label class="block">
              <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Repeat new password</span>
              <input v-model="passwords.repeatPassword" required type="password" autocomplete="new-password" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
              <span v-if="passwordMismatch" class="mt-1.5 block text-xs font-medium text-rose-600">The two entries do not match.</span>
            </label>
          </div>
          <div class="flex justify-end">
            <button :disabled="savingPassword || passwordMismatch" class="focus-ring h-10 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] transition hover:opacity-85 disabled:opacity-50">
              {{ savingPassword ? 'Saving…' : 'Change password' }}
            </button>
          </div>
        </form>
      </section>
    </main>
    <UiToastHost :notice="notice" @close="closeNotice" />
  </div>
</template>
