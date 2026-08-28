<script setup lang="ts">
import { Archive, Bug, LogOut, Moon, RefreshCcw, Sun, User, Users } from '@lucide/vue'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'reka-ui'
import type { SyncRun } from '~~/shared/types/domain'

const props = withDefaults(defineProps<{
  boardId?: string
  syncing?: boolean
  latestRun?: SyncRun | null
  archiveMode?: boolean
  /** Importing writes tickets, so viewers are not offered it. */
  canSync?: boolean
}>(), { boardId: '', syncing: false, latestRun: null, archiveMode: false, canSync: true })
const emit = defineEmits<{ sync: [] }>()

const { isDark, toggle } = useTheme()
const { user, instanceAdmin, logout } = useAuth()

// Board-less pages (profile, user administration) mount the same header.
const home = computed(() => (props.boardId ? `/b/${props.boardId}` : '/'))
const showBoardActions = computed(() => Boolean(props.boardId) && !props.archiveMode && props.canSync)

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
      <NuxtLink :to="home" class="focus-ring mr-auto flex items-center gap-3 rounded-xl" aria-label="Open-Bugster board">
        <span class="grid size-10 place-items-center rounded-xl bg-[var(--ink)] text-[var(--canvas)] shadow-sm">
          <Bug :size="20" :stroke-width="2.2" />
        </span>
        <span>
          <span class="block text-[15px] font-bold tracking-[-0.02em]">Open-Bugster</span>
          <span class="muted hidden text-[11px] font-medium tracking-wide sm:block">TESTFLIGHT TRIAGE</span>
        </span>
      </NuxtLink>

      <div v-if="showBoardActions" class="muted hidden items-center gap-2 rounded-full border border-[var(--line)] px-3 py-1.5 text-xs lg:flex">
        <span class="size-1.5 rounded-full" :class="latestRun?.status === 'failed' ? 'bg-rose-500' : 'bg-emerald-500'" />
        {{ syncLabel(latestRun) }}
      </div>

      <NuxtLink
        v-if="boardId"
        :to="archiveMode ? `/b/${boardId}` : `/b/${boardId}/archive`"
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
      <button v-if="showBoardActions" class="focus-ring hidden h-10 items-center gap-2 rounded-xl border border-[var(--line)] px-3.5 text-sm font-semibold transition hover:bg-[var(--panel-strong)] sm:flex" :disabled="syncing" @click="emit('sync')">
        <RefreshCcw :size="16" :class="syncing ? 'animate-spin' : ''" />
        <span>{{ syncing ? 'Syncing…' : 'TestFlight Sync' }}</span>
      </button>

      <DropdownMenuRoot v-if="user">
        <DropdownMenuTrigger class="focus-ring rounded-full" :aria-label="`Account menu for ${displayName(user)}`">
          <UiAvatar :person="user" size="lg" />
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            align="end"
            :side-offset="6"
            class="ui-popover z-[100] min-w-64 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel-strong)] p-1 text-[var(--ink)] shadow-[0_18px_45px_rgba(0,0,0,.16),0_3px_12px_rgba(0,0,0,.08)]"
          >
            <div class="px-3 py-2">
              <p class="truncate text-sm font-bold">{{ displayName(user) }}</p>
              <p class="muted truncate text-xs">{{ user.email }}</p>
            </div>
            <DropdownMenuSeparator class="my-1 h-px bg-[var(--line)]" />
            <DropdownMenuItem
              class="flex h-10 cursor-default select-none items-center gap-2 rounded-lg px-3 text-sm outline-none data-[highlighted]:bg-[var(--accent-soft)]"
              @select="navigateTo('/profile')"
            >
              <User :size="15" aria-hidden="true" /> Your profile
            </DropdownMenuItem>
            <DropdownMenuItem
              v-if="instanceAdmin"
              class="flex h-10 cursor-default select-none items-center gap-2 rounded-lg px-3 text-sm outline-none data-[highlighted]:bg-[var(--accent-soft)]"
              @select="navigateTo('/admin/users')"
            >
              <Users :size="15" aria-hidden="true" /> Users
            </DropdownMenuItem>
            <DropdownMenuSeparator class="my-1 h-px bg-[var(--line)]" />
            <DropdownMenuItem
              class="flex h-10 cursor-default select-none items-center gap-2 rounded-lg px-3 text-sm font-semibold text-rose-600 outline-none data-[highlighted]:bg-rose-500/10"
              @select="logout()"
            >
              <LogOut :size="15" aria-hidden="true" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>
    </div>
  </header>
</template>
