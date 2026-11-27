<script setup lang="ts">
import { ChevronLeft, ChevronRight } from '@lucide/vue'
import { parseDate, type DateValue } from '@internationalized/date'
import {
  CalendarCell,
  CalendarCellTrigger,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHead,
  CalendarGridRow,
  CalendarHeadCell,
  CalendarHeader,
  CalendarHeading,
  CalendarNext,
  CalendarPrev,
  CalendarRoot,
} from 'reka-ui'

/**
 * One month to pick a day from, in the app's own look. Days are YYYY-MM-DD strings in and
 * out, as everywhere else. `rangeStart` and `rangeEnd` shade the span between them, so the
 * same calendar serves a single date and either end of a span.
 */
const props = withDefaults(defineProps<{
  modelValue: string
  min?: string
  max?: string
  rangeStart?: string
  rangeEnd?: string
}>(), {
  min: undefined,
  max: undefined,
  rangeStart: undefined,
  rangeEnd: undefined,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const today = useBoardToday()
const parse = (value: string | undefined) => {
  if (!value) return undefined
  try {
    return parseDate(value)
  } catch {
    return undefined
  }
}

const value = computed(() => parse(props.modelValue))
// The month on show: the picked day's, else the other end of the span's, else today's.
const placeholder = shallowRef<DateValue>(parse(props.modelValue) ?? parse(props.rangeStart) ?? parse(props.rangeEnd) ?? parse(today)!)
watch(() => props.modelValue, (next) => {
  const day = parse(next)
  if (day) placeholder.value = day
})

function pick(day: DateValue | undefined) {
  // Clicking the picked day again does not clear it; clearing has its own button.
  if (day) emit('update:modelValue', day.toString())
}

function cellClass(day: DateValue) {
  const text = day.toString()
  const start = props.rangeStart
  const end = props.rangeEnd
  if (!start || !end || start > end) return ''
  if (text === start || text === end) return 'ui-calendar-edge'
  return text > start && text < end ? 'ui-calendar-between' : ''
}
</script>

<template>
  <CalendarRoot
    v-slot="{ weekDays, grid }"
    :model-value="value"
    :placeholder="placeholder"
    :min-value="parse(min)"
    :max-value="parse(max)"
    :week-starts-on="1"
    weekday-format="short"
    locale="en-GB"
    fixed-weeks
    prevent-deselect
    class="select-none p-3"
    @update:model-value="pick($event as DateValue | undefined)"
    @update:placeholder="placeholder = $event"
  >
    <CalendarHeader class="mb-2 flex items-center justify-between">
      <CalendarPrev class="focus-ring grid size-8 place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]">
        <ChevronLeft :size="16" aria-hidden="true" />
      </CalendarPrev>
      <CalendarHeading class="text-sm font-bold" />
      <CalendarNext class="focus-ring grid size-8 place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]">
        <ChevronRight :size="16" aria-hidden="true" />
      </CalendarNext>
    </CalendarHeader>
    <CalendarGrid v-for="month in grid" :key="month.value.toString()" class="w-full border-collapse">
      <CalendarGridHead>
        <CalendarGridRow class="grid grid-cols-7">
          <CalendarHeadCell v-for="day in weekDays" :key="day" class="muted pb-1 text-center text-[11px] font-semibold uppercase tracking-[.06em]">
            {{ day.slice(0, 2) }}
          </CalendarHeadCell>
        </CalendarGridRow>
      </CalendarGridHead>
      <CalendarGridBody class="grid gap-y-0.5">
        <CalendarGridRow v-for="(week, index) in month.rows" :key="`week-${index}`" class="grid grid-cols-7">
          <CalendarCell v-for="day in week" :key="day.toString()" :date="day" class="relative text-center text-sm" :class="cellClass(day)">
            <CalendarCellTrigger
              :day="day"
              :month="month.value"
              class="ui-calendar-day focus-ring relative mx-auto grid size-9 place-items-center rounded-lg tabular-nums outline-none transition-colors hover:bg-[var(--accent-soft)] data-[outside-view]:text-[var(--muted)] data-[outside-view]:opacity-50 data-[disabled]:pointer-events-none data-[disabled]:opacity-30 data-[today]:font-bold data-[today]:text-[var(--accent)] data-[selected]:!bg-[var(--primary)] data-[selected]:!text-[var(--primary-ink)] data-[selected]:!opacity-100"
            />
          </CalendarCell>
        </CalendarGridRow>
      </CalendarGridBody>
    </CalendarGrid>
  </CalendarRoot>
</template>

<style scoped>
/* The span between the two ends: a soft band behind the days, rounded where it starts and stops. */
.ui-calendar-between {
  background: var(--accent-soft);
}
.ui-calendar-edge :deep(.ui-calendar-day:not([data-selected])) {
  background: color-mix(in srgb, var(--primary) 22%, transparent);
  font-weight: 700;
}
</style>
