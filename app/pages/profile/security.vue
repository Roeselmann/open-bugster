<script setup lang="ts">
import { KeyRound } from '@lucide/vue'

const { notify } = useNotify()
const session = useUserSession()

const passwords = reactive({ currentPassword: '', newPassword: '', repeatPassword: '' })
const saving = ref(false)
const passwordMismatch = computed(() => Boolean(passwords.repeatPassword) && passwords.newPassword !== passwords.repeatPassword)

async function savePassword() {
  if (passwordMismatch.value) return
  saving.value = true
  try {
    await $fetch('/api/profile/password', {
      method: 'POST',
      body: { currentPassword: passwords.currentPassword, newPassword: passwords.newPassword },
    })
    passwords.currentPassword = ''
    passwords.newPassword = ''
    passwords.repeatPassword = ''
    // The session version moved, so this device needs the new cookie or it signs itself out.
    await session.fetch()
    notify('success', 'Your password was changed. Other devices have been signed out.')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="surface rounded-2xl">
    <header class="border-b border-[var(--line)] px-5 py-4">
      <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Security</p>
      <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold"><KeyRound :size="18" aria-hidden="true" /> Password</h2>
      <p class="muted mt-1 text-sm">
        Changing it signs you out everywhere else. API tokens keep working — revoke those
        under <NuxtLink to="/profile/integrations" class="focus-ring rounded font-semibold underline underline-offset-2">Integrations</NuxtLink>.
      </p>
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
        <button :disabled="saving || passwordMismatch" class="focus-ring h-10 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] transition hover:opacity-85 disabled:opacity-50">
          {{ saving ? 'Saving…' : 'Change password' }}
        </button>
      </div>
    </form>
  </section>
</template>
