<script setup lang="ts">
import { Tag, Trash2, X } from '@lucide/vue'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  VisuallyHidden,
} from 'reka-ui'
import type { CategorySummary } from '~~/shared/types/domain'

defineProps<{ categories: CategorySummary[]; deletingId?: string | null }>()
const emit = defineEmits<{
  close: []
  delete: [category: CategorySummary]
}>()
</script>

<template>
  <DialogRoot :open="true" @update:open="open => !open && emit('close')">
    <DialogPortal>
      <DialogOverlay class="ui-dialog-overlay fixed inset-0 z-[70] bg-black/35 backdrop-blur-[2px]" />
      <DialogContent class="ui-dialog-content surface fixed left-1/2 top-1/2 z-[71] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl shadow-2xl outline-none">
        <VisuallyHidden>
          <DialogDescription>View and delete existing ticket categories.</DialogDescription>
        </VisuallyHidden>
        <header class="flex items-center border-b border-[var(--line)] px-5 py-4">
          <div>
            <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Ticket categories</p>
            <DialogTitle as-child>
              <h2 class="mt-0.5 text-lg font-bold">Manage categories</h2>
            </DialogTitle>
          </div>
          <DialogClose as-child>
            <button class="focus-ring ml-auto grid size-9 place-items-center rounded-xl hover:bg-[var(--panel-strong)]" aria-label="Close"><X :size="18" /></button>
          </DialogClose>
        </header>

        <div v-if="categories.length" class="max-h-[60vh] divide-y divide-[var(--line)] overflow-y-auto">
          <div v-for="category in categories" :key="category.id" class="flex items-center gap-3 px-5 py-3">
            <span class="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]"><Tag :size="15" /></span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold">{{ category.name }}</p>
              <p class="muted text-[11px]">{{ category.ticketCount }} {{ category.ticketCount === 1 ? 'Ticket' : 'Tickets' }}</p>
            </div>
            <button
              :disabled="deletingId === category.id"
              class="focus-ring grid size-9 shrink-0 place-items-center rounded-xl text-rose-600 hover:bg-rose-500/10 disabled:opacity-40"
              :aria-label="`Delete ${category.name}`"
              @click="emit('delete', category)"
            ><Trash2 :size="16" /></button>
          </div>
        </div>
        <div v-else class="muted grid min-h-40 place-items-center px-5 text-center text-sm">
          No categories yet.<br>Create the first category in a ticket.
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
