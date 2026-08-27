<script setup lang="ts">
import { Check, ChevronDown, Plus, X } from '@lucide/vue'
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
} from 'reka-ui'

export interface UiMultiOption {
  value: string
  label: string
}

const props = withDefaults(defineProps<{
  modelValue: string[]
  options: UiMultiOption[]
  /** Offers an unknown search term as a new entry. */
  allowCreate?: boolean
  max?: number
  maxLength?: number
  id?: string
  ariaLabel?: string
  placeholder?: string
  emptyText?: string
  compact?: boolean
}>(), {
  allowCreate: false,
  max: 12,
  maxLength: 30,
  id: undefined,
  ariaLabel: undefined,
  placeholder: undefined,
  emptyText: 'Nothing to choose from yet.',
  compact: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const searchTerm = ref('')

const labelByValue = computed(() => new Map(props.options.map(option => [option.value, option.label])))
const selected = computed(() => props.modelValue.map(value => ({ value, label: labelByValue.value.get(value) || value })))
const full = computed(() => props.modelValue.length >= props.max)

const term = computed(() => searchTerm.value.trim())

/**
 * Filtering is ours rather than reka's: its built-in filter hides every item that does not
 * match, including the synthetic "create" row, which is needed exactly when nothing matches.
 */
const matches = computed(() => {
  const needle = term.value.toLocaleLowerCase('en')
  return props.options.filter(option => !needle || option.label.toLocaleLowerCase('en').includes(needle))
})

const creatable = computed(() => {
  if (!props.allowCreate || !term.value || full.value) return false
  const needle = term.value.toLocaleLowerCase('en')
  return !props.options.some(option => option.label.toLocaleLowerCase('en') === needle)
    && !props.modelValue.some(value => value.toLocaleLowerCase('en') === needle)
})

function apply(values: string[]) {
  emit('update:modelValue', values.slice(0, props.max))
  searchTerm.value = ''
}

function focusInput(event: MouseEvent) {
  (event.currentTarget as HTMLElement).querySelector('input')?.focus()
}

function remove(value: string) {
  apply(props.modelValue.filter(item => item !== value))
}

function createFromTerm() {
  if (!creatable.value) return
  apply([...props.modelValue, term.value.slice(0, props.maxLength)])
}

function onEnter(event: KeyboardEvent) {
  // Reka handles Enter for a highlighted item; only an unmatched term is ours to deal with.
  if (!creatable.value || matches.value.length) return
  event.preventDefault()
  createFromTerm()
}

function onBackspace() {
  if (searchTerm.value || !props.modelValue.length) return
  remove(props.modelValue[props.modelValue.length - 1]!)
}
</script>

<template>
  <ComboboxRoot
    multiple
    ignore-filter
    :model-value="modelValue"
    :reset-search-term-on-blur="false"
    :reset-search-term-on-select="false"
    open-on-click
    open-on-focus
    @update:model-value="value => apply((value as unknown as string[]) || [])"
  >
    <ComboboxAnchor
      class="surface-strong focus-within:border-[color-mix(in_srgb,var(--line)_55%,var(--accent))] relative flex w-full flex-wrap items-center gap-1.5 rounded-xl py-1.5 pl-2 pr-10 transition"
      :class="compact ? 'min-h-10' : 'min-h-11'"
      @click="focusInput"
    >
      <span
        v-for="item in selected"
        :key="item.value"
        class="flex max-w-full items-center gap-1 rounded-lg bg-[var(--accent-soft)] py-1 pl-2 pr-1 text-xs font-semibold text-[var(--accent)]"
      >
        <span class="truncate">{{ item.label }}</span>
        <button
          type="button"
          class="focus-ring grid size-4 shrink-0 place-items-center rounded hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]"
          :aria-label="`Remove ${item.label}`"
          @click.stop="remove(item.value)"
        ><X :size="12" /></button>
      </span>

      <ComboboxInput
        :id="id"
        :model-value="searchTerm"
        :maxlength="maxLength"
        :placeholder="selected.length ? '' : placeholder"
        :aria-label="ariaLabel"
        class="focus-ring h-8 min-w-24 flex-1 rounded-lg bg-transparent px-1 text-sm outline-none"
        @update:model-value="value => (searchTerm = String(value ?? ''))"
        @keydown.enter="onEnter"
        @keydown.delete="onBackspace"
      />

      <ComboboxTrigger class="focus-ring muted group absolute right-1.5 top-1.5 grid size-8 place-items-center rounded-lg outline-none hover:bg-[var(--accent-soft)]" :aria-label="`Open ${ariaLabel || 'selection'}`">
        <ChevronDown :size="16" class="transition-transform duration-150 group-data-[state=open]:rotate-180" aria-hidden="true" />
      </ComboboxTrigger>
    </ComboboxAnchor>

    <ComboboxPortal>
      <ComboboxContent
        position="popper"
        align="start"
        :side-offset="6"
        class="ui-popover z-[100] min-w-[var(--reka-combobox-trigger-width)] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel-strong)] text-[var(--ink)] shadow-[0_18px_45px_rgba(0,0,0,.16),0_3px_12px_rgba(0,0,0,.08)]"
      >
        <ComboboxViewport class="max-h-[min(20rem,var(--reka-combobox-content-available-height))] p-1">
          <ComboboxItem
            v-if="creatable"
            :value="term.slice(0, maxLength)"
            class="relative flex h-9 cursor-default select-none items-center gap-2 rounded-lg px-3 text-sm font-semibold outline-none data-[highlighted]:bg-[var(--accent-soft)] data-[highlighted]:text-[var(--ink)]"
          >
            <Plus :size="15" class="shrink-0 text-[var(--accent)]" aria-hidden="true" />
            <span class="truncate">Create “{{ term }}”</span>
          </ComboboxItem>

          <ComboboxItem
            v-for="option in matches"
            :key="option.value"
            :value="option.value"
            :disabled="full && !modelValue.includes(option.value)"
            class="relative flex h-9 cursor-default select-none items-center rounded-lg py-0 pl-8 pr-3 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-[var(--accent-soft)] data-[highlighted]:text-[var(--ink)]"
          >
            <ComboboxItemIndicator class="absolute left-2.5 grid place-items-center text-[var(--accent)]">
              <Check :size="15" stroke-width="2.5" aria-hidden="true" />
            </ComboboxItemIndicator>
            <span class="truncate">{{ option.label }}</span>
          </ComboboxItem>

          <p v-if="!matches.length && !creatable" class="muted px-3 py-2.5 text-sm">
            {{ full ? `At most ${max} at a time.` : term ? `No match for “${term}”.` : emptyText }}
          </p>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>
