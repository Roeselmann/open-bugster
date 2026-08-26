<script setup lang="ts">
import { Archive, Bug, LogOut, Moon, Plus, RefreshCcw, Sun } from '@lucide/vue'
import type { SyncRun } from '~~/shared/types/domain'

defineProps<{ syncing: boolean; latestRun: SyncRun | null; archiveMode?: boolean }>()
const emit = defineEmits<{ newTicket: []; sync: []; logout: [] }>()
const { isDark, toggle } = useTheme()

function syncLabel(run: SyncRun | null) {
  if (!run) return 'Not synced yet'
  if (run.status === 'running') return 'Sync in progress'
  const date = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(run.finishedAt || run.startedAt))
  return run.status === 'failed' ? `Error · ${date}` : `${run.importedCount} new · ${date}`
}
</script>

<template>
  <header class="border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--panel)_88%,transparent)] backdrop-blur-xl">
    <div class="mx-auto flex min-h-18 max-w-[1800px] items-center gap-3 px-4 sm:px-6">
      <NuxtLink to="/" class="focus-ring mr-auto flex items-center gap-3 rounded-xl" aria-label="Open-Bugster board">
        <span class="grid size-10 place-items-center rounded-xl bg-[var(--ink)] text-[var(--canvas)] shadow-sm">
          <Bug :size="20" :stroke-width="2.2" />
        </span>
        <span>
          <span class="block text-[15px] font-bold tracking-[-0.02em]">Open-Bugster</span>
          <span class="muted hidden text-[11px] font-medium tracking-wide sm:block">TESTFLIGHT TRIAGE</span>
        </span>
      </NuxtLink>

      <div v-if="!archiveMode" class="muted hidden items-center gap-2 rounded-full border border-[var(--line)] px-3 py-1.5 text-xs lg:flex">
        <span class="size-1.5 rounded-full" :class="latestRun?.status === 'failed' ? 'bg-rose-500' : 'bg-emerald-500'" />
        {{ syncLabel(latestRun) }}
      </div>

      <NuxtLink
        :to="archiveMode ? '/' : '/archive'"
        class="focus-ring grid size-10 place-items-center rounded-xl border border-[var(--line)] transition hover:bg-[var(--panel-strong)]"
        :aria-label="archiveMode ? 'Back to board' : 'Open archive'"
        :title="archiveMode ? 'Board' : 'Archive'"
      >
        <Archive :size="18" />
      </NuxtLink>
      <button class="focus-ring grid size-10 place-items-center rounded-xl border border-[var(--line)] transition hover:bg-[var(--panel-strong)]" aria-label="Toggle color scheme" @click="toggle">
        <Sun v-if="isDark" :size="18" />
        <Moon v-else :size="18" />
      </button>
      <button v-if="!archiveMode" class="focus-ring hidden h-10 items-center gap-2 rounded-xl border border-[var(--line)] px-3.5 text-sm font-semibold transition hover:bg-[var(--panel-strong)] sm:flex" :disabled="syncing" @click="emit('sync')">
        <RefreshCcw :size="16" :class="syncing ? 'animate-spin' : ''" />
        <span>{{ syncing ? 'Syncing…' : 'TestFlight Sync' }}</span>
      </button>
      <button v-if="!archiveMode" class="focus-ring flex h-10 items-center gap-2 rounded-xl bg-[var(--ink)] px-3.5 text-sm font-semibold text-[var(--canvas)] transition hover:opacity-85" @click="emit('newTicket')">
        <Plus :size="17" />
        <span class="hidden sm:inline">New ticket</span>
      </button>
      <button class="focus-ring grid size-10 place-items-center rounded-xl text-[var(--muted)] transition hover:bg-[var(--panel-strong)] hover:text-[var(--ink)]" aria-label="Sign out" @click="emit('logout')">
        <LogOut :size="18" />
      </button>
    </div>
  </header>
</template>
