<script setup lang="ts">
import { CalendarDays } from '@lucide/vue'
import { PopoverAnchor, PopoverContent, PopoverPortal, PopoverRoot } from 'reka-ui'

/**
 * Two date fields that share one calendar, with the span between them shaded: a start and a
 * due date, or the two ends of a live window. Either end may stay empty. Clicking a field
 * opens the calendar on that end; picking the first end of an open span moves on to the
 * other. YYYY-MM-DD in and out, '' for none; `change` names the end that was picked, so the
 * caller can drag the other along when they cross, as it did with the native inputs.
 */
const props = withDefaults(defineProps<{
  start: string
  end: string
  startLabel: string
  endLabel: string
  startPlaceholder?: string
  endPlaceholder?: string
  /** Extra classes for either field, such as a warning ring. */
  startClass?: string
  endClass?: string
  disabled?: boolean
}>(), {
  startPlaceholder: 'Pick a date',
  endPlaceholder: 'Pick a date',
  startClass: '',
  endClass: '',
  disabled: false,
})

const emit = defineEmits<{
  'update:start': [value: string]
  'update:end': [value: string]
  change: [side: 'start' | 'end']
}>()

type Side = 'start' | 'end'
const open = ref(false)
const side = ref<Side>('start')
const today = useBoardToday()

function openOn(next: Side) {
  if (props.disabled) return
  side.value = next
  open.value = true
}

function set(value: string) {
  const current = side.value === 'start' ? props.start : props.end
  const picked = side.value
  if (value !== current) {
    if (picked === 'start') emit('update:start', value)
    else emit('update:end', value)
    emit('change', picked)
  }
  // The first end of an empty span leads straight to the other; otherwise the pick is done.
  if (value && picked === 'start' && !props.end) side.value = 'end'
  else open.value = false
}

// A time field beside the dates leaves less room: the days go without their weekday then.
const slots = useSlots()
const roomy = computed(() => !slots['start-after'] && !slots['end-after'])

const fieldClass = 'focus-ring surface-strong flex h-11 w-full min-w-0 items-center gap-2 rounded-xl px-3 text-left text-sm outline-none transition hover:border-[color-mix(in_srgb,var(--line)_55%,var(--accent))] disabled:cursor-default disabled:hover:border-[var(--line)]'
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverAnchor as-child>
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="min-w-0">
          <slot name="start-label" />
          <div class="flex gap-2">
            <button
              type="button"
              :class="[fieldClass, startClass, open && side === 'start' ? 'ring-2 ring-[var(--accent)]' : '']"
              :disabled="disabled"
              :aria-label="startLabel"
              :aria-expanded="open && side === 'start'"
              data-range-start
              @click="openOn('start')"
            >
              <CalendarDays :size="15" class="muted shrink-0" aria-hidden="true" />
              <span class="min-w-0 truncate" :class="start ? '' : 'muted'">{{ start ? writtenDay(start, { weekday: roomy }) : startPlaceholder }}</span>
            </button>
            <slot name="start-after" />
          </div>
        </div>
        <div class="min-w-0">
          <slot name="end-label" />
          <div class="flex gap-2">
            <button
              type="button"
              :class="[fieldClass, endClass, open && side === 'end' ? 'ring-2 ring-[var(--accent)]' : '']"
              :disabled="disabled"
              :aria-label="endLabel"
              :aria-expanded="open && side === 'end'"
              data-range-end
              @click="openOn('end')"
            >
              <CalendarDays :size="15" class="muted shrink-0" aria-hidden="true" />
              <span class="min-w-0 truncate" :class="end ? '' : 'muted'">{{ end ? writtenDay(end, { weekday: roomy }) : endPlaceholder }}</span>
            </button>
            <slot name="end-after" />
          </div>
        </div>
      </div>
    </PopoverAnchor>
    <PopoverPortal>
      <PopoverContent
        align="start"
        :side-offset="6"
        :collision-padding="12"
        class="ui-popover z-[100] w-[18.5rem] rounded-xl border border-[var(--line)] bg-[var(--panel-strong)] text-[var(--ink)] shadow-[0_18px_45px_rgba(0,0,0,.16),0_3px_12px_rgba(0,0,0,.08)]"
        @open-auto-focus.prevent
      >
        <UiCalendar :key="side" :model-value="side === 'start' ? start : end" :range-start="start" :range-end="end" @update:model-value="set" />
        <!-- Which end the next pick sets, switched without closing; then clearing it, or today. -->
        <div class="flex items-center gap-1 border-t border-[var(--line)] px-2 py-2">
          <div class="flex rounded-lg bg-[var(--panel)] p-0.5" role="tablist" aria-label="Which end to pick">
            <button
              v-for="item in (['start', 'end'] as const)"
              :key="item"
              type="button"
              role="tab"
              :aria-selected="side === item"
              class="focus-ring rounded-md px-2 py-1 text-[11px] font-semibold transition-colors"
              :class="side === item ? 'bg-[var(--panel-strong)] text-[var(--ink)] shadow-sm' : 'muted hover:text-[var(--ink)]'"
              @click="side = item"
            >
              {{ item === 'start' ? startLabel : endLabel }}
            </button>
          </div>
          <button
            v-if="side === 'start' ? start : end"
            type="button"
            class="focus-ring muted ml-auto rounded-lg px-1.5 py-1 text-xs font-semibold hover:text-rose-600"
            @click="set('')"
          >
            Clear
          </button>
          <button
            type="button"
            class="focus-ring rounded-lg px-1.5 py-1 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
            :class="(side === 'start' ? start : end) ? '' : 'ml-auto'"
            @click="set(today)"
          >
            Today
          </button>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
