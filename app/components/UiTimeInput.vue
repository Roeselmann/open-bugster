<script setup lang="ts">
import { Clock, X } from '@lucide/vue'
import { Time } from '@internationalized/date'
import { PopoverAnchor, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger, TimeFieldInput, TimeFieldRoot } from 'reka-ui'

/**
 * A time of day on the 24-hour clock: hours and minutes typed or stepped with the arrow
 * keys, or picked from the quarter hours in a list. HH:MM in and out, '' for none.
 * `change` comes once an edit is finished — on leaving the field, or with a pick — so a
 * caller that saves there saves once, not at every keystroke.
 */
const props = withDefaults(defineProps<{
  modelValue: string
  ariaLabel?: string
  disabled?: boolean
}>(), {
  ariaLabel: undefined,
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
}>()

defineOptions({ inheritAttrs: false })

const toTime = (value: string) => {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  return match ? new Time(Number(match[1]), Number(match[2])) : undefined
}
const toText = (time: { hour: number; minute: number } | undefined | null) =>
  time ? `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}` : ''

// The field keeps its own value while it is being typed into; a finished one is passed on.
const time = shallowRef(toTime(props.modelValue))
watch(() => props.modelValue, (value) => {
  if (value !== toText(time.value)) time.value = toTime(value)
})
let atFocus = props.modelValue

function onField(value: unknown) {
  time.value = value as Time | undefined
  const text = toText(time.value)
  if (text !== props.modelValue) emit('update:modelValue', text)
}
function onFocusIn() {
  atFocus = props.modelValue
}
function onFocusOut(event: FocusEvent) {
  // Still in the field, from hour to minute: not finished yet. The buttons beside it save on their own.
  if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) return
  if (props.modelValue !== atFocus) {
    atFocus = props.modelValue
    emit('change', props.modelValue)
  }
}

function set(value: string) {
  open.value = false
  time.value = toTime(value)
  atFocus = value
  if (value === props.modelValue) return
  emit('update:modelValue', value)
  emit('change', value)
}

const open = ref(false)
const slots = Array.from({ length: 96 }, (_, index) => `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`)
const list = ref<HTMLElement | null>(null)
// Opens on the time set, or on the nearest quarter hour before it, or on nine in the morning.
watch(open, async (isOpen) => {
  if (!isOpen) return
  await nextTick()
  const target = props.modelValue ? slots.filter(slot => slot <= props.modelValue).at(-1) ?? '00:00' : '09:00'
  list.value?.querySelector<HTMLElement>(`[data-slot="${target}"]`)?.scrollIntoView({ block: 'center' })
})
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverAnchor as-child>
      <div
        class="surface-strong flex h-11 min-w-0 items-center gap-1 rounded-xl pl-3 pr-1.5 text-sm transition focus-within:ring-2 focus-within:ring-[var(--accent)]"
        :class="[disabled ? 'opacity-50' : 'hover:border-[color-mix(in_srgb,var(--line)_55%,var(--accent))]', $attrs.class]"
        v-bind="{ ...$attrs, class: undefined }"
      >
        <TimeFieldRoot
          v-slot="{ segments }"
          :model-value="time"
          :hour-cycle="24"
          granularity="minute"
          locale="en-GB"
          :disabled="disabled"
          :aria-label="ariaLabel"
          class="flex min-w-0 flex-1 items-center tabular-nums"
          @update:model-value="onField"
          @focusin="onFocusIn"
          @focusout="onFocusOut"
        >
          <template v-for="item in segments" :key="item.part">
            <TimeFieldInput v-if="item.part === 'literal'" :part="item.part" class="muted px-px">{{ item.value }}</TimeFieldInput>
            <TimeFieldInput
              v-else
              :part="item.part"
              class="rounded-md px-0.5 outline-none focus:bg-[var(--accent-soft)] data-[placeholder]:text-[var(--muted)]"
            >{{ item.value }}</TimeFieldInput>
          </template>
        </TimeFieldRoot>
        <button
          v-if="modelValue && !disabled"
          type="button"
          class="focus-ring muted grid size-7 shrink-0 place-items-center rounded-lg hover:text-rose-600"
          :aria-label="`Clear ${ariaLabel ?? 'time'}`"
          title="All day"
          @click="set('')"
        >
          <X :size="13" aria-hidden="true" />
        </button>
        <PopoverTrigger
          :disabled="disabled"
          class="focus-ring muted grid size-7 shrink-0 place-items-center rounded-lg hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]"
          :aria-label="`Pick ${ariaLabel ?? 'a time'}`"
        >
          <Clock :size="14" aria-hidden="true" />
        </PopoverTrigger>
      </div>
    </PopoverAnchor>
    <PopoverPortal>
      <PopoverContent
        align="end"
        :side-offset="6"
        :collision-padding="12"
        class="ui-popover z-[100] w-32 rounded-xl border border-[var(--line)] bg-[var(--panel-strong)] text-[var(--ink)] shadow-[0_18px_45px_rgba(0,0,0,.16),0_3px_12px_rgba(0,0,0,.08)]"
      >
        <div ref="list" class="max-h-60 overflow-y-auto p-1" role="listbox" :aria-label="ariaLabel">
          <button
            v-for="slot in slots"
            :key="slot"
            type="button"
            role="option"
            :aria-selected="slot === modelValue"
            :data-slot="slot"
            class="focus-ring flex h-8 w-full items-center rounded-lg px-3 text-sm tabular-nums"
            :class="slot === modelValue ? 'bg-[var(--primary)] font-semibold text-[var(--primary-ink)]' : slot.endsWith(':00') ? 'hover:bg-[var(--accent-soft)]' : 'muted hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]'"
            @click="set(slot)"
          >
            {{ slot }}
          </button>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
