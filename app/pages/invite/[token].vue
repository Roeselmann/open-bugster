<script setup lang="ts">
import { ArrowRight, Bug, UserPlus } from '@lucide/vue'

const route = useRoute()
const token = computed(() => String(route.params.token || ''))

const { data, error } = await useFetch<{ invite: { email: string; firstName: string; lastName: string } }>(`/api/invite/${token.value}`)

const form = reactive({ password: '', repeat: '' })
const loading = ref(false)
const errorMessage = ref('')
const mismatch = computed(() => Boolean(form.repeat) && form.password !== form.repeat)

async function accept() {
  if (mismatch.value) return
  loading.value = true
  errorMessage.value = ''
  try {
    await $fetch(`/api/invite/${token.value}`, { method: 'POST', body: { password: form.password } })
    await useUserSession().fetch()
    await navigateTo('/')
  } catch (accepted) {
    errorMessage.value = errorText(accepted)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="relative grid min-h-screen place-items-center overflow-hidden px-5 py-10">
    <div class="pointer-events-none absolute -left-24 -top-24 size-96 rounded-full bg-[var(--accent)] opacity-[.09] blur-3xl" />
    <div class="pointer-events-none absolute -bottom-32 -right-28 size-[28rem] rounded-full bg-amber-400 opacity-[.08] blur-3xl" />

    <section class="relative w-full max-w-[430px]">
      <div class="mb-8 flex items-center gap-3">
        <span class="grid size-11 place-items-center rounded-2xl bg-[var(--ink)] text-[var(--canvas)]"><Bug :size="22" /></span>
        <div><h1 class="text-xl font-bold tracking-[-.03em]">Open-Bugster</h1><p class="muted text-xs">Your TestFlight triage board</p></div>
      </div>

      <div class="surface-strong rounded-[28px] p-6 shadow-2xl shadow-black/5 sm:p-8">
        <div v-if="error" class="text-center">
          <h2 class="text-2xl font-bold tracking-[-.04em]">This link no longer works</h2>
          <p class="muted mt-2 text-sm leading-relaxed">Invitations expire after seven days and can only be used once. Ask an administrator for a fresh one.</p>
          <NuxtLink to="/login" class="focus-ring mt-6 inline-flex h-12 w-full items-center justify-center rounded-xl bg-[var(--ink)] font-semibold text-[var(--canvas)] transition hover:opacity-85">Back to sign-in</NuxtLink>
        </div>

        <template v-else>
          <div class="mb-7">
            <span class="mb-4 grid size-10 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]"><UserPlus :size="19" /></span>
            <h2 class="text-2xl font-bold tracking-[-.04em]">Welcome, {{ data?.invite.firstName }}</h2>
            <p class="muted mt-2 text-sm leading-relaxed">Choose a password for <strong class="font-semibold text-[var(--ink)]">{{ data?.invite.email }}</strong> to finish setting up your account.</p>
          </div>

          <form class="space-y-4" @submit.prevent="accept">
            <label class="block">
              <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Password</span>
              <input v-model="form.password" required type="password" minlength="12" autocomplete="new-password" class="focus-ring h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3.5 outline-none" placeholder="At least 12 characters">
            </label>
            <label class="block">
              <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Repeat password</span>
              <input v-model="form.repeat" required type="password" autocomplete="new-password" class="focus-ring h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3.5 outline-none" placeholder="••••••••••••">
            </label>
            <p v-if="mismatch" class="text-sm font-medium text-rose-600">The two entries do not match.</p>
            <p v-if="errorMessage" role="alert" class="rounded-xl bg-rose-500/10 px-3 py-2.5 text-sm font-medium text-rose-600">{{ errorMessage }}</p>
            <button :disabled="loading || mismatch" class="focus-ring flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--ink)] font-semibold text-[var(--canvas)] transition hover:opacity-85 disabled:opacity-50">
              {{ loading ? 'Setting up…' : 'Create account' }} <ArrowRight v-if="!loading" :size="17" />
            </button>
          </form>
        </template>
      </div>
      <p class="muted mt-5 text-center text-[11px]">Your credentials and Apple key remain on your server.</p>
    </section>
  </main>
</template>
