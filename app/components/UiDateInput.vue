<script setup lang="ts">
import { CalendarDays } from '@lucide/vue'
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'

// Classes and data attributes go to the field itself, not to the popover around it.
defineOptions({ inheritAttrs: false })

/**
 * A date field: the day written out, a calendar in a popover to pick it. YYYY-MM-DD in and
 * out, '' for none. `change` follows a pick, like a native input's, so callers save there.
 */
const props = withDefaults(defineProps<{
  modelValue: string
  min?: string
  max?: string
  placeholder?: string
  ariaLabel?: string
  /** Whether it can be emptied; a milestone's day, say, cannot. */
  clearable?: boolean
  disabled?: boolean
}>(), {
  min: undefined,
  max: undefined,
  placeholder: 'Pick a date',
  ariaLabel: undefined,
  clearable: true,
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
}>()

const open = ref(false)
const today = useBoardToday()

function set(value: string) {
  open.value = false
  if (value === props.modelValue) return
  emit('update:modelValue', value)
  emit('change', value)
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger
      :disabled="disabled"
      class="focus-ring surface-strong group flex h-11 w-full min-w-0 items-center gap-2 rounded-xl px-3 text-left text-sm outline-none transition hover:border-[color-mix(in_srgb,var(--line)_55%,var(--accent))] disabled:cursor-default disabled:hover:border-[var(--line)] data-[state=open]:ring-2 data-[state=open]:ring-[var(--accent)]"
      :aria-label="ariaLabel"
      v-bind="$attrs"
    >
      <CalendarDays :size="15" class="muted shrink-0" aria-hidden="true" />
      <span class="min-w-0 truncate" :class="modelValue ? '' : 'muted'">{{ modelValue ? writtenDay(modelValue) : placeholder }}</span>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        align="start"
        :side-offset="6"
        :collision-padding="12"
        class="ui-popover z-[100] w-[18.5rem] rounded-xl border border-[var(--line)] bg-[var(--panel-strong)] text-[var(--ink)] shadow-[0_18px_45px_rgba(0,0,0,.16),0_3px_12px_rgba(0,0,0,.08)]"
      >
        <UiCalendar :model-value="modelValue" :min="min" :max="max" @update:model-value="set" />
        <div class="flex items-center justify-between border-t border-[var(--line)] px-3 py-2">
          <button
            v-if="clearable && modelValue"
            type="button"
            class="focus-ring muted rounded-lg px-2 py-1 text-xs font-semibold hover:text-rose-600"
            @click="set('')"
          >
            Clear
          </button>
          <span v-else />
          <button
            type="button"
            class="focus-ring rounded-lg px-2 py-1 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:opacity-40"
            :disabled="Boolean((min && today < min) || (max && today > max))"
            @click="set(today)"
          >
            Today
          </button>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
