<script setup lang="ts">
import { KeyRound, UserRound } from '@lucide/vue'

const { user } = useAuth()
const { notice, notify, closeNotice } = useNotify()
const session = useUserSession()

const profile = reactive({ firstName: '', lastName: '' })
watchEffect(() => {
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
        <p class="muted mt-1 text-sm">{{ user?.email }} — the address every ticket, comment and import is matched against.</p>
      </div>

      <section class="surface rounded-2xl">
        <header class="border-b border-[var(--line)] px-5 py-4">
          <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Account</p>
          <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold"><UserRound :size="18" aria-hidden="true" /> Name</h2>
          <p class="muted mt-1 text-sm">Shown on the tickets you create and the comments you write, everywhere at once.</p>
        </header>
        <form class="space-y-4 px-5 py-5" @submit.prevent="saveProfile">
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
              {{ savingProfile ? 'Saving…' : 'Save name' }}
            </button>
          </div>
        </form>
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
