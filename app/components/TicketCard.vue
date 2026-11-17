<script setup lang="ts">
import { AlarmClock, ArrowDownToLine, ArrowUpToLine, Check, ChevronDown, ChevronUp, Image, Link as LinkIcon, ListTodo, MessageSquare, Paperclip, SquareKanban, Tag, TriangleAlert } from '@lucide/vue'
import type { Lane, Ticket } from '~~/shared/types/domain'
import { CATEGORY_TONE_CLASSES } from '~~/shared/utils/constants'
import { boardToday, daysUntil, dueDescription, dueLevel } from '~~/shared/utils/due-date'
import { cardImages } from '~~/shared/utils/card-images'
import { TODO_LIGHT_LABELS, todoLight } from '~~/shared/utils/todo-progress'

const props = withDefaults(defineProps<{
  ticket: Ticket
  index: number
  lanes: Lane[]
  preview?: boolean
  showScreenshot?: boolean
  /** How many tickets share the lane; greys out a reorder that would change nothing. */
  laneCount?: number
  /** Off on the phone, where a finger would rather scroll than drag and the buttons reorder instead. */
  draggable?: boolean
  /** Whether files dragged in from the desktop may be dropped on the card as attachments. */
  droppable?: boolean
  /** The board's lead times: orange from this many days before the due date, red from the other. */
  dueWarningDays?: number
  dueAlertDays?: number
}>(), { laneCount: 0, draggable: true, droppable: false, dueWarningDays: 7, dueAlertDays: 1 })
const emit = defineEmits<{
  open: [ticket: Ticket]
  move: [laneId: string]
  reorder: [placement: 'top' | 'up' | 'down' | 'bottom']
  dropFiles: [files: File[]]
}>()

// Files from the desktop arrive as a native drag; moving cards runs on pointer events, so the two never meet.
const dropActive = ref(false)
const carriesFiles = (event: DragEvent) => props.droppable && !props.preview && Boolean(event.dataTransfer?.types.includes('Files'))
function fileDragOver(event: DragEvent) {
  if (!carriesFiles(event)) return
  event.preventDefault()
  event.dataTransfer!.dropEffect = 'copy'
  dropActive.value = true
}
function fileDragLeave(event: DragEvent) {
  // Crossing onto a child of the card fires a leave as well; only the way out counts.
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) dropActive.value = false
}
function fileDrop(event: DragEvent) {
  if (!carriesFiles(event)) return
  event.preventDefault()
  dropActive.value = false
  const files = Array.from(event.dataTransfer!.files)
  if (files.length) emit('dropFiles', files)
}

const today = boardToday()
// Finished work is done with its deadline too: a done lane silences the warning.
const inDoneLane = computed(() => props.lanes.some(lane => lane.id === props.ticket.laneId && lane.isDone))
const dueState = computed(() => (inDoneLane.value ? 'none' : dueLevel(props.ticket.dueDate, today, { warningDays: props.dueWarningDays, alertDays: props.dueAlertDays })))
// The due date sits in the footer, left of the assignee; its colour follows the border's warning level.
// Far-off dates and finished work read better as a date than as a count of days.
const dueDayFormatter = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const dueText = computed(() => {
  const dueDate = props.ticket.dueDate
  if (!dueDate) return null
  const days = daysUntil(dueDate, today)
  if (days === null) return null
  if (inDoneLane.value || days > 30) return `Due ${dueDayFormatter.format(new Date(`${dueDate}T00:00:00Z`))}`
  return dueDescription(dueDate, today)
})

// The pictures ticked in the editor, or one picked by default (see `cardImages`). A link
// preview finished since the board was loaded is already counted, before the next reload.
const { finished: finishedPreviews } = useLinkPreviews()
const MAX_CARD_IMAGES = 4
const images = computed(() => {
  if (!props.showScreenshot) return []
  const links = props.ticket.links.map(link => ({ ...link, preview: finishedPreviews.value[link.id]?.preview ?? link.preview }))
  return cardImages({ ...props.ticket, links })
})
const moreImages = computed(() => Math.max(0, images.value.length - MAX_CARD_IMAGES))
const completedTodoCount = computed(() => props.ticket.todos.filter(todo => todo.completed).length)
// Green once everything — subtickets included — is done, orange from half, red below.
const light = computed(() => todoLight(props.ticket.todos))
// The card shows the first three to-dos; "+ N more" unfolds the rest right on the card.
const COLLAPSED_TODOS = 3
const todosExpanded = ref(false)
const visibleTodos = computed(() => (todosExpanded.value ? props.ticket.todos : props.ticket.todos.slice(0, COLLAPSED_TODOS)))
// The host is enough to tell where a link leads; the whole address is in the title.
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
const linkHost = computed(() => (props.ticket.link ? hostOf(props.ticket.link) : null))
/** "+N" unfolds every link on the card, each its own way out, instead of opening the first. */
const linksExpanded = ref(false)
const laneOptions = computed(() => props.lanes.map(lane => ({ value: lane.id, label: lane.name })))

// The phone has no drag between cards, so the card offers the four reorder steps itself.
const atTop = computed(() => props.index <= 0)
const atBottom = computed(() => props.index >= props.laneCount - 1)
const reorderButtons = computed(() => [
  { placement: 'top' as const, label: 'Move to top of lane', icon: ArrowUpToLine, disabled: atTop.value },
  { placement: 'up' as const, label: 'Move up', icon: ChevronUp, disabled: atTop.value },
  { placement: 'down' as const, label: 'Move down', icon: ChevronDown, disabled: atBottom.value },
  { placement: 'bottom' as const, label: 'Move to bottom of lane', icon: ArrowDownToLine, disabled: atBottom.value },
])
</script>

<template>
  <article
    :data-ticket-id="ticket.id"
    class="group relative overflow-hidden rounded-[10px] bg-[var(--panel-strong)] shadow-[0_1px_1px_rgba(0,0,0,.10),0_0_1px_rgba(0,0,0,.12)] transition-[box-shadow,transform] duration-150 ease-out dark:shadow-[0_1px_2px_rgba(0,0,0,.55),0_0_1px_rgba(0,0,0,.6)]"
    :class="[
      draggable ? 'cursor-grab active:cursor-grabbing' : '',
      preview
        ? 'scale-[.99] cursor-grabbing opacity-[.96] shadow-[0_18px_45px_rgba(0,0,0,.18),0_3px_12px_rgba(0,0,0,.12)]'
        : 'hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/10',
      dropActive ? 'ring-2 ring-[var(--accent)]'
      : dueState === 'alert' ? 'ring-[3px] ring-rose-600'
        : dueState === 'warning' ? 'ring-2 ring-orange-400' : '',
    ]"
    @dragenter="fileDragOver"
    @dragover="fileDragOver"
    @dragleave="fileDragLeave"
    @drop="fileDrop"
  >
    <button class="focus-ring block w-full text-left" :tabindex="preview ? -1 : undefined" @click="!preview && emit('open', ticket)">
      <!--
        Only the header wears the type's tone: title on the left, the type's mark on the right.
        An untyped ticket — or a type without a colour — keeps the plain panel.
      -->
      <div
        class="flex items-center justify-between gap-3 px-4 py-3.5"
        :class="ticket.type && ticket.type.color !== 'none' ? CATEGORY_TONE_CLASSES[ticket.type.color] : ''"
      >
        <h3 class="min-w-0 text-[15px] font-semibold leading-snug tracking-[-.01em]">{{ ticket.title }}</h3>
        <TicketTypeBadge v-if="ticket.type" :type="ticket.type" inverted class="pointer-events-none" />
      </div>

      <div class="px-4 pb-4 pt-3">
        <div class="flex flex-wrap items-center gap-2">
          <PriorityPill :priority="ticket.priority" />
          <span v-if="ticket.category" class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold" :class="CATEGORY_TONE_CLASSES[ticket.category.color]"><Tag :size="11" /> {{ ticket.category.name }}</span>
          <span v-if="ticket.source !== 'manual'" class="muted flex items-center gap-1 text-[11px] font-semibold" :title="ticket.jira?.url || ''">
            <TriangleAlert v-if="ticket.source === 'testflight_crash'" :size="13" />
            <SquareKanban v-else-if="ticket.source === 'jira_issue'" :size="13" />
            <Image v-else :size="13" />
            {{ ticket.source === 'testflight_crash' ? 'Crash' : ticket.source === 'jira_issue' ? (ticket.jira?.issueKey || 'Jira') : 'Feedback' }}
          </span>
        </div>

        <img
          v-if="images.length === 1"
          :src="images[0]!.url"
          :alt="images[0]!.label"
          class="mt-3 max-h-64 w-full rounded-none border-0 bg-transparent object-contain shadow-none outline-none"
          loading="lazy"
          draggable="false"
        >
        <!-- Several pictures share the width in pairs, three with the first across; past four, the last one says how many more. -->
        <div v-else-if="images.length" class="mt-3 grid grid-cols-2 gap-1">
          <div v-for="(image, index) in images.slice(0, MAX_CARD_IMAGES)" :key="image.id" class="relative overflow-hidden rounded-md bg-black/5" :class="images.length === 3 && index === 0 ? 'col-span-2' : ''">
            <img :src="image.url" :alt="image.label" class="aspect-video w-full object-cover" loading="lazy" draggable="false">
            <span v-if="moreImages && index === MAX_CARD_IMAGES - 1" class="absolute inset-0 grid place-items-center bg-black/55 text-sm font-bold text-white">+{{ moreImages }}</span>
          </div>
        </div>

        <div v-if="ticket.todos.length" class="mt-3 rounded-lg bg-[color-mix(in_srgb,var(--panel)_65%,transparent)] px-2.5 py-2">
          <div class="muted mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[.06em]">
            <ListTodo :size="12" />
            <span>To-dos</span>
            <span class="ml-auto flex items-center gap-1.5 tabular-nums" :title="light ? TODO_LIGHT_LABELS[light] : undefined">
              <TodoLight v-if="light" :light="light" size="sm" />
              {{ completedTodoCount }}/{{ ticket.todos.length }}
            </span>
          </div>
          <div class="space-y-1">
            <div v-for="todo in visibleTodos" :key="todo.id" class="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight" :class="todo.completed ? 'muted' : ''">
              <span class="grid size-3 shrink-0 place-items-center rounded-[3px] border" :class="todo.completed ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--line)]'">
                <Check v-if="todo.completed" :size="9" :stroke-width="3" />
              </span>
              <span class="truncate" :class="todo.completed ? 'line-through' : ''"><span v-if="todo.subticket" class="font-semibold tabular-nums" :title="`Subticket on ${todo.subticket.boardName} · ${todo.subticket.laneName}`">#{{ todo.subticket.ticketNumber }} </span>{{ todo.text }}</span>
            </div>
          </div>
          <!-- Inside the card's own button, so a span acting as one; the click stays off the card. -->
          <span
            v-if="ticket.todos.length > COLLAPSED_TODOS"
            role="button"
            :tabindex="preview ? -1 : 0"
            class="focus-ring muted mt-1.5 inline-block rounded text-[10px] font-semibold hover:text-[var(--accent)] hover:underline"
            :aria-expanded="todosExpanded"
            @click.stop="todosExpanded = !todosExpanded"
            @keydown.enter.stop.prevent="todosExpanded = !todosExpanded"
            @keydown.space.stop.prevent="todosExpanded = !todosExpanded"
          >{{ todosExpanded ? 'Show less' : `+ ${ticket.todos.length - COLLAPSED_TODOS} more` }}</span>
        </div>

        <div v-if="ticket.labels.length" class="mt-3 flex flex-wrap gap-1.5">
          <span v-for="label in ticket.labels.slice(0, 3)" :key="label.id" class="rounded-md border border-[var(--line)] px-1.5 py-0.5 text-[10px] font-semibold">{{ label.name }}</span>
        </div>

        <div class="muted mt-4 border-t border-[var(--line)] pt-3 text-[11px]">
          <!-- Links and the comment count get a line of their own, so a long host never squeezes the due date. -->
          <div v-if="ticket.link || ticket.commentCount" class="mb-2 flex items-center gap-3">
            <!-- Unfolded, the list below already holds the first link, so it is not shown twice. -->
            <a
              v-if="ticket.link && !linksExpanded"
              :href="ticket.link"
              target="_blank"
              rel="noopener noreferrer"
              class="focus-ring flex min-w-0 items-center gap-1 rounded hover:text-[var(--accent)] hover:underline"
              :title="ticket.link"
              draggable="false"
              @click.stop
            ><LinkIcon :size="13" class="shrink-0" /> <span class="truncate">{{ linkHost }}</span></a>
            <!-- Inside the card's own button, so a span acting as one; the click stays off the card and off the link. -->
            <span
              v-if="ticket.links.length > 1"
              role="button"
              :tabindex="preview ? -1 : 0"
              :class="linksExpanded ? '-ml-1' : '-ml-2'"
              class="focus-ring shrink-0 rounded px-1 font-semibold hover:bg-[var(--panel)] hover:text-[var(--accent)]"
              :aria-expanded="linksExpanded"
              :aria-label="linksExpanded ? 'Hide the links' : `Show all ${ticket.links.length} links`"
              :title="linksExpanded ? 'Hide the links' : `Show all ${ticket.links.length} links`"
              @click.stop="linksExpanded = !linksExpanded"
              @keydown.enter.stop.prevent="linksExpanded = !linksExpanded"
              @keydown.space.stop.prevent="linksExpanded = !linksExpanded"
            >{{ linksExpanded ? 'Hide' : `+${ticket.links.length - 1}` }}</span>
            <span v-if="ticket.commentCount" class="ml-auto flex shrink-0 items-center gap-1" :title="`${ticket.commentCount} comments`"><MessageSquare :size="13" /> {{ ticket.commentCount }}</span>
          </div>
          <ul v-if="linksExpanded && ticket.links.length > 1" class="mb-2 space-y-1 rounded-lg bg-[var(--panel)] px-2.5 py-2">
            <li v-for="link in ticket.links" :key="link.id">
              <a
                :href="link.url"
                target="_blank"
                rel="noopener noreferrer"
                class="focus-ring flex min-w-0 items-center gap-1.5 rounded hover:text-[var(--accent)] hover:underline"
                :title="link.url"
                draggable="false"
                @click.stop
              >
                <LinkIcon :size="12" class="shrink-0" />
                <span class="shrink-0 font-semibold">{{ hostOf(link.url) }}</span>
                <span v-if="link.preview.title" class="truncate opacity-80">· {{ link.preview.title }}</span>
              </a>
            </li>
          </ul>
          <!-- Who filed it and when stay in the editor; the card keeps when it is due, who holds it and its number. -->
          <div class="flex items-center gap-3">
            <span
              v-if="dueText"
              class="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold"
              :class="dueState === 'alert' ? 'bg-rose-600 text-white'
                : dueState === 'warning' ? 'bg-orange-400/20 text-orange-700 dark:text-orange-300'
                  : 'bg-[var(--panel)]'"
              :title="`Due ${ticket.dueDate}`"
            ><AlarmClock :size="12" class="shrink-0" aria-hidden="true" /> <span class="truncate">{{ dueText }}</span></span>
            <span class="ml-auto flex shrink-0 items-center gap-2">
              <UiAvatar v-if="ticket.assignee" :person="ticket.assignee" size="sm" :muted="ticket.assignee.status !== 'active'" />
              <span class="font-semibold tabular-nums">#{{ ticket.ticketNumber }}</span>
            </span>
          </div>
        </div>
      </div>
    </button>

    <div class="muted block px-4 pb-4 text-[10px] font-semibold uppercase tracking-wider sm:hidden">
      <span class="mb-1 block">Move</span>
      <div class="flex items-center gap-1.5">
        <div class="min-w-0 flex-1">
          <UiSelect
            :model-value="ticket.laneId"
            :options="laneOptions"
            aria-label="Move ticket"
            compact
            @update:model-value="emit('move', $event)"
          />
        </div>
        <button
          v-for="action in reorderButtons"
          :key="action.placement"
          type="button"
          class="focus-ring muted grid size-8 shrink-0 place-items-center rounded-lg border border-[var(--line)] transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--line)] disabled:hover:bg-transparent"
          :disabled="preview || action.disabled"
          :aria-label="action.label"
          :title="action.label"
          @click="emit('reorder', action.placement)"
        >
          <component :is="action.icon" :size="15" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div v-if="dropActive" class="pointer-events-none absolute inset-0 grid place-items-center bg-[color-mix(in_srgb,var(--accent-soft)_88%,transparent)] text-sm font-semibold text-[var(--accent)]">
      <span class="flex items-center gap-2"><Paperclip :size="16" /> Drop to attach</span>
    </div>
  </article>
</template>
