<script setup lang="ts">
import { Archive, Bug, Layers, LogOut, Moon, Sun, User, Users } from '@lucide/vue'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'reka-ui'

const props = withDefaults(defineProps<{
  boardId?: string
  archiveMode?: boolean
  /** The archive is a board administrator's view, so the way into it is theirs too. */
  canViewArchive?: boolean
}>(), { boardId: '', archiveMode: false, canViewArchive: true })

const { isDark, toggle } = useTheme()
const { user, instanceAdmin, logout } = useAuth()
const { workspaceId } = useCurrentWorkspace()

// Board-less pages (profile, user administration) mount the same header.
const home = computed(() => (props.boardId ? `/b/${props.boardId}` : '/'))
</script>

<template>
  <header class="border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--panel)_88%,transparent)] backdrop-blur-xl">
    <div class="mx-auto flex min-h-18 max-w-[1800px] items-center gap-3 px-4 sm:px-6">
      <!-- The wrapper takes all free space (keeping the icons right even when the workspace
           switcher inside renders nothing) and passes it down, so the switcher can lay a
           description into the room the workspace name leaves over. -->
      <div class="flex min-w-0 flex-1 items-center gap-1">
        <NuxtLink :to="home" class="focus-ring flex shrink-0 items-center gap-3 rounded-xl" aria-label="Open-Bugster board">
          <span class="grid size-10 place-items-center rounded-xl bg-[var(--ink)] text-[var(--canvas)] shadow-sm">
            <Bug :size="20" :stroke-width="2.2" />
          </span>
          <span class="text-[15px] font-bold tracking-[-0.02em]">Open-Bugster</span>
        </NuxtLink>
        <WorkspaceSwitcher />
      </div>

      <NuxtLink
        v-if="boardId && (archiveMode || canViewArchive)"
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
            <!-- The way in while the switcher is hidden — the second workspace is created here. -->
            <DropdownMenuItem
              v-if="instanceAdmin && workspaceId"
              class="flex h-10 cursor-default select-none items-center gap-2 rounded-lg px-3 text-sm outline-none data-[highlighted]:bg-[var(--accent-soft)]"
              @select="navigateTo(`/w/${workspaceId}/settings`)"
            >
              <Layers :size="15" aria-hidden="true" /> Workspaces
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
