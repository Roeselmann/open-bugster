<script setup lang="ts">
import { Shapes } from '@lucide/vue'
import type { TicketTypeSummary } from '~~/shared/types/domain'

/**
 * The options every import on a board shares — how far a sync looks, whether the person
 * an item names becomes its author, which type imports land with. Board-wide rather than
 * per connection, so the TestFlight and Jira tabs both show them and either saves them.
 */
const props = defineProps<{ boardId: string }>()

const syncLimit = defineModel<number>('syncLimit', { required: true })
const autoAuthor = defineModel<boolean>('autoAuthor', { required: true })
/** `'none'` for no type: reka-ui refuses an empty select value, and no uuid can collide with it. */
const importTypeId = defineModel<string>('importTypeId', { required: true })

const NO_TYPE = 'none'
const boardId = computed(() => props.boardId)
const { data: typeData } = await useFetch<{ types: TicketTypeSummary[] }>('/api/ticket-types', { query: { boardId }, watch: [boardId] })
const ticketTypes = computed(() => typeData.value?.types || [])
const typeOptions = computed(() => [{ value: NO_TYPE, label: 'No type' }, ...ticketTypes.value.map(type => ({ value: type.id, label: type.name }))])
const selectedType = computed(() => ticketTypes.value.find(type => type.id === importTypeId.value) || null)
</script>

<template>
  <div class="space-y-4">
    <p class="muted text-[11px] leading-relaxed">These three options belong to the board and apply to every import on it, whether it comes from TestFlight or Jira.</p>

    <label class="block max-w-xs">
      <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Items per sync</span>
      <input
        v-model.number="syncLimit"
        type="number"
        min="1"
        max="2000"
        step="1"
        class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none"
      >
      <span class="muted mt-2 block text-[11px] leading-relaxed">
        Each sync checks this many of the newest items — TestFlight submissions per feedback type, screenshots and crashes counted separately, or Jira issues — and imports the ones that are not on the board yet.
      </span>
    </label>

    <label class="flex max-w-xl cursor-pointer items-start gap-3">
      <input v-model="autoAuthor" type="checkbox" class="focus-ring mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--accent)]">
      <span>
        <span class="block text-xs font-bold uppercase tracking-[.08em]">Attribute imports to the person they name</span>
        <span class="muted mt-2 block text-[11px] leading-relaxed">
          When the tester of a submission or the reporter of an issue already has an account here, record them as the ticket's author. People without an account are noted on the ticket either way, and a board admin can set the author by hand at any time.
        </span>
      </span>
    </label>

    <div class="block max-w-xs">
      <span class="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><Shapes :size="14" /> Type for imported tickets</span>
      <div class="flex items-center gap-2">
        <TicketTypeBadge v-if="selectedType" :type="selectedType" untitled />
        <div class="min-w-0 flex-1">
          <UiSelect
            :model-value="importTypeId"
            :options="typeOptions"
            aria-label="Type for imported tickets"
            @update:model-value="importTypeId = $event"
          />
        </div>
      </div>
      <span class="muted mt-2 block text-[11px] leading-relaxed">
        Everything a sync brings in gets this type. Applies to future imports only; tickets already on the board keep theirs. If the type is deleted later, imports simply arrive untyped.
      </span>
    </div>
  </div>
</template>
