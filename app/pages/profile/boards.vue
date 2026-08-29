<script setup lang="ts">
import { ChevronRight, LayoutGrid } from '@lucide/vue'
import type { BoardRole, BoardSummary } from '~~/shared/types/domain'

const { user, instanceAdmin } = useAuth()
const { boards } = useBoards()

const boardRoleLabels: Record<BoardRole, string> = { viewer: 'Viewer', editor: 'Editor', admin: 'Administrator' }

/**
 * An instance administrator is handed `admin` on every board whether or not anybody added
 * them, so the row has to say which of the two it is — a membership can be taken away, the
 * instance role cannot.
 */
function viaInstanceRole(board: BoardSummary): boolean {
  return instanceAdmin.value && !board.members.some(member => member.userId === user.value?.id)
}
</script>

<template>
  <section class="surface rounded-2xl">
    <header class="border-b border-[var(--line)] px-5 py-4">
      <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Access</p>
      <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold"><LayoutGrid :size="18" aria-hidden="true" /> Your boards</h2>
      <p class="muted mt-1 text-sm">
        Viewers read and comment, editors work the board, administrators also change its settings
        and the App Store Connect key. Only a board administrator can change who is on a board.
      </p>
    </header>

    <ul v-if="boards.length" class="divide-y divide-[var(--line)]">
      <li v-for="board in boards" :key="board.id">
        <NuxtLink
          :to="`/b/${board.id}`"
          class="focus-ring flex items-center gap-3 px-5 py-3.5 transition hover:bg-[var(--panel-strong)]"
        >
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">{{ board.name }}</p>
            <p class="muted mt-0.5 text-xs">
              {{ board.ticketCount }} open {{ board.ticketCount === 1 ? 'ticket' : 'tickets' }} ·
              {{ board.members.length }} {{ board.members.length === 1 ? 'member' : 'members' }}
              <template v-if="viaInstanceRole(board)"> · through your instance role, not a membership</template>
            </p>
          </div>
          <span class="tone tone-neutral shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide">
            {{ boardRoleLabels[board.role] }}
          </span>
          <ChevronRight class="muted shrink-0" :size="16" aria-hidden="true" />
        </NuxtLink>
      </li>
    </ul>
    <p v-else class="muted px-5 py-6 text-sm">
      You are not on any board yet — a board administrator has to add you.
    </p>
  </section>
</template>
