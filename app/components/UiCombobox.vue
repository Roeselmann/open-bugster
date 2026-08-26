<script setup lang="ts">
import { Check, ChevronDown } from '@lucide/vue'
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
} from 'reka-ui'

const props = withDefaults(defineProps<{
  modelValue: string
  options: string[]
  id?: string
  ariaLabel?: string
  placeholder?: string
  maxLength?: number
}>(), {
  id: undefined,
  ariaLabel: undefined,
  placeholder: undefined,
  maxLength: 30,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

function updateValue(value: unknown) {
  emit('update:modelValue', String(value ?? '').slice(0, props.maxLength))
}
</script>

<template>
  <ComboboxRoot
    :model-value="modelValue || undefined"
    :reset-search-term-on-blur="false"
    :reset-search-term-on-select="false"
    open-on-click
    open-on-focus
    @update:model-value="updateValue"
  >
    <ComboboxAnchor class="surface-strong focus-within:border-[color-mix(in_srgb,var(--line)_55%,var(--accent))] relative flex h-11 w-full items-center rounded-xl transition">
      <ComboboxInput
        :id="id"
        :model-value="modelValue"
        :maxlength="maxLength"
        :placeholder="placeholder"
        :aria-label="ariaLabel"
        class="focus-ring h-full min-w-0 flex-1 rounded-xl bg-transparent px-3 pr-10 text-sm outline-none"
        @update:model-value="updateValue"
      />
      <ComboboxTrigger class="focus-ring muted group absolute right-1.5 grid size-8 place-items-center rounded-lg outline-none hover:bg-[var(--accent-soft)]" :aria-label="`Open ${ariaLabel || 'selection'}`">
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
          <ComboboxEmpty class="muted px-3 py-2.5 text-sm">
            {{ modelValue.trim() ? `“${modelValue.trim()}” will be created.` : 'No categories available.' }}
          </ComboboxEmpty>
          <ComboboxItem
            v-for="option in options"
            :key="option"
            :value="option"
            class="relative flex h-9 cursor-default select-none items-center rounded-lg py-0 pl-8 pr-3 text-sm outline-none data-[highlighted]:bg-[var(--accent-soft)] data-[highlighted]:text-[var(--ink)]"
          >
            <ComboboxItemIndicator class="absolute left-2.5 grid place-items-center text-[var(--accent)]">
              <Check :size="15" stroke-width="2.5" aria-hidden="true" />
            </ComboboxItemIndicator>
            <span class="truncate">{{ option }}</span>
          </ComboboxItem>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>
