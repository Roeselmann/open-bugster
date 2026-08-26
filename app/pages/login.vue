<script setup lang="ts">
import { ArrowRight, Bug, LockKeyhole } from '@lucide/vue'

const form = reactive({ username: '', password: '' })
const loading = ref(false)
const errorMessage = ref('')

async function login() {
  loading.value = true
  errorMessage.value = ''
  try {
    await $fetch('/api/auth/login', { method: 'POST', body: form })
    await useUserSession().fetch()
    await navigateTo('/')
  } catch (error: any) {
    errorMessage.value = error?.data?.statusMessage || 'Sign-in failed.'
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
        <div class="mb-7">
          <span class="mb-4 grid size-10 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]"><LockKeyhole :size="19" /></span>
          <h2 class="text-2xl font-bold tracking-[-.04em]">Welcome back</h2>
          <p class="muted mt-2 text-sm leading-relaxed">Sign in to prioritize tickets and import new TestFlight feedback.</p>
        </div>

        <form class="space-y-4" @submit.prevent="login">
          <label class="block"><span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Username</span><input v-model="form.username" required autocomplete="username" class="focus-ring h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3.5 outline-none" placeholder="admin"></label>
          <label class="block"><span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Password</span><input v-model="form.password" required type="password" autocomplete="current-password" class="focus-ring h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3.5 outline-none" placeholder="••••••••••••"></label>
          <p v-if="errorMessage" role="alert" class="rounded-xl bg-rose-500/10 px-3 py-2.5 text-sm font-medium text-rose-600">{{ errorMessage }}</p>
          <button :disabled="loading" class="focus-ring flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--ink)] font-semibold text-[var(--canvas)] transition hover:opacity-85 disabled:opacity-50">
            {{ loading ? 'Signing in…' : 'Sign in' }} <ArrowRight v-if="!loading" :size="17" />
          </button>
        </form>
      </div>
      <p class="muted mt-5 text-center text-[11px]">Your credentials and Apple key remain on your server.</p>
    </section>
  </main>
</template>
