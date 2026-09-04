<script setup lang="ts">
import { Archive, Bug, Check, Layers, LogOut, Menu, Moon, Settings2, Sun, User, Users } from '@lucide/vue'
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  VisuallyHidden,
} from 'reka-ui'
import type { WorkspaceSummary } from '~~/shared/types/domain'

const props = withDefaults(defineProps<{
  boardId?: string
  archiveMode?: boolean
  /** The archive is a board administrator's view, so the way into it is theirs too. */
  canViewArchive?: boolean
}>(), { boardId: '', archiveMode: false, canViewArchive: true })

const { isDark, toggle } = useTheme()
const { user, instanceAdmin, logout } = useAuth()
const { workspaceId, workspace } = useCurrentWorkspace()
const { workspaces } = useWorkspaces()
const { boards } = useBoards()
const lastWorkspaceId = useLastWorkspaceId()
const lastBoardId = useLastBoardId()

// Board-less pages (profile, user administration) mount the same header.
const home = computed(() => (props.boardId ? `/b/${props.boardId}` : '/'))
const showArchiveLink = computed(() => Boolean(props.boardId) && (props.archiveMode || props.canViewArchive))

// Below `md` everything but the title folds into this sheet.
const menuOpen = ref(false)
const route = useRoute()
watch(() => route.fullPath, () => { menuOpen.value = false })

function closeMenu() {
  menuOpen.value = false
}

// Same rule as WorkspaceSwitcher: the remembered board if it lives here, else the first.
function openWorkspace(item: WorkspaceSummary) {
  lastWorkspaceId.value = item.id
  const inWorkspace = boards.value.filter(board => board.workspaceId === item.id)
  const target = inWorkspace.find(board => board.id === lastBoardId.value) || inWorkspace[0]
  closeMenu()
  return navigateTo(target ? `/b/${target.id}` : '/')
}
</script>

<template>
  <header class="border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--panel)_88%,transparent)] backdrop-blur-xl">
    <div class="mx-auto hidden min-h-18 max-w-[1800px] items-center gap-3 px-6 md:flex">
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
        v-if="showArchiveLink"
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
            <DropdownMenuSeparator v-if="instanceAdmin" class="my-1 h-px bg-[var(--line)]" />
            <DropdownMenuLabel v-if="instanceAdmin" class="muted px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[.14em]">Administration</DropdownMenuLabel>
            <DropdownMenuItem
              v-if="instanceAdmin"
              class="flex h-10 cursor-default select-none items-center gap-2 rounded-lg px-3 text-sm outline-none data-[highlighted]:bg-[var(--accent-soft)]"
              @select="navigateTo('/admin/users')"
            >
              <Users :size="15" aria-hidden="true" /> Users
            </DropdownMenuItem>
            <!-- Instance level: every workspace of the server. The current workspace's own
                 settings live with the switcher, next to its name. -->
            <DropdownMenuItem
              v-if="instanceAdmin"
              class="flex h-10 cursor-default select-none items-center gap-2 rounded-lg px-3 text-sm outline-none data-[highlighted]:bg-[var(--accent-soft)]"
              @select="navigateTo('/admin/workspaces')"
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

    <!-- Phone: logo, the page's title, its quick actions (search, filter) and the burger. -->
    <div class="flex min-h-14 items-center gap-2 px-3 md:hidden">
      <NuxtLink :to="home" class="focus-ring grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--ink)] text-[var(--canvas)] shadow-sm" aria-label="Open-Bugster board">
        <Bug :size="18" :stroke-width="2.2" />
      </NuxtLink>
      <div class="min-w-0 flex-1">
        <slot name="title">
          <span class="block truncate text-[15px] font-bold tracking-[-0.02em]">{{ workspace?.name || 'Open-Bugster' }}</span>
        </slot>
      </div>
      <slot name="actions" />
      <button
        type="button"
        class="focus-ring grid size-10 shrink-0 place-items-center rounded-xl border border-[var(--line)] transition hover:bg-[var(--panel-strong)]"
        aria-label="Open menu"
        @click="menuOpen = true"
      >
        <Menu :size="18" />
      </button>
    </div>

    <DialogRoot :open="menuOpen" @update:open="menuOpen = $event">
      <DialogPortal>
        <DialogOverlay class="ui-dialog-overlay fixed inset-0 z-[70] bg-black/35 backdrop-blur-[2px]" />
        <DialogContent
          class="ui-sheet-content fixed inset-x-0 bottom-0 z-[71] max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t border-[var(--line)] bg-[var(--panel-strong)] px-2 pt-2 pb-[max(.5rem,env(safe-area-inset-bottom))] text-[var(--ink)] shadow-[0_-18px_45px_rgba(0,0,0,.16)]"
          aria-label="Menu"
          @open-auto-focus.prevent
        >
          <VisuallyHidden>
            <DialogTitle>Menu</DialogTitle>
            <DialogDescription>Boards, filters and your account.</DialogDescription>
          </VisuallyHidden>
          <div aria-hidden="true" class="mx-auto mb-2 h-1 w-10 rounded-full bg-[var(--line)]" />

          <div v-if="user" class="px-3 py-2">
            <p class="truncate text-sm font-bold">{{ displayName(user) }}</p>
            <p class="muted truncate text-xs">{{ user.email }}</p>
          </div>

          <!-- The page's own entries: boards, settings, sync. -->
          <slot name="menu" :close="closeMenu" />

          <template v-if="workspaces.length > 1">
            <p class="sheet-heading">Switch workspace</p>
            <button v-for="item in workspaces" :key="item.id" type="button" class="sheet-item" @click="openWorkspace(item)">
              <Check v-if="item.id === workspaceId" :size="15" stroke-width="2.5" class="text-[var(--accent)]" aria-hidden="true" />
              <span v-else class="size-[15px]" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate">{{ item.name }}</span>
              <span class="muted shrink-0 text-[11px] font-semibold tabular-nums">{{ item.boardCount }} {{ item.boardCount === 1 ? 'board' : 'boards' }}</span>
            </button>
          </template>

          <div class="my-1 h-px bg-[var(--line)]" />
          <NuxtLink v-if="showArchiveLink" :to="archiveMode ? `/b/${boardId}` : `/b/${boardId}/archive`" class="sheet-item" @click="closeMenu">
            <Archive :size="15" aria-hidden="true" /> {{ archiveMode ? 'Back to board' : 'Archive' }}
          </NuxtLink>
          <button type="button" class="sheet-item" @click="toggle">
            <Sun v-if="isDark" :size="15" aria-hidden="true" />
            <Moon v-else :size="15" aria-hidden="true" />
            {{ isDark ? 'Light mode' : 'Dark mode' }}
          </button>
          <NuxtLink v-if="workspace?.role === 'admin'" :to="`/w/${workspaceId}/settings`" class="sheet-item" @click="closeMenu"><Settings2 :size="15" aria-hidden="true" /> Settings of {{ workspace.name }}</NuxtLink>
          <NuxtLink to="/profile" class="sheet-item" @click="closeMenu"><User :size="15" aria-hidden="true" /> Your profile</NuxtLink>
          <template v-if="instanceAdmin">
            <p class="sheet-heading">Administration</p>
            <NuxtLink to="/admin/users" class="sheet-item" @click="closeMenu"><Users :size="15" aria-hidden="true" /> Users</NuxtLink>
            <NuxtLink to="/admin/workspaces" class="sheet-item" @click="closeMenu"><Layers :size="15" aria-hidden="true" /> Workspaces</NuxtLink>
          </template>
          <div class="my-1 h-px bg-[var(--line)]" />
          <button type="button" class="sheet-item font-semibold text-rose-600 hover:bg-rose-500/10" @click="logout()">
            <LogOut :size="15" aria-hidden="true" /> Sign out
          </button>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </header>
</template>
