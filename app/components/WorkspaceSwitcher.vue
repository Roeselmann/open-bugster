<script setup lang="ts">
import { Check, ChevronDown, Layers, Plus, Settings2 } from '@lucide/vue'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  VisuallyHidden,
} from 'reka-ui'
import type { WorkspaceSummary } from '~~/shared/types/domain'
import { DEFAULT_WORKSPACE_NAME } from '~~/shared/utils/constants'

// The header mounts on board-less pages too, so the switcher loads its own list rather
// than trusting any middleware to have done it. Cached per account; this rarely fetches.
await loadWorkspaces()

const { workspaces, refresh: refreshWorkspaces } = useWorkspaces()
const { workspace } = useCurrentWorkspace()
const { instanceAdmin } = useAuth()
const { boards } = useBoards()
const lastWorkspaceId = useLastWorkspaceId()
const lastBoardId = useLastBoardId()

// One workspace needs no switcher: the header looks exactly as it did before workspaces
// existed, and the menu appears on its own the day a second one is created.
const hasChoice = computed(() => workspaces.value.length > 1)
// Instance administrators get the menu even with a single workspace — it carries the
// shortcut to open the second one, the same way the board switcher offers "New board".
const hasMenu = computed(() => hasChoice.value || instanceAdmin.value)

// A lone workspace still shows its name — as a plain title, like the single-board case in
// BoardSwitcher — once somebody has made it theirs: renamed it away from the seeded default
// or given it a description. Untouched, the header stays exactly as before workspaces.
const visible = computed(() => hasChoice.value
  || Boolean(workspace.value && (workspace.value.description || workspace.value.name !== DEFAULT_WORKSPACE_NAME)))

const createOpen = ref(false)
const newName = ref('')
const creating = ref(false)
const createError = ref('')

function open(item: WorkspaceSummary) {
  lastWorkspaceId.value = item.id
  // Resolved here rather than bounced through "/": routing to the page we are already on
  // is a no-op, so from the empty state "/" would never re-run the middleware — and the
  // page would keep saying a workspace with boards is empty. Same rule as `home-board`:
  // the remembered board if it lives here, else the workspace's first, else the empty state.
  const inWorkspace = boards.value.filter(board => board.workspaceId === item.id)
  const target = inWorkspace.find(board => board.id === lastBoardId.value) || inWorkspace[0]
  return navigateTo(target ? `/b/${target.id}` : '/')
}

function openCreate() {
  newName.value = ''
  createError.value = ''
  createOpen.value = true
}

async function createWorkspace() {
  const name = newName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  createError.value = ''
  try {
    const response = await $fetch<{ workspace: WorkspaceSummary }>('/api/workspaces', { method: 'POST', body: { name } })
    await refreshWorkspaces()
    lastWorkspaceId.value = response.workspace.id
    createOpen.value = false
    await navigateTo(`/w/${response.workspace.id}/settings`)
  } catch (error: any) {
    createError.value = error?.data?.statusMessage || error?.statusMessage || 'The workspace could not be created.'
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div v-if="visible && workspace" class="flex min-w-0 flex-1 items-center gap-1.5">
    <span class="muted mx-1 select-none text-2xl font-light" aria-hidden="true">/</span>

    <span v-if="!hasMenu" class="truncate px-1 text-3xl font-bold tracking-[-.045em]">{{ workspace.name }}</span>

    <DropdownMenuRoot v-else>
      <DropdownMenuTrigger
        class="focus-ring group flex min-w-0 items-center gap-2 rounded-xl px-1 text-left transition hover:bg-[var(--panel-strong)]"
        :aria-label="`Switch workspace, currently ${workspace.name}`"
      >
        <span class="truncate text-3xl font-bold tracking-[-.045em]">{{ workspace.name }}</span>
        <ChevronDown :size="20" class="muted shrink-0 transition-transform duration-150 group-data-[state=open]:rotate-180" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent
          align="start"
          :side-offset="6"
          class="ui-popover z-[100] min-w-64 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel-strong)] p-1 text-[var(--ink)] shadow-[0_18px_45px_rgba(0,0,0,.16),0_3px_12px_rgba(0,0,0,.08)]"
        >
          <DropdownMenuItem
            v-for="item in workspaces"
            :key="item.id"
            class="relative flex h-10 cursor-default select-none items-center gap-2 rounded-lg py-0 pl-8 pr-3 text-sm outline-none data-[highlighted]:bg-[var(--accent-soft)]"
            @select="open(item)"
          >
            <Check v-if="item.id === workspace.id" :size="15" stroke-width="2.5" class="absolute left-2.5 text-[var(--accent)]" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate font-medium">{{ item.name }}</span>
            <span class="muted shrink-0 text-[11px] font-semibold tabular-nums">{{ item.boardCount }} {{ item.boardCount === 1 ? 'board' : 'boards' }}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator v-if="workspace.role === 'admin' || instanceAdmin" class="my-1 h-px bg-[var(--line)]" />
          <DropdownMenuItem
            v-if="workspace.role === 'admin'"
            class="flex h-10 cursor-default select-none items-center gap-2 rounded-lg px-3 text-sm font-semibold outline-none data-[highlighted]:bg-[var(--accent-soft)]"
            @select="navigateTo(`/w/${workspace.id}/settings`)"
          >
            <Settings2 :size="15" aria-hidden="true" /> Settings of {{ workspace.name }}
          </DropdownMenuItem>
          <DropdownMenuItem
            v-if="instanceAdmin"
            class="flex h-10 cursor-default select-none items-center gap-2 rounded-lg px-3 text-sm font-semibold outline-none data-[highlighted]:bg-[var(--accent-soft)]"
            @select="openCreate"
          >
            <Plus :size="15" aria-hidden="true" /> New workspace…
          </DropdownMenuItem>
          <DropdownMenuItem
            v-if="instanceAdmin"
            class="flex h-10 cursor-default select-none items-center gap-2 rounded-lg px-3 text-sm font-semibold outline-none data-[highlighted]:bg-[var(--accent-soft)]"
            @select="navigateTo('/admin/workspaces')"
          >
            <Layers :size="15" aria-hidden="true" /> All workspaces
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>

    <NuxtLink
      v-if="workspace.role === 'admin'"
      :to="`/w/${workspace.id}/settings`"
      class="focus-ring surface grid size-9 shrink-0 place-items-center rounded-xl hover:bg-[var(--panel-strong)]"
      aria-label="Workspace settings"
      title="Workspace settings"
    >
      <Settings2 :size="17" />
    </NuxtLink>

    <!-- Three lines at most, in the room the name leaves over: `flex-1` with a zero basis
         means the name keeps its natural width and only the leftovers wrap here — without
         it, a long description would squeeze the name down to a few letters. The title
         attribute carries anything the clamp still cuts off. -->
    <span
      v-if="workspace.description"
      class="muted hidden min-w-0 flex-1 px-1 text-sm lg:line-clamp-3"
      :title="workspace.description"
    >{{ workspace.description }}</span>

    <DialogRoot :open="createOpen" @update:open="value => !creating && (createOpen = value)">
      <DialogPortal>
        <DialogOverlay class="ui-dialog-overlay fixed inset-0 z-[70] bg-black/35 backdrop-blur-[2px]" />
        <DialogContent class="ui-dialog-content surface fixed left-1/2 top-1/2 z-[71] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl p-5 shadow-2xl sm:p-6">
          <VisuallyHidden>
            <DialogDescription>Create a workspace to group boards under.</DialogDescription>
          </VisuallyHidden>
          <DialogTitle as-child>
            <h2 class="text-lg font-bold tracking-[-.025em]">New workspace</h2>
          </DialogTitle>
          <p class="muted mt-2 text-sm">A workspace groups boards. It starts empty — you are taken to its settings to open the first board.</p>
          <form class="mt-5" @submit.prevent="createWorkspace">
            <label class="mb-2 block text-xs font-bold uppercase tracking-[.08em]" for="new-workspace-name">Name</label>
            <input
              id="new-workspace-name"
              v-model="newName"
              class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none"
              maxlength="40"
              placeholder="Marketing"
              autofocus
            >
            <p v-if="createError" class="mt-2 text-sm text-rose-600">{{ createError }}</p>
            <div class="mt-6 flex justify-end gap-2.5">
              <DialogClose as-child>
                <button type="button" :disabled="creating" class="focus-ring h-10 rounded-xl px-4 text-sm font-semibold hover:bg-[var(--panel-strong)] disabled:opacity-50">Cancel</button>
              </DialogClose>
              <button type="submit" :disabled="creating || !newName.trim()" class="focus-ring h-10 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] disabled:opacity-50">
                {{ creating ? 'Creating…' : 'Create workspace' }}
              </button>
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>
