<script setup lang="ts">
import { ListFilter } from '@lucide/vue'
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'

interface FilterOption {
  value: string
  label: string
}

defineProps<{
  labelOptions: FilterOption[]
  categoryOptions: FilterOption[]
  typeOptions: FilterOption[]
  assigneeOptions: FilterOption[]
}>()

const labels = defineModel<string[]>('labels', { required: true })
const category = defineModel<string>('category', { required: true })
const type = defineModel<string>('type', { required: true })
const assignee = defineModel<string>('assignee', { required: true })

const activeCount = computed(() =>
  labels.value.length
  + (category.value !== 'all' ? 1 : 0)
  + (type.value !== 'all' ? 1 : 0)
  + (assignee.value !== 'all' ? 1 : 0),
)

function clear() {
  labels.value = []
  category.value = 'all'
  type.value = 'all'
  assignee.value = 'all'
}
</script>

<template>
  <PopoverRoot>
    <PopoverTrigger
      class="focus-ring surface flex h-11 items-center gap-2 rounded-xl px-3.5 text-sm font-semibold outline-none transition hover:bg-[var(--panel-strong)]"
      :class="activeCount ? 'border-[color-mix(in_srgb,var(--line)_35%,var(--accent))]' : ''"
      aria-label="Filter tickets"
    >
      <ListFilter :size="16" :class="activeCount ? 'text-[var(--accent)]' : 'muted'" aria-hidden="true" />
      Filter
      <span
        v-if="activeCount"
        class="grid min-w-5 place-items-center rounded-full bg-[var(--accent-soft)] px-1 py-0.5 text-[11px] font-bold tabular-nums text-[var(--accent)]"
      >{{ activeCount }}</span>
    </PopoverTrigger>

    <PopoverPortal>
      <PopoverContent
        align="end"
        :side-offset="6"
        :collision-padding="12"
        class="ui-popover z-[100] w-[min(20rem,calc(100vw-1.5rem))] rounded-xl border border-[var(--line)] bg-[var(--panel-strong)] p-4 text-[var(--ink)] shadow-[0_18px_45px_rgba(0,0,0,.16),0_3px_12px_rgba(0,0,0,.08)]"
        @open-auto-focus.prevent
      >
        <div class="space-y-4">
          <div>
            <label class="mb-2 block text-xs font-bold uppercase tracking-[.08em]" for="filter-labels">Labels</label>
            <UiMultiCombobox
              id="filter-labels"
              v-model="labels"
              :options="labelOptions"
              aria-label="Filter by labels"
              placeholder="Filter by labels"
              empty-text="No labels on this board yet."
            />
          </div>
          <div>
            <label class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Category</label>
            <UiSelect v-model="category" :options="categoryOptions" aria-label="Filter by category" />
          </div>
          <div>
            <label class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Type</label>
            <UiSelect v-model="type" :options="typeOptions" aria-label="Filter by type" />
          </div>
          <div>
            <label class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Assignee</label>
            <UiSelect v-model="assignee" :options="assigneeOptions" aria-label="Filter by assignee" />
          </div>
          <button
            v-if="activeCount"
            type="button"
            class="focus-ring h-9 w-full rounded-xl text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
            @click="clear"
          >
            Clear filters
          </button>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
