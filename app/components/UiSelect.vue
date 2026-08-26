<script setup lang="ts">
import { Check, ChevronDown } from '@lucide/vue'
import {
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from 'reka-ui'

export interface UiSelectOption {
  value: string
  label: string
}

const props = withDefaults(defineProps<{
  modelValue: string
  options: UiSelectOption[]
  ariaLabel?: string
  disabled?: boolean
  compact?: boolean
}>(), {
  ariaLabel: undefined,
  disabled: false,
  compact: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>

<template>
  <SelectRoot
    :model-value="props.modelValue"
    :disabled="props.disabled"
    @update:model-value="value => emit('update:modelValue', String(value))"
  >
    <SelectTrigger
      class="focus-ring surface-strong group flex w-full items-center justify-between gap-2 outline-none transition hover:border-[color-mix(in_srgb,var(--line)_55%,var(--accent))] disabled:cursor-not-allowed disabled:opacity-50"
      :class="compact ? 'h-8 rounded-lg px-2.5 text-xs' : 'h-11 rounded-xl px-3 text-sm'"
      :aria-label="ariaLabel"
    >
      <SelectValue class="min-w-0 truncate" />
      <ChevronDown :size="compact ? 14 : 16" class="muted shrink-0 transition-transform duration-150 group-data-[state=open]:rotate-180" aria-hidden="true" />
    </SelectTrigger>

    <SelectPortal>
      <SelectContent
        position="popper"
        align="start"
        :side-offset="6"
        class="ui-popover z-[100] min-w-[var(--reka-select-trigger-width)] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel-strong)] text-[var(--ink)] shadow-[0_18px_45px_rgba(0,0,0,.16),0_3px_12px_rgba(0,0,0,.08)]"
      >
        <SelectViewport class="max-h-[min(20rem,var(--reka-select-content-available-height))] p-1">
          <SelectItem
            v-for="option in options"
            :key="option.value"
            :value="option.value"
            class="relative flex h-9 cursor-default select-none items-center rounded-lg py-0 pl-8 pr-3 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-[var(--accent-soft)] data-[highlighted]:text-[var(--ink)]"
          >
            <SelectItemIndicator class="absolute left-2.5 grid place-items-center text-[var(--accent)]">
              <Check :size="15" stroke-width="2.5" aria-hidden="true" />
            </SelectItemIndicator>
            <SelectItemText>{{ option.label }}</SelectItemText>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
