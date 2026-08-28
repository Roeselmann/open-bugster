<script setup lang="ts">
import { CalendarClock, Check, Image, ListTodo, MessageSquare, Tag, TestTubeDiagonal, TriangleAlert, UserRound } from '@lucide/vue'
import type { Lane, Ticket } from '~~/shared/types/domain'
import { CATEGORY_TONE_CLASSES } from '~~/shared/utils/constants'

const props = defineProps<{ ticket: Ticket; index: number; lanes: Lane[]; preview?: boolean; showScreenshot?: boolean }>()
const emit = defineEmits<{
  open: [ticket: Ticket]
  move: [laneId: string]
}>()

const dateFormatter = new Intl.DateTimeFormat('en', {
  day: '2-digit',
  month: 'short',
  timeZone: 'Europe/Berlin',
})

const cardDateText = computed(() => {
  const rawDate = props.ticket.feedback?.sourceCreatedAt || props.ticket.createdAt

  if (!rawDate) return null
  const date = new Date(rawDate)
  return Number.isNaN(date.getTime()) ? null : dateFormatter.format(date)
})

const imageAttachment = computed(() => props.showScreenshot
  ? props.ticket.attachments.find(attachment => attachment.mimeType.startsWith('image/')) || null
  : null)
const authorText = computed(() => {
  const author = props.ticket.author || props.ticket.feedback?.tester
  return author ? displayName(author) : props.ticket.feedback?.testerEmail || null
})
const authorTitle = computed(() => props.ticket.author?.email || props.ticket.feedback?.testerEmail || '')
const completedTodoCount = computed(() => props.ticket.todos.filter(todo => todo.completed).length)
const laneOptions = computed(() => props.lanes.map(lane => ({ value: lane.id, label: lane.name })))
</script>

<template>
  <article
    :data-ticket-id="ticket.id"
    class="group relative cursor-grab rounded-[10px] bg-[var(--panel-strong)] p-4 shadow-[0_1px_1px_rgba(0,0,0,.10),0_0_1px_rgba(0,0,0,.12)] transition-[box-shadow,transform] duration-150 ease-out active:cursor-grabbing dark:shadow-[0_1px_2px_rgba(0,0,0,.55),0_0_1px_rgba(0,0,0,.6)]"
    :class="preview
      ? 'scale-[.99] cursor-grabbing opacity-[.96] shadow-[0_18px_45px_rgba(0,0,0,.18),0_3px_12px_rgba(0,0,0,.12)]'
      : 'hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/10'"
  >
    <button class="focus-ring block w-full rounded-lg text-left" :tabindex="preview ? -1 : undefined" @click="!preview && emit('open', ticket)">
      <div class="mb-3 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <PriorityPill :priority="ticket.priority" />
          <span v-if="ticket.source !== 'manual'" class="muted flex items-center gap-1 text-[11px] font-semibold">
            <TriangleAlert v-if="ticket.source === 'testflight_crash'" :size="13" />
            <Image v-else :size="13" />
            {{ ticket.source === 'testflight_crash' ? 'Crash' : 'Feedback' }}
          </span>
        </div>
        <UiAvatar v-if="ticket.assignee" :person="ticket.assignee" size="sm" :muted="ticket.assignee.status !== 'active'" />
      </div>

      <h3 class="text-[15px] font-semibold leading-snug tracking-[-.01em]">{{ ticket.title }}</h3>

      <img
        v-if="imageAttachment"
        :src="imageAttachment.url"
        :alt="imageAttachment.filename"
        class="mt-3 max-h-64 w-full rounded-none border-0 bg-transparent object-contain shadow-none outline-none"
        loading="lazy"
        draggable="false"
      >

      <div v-if="ticket.category" class="mt-3">
        <span class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold" :class="CATEGORY_TONE_CLASSES[ticket.category.color]"><Tag :size="11" /> {{ ticket.category.name }}</span>
      </div>

      <div v-if="ticket.todos.length" class="mt-3 rounded-lg bg-[color-mix(in_srgb,var(--panel)_65%,transparent)] px-2.5 py-2">
        <div class="muted mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[.06em]">
          <ListTodo :size="12" />
          <span>To-dos</span>
          <span class="ml-auto tabular-nums">{{ completedTodoCount }}/{{ ticket.todos.length }}</span>
        </div>
        <div class="space-y-1">
          <div v-for="todo in ticket.todos.slice(0, 3)" :key="todo.id" class="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight" :class="todo.completed ? 'muted' : ''">
            <span class="grid size-3 shrink-0 place-items-center rounded-[3px] border" :class="todo.completed ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--line)]'">
              <Check v-if="todo.completed" :size="9" :stroke-width="3" />
            </span>
            <span class="truncate" :class="todo.completed ? 'line-through' : ''">{{ todo.text }}</span>
          </div>
        </div>
        <p v-if="ticket.todos.length > 3" class="muted mt-1.5 text-[10px] font-semibold">+ {{ ticket.todos.length - 3 }} more</p>
      </div>

      <div v-if="ticket.labels.length" class="mt-3 flex flex-wrap gap-1.5">
        <span v-for="label in ticket.labels.slice(0, 3)" :key="label.id" class="rounded-md border border-[var(--line)] px-1.5 py-0.5 text-[10px] font-semibold">{{ label.name }}</span>
      </div>

      <div class="muted mt-4 border-t border-[var(--line)] pt-3 text-[11px]">
        <div v-if="authorText || cardDateText" class="flex items-center gap-3">
          <span v-if="authorText" class="flex min-w-0 items-center gap-1" :title="authorTitle">
            <UserRound :size="13" class="shrink-0" />
            <span class="truncate">{{ authorText }}</span>
          </span>
          <span v-if="cardDateText" class="ml-auto flex shrink-0 items-center gap-1"><CalendarClock :size="13" /> {{ cardDateText }}</span>
        </div>
        <div class="flex items-center gap-3" :class="authorText || cardDateText ? 'mt-2' : ''">
          <span v-if="ticket.buildNumber" class="flex min-w-0 items-center gap-1"><TestTubeDiagonal :size="13" class="shrink-0" /> <span class="truncate">Build {{ ticket.buildNumber }}</span></span>
          <span v-if="ticket.commentCount" class="flex shrink-0 items-center gap-1" :title="`${ticket.commentCount} comments`"><MessageSquare :size="13" /> {{ ticket.commentCount }}</span>
          <span class="ml-auto shrink-0 font-semibold tabular-nums">#{{ ticket.ticketNumber }}</span>
        </div>
      </div>
    </button>

    <div class="muted mt-3 block text-[10px] font-semibold uppercase tracking-wider sm:hidden">
      <span class="mb-1 block">Move</span>
      <UiSelect
        :model-value="ticket.laneId"
        :options="laneOptions"
        aria-label="Move ticket"
        compact
        @update:model-value="emit('move', $event)"
      />
    </div>

  </article>
</template>
