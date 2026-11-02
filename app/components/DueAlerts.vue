<script setup lang="ts">
import { AlarmClock, ChevronRight } from '@lucide/vue'
import { PopoverClose, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import type { DueTicket } from '~~/shared/types/domain'
import { boardToday, daysUntil } from '~~/shared/utils/due-date'

const { tickets, refresh } = useDueTickets()
const { boards } = useBoards()
const lastWorkspaceId = useLastWorkspaceId()
const lastBoardId = useLastBoardId()

// Another tab or another person may have changed a due date in the meantime.
const route = useRoute()
watch(() => route.path, () => refresh())

const alertCount = computed(() => tickets.value.filter(ticket => ticket.level === 'alert').length)
const level = computed(() => (alertCount.value ? 'alert' : 'warning'))

// Workspace, then board, in the order the server sent them.
const groups = computed(() => {
  const workspaces: Array<{ id: string; name: string; boards: Array<{ id: string; name: string; tickets: DueTicket[] }> }> = []
  for (const ticket of tickets.value) {
    let workspace = workspaces.find(item => item.id === ticket.workspaceId)
    if (!workspace) workspaces.push(workspace = { id: ticket.workspaceId, name: ticket.workspaceName, boards: [] })
    let board = workspace.boards.find(item => item.id === ticket.boardId)
    if (!board) workspace.boards.push(board = { id: ticket.boardId, name: ticket.boardName, tickets: [] })
    board.tickets.push(ticket)
  }
  return workspaces
})

const today = boardToday()
function dueText(ticket: DueTicket) {
  const days = daysUntil(ticket.dueDate, today) ?? 0
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days > 1) return `in ${days} days`
  return days === -1 ? '1 day overdue' : `${-days} days overdue`
}

// Same rule as the workspace switcher: the remembered board if it lives there, else the first.
function workspaceTarget(workspaceId: string) {
  const inWorkspace = boards.value.filter(board => board.workspaceId === workspaceId)
  const target = inWorkspace.find(board => board.id === lastBoardId.value) || inWorkspace[0]
  return target ? `/b/${target.id}` : '/'
}
function openWorkspace(workspaceId: string) {
  lastWorkspaceId.value = workspaceId
  return navigateTo(workspaceTarget(workspaceId))
}
</script>

<template>
  <PopoverRoot v-if="tickets.length">
    <PopoverTrigger
      class="focus-ring relative grid size-10 shrink-0 place-items-center rounded-xl border transition"
      :class="level === 'alert'
        ? 'border-rose-600/40 bg-rose-600/10 text-rose-600 hover:bg-rose-600/15'
        : 'border-orange-400/50 bg-orange-400/10 text-orange-600 hover:bg-orange-400/20 dark:text-orange-300'"
      :aria-label="`${tickets.length} ${tickets.length === 1 ? 'ticket' : 'tickets'} due soon or overdue`"
      :title="alertCount ? `${alertCount} urgent` : `${tickets.length} due soon`"
    >
      <AlarmClock :size="18" aria-hidden="true" />
      <span
        class="absolute -right-1.5 -top-1.5 grid min-w-5 place-items-center rounded-full px-1 py-0.5 text-[10px] font-bold tabular-nums text-white"
        :class="level === 'alert' ? 'bg-rose-600' : 'bg-orange-500'"
      >{{ tickets.length }}</span>
    </PopoverTrigger>

    <PopoverPortal>
      <PopoverContent
        align="end"
        :side-offset="6"
        :collision-padding="12"
        class="ui-popover z-[100] max-h-[min(32rem,calc(100dvh-6rem))] w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--panel-strong)] p-1 text-[var(--ink)] shadow-[0_18px_45px_rgba(0,0,0,.16),0_3px_12px_rgba(0,0,0,.08)]"
      >
        <div class="px-3 pb-1 pt-2">
          <p class="text-sm font-bold">Due dates</p>
          <p class="muted text-xs">
            <template v-if="alertCount">{{ alertCount }} urgent<template v-if="tickets.length > alertCount">, {{ tickets.length - alertCount }} coming up</template>.</template>
            <template v-else>{{ tickets.length }} coming up.</template>
          </p>
        </div>

        <section v-for="workspace in groups" :key="workspace.id" class="mt-1 border-t border-[var(--line)] pt-1">
          <PopoverClose as-child>
            <button
              type="button"
              class="muted flex w-full items-center gap-1 rounded-lg px-3 pb-1 pt-2 text-left text-[10px] font-bold uppercase tracking-[.14em] hover:text-[var(--ink)]"
              @click="openWorkspace(workspace.id)"
            >
              {{ workspace.name }} <ChevronRight :size="12" aria-hidden="true" />
            </button>
          </PopoverClose>

          <div v-for="board in workspace.boards" :key="board.id" class="pb-1">
            <PopoverClose as-child>
              <NuxtLink :to="`/b/${board.id}`" class="flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold hover:bg-[var(--accent-soft)]">
                {{ board.name }} <ChevronRight :size="14" class="muted" aria-hidden="true" />
              </NuxtLink>
            </PopoverClose>
            <PopoverClose v-for="ticket in board.tickets" :key="ticket.id" as-child>
              <NuxtLink
                :to="{ path: `/b/${board.id}`, query: { ticket: ticket.ticketNumber } }"
                class="flex items-center gap-2 rounded-lg py-1.5 pl-5 pr-3 text-sm hover:bg-[var(--accent-soft)]"
              >
                <span class="size-2 shrink-0 rounded-full" :class="ticket.level === 'alert' ? 'bg-rose-600' : 'bg-orange-400'" aria-hidden="true" />
                <span class="muted shrink-0 text-xs font-semibold tabular-nums">#{{ ticket.ticketNumber }}</span>
                <span class="min-w-0 flex-1 truncate">{{ ticket.title }}</span>
                <span
                  class="shrink-0 text-xs font-semibold"
                  :class="ticket.level === 'alert' ? 'text-rose-600' : 'text-orange-600 dark:text-orange-300'"
                >{{ dueText(ticket) }}</span>
              </NuxtLink>
            </PopoverClose>
          </div>
        </section>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
