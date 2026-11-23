<script setup lang="ts">
import { AlarmClock, ArrowDownToLine, ArrowUpToLine, Check, ChevronDown, ChevronUp, CornerDownRight, Diamond, Image, Repeat, Link as LinkIcon, ListTodo, MessageSquare, Paperclip, Radio, SquareKanban, ListOrdered, Tag, TriangleAlert, Vote } from '@lucide/vue'
import type { Lane, Ticket } from '~~/shared/types/domain'
import { CATEGORY_TONE_CLASSES } from '~~/shared/utils/constants'
import { boardToday, daysUntil, dueDescription, dueLevel, liveDescription, liveLevel } from '~~/shared/utils/due-date'
import { cardImages } from '~~/shared/utils/card-images'
import { TODO_LIGHT_LABELS, decisionAnswer, todoLight } from '~~/shared/utils/todo-progress'
import { describeRecurrence } from '~~/shared/utils/recurrence'

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
  /** The ticket open in the detail panel: the card says so while the panel covers the board. */
  selected?: boolean
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
// Finished work is done with its deadline too: a done lane silences the warning. A live lane
// does as well, and lights the card by the end of its live window instead.
const lane = computed(() => props.lanes.find(item => item.id === props.ticket.laneId))
const inDoneLane = computed(() => Boolean(lane.value?.isDone))
const inLiveLane = computed(() => Boolean(lane.value?.isLive))
const dueState = computed(() => {
  if (inDoneLane.value) return 'none'
  if (inLiveLane.value) return liveLevel(props.ticket.liveUntil, today, props.dueWarningDays)
  return dueLevel(props.ticket.dueDate, today, { warningDays: props.dueWarningDays, alertDays: props.dueAlertDays })
})
// The due date sits in the footer, left of the assignee; its colour follows the border's warning level.
// Far-off dates and finished work read better as a date than as a count of days.
const dueDayFormatter = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const dayOf = (date: string) => dueDayFormatter.format(new Date(`${date}T00:00:00Z`))
// With a start as well the card reads as a span, "3 Mar – 14 Mar", until the countdown matters more.
const dueText = computed(() => {
  const { startDate, dueDate, liveFrom, liveUntil } = props.ticket
  if (inLiveLane.value) {
    if (liveUntil) return liveDescription(liveUntil, today, dayOf)
    return liveFrom ? `Live since ${dayOf(liveFrom)}` : 'Live'
  }
  if (!dueDate) return startDate ? `Starts ${dayOf(startDate)}` : null
  // A round finished early waits in its done lane for the next one.
  if (recurring.value && inDoneLane.value) return props.ticket.nextRound ? `Next ${dayOf(props.ticket.nextRound)}` : 'Series over'
  const days = daysUntil(dueDate, today)
  if (days === null) return null
  const span = startDate && startDate !== dueDate ? `${dayOf(startDate)} – ${dayOf(dueDate)}` : null
  // A milestone is a day, not a deadline: its date reads plain, beside a flag.
  if (inDoneLane.value || days > 30) return span ?? (props.ticket.schedule === 'milestone' ? dayOf(dueDate) : `Due ${dayOf(dueDate)}`)
  if (span && dueState.value === 'none') return span
  return dueDescription(dueDate, today)
})
const dueTitle = computed(() => {
  const { startDate, dueDate, liveFrom, liveUntil } = props.ticket
  if (inLiveLane.value) return `Live ${liveFrom ?? '…'} to ${liveUntil ?? '…'}`
  if (props.ticket.schedule === 'milestone') return `Milestone ${dueDate}`
  if (recurring.value) return `${describeRecurrence(props.ticket.recurrence!)} · this round is due ${dueDate}${props.ticket.nextRound ? `, the next one ${props.ticket.nextRound}` : ', the last of the series'}`
  if (startDate && dueDate) return startDate === dueDate ? `Due ${dueDate}` : `${startDate} to ${dueDate}`
  return startDate ? `Starts ${startDate}` : `Due ${dueDate}`
})

/**
 * What kind of date the card carries, told by the icon in its date: a card that comes round
 * again, an event on one day (a diamond, as on the timeline), work with a live window, or a
 * plain deadline.
 */
const recurring = computed(() => props.ticket.schedule === 'recurring' && Boolean(props.ticket.recurrence))
const scheduleKind = computed(() => {
  const { schedule, recurrence, liveFrom, liveUntil } = props.ticket
  if (recurring.value && recurrence) return { icon: Repeat, label: describeRecurrence(recurrence) }
  if (schedule === 'milestone') return { icon: Diamond, label: 'Milestone' }
  if (inLiveLane.value || liveFrom || liveUntil) return { icon: Radio, label: `Live ${liveFrom ?? '…'} to ${liveUntil ?? '…'}` }
  return { icon: AlarmClock, label: 'Deadline' }
})
// The last round went by unfinished, and the one on now is not finished either: worth a red mark.
const missedRound = computed(() => {
  const last = props.ticket.rounds[0]
  return recurring.value && last?.outcome === 'missed' && !inDoneLane.value ? last : null
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
  <!-- The ticket open in the detail panel lifts on a small, crisp, dark shadow while the panel covers the board. -->
  <article
    :data-ticket-id="ticket.id"
    :data-card-selected="selected || undefined"
    class="group relative overflow-hidden rounded-[10px] bg-[var(--panel-strong)] transition-[box-shadow,transform] duration-150 ease-out"
    :class="[
      draggable ? 'cursor-grab active:cursor-grabbing' : '',
      preview
        ? 'scale-[.99] cursor-grabbing opacity-[.96] shadow-[0_18px_45px_rgba(0,0,0,.18),0_3px_12px_rgba(0,0,0,.12)]'
        : selected
          ? '-translate-y-0.5 shadow-[0_4px_8px_rgba(0,0,0,.30),0_1px_3px_rgba(0,0,0,.28)]'
          : 'shadow-[0_1px_1px_rgba(0,0,0,.10),0_0_1px_rgba(0,0,0,.12)] hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/10',
      dropActive ? 'ring-2 ring-[var(--accent)]'
      : dueState === 'alert' ? 'ring-[3px] ring-rose-600'
        : dueState === 'warning' ? 'ring-2 ring-orange-400' : '',
    ]"
    @dragenter="fileDragOver"
    @dragover="fileDragOver"
    @dragleave="fileDragLeave"
    @drop="fileDrop"
  >
    <button class="focus-ring block w-full text-left" :aria-current="selected ? 'true' : undefined" :tabindex="preview ? -1 : undefined" @click="!preview && emit('open', ticket)">
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
          <span
            v-if="missedRound"
            class="inline-flex items-center gap-1 rounded-md bg-rose-600 px-1.5 py-0.5 text-[10px] font-semibold text-white"
            :title="`The round of ${missedRound.date} went by with ${missedRound.todosTotal - missedRound.todosDone} of ${missedRound.todosTotal} to-dos open`"
            data-missed-round
          ><TriangleAlert :size="11" aria-hidden="true" /> Missed {{ dayOf(missedRound.date) }}</span>
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
            <ListOrdered v-if="ticket.strictOrder" :size="12" title="Strict order: top to bottom" aria-label="Strict order" />
            <span class="ml-auto flex items-center gap-1.5 tabular-nums" :title="light ? TODO_LIGHT_LABELS[light] : undefined">
              <TodoLight v-if="light" :light="light" size="sm" />
              {{ completedTodoCount }}/{{ ticket.todos.length }}
            </span>
          </div>
          <div class="space-y-1">
            <div v-for="todo in visibleTodos" :key="todo.id" class="flex min-w-0 items-start gap-1.5 text-[11px] leading-tight" :class="todo.completed ? 'muted' : ''">
              <span v-if="todo.decision" class="mt-px grid size-3 shrink-0 place-items-center" :class="todo.completed ? 'text-[var(--accent)]' : ''" :title="todo.completed ? 'Decided' : 'Open decision'">
                <Vote :size="12" aria-hidden="true" />
              </span>
              <span v-else class="mt-px grid size-3 shrink-0 place-items-center rounded-[3px] border" :class="todo.completed ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--line)]'">
                <Check v-if="todo.completed" :size="9" :stroke-width="3" />
              </span>
              <!-- As in the editor: the title alone, and a subticket's number leading a second line. -->
              <span class="flex min-w-0 flex-col">
                <span class="truncate" :class="todo.completed && !todo.decision ? 'line-through' : ''">{{ todo.text }}</span>
                <!-- A decided question keeps its words; what it landed on is the news. -->
                <span v-if="todo.decision && todo.completed" class="flex min-w-0 items-center gap-1 text-[10px] font-semibold text-[var(--ink)]">
                  <CornerDownRight :size="10" class="shrink-0 text-[var(--accent)]" aria-hidden="true" />
                  <span class="truncate">{{ decisionAnswer(todo.decision) }}</span>
                </span>
                <span v-if="todo.subticket" class="muted flex min-w-0 items-center gap-1 text-[10px]">
                  <CornerDownRight :size="10" class="shrink-0" aria-hidden="true" />
                  <span class="shrink-0 font-semibold tabular-nums">#{{ todo.subticket.ticketNumber }}</span>
                  <span class="truncate">· {{ todo.subticket.boardName }} · {{ todo.subticket.laneName }}</span>
                </span>
              </span>
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
                : dueState === 'warning' ? 'bg-orange-400/20 text-orange-700'
                  : 'bg-[var(--panel)]'"
              :title="`${dueTitle}${recurring || ticket.schedule === 'milestone' ? '' : ` · ${scheduleKind.label}`}`"
            ><component :is="scheduleKind.icon" :size="12" class="shrink-0" :aria-label="scheduleKind.label" data-schedule-icon /> <span class="sr-only">{{ scheduleKind.label }}:</span> <span class="truncate">{{ dueText }}</span></span>
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
