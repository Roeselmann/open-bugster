<script setup lang="ts">
import { UserRound } from '@lucide/vue'

const { user } = useAuth()
const { notify } = useNotify()
const session = useUserSession()

const profile = reactive({ email: '', firstName: '', lastName: '' })
watchEffect(() => {
  profile.email = user.value?.email || ''
  profile.firstName = user.value?.firstName || ''
  profile.lastName = user.value?.lastName || ''
})

const saving = ref(false)
async function saveProfile() {
  saving.value = true
  try {
    await $fetch('/api/profile', { method: 'PATCH', body: { ...profile } })
    // The cookie carries the display name and the address, so it has to be refreshed
    // alongside the row or the header keeps showing the old one.
    await session.fetch()
    notify('success', 'Your profile was saved.')
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
        <button :disabled="saving" class="focus-ring h-10 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] transition hover:opacity-85 disabled:opacity-50">
          {{ saving ? 'Saving…' : 'Save profile' }}
        </button>
      </div>
    </form>
  </section>
</template>
