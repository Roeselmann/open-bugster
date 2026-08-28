<script setup lang="ts">
import { Check, Copy, KeyRound, Link2, Link2Off, Trash2, UserRoundX } from '@lucide/vue'
import type { BoardRole, UserAccount, UserRole, UserStatus } from '~~/shared/types/domain'

const { user: currentUser, instanceAdmin } = useAuth()
const { notice, notify, closeNotice } = useNotify()

// The account menu only offers this page to administrators; a typed-in URL still has to bounce.
watchEffect(() => { if (currentUser.value && !instanceAdmin.value) navigateTo('/') })

const { data, refresh } = await useFetch<{ users: UserAccount[] }>('/api/users')
const users = computed(() => data.value?.users || [])

const roleOptions = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Administrator' },
]
const statusLabels: Record<UserStatus, string> = { invited: 'Invitation pending', active: 'Active', disabled: 'Disabled' }
const boardRoleLabels: Record<BoardRole, string> = { viewer: 'Viewer', editor: 'Editor', admin: 'Administrator' }

const DAY = 24 * 60 * 60 * 1000

/**
 * A pending account says nothing useful on its own: an invitation that lapsed three weeks
 * ago looks exactly like one sent this morning. Report what the link is actually doing.
 */
function accountState(account: UserAccount): string {
  const noun = account.status === 'invited' ? 'Invitation' : 'Password link'
  if (account.status !== 'invited' && !account.inviteExpiresAt) return statusLabels[account.status]
  if (!account.inviteExpiresAt) return 'No invitation link'
  const remaining = Date.parse(account.inviteExpiresAt) - Date.now()
  if (!Number.isFinite(remaining) || remaining <= 0) return `${noun} expired`
  const days = Math.ceil(remaining / DAY)
  const validity = days <= 1 ? 'expires today' : `expires in ${days} days`
  // An outstanding reset says nothing about whether the account still works, so on an
  // account that has a password the status has to be named alongside it.
  return account.status === 'invited' ? `${noun} ${validity}` : `${statusLabels[account.status]} · ${noun} ${validity}`
}

/**
 * Who can be handed a link. It sets a password and signs the holder in, which is why a
 * disabled account is left out, and why an administrator cannot issue one for the owner —
 * the owner recovers with `npm run owner:reset` on the server. Your own password is
 * changed under Your profile, so your row does not offer it either.
 */
function canIssueLink(account: UserAccount): boolean {
  if (account.anonymizedAt || account.status === 'disabled') return false
  return account.role !== 'owner' && account.id !== currentUser.value?.id
}

const invite = reactive({ email: '', firstName: '', lastName: '', role: 'member' as UserRole })
const inviting = ref(false)
const pendingLink = ref<{ userId: string; url: string } | null>(null)
const copied = ref(false)
const busyId = ref('')
/** Erasing keeps the person's history readable as one person's; removing does not. */
const confirmation = ref<{ account: UserAccount; kind: 'delete' | 'anonymize' } | null>(null)
const confirmationPending = ref(false)

const confirmationCopy = computed(() => {
  const pending = confirmation.value
  if (!pending) return null
  return pending.kind === 'anonymize'
    ? {
        title: `Anonymize ${displayName(pending.account)}?`,
        description: 'Their name and email address are erased everywhere, including inside the ticket history. Everything they filed, wrote and were assigned stays on the boards, still recognisable as one person, and they can no longer sign in. This cannot be undone.',
        confirmLabel: 'Anonymize account',
      }
    : {
        title: `Remove ${displayName(pending.account)}?`,
        description: 'The account is deleted outright. Their tickets, comments and history stay on the boards but lose the person behind them — to keep that link, anonymize instead.',
        confirmLabel: 'Remove account',
      }
})

const dateFormat = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' })

/**
 * The link belongs to one account, so it is shown on that account's row. A freshly created
 * one can land anywhere in the alphabetical list, hence the scroll.
 */
function showLink(userId: string, url: string) {
  pendingLink.value = { userId, url }
  copied.value = false
  nextTick(() => document.querySelector('[data-invite-link]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
}

async function createUser() {
  inviting.value = true
  try {
    const response = await $fetch<{ user: UserAccount; inviteUrl: string }>('/api/users', { method: 'POST', body: { ...invite } })
    invite.email = ''
    invite.firstName = ''
    invite.lastName = ''
    invite.role = 'member'
    // The new row has to exist before the link can be shown under it and scrolled to.
    await refresh()
    showLink(response.user.id, response.inviteUrl)
    notify('success', 'The account was created. Copy the invitation link below.')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    inviting.value = false
  }
}

async function regenerateInvite(account: UserAccount) {
  busyId.value = account.id
  try {
    const response = await $fetch<{ inviteUrl: string; purpose: 'invite' | 'reset' }>(`/api/users/${account.id}/invite`, { method: 'POST' })
    // Before showing the link, so the row reports the new expiry rather than the old state.
    await refresh()
    showLink(account.id, response.inviteUrl)
    notify('success', response.purpose === 'reset'
      ? `A password link for ${account.email} was generated. Pass it on and they can set a new one.`
      : 'A fresh invitation link was generated.')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    busyId.value = ''
  }
}

async function revokeInvite(account: UserAccount) {
  busyId.value = account.id
  try {
    await $fetch(`/api/users/${account.id}/invite`, { method: 'DELETE' })
    if (pendingLink.value?.userId === account.id) pendingLink.value = null
    await refresh()
    notify('success', `The link for ${account.email} no longer works.`)
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    busyId.value = ''
  }
}

async function patchUser(account: UserAccount, body: { role?: UserRole; status?: UserStatus }) {
  busyId.value = account.id
  try {
    await $fetch(`/api/users/${account.id}`, { method: 'PATCH', body })
    await refresh()
    notify('success', 'The account was updated.')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    busyId.value = ''
  }
}

async function confirmRemoval() {
  const pending = confirmation.value
  if (!pending) return
  const name = displayName(pending.account)
  confirmationPending.value = true
  try {
    if (pending.kind === 'anonymize') await $fetch(`/api/users/${pending.account.id}/anonymize`, { method: 'POST' })
    else await $fetch(`/api/users/${pending.account.id}`, { method: 'DELETE' })
    await refresh()
    confirmation.value = null
    notify('success', pending.kind === 'anonymize' ? `${name} was anonymized.` : `${name} was removed.`)
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    confirmationPending.value = false
  }
}

async function copyLink() {
  if (!pendingLink.value) return
  try {
    await navigator.clipboard.writeText(pendingLink.value.url)
    copied.value = true
    return
  } catch {
    // The clipboard API is only available in a secure context, and a self-hosted instance
    // reached over plain http on the local network is not one. Fall through.
  }

  const field = document.querySelector<HTMLInputElement>('[data-invite-link] input')
  if (field) {
    field.focus()
    field.select()
    if (document.execCommand('copy')) {
      copied.value = true
      return
    }
  }
  notify('error', 'The link could not be copied automatically—it is selected, so press ⌘C or Ctrl+C.')
}
</script>

<template>
  <div class="min-h-screen">
    <AppHeader />
    <main class="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <h1 class="text-3xl font-bold tracking-[-.045em]">Users</h1>
        <p class="muted mt-1 text-sm">
          Accounts are identified by email address. Adding one also picks up every ticket and
          TestFlight report that address had already left behind.
        </p>
      </div>

      <section class="surface rounded-2xl">
        <header class="border-b border-[var(--line)] px-5 py-4">
          <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Instance</p>
          <h2 class="mt-0.5 text-lg font-bold">Accounts</h2>
          <p class="muted mt-1 text-sm">Administrators manage users and see every board. Members only see the boards they are on.</p>
        </header>

        <ul class="divide-y divide-[var(--line)]">
          <li v-for="account in users" :key="account.id" class="px-5 py-4">
            <div class="flex flex-wrap items-center gap-3">
            <UiAvatar :person="account" size="lg" :muted="account.status !== 'active'" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold">
                {{ displayName(account) }}
                <span v-if="account.id === currentUser?.id" class="muted font-normal">· you</span>
              </p>
              <p class="muted truncate text-xs">{{ account.email || 'Anonymized — no address' }}</p>
              <p class="muted mt-0.5 text-[11px]">
                {{ accountState(account) }} ·
                {{ account.lastLoginAt ? `last seen ${dateFormat.format(new Date(account.lastLoginAt))}` : 'never signed in' }}
              </p>
              <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span
                  v-for="membership in account.boards"
                  :key="membership.boardId"
                  class="tone tone-neutral rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  :title="`${boardRoleLabels[membership.role]} on ${membership.boardName}`"
                >
                  {{ membership.boardName }}
                  <span class="font-normal opacity-70">· {{ boardRoleLabels[membership.role] }}</span>
                </span>
                <!--
                  A membership row is not the whole truth for an administrator: the instance
                  role outranks it and opens every board, so it has to be said next to the list.
                -->
                <span v-if="account.role !== 'member'" class="muted text-[11px]">
                  {{ account.boards.length ? 'and every other board as an instance administrator' : 'Every board, as an instance administrator' }}
                </span>
                <span v-else-if="!account.boards.length" class="muted text-[11px]">On no board yet</span>
              </div>
            </div>

            <span v-if="account.role === 'owner'" class="tone tone-violet rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide">Owner</span>
            <span v-else-if="account.anonymizedAt" class="surface-strong rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide">Anonymized</span>
            <div v-else class="w-40 shrink-0">
              <UiSelect
                :model-value="account.role"
                :options="roleOptions"
                :disabled="busyId === account.id || account.id === currentUser?.id"
                compact
                :aria-label="`Role of ${displayName(account)}`"
                @update:model-value="value => patchUser(account, { role: value as UserRole })"
              />
            </div>

            <button
              v-if="canIssueLink(account)"
              class="focus-ring flex h-8 items-center gap-1.5 rounded-lg border border-[var(--line)] px-2.5 text-xs font-semibold transition hover:bg-[var(--panel-strong)]"
              :disabled="busyId === account.id"
              :title="account.status === 'invited'
                ? `Replace the invitation link for ${account.email}`
                : `Generate a link that lets ${displayName(account)} set a new password`"
              @click="regenerateInvite(account)"
            >
              <component :is="account.status === 'invited' ? Link2 : KeyRound" :size="14" aria-hidden="true" />
              {{ account.status === 'invited' ? 'New link' : 'Reset password' }}
            </button>
            <button
              v-if="account.inviteExpiresAt && !account.anonymizedAt"
              class="focus-ring flex h-8 items-center gap-1.5 rounded-lg border border-[var(--line)] px-2.5 text-xs font-semibold transition hover:bg-[var(--panel-strong)]"
              :disabled="busyId === account.id"
              :title="`Stop the current link for ${account.email} from working`"
              @click="revokeInvite(account)"
            >
              <Link2Off :size="14" aria-hidden="true" /> Revoke
            </button>
            <button
              v-if="account.status !== 'invited' && account.role !== 'owner' && account.id !== currentUser?.id && !account.anonymizedAt"
              class="focus-ring h-8 rounded-lg border border-[var(--line)] px-2.5 text-xs font-semibold transition hover:bg-[var(--panel-strong)]"
              :disabled="busyId === account.id"
              @click="patchUser(account, { status: account.status === 'disabled' ? 'active' : 'disabled' })"
            >
              {{ account.status === 'disabled' ? 'Enable' : 'Disable' }}
            </button>

            <button
              v-if="account.role !== 'owner' && account.id !== currentUser?.id && !account.anonymizedAt"
              class="focus-ring grid size-8 place-items-center rounded-lg transition hover:bg-[var(--panel-strong)]"
              :aria-label="`Anonymize ${displayName(account)}`"
              title="Erase the person, keep everything they did"
              @click="confirmation = { account, kind: 'anonymize' }"
            >
              <UserRoundX :size="15" />
            </button>
            <button
              v-if="account.role !== 'owner' && account.id !== currentUser?.id"
              class="focus-ring grid size-8 place-items-center rounded-lg text-rose-600 transition hover:bg-rose-500/10"
              :aria-label="`Remove ${displayName(account)}`"
              @click="confirmation = { account, kind: 'delete' }"
            >
              <Trash2 :size="15" />
            </button>
            </div>

            <div
              v-if="pendingLink?.userId === account.id"
              data-invite-link
              class="mt-3 rounded-xl border border-[color-mix(in_srgb,var(--accent)_35%,var(--line))] bg-[var(--accent-soft)] px-3.5 py-3"
            >
              <p class="text-[10px] font-bold uppercase tracking-[.14em] text-[var(--accent)]">
                {{ account.status === 'invited' ? 'Invitation link' : 'Password link' }}
              </p>
              <p class="muted mt-0.5 text-xs">
                Valid for seven days and usable once—Open-Bugster sends no mail, so pass it on yourself.
                Hiding this does not revoke the link, and it cannot be shown again.
                <template v-if="account.status !== 'invited'">Using it replaces the old password and signs out every open session.</template>
              </p>
              <div class="mt-2.5 flex flex-wrap items-center gap-2">
                <input :value="pendingLink.url" readonly class="focus-ring surface-strong h-10 min-w-56 flex-1 rounded-lg px-2.5 font-mono text-xs outline-none" :aria-label="`Link for ${account.email}`">
                <button type="button" class="focus-ring flex h-10 items-center gap-2 rounded-lg bg-[var(--ink)] px-3.5 text-sm font-semibold text-[var(--canvas)] transition hover:opacity-85" @click="copyLink">
                  <component :is="copied ? Check : Copy" :size="15" aria-hidden="true" />
                  {{ copied ? 'Copied' : 'Copy' }}
                </button>
                <button type="button" class="focus-ring h-10 rounded-lg border border-[var(--line)] px-3.5 text-sm font-semibold transition hover:bg-[var(--panel-strong)]" @click="pendingLink = null">Hide</button>
              </div>
            </div>
          </li>
        </ul>

        <form class="flex flex-wrap items-end gap-3 border-t border-[var(--line)] px-5 py-4" @submit.prevent="createUser">
          <label class="min-w-56 flex-1">
            <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Email</span>
            <input v-model="invite.email" required type="email" maxlength="160" placeholder="teammate@example.com" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
          </label>
          <label class="min-w-32 flex-1">
            <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">First name</span>
            <input v-model="invite.firstName" required maxlength="60" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
          </label>
          <label class="min-w-32 flex-1">
            <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Last name</span>
            <input v-model="invite.lastName" maxlength="60" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
          </label>
          <div class="w-40 shrink-0">
            <UiSelect v-model="invite.role" :options="roleOptions" aria-label="Role of the new account" />
          </div>
          <button :disabled="inviting" class="focus-ring h-11 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] transition hover:opacity-85 disabled:opacity-50">
            {{ inviting ? 'Creating…' : 'Create account' }}
          </button>
        </form>
      </section>
    </main>

    <UiConfirmDialog
      v-if="confirmationCopy"
      :open="true"
      :title="confirmationCopy.title"
      :description="confirmationCopy.description"
      :confirm-label="confirmationCopy.confirmLabel"
      :pending="confirmationPending"
      @update:open="open => !open && (confirmation = null)"
      @confirm="confirmRemoval"
    />
    <UiToastHost :notice="notice" @close="closeNotice" />
  </div>
</template>
