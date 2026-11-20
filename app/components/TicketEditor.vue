<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import { AlarmClock, Archive, ArrowDownToLine, ArrowRightLeft, ArrowUpToLine, Calendar, CalendarArrowUp, CalendarClock, CalendarRange, Check, ChevronDown, Flag, Circle, CircleAlert, CircleCheck, CornerDownRight, CornerLeftUp, Download, ExternalLink, FileText, Gauge, GripVertical, History, Link2, ListTodo, LoaderCircle, MessageSquare, Paperclip, PenLine, Pin, PinOff, Plus, Radio, Shapes, SquareKanban, Tag, Tags, TestTubeDiagonal, Trash2, Upload, UserRound, X } from '@lucide/vue'
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  VisuallyHidden,
} from 'reka-ui'
import type { Attachment, BoardMember, DependencyRef, ShiftResult, Category, LabelSummary, Lane, SubticketRef, Ticket, TicketLinkInput, TicketPatch, TicketPriority, TicketSchedule, TicketTodoInput, TicketType, BoardSummary } from '~~/shared/types/domain'
import { TODO_LIGHT_LABELS, todoLight } from '~~/shared/utils/todo-progress'
import { PRIORITY_LABELS } from '~~/shared/utils/constants'
import { boardToday, dueDescription, dueLevel, liveDescription, liveLevel } from '~~/shared/utils/due-date'
import { dependencyWarnings } from '~~/shared/utils/timeline'
import { cardImageCandidates, cardImages } from '~~/shared/utils/card-images'

const props = withDefaults(defineProps<{ ticket?: Ticket | null; lanes: Lane[]; members?: BoardMember[]; canEdit?: boolean; canModerate?: boolean; categories?: Category[]; labels?: LabelSummary[]; ticketTypes?: TicketType[]; saving?: boolean; /** How the last field-by-field save went; shown in the footer of an existing ticket. */ saveState?: 'idle' | 'saving' | 'saved' | 'error'; deletingAttachmentId?: string | null; initialLaneId?: string | null; initialPlacement?: 'top' | 'bottom'; laneTicketCount?: number; /** Other boards of the workspace the ticket may be moved onto. */ boards?: BoardSummary[]; /** Boards of the workspace a subticket may be filed on, this one included. */ subticketBoards?: BoardSummary[]; /** Whether the board has TestFlight connected; without it a build number has nothing to refer to. */ testflight?: boolean; /** The board's lead times for the due date warning, as on the card. */ dueWarningDays?: number; dueAlertDays?: number }>(), { canEdit: true, testflight: true, dueWarningDays: 7, dueAlertDays: 1, saveState: 'idle', initialLaneId: null, initialPlacement: 'bottom', laneTicketCount: 0, boards: () => [], subticketBoards: () => [] })
const emit = defineEmits<{
  close: []
  /** Dates moved by a shift: this ticket and others changed on the server, so the board reloads. */
  shifted: []
  /** Creates a new ticket. An existing one never comes through here: its fields save themselves via `patch`. */
  save: [payload: TicketPatch & { laneId?: string; placement?: 'top' | 'bottom'; todos: TicketTodoInput[]; attachments: File[]; stayOpen?: boolean }]
  /** One or more fields of an existing ticket, sent the moment they change. */
  patch: [ticket: Ticket, changes: TicketPatch]
  /** Files added to an existing ticket, uploaded right away. */
  upload: [ticket: Ticket, files: File[]]
  commented: []
  notify: [type: 'success' | 'error', text: string]
  move: [ticket: Ticket, laneId: string]
  reorder: [ticket: Ticket, placement: 'top' | 'bottom']
  transfer: [ticket: Ticket, boardId: string, laneId: string]
  archive: [ticket: Ticket]
  removeAttachment: [attachment: Attachment]
  saveDescription: [ticket: Ticket, description: string]
  saveTitle: [ticket: Ticket, title: string]
  /** A new ticket filed as a to-do of this one; `done` says whether it worked, so the dialog can close. */
  createSubticket: [ticket: Ticket, input: { boardId: string; laneId: string; title: string; description: string }, done: (ok: boolean) => void]
}>()

const form = reactive({ title: '', description: '', priority: 'medium' as TicketPriority, startDate: '', dueDate: '', liveFrom: '', liveUntil: '', buildNumber: '', assigneeId: 'unassigned', authorId: 'unassigned', labels: [] as string[], categoryName: '', typeId: 'none', laneId: '', placement: 'bottom' as 'top' | 'bottom' })
// Lit the same way as the card, and follows the field while it is being changed.
const today = boardToday()
const currentLane = computed(() => {
  const laneId = props.ticket ? props.ticket.laneId : form.laneId
  return props.lanes.find(lane => lane.id === laneId)
})
// A done lane and a live lane both mean the work is finished: the due date goes quiet.
const inDoneLane = computed(() => Boolean(currentLane.value?.isDone || currentLane.value?.isLive))
const inLiveLane = computed(() => Boolean(currentLane.value?.isLive))
const dueState = computed(() => (inDoneLane.value ? 'none' : dueLevel(form.dueDate || null, today, { warningDays: props.dueWarningDays, alertDays: props.dueAlertDays })))
const dueText = computed(() => (dueState.value === 'none' ? null : dueDescription(form.dueDate, today)))
// The live window only lights up while the ticket is in a live lane, as on the card.
const liveState = computed(() => (inLiveLane.value ? liveLevel(form.liveUntil || null, today, props.dueWarningDays) : 'none'))
const liveText = computed(() => (liveState.value === 'none' || !form.liveUntil ? null : liveDescription(form.liveUntil, today, date => date)))
// Schedule: a plain ticket has no days at all; a milestone has one, an event; a lifecycle has
// start, due date and live window. A choice not saved yet — a milestone still without its
// day — is held here until the date comes, and the saved one counts again once it agrees.
const scheduleChoice = ref<TicketSchedule | null>(null)
const schedule = computed<TicketSchedule>(() => scheduleChoice.value ?? props.ticket?.schedule ?? 'none')
const lifecycleOn = computed(() => schedule.value !== 'none')
const SCHEDULE_OPTIONS: Array<{ value: TicketSchedule; label: string; title: string }> = [
  { value: 'none', label: 'None', title: 'No dates: removes every date and what it waits on' },
  { value: 'milestone', label: 'Milestone', title: 'One day, an event: a meeting, a go-live' },
  { value: 'lifecycle', label: 'Lifecycle', title: 'Work from start to due date, then a live window; a due date alone is a deadline' }
]
interface EditableTodo extends TicketTodoInput { key: string; subticket?: SubticketRef | null }
const todos = ref<EditableTodo[]>([])
const links = ref<TicketLinkInput[]>([])
// The category value whose save is still on its way, see `commitCategory`.
let categoryInFlight: string | null | undefined
let todoSequence = 0
const isEdit = computed(() => Boolean(props.ticket))
const isManual = computed(() => !props.ticket || props.ticket.source === 'manual')
const showBuildNumber = computed(() => isManual.value && props.testflight)
const titleInput = ref<HTMLTextAreaElement | null>(null)
const descriptionInput = ref<HTMLTextAreaElement | null>(null)

// Title and description are the two fields with a Save button of their own: one writes in
// them for a while, and the description flips to rendered Markdown, so a change should be
// deliberate. Everything else saves the moment it changes (see `commit`). Both open as text
// on a click and start out open on a new ticket, which has nothing to show yet.
const editingTitle = ref(true)
const hasSavedTitle = computed(() => Boolean(props.ticket?.title?.trim()))
const titleChanged = computed(() => form.title.trim() !== (props.ticket?.title || ''))
function editTitle() {
  if (!props.canEdit) return
  editingTitle.value = true
  nextTick(() => titleInput.value?.focus())
}
function cancelTitle() {
  form.title = props.ticket?.title || ''
  editingTitle.value = false
}
function saveTitle() {
  const title = form.title.trim()
  if (!props.ticket || !title) return
  if (title === props.ticket.title) return void (editingTitle.value = false)
  emit('saveTitle', props.ticket, title)
}

const editingDescription = ref(true)
// Whitespace counts as nothing: a description of blanks would otherwise open as an empty
// preview with only an Edit button, and the field would look broken.
const hasSavedDescription = computed(() => Boolean(props.ticket?.description?.trim()))
function editDescription() {
  if (!props.canEdit) return
  editingDescription.value = true
  nextTick(() => descriptionInput.value?.focus())
}
function cancelDescription() {
  form.description = props.ticket?.description || ''
  editingDescription.value = false
}
// Closing throws away what was never saved: everything typed into a new ticket, and on an
// existing one a title or description still waiting for its Save. So it asks first.
const hasUnsavedWork = computed(() => {
  const ticket = props.ticket
  if (ticket) return props.canEdit && (form.title.trim() !== ticket.title.trim() || form.description !== (ticket.description || ''))
  return Boolean(form.title.trim() || form.description.trim() || todos.value.some(todo => todo.text.trim()) || pendingFiles.value.length
    || form.labels.length || form.categoryName.trim() || links.value.length || form.buildNumber.trim() || form.startDate || form.dueDate || form.liveFrom || form.liveUntil)
})
const discardOpen = ref(false)
function requestClose() {
  if (hasUnsavedWork.value) discardOpen.value = true
  else emit('close')
}
function discard() {
  discardOpen.value = false
  emit('close')
}

// Saved on its own, like a lane move: the parent replaces the ticket, and the watch below
// flips back to the rendered view. A failed save therefore leaves the textarea open.
function saveDescription() {
  if (props.ticket) emit('saveDescription', props.ticket, form.description)
}

// An import only gains an author when its tester already had an account, so most of them
// show the tester instead — who becomes a colleague the moment somebody invites them.
const person = computed(() => {
  const author = props.ticket?.author
  if (author) return { name: displayName(author), email: author.email || '', role: 'Author' }
  const tester = props.ticket?.feedback?.tester
  if (tester) return { name: displayName(tester), email: tester.email || '', role: 'TestFlight tester' }
  // Jira rarely shares an address, so its reporter is usually a name without a row here.
  const jira = props.ticket?.jira
  if (jira?.reporter) return { name: displayName(jira.reporter), email: jira.reporter.email || '', role: 'Jira reporter' }
  return jira?.reporterName ? { name: jira.reporterName, email: '', role: 'Jira reporter' } : null
})

// reka-ui refuses an empty `SelectItem` value, so "nobody" needs a sentinel. No id can
// collide with it, since every id is a uuid.
const UNASSIGNED = 'unassigned'
const memberOptions = computed(() => (props.members || []).map(member => ({ value: member.userId, label: member.isService ? `${displayName(member)} · agent` : displayName(member) })))
const assigneeOptions = computed(() => [{ value: UNASSIGNED, label: 'Unassigned' }, ...memberOptions.value])
// The shortcut beside the label: only for a member of this board, and only while the
// ticket is not theirs already.
const { user } = useAuth()
const canAssignSelf = computed(() => {
  const id = user.value?.id
  return Boolean(props.canEdit && id && form.assigneeId !== id && (props.members || []).some(member => member.userId === id))
})
// Shown beside the assignee: whoever reported an existing ticket, and for a new one the
// person about to file it.
const author = computed(() => {
  if (props.ticket) return person.value
  return user.value ? { name: displayName(user.value), email: user.value.email || '', role: 'Author' } : null
})
function assignToMe() {
  const id = user.value?.id
  if (!id || !canAssignSelf.value) return
  form.assigneeId = id
  commit({ assigneeId: id })
}

/**
 * Attribution is a claim about who reported something, so correcting it stays with the
 * board's admins. Only imports need it: a ticket filed here already knows who wrote it.
 */
const canAttribute = computed(() => Boolean(props.canModerate && props.ticket && !isManual.value))
const authorOptions = computed(() => [{ value: UNASSIGNED, label: 'Nobody' }, ...memberOptions.value])
const commentRefreshKey = ref(0)

/**
 * The drawer shows one pane at a time, picked in the header: the ticket's details, its plan
 * (to-dos, subtickets, what it waits on), its comments, its files and links, or its history. Comments and files can each be pinned instead: a pinned pane
 * stands as a column of its own beside whichever pane the header shows, and its tab only
 * points at it. Nothing is pinned until somebody pins it; the choice belongs to the ticket
 * and lasts for this browser tab's session.
 */
type EditorTab = 'details' | 'plan' | 'comments' | 'files' | 'history'
type PinnableTab = 'comments' | 'files'
const isPinnable = (tab: EditorTab): tab is PinnableTab => tab === 'comments' || tab === 'files'
const activeTab = ref<EditorTab>('details')
const pinned = reactive<Record<PinnableTab, boolean>>({ comments: false, files: false })
const pinnedKey = (ticketId: string) => `open-bugster-ticket-pinned:${ticketId}`
function restorePinned(ticketId: string | undefined) {
  pinned.comments = pinned.files = false
  if (!ticketId) return
  try {
    const stored = JSON.parse(sessionStorage.getItem(pinnedKey(ticketId)) || '{}')
    pinned.comments = stored.comments === true
    pinned.files = stored.files === true
  } catch {
    // Nothing stored, or nothing readable: nothing is pinned.
  }
}
function rememberPinned() {
  // A ticket not yet created has nowhere to keep it: its pins last as long as the editor.
  if (!props.ticket) return
  try {
    if (pinned.comments || pinned.files) sessionStorage.setItem(pinnedKey(props.ticket.id), JSON.stringify(pinned))
    else sessionStorage.removeItem(pinnedKey(props.ticket.id))
  } catch {
    // Private mode or a full store: pinning still works, it just forgets.
  }
}
// The thread lives on the saved ticket, so a brand-new one has no comments to show.
const commentsAvailable = computed(() => Boolean(props.ticket))
const commentsPinned = computed(() => commentsAvailable.value && pinned.comments)
const commentsShown = computed(() => commentsAvailable.value && (pinned.comments || activeTab.value === 'comments'))
const filesShown = computed(() => pinned.files || activeTab.value === 'files')
// Once shown, the thread stays mounted and is only hidden: a comment half written is still there when it comes back.
const commentsMounted = ref(false)
watch(commentsShown, (shown) => { if (shown) commentsMounted.value = true }, { immediate: true })
// Comments and history live on the saved ticket, so a brand-new one shows neither.
const editorTabs = computed(() => ([
  { key: 'details', label: 'Details' },
  { key: 'plan', label: 'Plan' },
  ...(commentsAvailable.value ? [{ key: 'comments', label: 'Comments' }] : []),
  { key: 'files', label: 'Assets' },
  ...(props.ticket ? [{ key: 'history', label: 'History' }] : [])
] as { key: EditorTab, label: string }[]))
const fileCount = computed(() => (props.ticket?.attachments.length || 0) + pendingFiles.value.length)

function scrollPaneIntoView(tab: EditorTab) {
  nextTick(() => {
    const scroller = document.querySelector<HTMLElement>('[data-ticket-editor-scroll]')
    const pane = document.querySelector<HTMLElement>(`[data-editor-pane="${tab}"]`)
    if (!scroller || !pane) return
    // A pane in the main column starts at the top; a pinned one is only brought into view (on a phone it sits below).
    if (tab === activeTab.value) scroller.scrollTop = 0
    else pane.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
}
function selectTab(tab: EditorTab) {
  if (isPinnable(tab) && pinned[tab]) return scrollPaneIntoView(tab)
  activeTab.value = tab
  scrollPaneIntoView(tab)
}
function togglePin(tab: PinnableTab) {
  pinned[tab] = !pinned[tab]
  // A pane pinned out of the main column leaves the details there; one unpinned simply goes.
  if (pinned[tab] && activeTab.value === tab) activeTab.value = 'details'
  rememberPinned()
}

/**
 * The editor's header grows with the parents and the tabs, so what sticks below it is
 * placed by its measured height rather than a guess.
 */
const headerHeight = ref(72)
let headerObserver: ResizeObserver | undefined
// The header renders in the dialog's portal; a function ref sees it whenever it comes and goes.
function observeHeader(header: Element | ComponentPublicInstance | null) {
  headerObserver?.disconnect()
  headerObserver = undefined
  if (!(header instanceof HTMLElement) || typeof ResizeObserver === 'undefined') return
  const measure = () => { if (header.offsetHeight) headerHeight.value = header.offsetHeight }
  nextTick(measure)
  headerObserver = new ResizeObserver(measure)
  headerObserver.observe(header)
}
onBeforeUnmount(() => headerObserver?.disconnect())

/**
 * A pinned files column can be dragged wider, from its narrow default up to about the width
 * of a comments column. Only the files column changes: the drawer grows by as much, so the
 * other columns keep their width — as long as the window has the room, which caps the drag.
 * The width is one for every ticket, kept in this browser.
 */
const FILES_WIDTH_KEY = 'open-bugster-ticket-files-width'
const FILES_MIN_WIDTH = 240
// The drawer with one pane, and with the comments pinned beside it (two equal columns).
const DRAWER_WIDTH = 672
const DRAWER_WIDTH_WITH_COMMENTS = 1120
const FILES_MAX_WIDTH = 504
const LG_BREAKPOINT = 1024
const columns = ref<HTMLElement | null>(null)
const filesWidth = ref(FILES_MIN_WIDTH)
const resizingFiles = ref(false)
const viewportWidth = ref(LG_BREAKPOINT)
const baseDrawerWidth = computed(() => commentsPinned.value && viewportWidth.value >= LG_BREAKPOINT ? DRAWER_WIDTH_WITH_COMMENTS : DRAWER_WIDTH)
const maxFilesWidth = () => Math.max(FILES_MIN_WIDTH, Math.min(FILES_MAX_WIDTH, viewportWidth.value - baseDrawerWidth.value))
const shownFilesWidth = computed(() => Math.min(filesWidth.value, maxFilesWidth()))
const drawerStyle = computed(() => ({
  maxWidth: `${baseDrawerWidth.value + (pinned.files ? shownFilesWidth.value : 0)}px`,
  '--files-width': `${shownFilesWidth.value}px`,
  '--editor-header': `${headerHeight.value}px`
}))
// One column per pinned pane, the main one first; on a phone they all stack.
const columnsClass = computed(() => {
  if (commentsPinned.value && pinned.files) return 'sm:grid-cols-[minmax(0,1fr)_var(--files-width)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_var(--files-width)]'
  if (pinned.files) return 'sm:grid-cols-[minmax(0,1fr)_var(--files-width)]'
  if (commentsPinned.value) return 'sm:grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'
  return 'sm:grid-cols-1'
})
const measureViewport = () => { viewportWidth.value = window.innerWidth }
onMounted(() => {
  measureViewport()
  window.addEventListener('resize', measureViewport)
})
onBeforeUnmount(() => window.removeEventListener('resize', measureViewport))

function setFilesWidth(width: number) {
  filesWidth.value = Math.round(Math.min(maxFilesWidth(), Math.max(FILES_MIN_WIDTH, width)))
}
function rememberFilesWidth() {
  try {
    localStorage.setItem(FILES_WIDTH_KEY, String(filesWidth.value))
  } catch {
    // As with pinning: the column still resizes, it just forgets.
  }
}
onMounted(() => {
  try {
    const stored = Number(localStorage.getItem(FILES_WIDTH_KEY))
    if (stored >= FILES_MIN_WIDTH) filesWidth.value = Math.round(stored)
  } catch {
    // Nothing stored, or nothing readable: the default stands.
  }
})

function startFilesResize(event: PointerEvent) {
  if (event.button !== 0 || !columns.value) return
  event.preventDefault()
  // The column is the rightmost one, so its width is wherever the pointer is, counted from the right.
  const right = columns.value.getBoundingClientRect().right
  setFilesWidth(right - event.clientX)
  resizingFiles.value = true
  const move = (moved: PointerEvent) => setFilesWidth(right - moved.clientX)
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
    resizingFiles.value = false
    rememberFilesWidth()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
  window.addEventListener('pointercancel', stop)
}
function resizeFilesByKey(event: KeyboardEvent) {
  const step = event.shiftKey ? 64 : 16
  if (event.key === 'ArrowLeft') setFilesWidth(filesWidth.value + step)
  else if (event.key === 'ArrowRight') setFilesWidth(filesWidth.value - step)
  else if (event.key === 'Home') setFilesWidth(FILES_MIN_WIDTH)
  else if (event.key === 'End') setFilesWidth(maxFilesWidth())
  else return
  event.preventDefault()
  rememberFilesWidth()
}
function resetFilesWidth() {
  setFilesWidth(FILES_MIN_WIDTH)
  rememberFilesWidth()
}

// The ticket in hand keeps the count it was opened with, so the thread reports its own.
const commentCount = ref(0)
function onCommented(count: number) {
  commentCount.value = count
  commentRefreshKey.value += 1
  emit('commented')
}
const fileInput = ref<HTMLInputElement | null>(null)
const pendingFiles = ref<File[]>([])
const fileError = ref('')
const dragActive = ref(false)
const lightboxId = ref<string | null>(null)
const imageAttachments = computed(() => props.ticket?.attachments.filter(attachment => attachment.mimeType.startsWith('image/')) || [])
// The pictures the card shows, ticked here: attachments and link previews alike. A preview
// rendered since the board was loaded counts already, as it does on the card.
const { finished: finishedPreviews } = useLinkPreviews()
const cardImageSource = computed(() => props.ticket
  ? { ...props.ticket, links: props.ticket.links.map(link => ({ ...link, preview: finishedPreviews.value[link.id]?.preview ?? link.preview })) }
  : null)
const shownOnCard = computed(() => new Set(cardImageSource.value ? cardImages(cardImageSource.value).map(image => image.id) : []))
const cardImageOptions = computed(() => new Set(cardImageSource.value ? cardImageCandidates(cardImageSource.value).map(image => image.id) : []))

function toggleCardImage(id: string) {
  if (!cardImageSource.value) return
  const next = new Set(shownOnCard.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  // Ticking makes the default a choice: from here on the card shows exactly what is ticked.
  commit({ cardImageIds: cardImageCandidates(cardImageSource.value).map(image => image.id).filter(candidate => next.has(candidate)) })
}
const laneOptions = computed(() => props.lanes.map(lane => ({ value: lane.id, label: lane.name })))
// Whether the ticket already sits where a reorder button would take it.
const atTop = computed(() => (props.ticket?.position ?? 0) === 0)
const atBottom = computed(() => (props.ticket?.position ?? 0) >= props.laneTicketCount - 1)
const placementOptions = [{ value: 'top', label: 'Top of lane' }, { value: 'bottom', label: 'Bottom of lane' }]

// Moving onto another board hides behind a small button beside the lane: pick the board, then
// one of its lanes, then say so with a button — unlike the lane select, this leaves the
// board and must not happen by accident.
const transferOpen = ref(false)
const targetBoardId = ref('')
const targetLaneId = ref('')
const boardOptions = computed(() => props.boards.map(board => ({ value: board.id, label: board.name })))
const targetBoard = computed(() => transferOpen.value ? props.boards.find(board => board.id === targetBoardId.value) || null : null)
const targetLaneOptions = computed(() => (targetBoard.value?.lanes || []).filter(lane => !lane.isImport).map(lane => ({ value: lane.id, label: lane.name })))
watch(targetBoard, (board) => { targetLaneId.value = board?.lanes.find(lane => !lane.isImport)?.id || '' })
watch(() => props.ticket?.id, () => { transferOpen.value = false })
function toggleTransfer() {
  transferOpen.value = !transferOpen.value
  if (transferOpen.value && !props.boards.some(board => board.id === targetBoardId.value)) targetBoardId.value = props.boards[0]?.id || ''
}
// The small pill beside a field label ("Assign to me").
const labelPill = 'focus-ring flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[11px] font-semibold leading-none transition'
const labelPillIdle = 'muted border-[var(--line)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]'
// The icon buttons beside the lane in the header: to the top, to the bottom, to another board.
// Pins a pane beside the ticket, or takes it back into the header's tabs.
const pinButton = 'focus-ring muted grid size-7 shrink-0 place-items-center rounded-lg hover:bg-[var(--panel-strong)] hover:text-[var(--ink)] aria-pressed:text-[var(--accent)]'
const headerButton = 'focus-ring muted flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--line)] transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--line)] disabled:hover:bg-transparent'
const priorityOptions = Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label }))
const categoryOptions = computed(() => (props.categories || []).map(category => category.name))
// Same sentinel trick as `UNASSIGNED`: "no type" needs a value the select can hold.
const NO_TYPE = 'none'
// A new ticket starts as the workspace's "Ticket" type, the way imports do; untyped where there is none.
const defaultTypeId = computed(() => (props.ticketTypes || []).find(type => type.name.trim().toLowerCase() === 'ticket')?.id || NO_TYPE)
// The types may arrive after a new ticket's editor opened; it then still starts as "Ticket".
watch(defaultTypeId, (id) => { if (!props.ticket && form.typeId === NO_TYPE) form.typeId = id })
const typeOptions = computed(() => [{ value: NO_TYPE, label: 'No type' }, ...(props.ticketTypes || []).map(type => ({ value: type.id, label: type.name }))])
const selectedType = computed(() => (props.ticketTypes || []).find(type => type.id === form.typeId) || null)
// The picker works on names here: an unknown one is created when the ticket is saved.
const labelOptions = computed(() => (props.labels || []).map(label => ({ value: label.name, label: label.name })))

// Runs on every save too, since the parent hands back the server's ticket as a new object.
// A save of one field must not throw away what is being typed in another: the two text
// fields keep their draft while open, and the to-do rows keep their keys (and the focus)
// unless the list itself came back different — which is also how a failed save rolls back.
watch(() => props.ticket, (ticket, previous) => {
  const sameTicket = Boolean(previous && ticket && previous.id === ticket.id)
  const keepFiles = pendingFiles.value.length > 0 && (!previous || previous.id === ticket?.id)
  if (!keepFiles) pendingFiles.value = []
  const savedTitle = ticket?.title || ''
  if (!sameTicket || !editingTitle.value || form.title.trim() === savedTitle) {
    form.title = savedTitle
    editingTitle.value = !savedTitle.trim()
  }
  const savedDescription = ticket?.description || ''
  if (!sameTicket || !editingDescription.value || form.description === savedDescription) {
    form.description = savedDescription
    editingDescription.value = !savedDescription.trim()
  }
  form.priority = ticket?.priority || 'medium'
  form.startDate = ticket?.startDate || ''
  form.dueDate = ticket?.dueDate || ''
  form.liveFrom = ticket?.liveFrom || ''
  form.liveUntil = ticket?.liveUntil || ''
  if (!sameTicket || ticket?.schedule === scheduleChoice.value) scheduleChoice.value = null
  form.buildNumber = ticket?.buildNumber || ''
  links.value = (ticket?.links || []).map(link => ({ url: link.url, display: link.display }))
  form.assigneeId = ticket?.assignee?.id || UNASSIGNED
  form.authorId = ticket?.author?.id || UNASSIGNED
  if (!sameTicket) {
    commentCount.value = ticket?.commentCount || 0
    activeTab.value = 'details'
    if (import.meta.client) restorePinned(ticket?.id)
    commentsMounted.value = commentsShown.value
  }
  form.labels = ticket?.labels.map(label => label.name) || []
  form.categoryName = ticket?.category?.name || ''
  categoryInFlight = undefined
  form.typeId = ticket ? ticket.type?.id || NO_TYPE : defaultTypeId.value
  // Only a new ticket picks its lane and position here; an existing one is moved through the lane select.
  form.laneId = ticket ? ticket.laneId : (props.initialLaneId || props.lanes[0]?.id || '')
  form.placement = ticket ? 'bottom' : props.initialPlacement
  const savedTodos = savedTodoList(ticket)
  if (!sameTicket || JSON.stringify(savedTodos) !== JSON.stringify(payload.todos())) {
    todos.value = (ticket?.todos || []).map(todo => ({ key: `todo-${++todoSequence}`, text: todo.text, completed: todo.completed, subticketId: todo.subticketId, subticket: todo.subticket }))
  } else {
    // Same list, but a subticket may have moved lanes or been renamed meanwhile.
    const refs = new Map((ticket?.todos || []).filter(todo => todo.subticket).map(todo => [todo.subticketId, todo.subticket]))
    for (const todo of todos.value) if (todo.subticketId) todo.subticket = refs.get(todo.subticketId) ?? todo.subticket
  }
}, { immediate: true })

// The form's sentinels and blanks, turned into what the API expects. Used both by the
// single-field saves and by creating a ticket, so the two never disagree.
const payload = {
  assigneeId: () => form.assigneeId === UNASSIGNED ? null : form.assigneeId,
  authorId: () => form.authorId === UNASSIGNED ? null : form.authorId,
  typeId: () => form.typeId === NO_TYPE ? null : form.typeId,
  startDate: () => form.startDate || null,
  dueDate: () => form.dueDate || null,
  liveFrom: () => form.liveFrom || null,
  liveUntil: () => form.liveUntil || null,
  buildNumber: () => form.buildNumber.trim() || null,
  categoryName: () => form.categoryName.trim() || null,
  labels: () => [...form.labels],
  todos: () => todos.value.map(todoInput).filter(todo => todo.text),
}

// A subticket goes back with its id, which is all that keeps it in the list; its text and
// flag are the server's to say. Plain to-dos carry no id at all, as they always did.
function todoInput(todo: TicketTodoInput): TicketTodoInput {
  return todo.subticketId
    ? { text: todo.text.trim(), completed: todo.completed, subticketId: todo.subticketId }
    : { text: todo.text.trim(), completed: todo.completed }
}
function savedTodoList(ticket: Ticket | null | undefined): TicketTodoInput[] {
  return (ticket?.todos || []).map(todoInput)
}
const light = computed(() => todoLight(todos.value))

const hasSubtickets = computed(() => Boolean(props.ticket?.todos.some(todo => todo.subticketId)))
// Whatever the editor learns about the ticket and its subtickets asks the timeline to read again.
const timelineKey = computed(() => {
  const ticket = props.ticket
  if (!ticket) return ''
  return [ticket.updatedAt, ticket.startDate, ticket.dueDate, ...ticket.todos.map(todo => `${todo.subticketId}:${todo.subticket?.laneId}:${todo.subticket?.title}`)].join('|')
})
const subticketOpen = ref(false)
const subticketPending = ref(false)
const canAddSubticket = computed(() => Boolean(props.ticket && props.canEdit && props.subticketBoards.length))
function subticketHref(subticket: Pick<SubticketRef, 'boardId' | 'ticketNumber'>) {
  return `/b/${subticket.boardId}?ticket=${subticket.ticketNumber}`
}

// Where used: read when the ticket opens. Linking it elsewhere does not touch this ticket,
// so the line can lag until it is opened again.
const parents = ref<SubticketRef[]>([])
async function loadParents() {
  const id = props.ticket?.id
  if (!id) return
  try {
    const result = await $fetch<{ parents: SubticketRef[] }>(`/api/tickets/${id}/parents`)
    if (props.ticket?.id === id) parents.value = result.parents
  } catch {
    // The menu keeps what it had; the ticket itself is unaffected.
  }
}
watch(() => props.ticket?.id, () => {
  parents.value = []
  loadParents()
}, { immediate: true })
// Linking is just naming the ticket in the list: it saves like any other change to it.
function linkSubticket(subticket: SubticketRef) {
  if (!props.ticket || todos.value.some(todo => todo.subticketId === subticket.id)) return void (subticketOpen.value = false)
  todos.value.push({ key: `todo-${++todoSequence}`, text: subticket.title, completed: subticket.done, subticketId: subticket.id, subticket })
  commitTodos()
  subticketOpen.value = false
}
function createSubticket(input: { boardId: string; laneId: string; title: string; description: string }) {
  if (!props.ticket) return
  // Whatever is typed into the list goes first, so the server appends to what the user sees.
  commitTodos()
  subticketPending.value = true
  emit('createSubticket', props.ticket, input, (ok) => {
    subticketPending.value = false
    if (ok) subticketOpen.value = false
  })
}

/**
 * Saves the given fields of an existing ticket right away. A new ticket keeps them in the
 * form until it is created, so nothing happens there.
 */
function commit(changes: TicketPatch) {
  if (props.ticket && props.canEdit) emit('patch', props.ticket, changes)
}

function removeLiveWindow() {
  const hadDates = Boolean(props.ticket?.liveFrom || props.ticket?.liveUntil)
  form.liveFrom = ''
  form.liveUntil = ''
  if (hadDates) commit({ liveFrom: null, liveUntil: null })
}

/**
 * Switches the schedule, clearing what the new one has no room for; the server does the same.
 * None drops every date and, as part of the plan, what it waits on. A milestone keeps one day:
 * the due date, else the start. Without any day yet it waits for its date before it saves.
 */
function setSchedule(next: TicketSchedule) {
  if (next === schedule.value || (props.ticket && !props.canEdit)) return
  const saved = props.ticket
  scheduleChoice.value = next
  if (next === 'none') {
    form.startDate = form.dueDate = form.liveFrom = form.liveUntil = ''
    dependencyPicking.value = false
    shiftOpen.value = false
    const changes: TicketPatch = saved && saved.schedule !== 'none' ? { schedule: 'none' } : {}
    if (saved?.waitsOn.length) changes.waitsOn = []
    if (Object.keys(changes).length) commit(changes)
    return
  }
  if (next === 'milestone') {
    form.dueDate = form.dueDate || form.startDate
    form.startDate = form.liveFrom = form.liveUntil = ''
    if (form.dueDate) commit({ schedule: 'milestone' })
    return
  }
  commit({ schedule: 'lifecycle' })
}

/** The schedule goes along with a date when it has not been saved yet: a milestone getting its day. */
function withSchedule(changes: TicketPatch): TicketPatch {
  return props.ticket && schedule.value !== props.ticket.schedule ? { schedule: schedule.value, ...changes } : changes
}

/** A milestone is its day: clearing it puts the saved day back rather than leave it without one. */
function commitMilestone() {
  if (!form.dueDate) {
    form.dueDate = props.ticket?.schedule === 'milestone' ? props.ticket.dueDate || '' : ''
    return
  }
  commit(withSchedule({ dueDate: payload.dueDate() }))
}

// Dependencies, finish-to-start: what this ticket waits on is part of it; who waits on it is
// read apart, like the parents, since that is other tickets' business.
const waitsOn = computed(() => props.ticket?.waitsOn ?? [])
const dependents = ref<DependencyRef[]>([])
async function loadDependents() {
  const id = props.ticket?.id
  if (!id) return
  try {
    const result = await $fetch<{ dependents: DependencyRef[] }>(`/api/tickets/${id}/dependents`)
    if (props.ticket?.id === id) dependents.value = result.dependents
  } catch {
    // Only the hint goes missing.
  }
}
watch(() => props.ticket?.id, () => {
  dependents.value = []
  loadDependents()
}, { immediate: true })

/** Why a ticket this one waits on is worth a look: it is late, or it ends after this one starts. */
function blockerConcern(blocker: DependencyRef): 'late' | 'overlap' | null {
  if (blocker.done || blocker.archived || inDoneLane.value) return null
  if (blocker.dueDate && blocker.dueDate < today) return 'late'
  const start = form.startDate || form.dueDate
  return start && blocker.dueDate && start < blocker.dueDate ? 'overlap' : null
}
const dependencyIssues = computed(() => props.ticket
  ? dependencyWarnings({ id: props.ticket.id, ticketNumber: props.ticket.ticketNumber, startDate: form.startDate || null, dueDate: form.dueDate || null, done: inDoneLane.value, waitsOn: waitsOn.value }, today)
  : [])

const dependencyPicking = ref(false)
const dependencyQuery = ref('')
const dependencyCandidates = ref<SubticketRef[]>([])
const dependencySearching = ref(false)
let dependencyTimer: ReturnType<typeof setTimeout> | null = null
let dependencySequence = 0
async function searchDependencies() {
  const id = props.ticket?.id
  if (!id) return
  const sequence = ++dependencySequence
  dependencySearching.value = true
  try {
    const result = await $fetch<{ candidates: SubticketRef[] }>(`/api/tickets/${id}/subticket-candidates`, { query: { query: dependencyQuery.value.trim(), for: 'dependency' } })
    if (sequence === dependencySequence) dependencyCandidates.value = result.candidates.slice(0, 8)
  } catch {
    if (sequence === dependencySequence) dependencyCandidates.value = []
  } finally {
    if (sequence === dependencySequence) dependencySearching.value = false
  }
}
watch(dependencyQuery, () => {
  if (!dependencyPicking.value) return
  if (dependencyTimer) clearTimeout(dependencyTimer)
  dependencyTimer = setTimeout(searchDependencies, 200)
})
onBeforeUnmount(() => { if (dependencyTimer) clearTimeout(dependencyTimer) })
function openDependencyPicker() {
  dependencyPicking.value = true
  dependencyQuery.value = ''
  void searchDependencies()
  nextTick(() => document.querySelector<HTMLInputElement>('[data-dependency-search]')?.focus())
}
function addDependency(candidate: SubticketRef) {
  dependencyPicking.value = false
  commit({ waitsOn: [...waitsOn.value.map(item => item.id), candidate.id] })
}
function removeDependency(id: string) {
  commit({ waitsOn: waitsOn.value.filter(item => item.id !== id).map(item => item.id) })
}

// Shifting the plan: this ticket and everything waiting on it, by the same days. A preview first.
const shiftOpen = ref(false)
const shiftDays = ref(7)
const shiftPreview = ref<ShiftResult | null>(null)
const shiftBusy = ref(false)
const shiftError = ref('')
watch(shiftDays, () => { shiftPreview.value = null })
watch(() => props.ticket?.id, () => {
  shiftOpen.value = false
  shiftPreview.value = null
})
async function runShift(dryRun: boolean) {
  const id = props.ticket?.id
  if (!id || !Number.isInteger(shiftDays.value) || !shiftDays.value) return
  shiftBusy.value = true
  shiftError.value = ''
  try {
    const result = await $fetch<ShiftResult>(`/api/tickets/${id}/shift`, { method: 'POST', body: { days: shiftDays.value, dryRun } })
    if (dryRun) {
      shiftPreview.value = result
    } else {
      shiftOpen.value = false
      shiftPreview.value = null
      emit('shifted')
    }
  } catch (error) {
    shiftError.value = (error as { statusMessage?: string })?.statusMessage || 'The shift failed.'
  } finally {
    shiftBusy.value = false
  }
}
const shiftDayFormatter = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' })
/** "Jan 8 – Jan 22 → Jan 4 – Jan 18"; a milestone or a lone date is one day. */
function shiftText(dates: ShiftResult['moves'][number]) {
  const day = (value: string) => shiftDayFormatter.format(new Date(`${value}T00:00:00Z`))
  const span = (start: string | null, due: string | null) => {
    const days = [...new Set([start, due].filter((value): value is string => Boolean(value)))]
    return days.map(day).join(' – ')
  }
  return `${span(dates.startDate.from, dates.dueDate.from)} → ${span(dates.startDate.to, dates.dueDate.to)}`
}

/** An end before its start drags the start along, and back, as the span does. */
function commitLiveWindow(changed: 'liveFrom' | 'liveUntil') {
  if (form.liveFrom && form.liveUntil && form.liveFrom > form.liveUntil) {
    if (changed === 'liveFrom') form.liveUntil = form.liveFrom
    else form.liveFrom = form.liveUntil
    return commit(withSchedule({ liveFrom: payload.liveFrom(), liveUntil: payload.liveUntil() }))
  }
  commit(withSchedule(changed === 'liveFrom' ? { liveFrom: payload.liveFrom() } : { liveUntil: payload.liveUntil() }))
}

/**
 * A start past the due date (or a due date before the start) drags the other one along
 * rather than being refused: the span stays whole, and both go out in one save.
 */
function commitSpan(changed: 'startDate' | 'dueDate') {
  if (form.startDate && form.dueDate && form.startDate > form.dueDate) {
    if (changed === 'startDate') form.dueDate = form.startDate
    else form.startDate = form.dueDate
    return commit(withSchedule({ startDate: payload.startDate(), dueDate: payload.dueDate() }))
  }
  commit(withSchedule(changed === 'startDate' ? { startDate: payload.startDate() } : { dueDate: payload.dueDate() }))
}

// Text inputs save when they are left. Leaving one untouched must not cost a request (and an
// audit line), so the cleaned value is compared with what the ticket already has.
function commitBuildNumber() {
  if (payload.buildNumber() !== (props.ticket?.buildNumber || null)) commit({ buildNumber: payload.buildNumber() })
}
// Picking an option and then leaving the field both ask for a save; the second may come
// before the first has been answered, so the value in flight counts as saved already.
function commitCategory() {
  const next = payload.categoryName()
  const current = categoryInFlight !== undefined ? categoryInFlight : (props.ticket?.category?.name || null)
  if (next === current) return
  categoryInFlight = next
  commit({ categoryName: next })
}
// The category combobox reports every keystroke, so a typed name saves on Enter or once the
// focus has left it — including its popover, which lives in a portal outside the wrapper.
// Picking an option from the list saves at once (see `@select` in the template).
function leaveCategory(event: FocusEvent) {
  const wrapper = event.currentTarget as HTMLElement
  setTimeout(() => {
    const active = document.activeElement
    if (active && (wrapper.contains(active) || active.closest('[data-reka-combobox-content], [role="listbox"]'))) return
    commitCategory()
  }, 0)
}
function commitTodos() {
  const next = payload.todos()
  if (JSON.stringify(next) !== JSON.stringify(savedTodoList(props.ticket))) commit({ todos: next })
}

// Escape (or anything else that unmounts the drawer) takes the focus away without a blur,
// so a value typed into one of these fields would otherwise be lost. Each commit compares
// with the ticket first, so an untouched field costs nothing here.
function flushPendingCommits() {
  if (!props.ticket || !props.canEdit) return
  commitBuildNumber()
  commitCategory()
  commitTodos()
}
onBeforeUnmount(flushPendingCommits)

// `stayOpen` is the small Save beside a new ticket's description: the ticket is created like
// with the big one, but the editor stays and shows it, so writing can go on.
function submit(options: { stayOpen?: boolean } = {}) {
  if (isEdit.value || !form.title.trim()) return
  const shared = { todos: payload.todos(), attachments: [...pendingFiles.value], assigneeId: payload.assigneeId() }
  const manualFields = isManual.value ? { buildNumber: payload.buildNumber() } : {}
  // Sent only by somebody allowed to set it — the API rejects it from anyone else.
  const authorFields = canAttribute.value ? { authorId: payload.authorId() } : {}
  emit('save', { ...shared, ...manualFields, ...authorFields, laneId: form.laneId || undefined, placement: form.placement, title: form.title.trim(), description: form.description, priority: form.priority, schedule: schedule.value === 'milestone' && !form.dueDate ? 'none' : schedule.value, startDate: payload.startDate(), dueDate: payload.dueDate(), liveFrom: payload.liveFrom(), liveUntil: payload.liveUntil(), links: [...links.value], labels: payload.labels(), categoryName: payload.categoryName(), typeId: payload.typeId(), stayOpen: options.stayOpen === true })
}

// Links save as soon as one is added, removed or switched between preview and text.
function changeLinks(next: TicketLinkInput[]) {
  links.value = next
  commit({ links: next })
}

function focusTodo(key: string) {
  nextTick(() => document.querySelector<HTMLInputElement>(`[data-todo-input="${key}"]`)?.focus())
}

function addTodo(index = todos.value.length) {
  if (todos.value.length >= 100) return
  const todo = { key: `todo-${++todoSequence}`, text: '', completed: false }
  todos.value.splice(index, 0, todo)
  focusTodo(todo.key)
}

function removeTodo(index: number) {
  const fallback = todos.value[index + 1]?.key || todos.value[index - 1]?.key
  todos.value.splice(index, 1)
  if (fallback) focusTodo(fallback)
  commitTodos()
}

function moveTodo(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= todos.value.length) return
  const [todo] = todos.value.splice(index, 1)
  if (!todo) return
  todos.value.splice(target, 0, todo)
  nextTick(() => document.querySelector<HTMLButtonElement>(`[data-todo-handle="${todo.key}"]`)?.focus())
  commitTodos()
}

const draggingTodoKey = ref<string | null>(null)
const todoTargetIndex = ref<number | null>(null)
const todoDragPreview = ref<{ x: number; y: number; width: number; height: number } | null>(null)
const todoDragPreviewElement = ref<HTMLElement | null>(null)
const todoListElement = ref<HTMLElement | null>(null)
const draggedTodo = computed(() => todos.value.find(todo => todo.key === draggingTodoKey.value) || null)
const todoSortItems = computed<Array<EditableTodo | null>>(() => {
  if (!draggingTodoKey.value || todoTargetIndex.value === null) return todos.value
  const items: Array<EditableTodo | null> = todos.value.filter(todo => todo.key !== draggingTodoKey.value)
  items.splice(Math.min(todoTargetIndex.value, items.length), 0, null)
  return items
})

interface TodoPointerDrag {
  pointerId: number
  key: string
  offsetX: number
  offsetY: number
  scrollContainer: HTMLElement | null
}

let todoPointer: TodoPointerDrag | null = null
let previousBodyUserSelect = ''
let previousBodyCursor = ''
let todoPointerX = 0
let todoPointerY = 0
let todoPreviewFrame: number | null = null
let todoScrollFrame: number | null = null

function todoIndexOf(key: string) {
  return todos.value.findIndex(todo => todo.key === key)
}

function beginTodoDrag(event: PointerEvent, key: string) {
  if (event.button !== 0 || !event.isPrimary) return
  const row = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-todo-row]')
  if (!row) return
  const bounds = row.getBoundingClientRect()
  todoPointer = {
    pointerId: event.pointerId,
    key,
    offsetX: event.clientX - bounds.left,
    offsetY: event.clientY - bounds.top,
    scrollContainer: row.closest<HTMLElement>('[data-ticket-editor-scroll]')
  }
  todoPointerX = event.clientX
  todoPointerY = event.clientY
  draggingTodoKey.value = key
  todoTargetIndex.value = todos.value.findIndex(todo => todo.key === key)
  todoDragPreview.value = { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height }
  previousBodyUserSelect = document.body.style.userSelect
  previousBodyCursor = document.body.style.cursor
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'grabbing'
  window.addEventListener('pointermove', moveTodoDrag, { passive: false })
  window.addEventListener('pointerup', finishTodoDrag)
  window.addEventListener('pointercancel', cancelTodoDrag)
  event.preventDefault()
}

function todoDropPosition(clientY: number) {
  const stack = todoListElement.value?.querySelector<HTMLElement>('[data-todo-stack]')
  if (!stack) return 0
  const rows = Array.from(stack.querySelectorAll<HTMLElement>('[data-todo-sort-item]'))
  const placeholder = stack.querySelector<HTMLElement>('[data-todo-placeholder]')
  const localY = clientY - stack.getBoundingClientRect().top
  const placeholderTop = placeholder?.offsetTop
  const placeholderFootprint = placeholder ? placeholder.offsetHeight + 8 : 0
  const index = rows.findIndex((row) => {
    const followsPlaceholder = placeholderTop !== undefined && row.offsetTop > placeholderTop
    const compactedTop = row.offsetTop - (followsPlaceholder ? placeholderFootprint : 0)
    return localY < compactedTop + row.offsetHeight / 2
  })
  return index === -1 ? rows.length : index
}

function updateTodoDropTarget(clientY: number) {
  const index = todoDropPosition(clientY)
  if (todoTargetIndex.value !== index) todoTargetIndex.value = index
}

function scheduleTodoPreview() {
  if (todoPreviewFrame !== null) return
  todoPreviewFrame = window.requestAnimationFrame(() => {
    todoPreviewFrame = null
    if (!todoPointer || !todoDragPreviewElement.value) return
    todoDragPreviewElement.value.style.transform = `translate3d(${todoPointerX - todoPointer.offsetX}px, ${todoPointerY - todoPointer.offsetY}px, 0)`
  })
}

function runTodoAutoScroll() {
  todoScrollFrame = null
  const container = todoPointer?.scrollContainer
  if (!todoPointer || !container) return
  const bounds = container.getBoundingClientRect()
  const edge = Math.min(72, bounds.height / 4)
  let delta = 0
  if (todoPointerY < bounds.top + edge) delta = -Math.ceil(10 * (1 - Math.max(0, todoPointerY - bounds.top) / edge))
  else if (todoPointerY > bounds.bottom - edge) delta = Math.ceil(10 * (1 - Math.max(0, bounds.bottom - todoPointerY) / edge))
  if (delta !== 0) {
    const previousScrollTop = container.scrollTop
    container.scrollTop += delta
    if (container.scrollTop !== previousScrollTop) {
      updateTodoDropTarget(todoPointerY)
      todoScrollFrame = window.requestAnimationFrame(runTodoAutoScroll)
    }
  }
}

function scheduleTodoAutoScroll() {
  if (todoScrollFrame === null) todoScrollFrame = window.requestAnimationFrame(runTodoAutoScroll)
}

function moveTodoDrag(event: PointerEvent) {
  if (!todoPointer || event.pointerId !== todoPointer.pointerId) return
  todoPointerX = event.clientX
  todoPointerY = event.clientY
  updateTodoDropTarget(event.clientY)
  scheduleTodoPreview()
  scheduleTodoAutoScroll()
  event.preventDefault()
}

function finishTodoDrag(event?: PointerEvent) {
  if (event && todoPointer && event.pointerId !== todoPointer.pointerId) return
  const key = todoPointer?.key
  const targetIndex = todoTargetIndex.value
  if (key && targetIndex !== null) {
    const sourceIndex = todos.value.findIndex(todo => todo.key === key)
    const [todo] = sourceIndex >= 0 ? todos.value.splice(sourceIndex, 1) : []
    if (todo) todos.value.splice(Math.max(0, Math.min(targetIndex, todos.value.length)), 0, todo)
  }
  cleanupTodoDrag()
  commitTodos()
}

function cancelTodoDrag(event?: PointerEvent) {
  if (event && todoPointer && event.pointerId !== todoPointer.pointerId) return
  cleanupTodoDrag()
}

function cleanupTodoDrag() {
  const wasDragging = Boolean(todoPointer)
  window.removeEventListener('pointermove', moveTodoDrag)
  window.removeEventListener('pointerup', finishTodoDrag)
  window.removeEventListener('pointercancel', cancelTodoDrag)
  if (todoPreviewFrame !== null) window.cancelAnimationFrame(todoPreviewFrame)
  if (todoScrollFrame !== null) window.cancelAnimationFrame(todoScrollFrame)
  if (wasDragging) {
    document.body.style.userSelect = previousBodyUserSelect
    document.body.style.cursor = previousBodyCursor
  }
  todoPointer = null
  todoPreviewFrame = null
  todoScrollFrame = null
  draggingTodoKey.value = null
  todoTargetIndex.value = null
  todoDragPreview.value = null
}

onBeforeUnmount(cleanupTodoDrag)

function addFiles(files: FileList | File[]) {
  fileError.value = ''
  const additions = Array.from(files)
  const merged = [...pendingFiles.value]
  for (const file of additions) {
    if (merged.some(item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) continue
    merged.push(file)
  }
  if (merged.length > 10) return void (fileError.value = 'A maximum of 10 files is allowed per upload.')
  if (merged.some(file => file.size > 25 * 1024 * 1024)) return void (fileError.value = 'One file is larger than 25 MB.')
  if (merged.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) return void (fileError.value = 'The total upload is larger than 100 MB.')
  // An existing ticket takes the files right away; a new one holds them until it is created.
  if (props.ticket) emit('upload', props.ticket, additions)
  else pendingFiles.value = merged
}

function chooseFiles(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.files) addFiles(input.files)
  input.value = ''
}

function dropFiles(event: DragEvent) {
  dragActive.value = false
  if (event.dataTransfer?.files) addFiles(event.dataTransfer.files)
}

function formatSize(size: number) {
  return size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`
}

function date(value: string) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

// A new ticket wants its title typed; an existing one is opened to read, so the focus goes
// to the panel itself — no caret in the title, and no keyboard popping up on a phone.
function focusTitle(event: Event) {
  event.preventDefault()
  nextTick(() => {
    if (props.ticket) document.querySelector<HTMLElement>('[data-ticket-editor-scroll]')?.focus()
    else titleInput.value?.focus()
  })
}
</script>

<template>
  <DialogRoot :open="true" @update:open="open => !open && requestClose()">
    <DialogPortal>
      <DialogOverlay class="ui-dialog-overlay fixed inset-0 z-50 bg-black/35" />
      <DialogContent
        data-ticket-editor-scroll
        class="ui-dialog-content fixed inset-y-0 right-0 z-[51] h-full w-full overflow-y-auto bg-[var(--panel)] shadow-2xl outline-none transition-[max-width] duration-200 ease-out"
        :class="resizingFiles ? '!transition-none' : ''"
        :style="drawerStyle"
        @open-auto-focus="focusTitle"
      >
        <VisuallyHidden>
          <DialogDescription>{{ isEdit ? 'Edit the ticket. Changes are saved as you make them.' : 'Create a new ticket.' }}</DialogDescription>
        </VisuallyHidden>
        <form class="flex min-h-full flex-col" @submit.prevent="submit()">
          <header :ref="observeHeader" class="sticky top-0 z-10 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--panel)_62%,var(--canvas))] px-5 py-4 sm:px-7">
            <div class="flex items-center gap-3">
              <DialogTitle as-child>
                <h2 class="shrink-0 text-xl font-bold tracking-[-.03em]">
                  <template v-if="ticket"><span class="hidden sm:inline">Ticket </span>#{{ ticket.ticketNumber }}</template>
                  <template v-else>New ticket</template>
                </h2>
              </DialogTitle>
              <!-- The lane, with what moves the ticket within it or off the board, rides in the header. -->
              <div class="ml-auto flex min-w-0 max-w-xs flex-1 items-center gap-1.5">
                <div class="min-w-0 flex-1">
                  <UiSelect
                    v-if="ticket"
                    :model-value="ticket.laneId"
                    :options="laneOptions"
                    :disabled="!canEdit"
                    aria-label="Lane"
                    compact
                    @update:model-value="emit('move', ticket, $event)"
                  />
                  <UiSelect v-else :model-value="form.laneId" :options="laneOptions" aria-label="Lane" compact @update:model-value="form.laneId = $event" />
                </div>
                <template v-if="ticket && canEdit">
                  <button type="button" :class="headerButton" :disabled="atTop" aria-label="Move to top of lane" title="Move to top of lane" @click="emit('reorder', ticket, 'top')">
                    <ArrowUpToLine :size="15" aria-hidden="true" />
                  </button>
                  <button type="button" :class="headerButton" :disabled="atBottom" aria-label="Move to bottom of lane" title="Move to bottom of lane" @click="emit('reorder', ticket, 'bottom')">
                    <ArrowDownToLine :size="15" aria-hidden="true" />
                  </button>
                  <button
                    v-if="boards.length"
                    type="button"
                    :class="[headerButton, transferOpen ? '!border-[var(--ink)] !bg-[var(--ink)] !text-[var(--canvas)]' : '']"
                    :aria-expanded="transferOpen"
                    :aria-label="transferOpen ? 'Cancel moving to another board' : 'Move to board'"
                    :title="transferOpen ? 'Cancel' : 'Move to board'"
                    @click="toggleTransfer"
                  >
                    <ArrowRightLeft :size="15" aria-hidden="true" />
                  </button>
                </template>
              </div>
              <button type="button" class="focus-ring grid size-10 shrink-0 place-items-center rounded-xl hover:bg-[var(--panel-strong)]" aria-label="Close" @click="requestClose"><X :size="20" /></button>
            </div>
            <!-- The way up: a second line with every ticket holding this one as a subticket, as the to-dos are the way down. -->
            <nav v-if="ticket && parents.length" class="mt-3 flex flex-wrap gap-1.5" aria-label="Where used: the tickets this one is a subticket of">
              <NuxtLink
                v-for="parent in parents"
                :key="parent.id"
                :to="subticketHref(parent)"
                class="focus-ring flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-xl border border-[var(--line)] px-2.5 text-xs font-semibold hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] sm:max-w-[22rem]"
                :title="`Subticket of #${parent.ticketNumber} ${parent.title} · ${parent.boardName} · ${parent.laneName}${parent.archived ? ' · archived' : ''}`"
              >
                <CornerLeftUp :size="14" class="shrink-0" aria-hidden="true" />
                <span class="truncate" :class="parent.archived ? 'muted line-through' : ''">{{ parent.title }}</span>
                <span class="muted shrink-0 tabular-nums">#{{ parent.ticketNumber }}</span>
              </NuxtLink>
            </nav>
            <!-- One pane at a time; a pinned one stands beside the others, so its tab only points at it. -->
            <div role="tablist" aria-label="Ticket panes" class="-mb-4 mt-2 flex gap-1 overflow-x-auto scrollbar-thin">
              <button
                v-for="tab in editorTabs"
                :key="tab.key"
                type="button"
                role="tab"
                :aria-selected="activeTab === tab.key"
                :title="isPinnable(tab.key) && pinned[tab.key] ? `${tab.label} pinned beside` : undefined"
                class="focus-ring -mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-semibold transition-colors"
                :class="activeTab === tab.key ? 'border-[var(--ink)] text-[var(--ink)]' : 'muted border-transparent hover:text-[var(--ink)]'"
                @click="selectTab(tab.key)"
              >
                <SquareKanban v-if="tab.key === 'details'" :size="15" aria-hidden="true" />
                <ListTodo v-else-if="tab.key === 'plan'" :size="15" aria-hidden="true" />
                <MessageSquare v-else-if="tab.key === 'comments'" :size="15" aria-hidden="true" />
                <Paperclip v-else-if="tab.key === 'files'" :size="15" aria-hidden="true" />
                <History v-else :size="15" aria-hidden="true" />
                {{ tab.label }}
                <span v-if="tab.key === 'plan' && todos.length" class="flex items-center gap-1 text-xs tabular-nums" :title="light ? TODO_LIGHT_LABELS[light] : undefined">
                  <TodoLight v-if="light" :light="light" />
                  <span class="muted">{{ todos.filter(todo => todo.completed).length }}/{{ todos.length }}</span>
                </span>
                <span v-if="tab.key === 'comments' && commentCount" class="muted text-xs tabular-nums">{{ commentCount }}</span>
                <span v-if="tab.key === 'files' && fileCount" class="muted text-xs tabular-nums">{{ fileCount }}</span>
                <Pin v-if="isPinnable(tab.key) && pinned[tab.key]" :size="12" class="text-[var(--accent)]" aria-label="pinned" />
              </button>
            </div>
          </header>

          <!-- Columns stretch to the footer so the lines between them run all the way down; what sticks is inside. -->
          <div
            ref="columns"
            class="flex-1 sm:grid"
            :class="[columnsClass, resizingFiles ? 'cursor-col-resize select-none' : '']"
          >
          <div v-show="activeTab === 'details'" data-editor-pane="details" role="tabpanel" class="order-first space-y-6 px-5 py-6 sm:px-7">
            <!-- The transfer, folded out by the header button: destination board and lane, then one deliberate button. -->
            <div v-if="ticket && targetBoard" class="surface-strong rounded-xl p-3">
              <div class="grid gap-2 sm:grid-cols-2">
                <UiSelect :model-value="targetBoardId" :options="boardOptions" aria-label="Destination board" compact @update:model-value="targetBoardId = $event" />
                <UiSelect :model-value="targetLaneId" :options="targetLaneOptions" aria-label="Lane on the destination board" compact @update:model-value="targetLaneId = $event" />
              </div>
              <div class="mt-2 flex items-center justify-between gap-3">
                <span class="muted text-[11px]">The ticket leaves this board. Labels and category come along; an assignee who is no member over there is dropped.</span>
                <button
                  type="button"
                  class="focus-ring flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3 text-xs font-semibold text-[var(--canvas)] disabled:opacity-50"
                  :disabled="!targetLaneId || saving"
                  @click="emit('transfer', ticket, targetBoard.id, targetLaneId)"
                >
                  <ArrowRightLeft :size="14" aria-hidden="true" /> Move to {{ targetBoard.name }}
                </button>
              </div>
            </div>

            <div class="block">
              <div class="mb-2 flex items-center justify-between gap-3">
                <label for="ticket-title" class="block text-xs font-bold uppercase tracking-[.08em]">Title</label>
                <div v-if="canEdit && isEdit && (editingTitle || titleChanged)" class="flex items-center gap-2">
                  <button v-if="hasSavedTitle" type="button" class="focus-ring flex h-7 items-center gap-1.5 rounded-lg border border-[var(--line)] px-2.5 text-xs font-semibold" @click="cancelTitle">
                    <X :size="14" /> Cancel
                  </button>
                  <button type="button" :disabled="saving || saveState === 'saving' || !form.title.trim()" class="focus-ring flex h-7 items-center gap-1.5 rounded-lg bg-[var(--ink)] px-2.5 text-xs font-semibold text-[var(--canvas)] disabled:opacity-50" @click="saveTitle">
                    <Check :size="14" /> Save
                  </button>
                </div>
              </div>
              <textarea
                v-if="editingTitle || !isEdit"
                id="ticket-title"
                ref="titleInput"
                v-model="form.title"
                :maxlength="isManual ? 160 : 10000"
                required
                rows="2"
                class="focus-ring surface-strong min-h-20 w-full resize-none overflow-hidden rounded-xl px-3.5 py-3 text-[15px] leading-snug outline-none [field-sizing:content]"
                placeholder="What needs to be done?"
                @keydown.enter.prevent="isEdit ? saveTitle() : undefined"
                @keydown.esc.stop="isEdit && hasSavedTitle ? cancelTitle() : undefined"
              />
              <div
                v-else
                class="surface-strong min-h-20 w-full whitespace-pre-wrap rounded-xl px-3.5 py-3 text-[15px] font-semibold leading-snug"
                :class="canEdit ? 'focus-ring cursor-text' : ''"
                :role="canEdit ? 'button' : undefined"
                :tabindex="canEdit ? 0 : undefined"
                :title="canEdit ? 'Click to edit' : undefined"
                @click="editTitle"
                @keydown.enter.prevent="editTitle"
              >{{ form.title }}</div>
            </div>

            <div class="block">
              <div class="mb-2 flex items-center justify-between gap-3">
                <label for="ticket-description" class="block text-xs font-bold uppercase tracking-[.08em]">Description</label>
                <div v-if="canEdit && isEdit && (editingDescription || form.description !== (ticket?.description || ''))" class="flex items-center gap-2">
                  <button v-if="hasSavedDescription" type="button" class="focus-ring flex h-7 items-center gap-1.5 rounded-lg border border-[var(--line)] px-2.5 text-xs font-semibold" @click="cancelDescription">
                    <X :size="14" /> Cancel
                  </button>
                  <button type="button" :disabled="saving || saveState === 'saving'" class="focus-ring flex h-7 items-center gap-1.5 rounded-lg bg-[var(--ink)] px-2.5 text-xs font-semibold text-[var(--canvas)] disabled:opacity-50" @click="saveDescription">
                    <Check :size="14" /> Save
                  </button>
                </div>
                <!-- A new ticket: this creates it and keeps the editor open on it, unlike the Create button below. -->
                <button
                  v-else-if="canEdit && !isEdit && form.description.trim()"
                  type="button"
                  :disabled="saving || !form.title.trim()"
                  :title="form.title.trim() ? 'Create the ticket and keep editing' : 'A title is needed first'"
                  class="focus-ring flex h-7 items-center gap-1.5 rounded-lg bg-[var(--ink)] px-2.5 text-xs font-semibold text-[var(--canvas)] disabled:opacity-50"
                  @click="submit({ stayOpen: true })"
                >
                  <Check :size="14" /> Save
                </button>
              </div>
              <textarea v-if="editingDescription" id="ticket-description" ref="descriptionInput" v-model="form.description" maxlength="10000" rows="7" class="focus-ring surface-strong w-full resize-y rounded-xl px-3.5 py-3 text-sm leading-relaxed outline-none" placeholder="Context, expected behavior, notes… Markdown is supported." />
              <MarkdownView
                v-else
                :source="form.description"
                class="surface-strong min-h-24 w-full rounded-xl px-3.5 py-3 text-sm leading-relaxed"
                :class="canEdit ? 'focus-ring cursor-text' : ''"
                :role="canEdit ? 'button' : undefined"
                :tabindex="canEdit ? 0 : undefined"
                :title="canEdit ? 'Click to edit' : undefined"
                @click="editDescription"
                @keydown.enter.prevent="editDescription"
              />
            </div>

            <div class="grid gap-4" :class="ticket ? '' : 'sm:grid-cols-2'">
              <div class="block">
                <span class="mb-2 flex h-5 items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><Shapes :size="14" /> Type</span>
                <div class="flex items-center gap-2">
                  <TicketTypeBadge v-if="selectedType" :type="selectedType" untitled />
                  <div class="min-w-0 flex-1">
                    <UiSelect
                      :model-value="form.typeId"
                      :options="typeOptions"
                      aria-label="Type"
                      :disabled="!canEdit"
                      @update:model-value="form.typeId = $event; commit({ typeId: payload.typeId() })"
                    />
                  </div>
                </div>
              </div>
              <div v-if="!ticket" class="block">
                <span class="mb-2 flex h-5 items-center text-xs font-bold uppercase tracking-[.08em]">Position</span>
                <UiSelect :model-value="form.placement" :options="placementOptions" aria-label="Position in lane" @update:model-value="form.placement = $event as 'top' | 'bottom'" />
                <span class="muted mt-1.5 block text-[11px]">Top pushes the lane’s other tickets down.</span>
              </div>
            </div>

            <div class="grid items-start gap-4 sm:grid-cols-2">
              <div class="block">
                <div class="mb-2 flex h-5 items-center justify-between gap-2">
                  <span class="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><UserRound :size="14" /> Assignee</span>
                  <button v-if="canAssignSelf" type="button" :class="[labelPill, labelPillIdle]" @click="assignToMe"><UserRound :size="11" aria-hidden="true" /> Assign to me</button>
                </div>
                <UiSelect
                  :model-value="form.assigneeId"
                  :options="assigneeOptions"
                  aria-label="Assignee"
                  :disabled="!canEdit"
                  @update:model-value="form.assigneeId = $event; commit({ assigneeId: payload.assigneeId() })"
                />
              </div>
              <div class="block">
                <span class="mb-2 flex h-5 items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><PenLine :size="14" /> {{ author && !canAttribute ? author.role : 'Author' }}</span>
                <!-- Admins may correct who reported an import; everyone else just sees who did. -->
                <template v-if="canAttribute">
                  <UiSelect
                    :model-value="form.authorId"
                    :options="authorOptions"
                    aria-label="Author"
                    title="Who really reported this. Imports name their tester automatically when that person already has an account."
                    @update:model-value="form.authorId = $event; commit({ authorId: payload.authorId() })"
                  />
                  <span v-if="form.authorId === UNASSIGNED && person" class="muted mt-1.5 block truncate text-[11px]">{{ person.role }}: {{ person.name }}</span>
                </template>
                <div
                  v-else
                  class="surface-strong flex h-11 items-center gap-2 rounded-xl px-3 text-sm"
                  :title="author?.email || undefined"
                >
                  <span class="min-w-0 truncate" :class="author ? '' : 'muted'">{{ author?.name || 'Unknown' }}</span>
                </div>
              </div>
            </div>

            <label v-if="showBuildNumber" class="block">
              <span class="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><TestTubeDiagonal :size="14" /> Build number</span>
              <input v-model="form.buildNumber" maxlength="100" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none" placeholder="e.g. 42 or 1.4.0 (42)" :readonly="!canEdit" @blur="commitBuildNumber" @keydown.enter.prevent="commitBuildNumber">
            </label>

            <!-- How the ticket is sorted: how urgent, which category, which labels. -->
            <section class="!mt-10 space-y-4 rounded-2xl border border-[color-mix(in_srgb,var(--accent)_22%,var(--line))] bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] p-4" aria-label="Classification">
              <div class="grid items-start gap-4 sm:grid-cols-2">
                <div class="block">
                  <span class="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><Gauge :size="14" /> Priority</span>
                  <UiSelect
                    :model-value="form.priority"
                    :options="priorityOptions"
                    aria-label="Priority"
                    :disabled="!canEdit"
                    @update:model-value="form.priority = $event as TicketPriority; commit({ priority: form.priority })"
                  />
                </div>
                <div class="block">
                  <label for="ticket-category" class="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><Tag :size="14" /> Category</label>
                  <div @focusout="leaveCategory" @keydown.enter.prevent="nextTick(commitCategory)">
                    <UiCombobox
                      id="ticket-category"
                      :model-value="form.categoryName"
                      :options="categoryOptions"
                      aria-label="Category"
                      placeholder="Select or enter a new category"
                      @update:model-value="form.categoryName = $event"
                      @select="form.categoryName = $event; commitCategory()"
                    />
                  </div>
                </div>
              </div>

              <div class="block">
                <label for="ticket-labels" class="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><Tags :size="14" /> Labels</label>
                <UiMultiCombobox
                  id="ticket-labels"
                  :model-value="form.labels"
                  :options="labelOptions"
                  @update:model-value="form.labels = $event; commit({ labels: payload.labels() })"
                  allow-create
                  aria-label="Labels"
                  placeholder="Select or type a new label"
                  empty-text="No labels on this board yet."
                />
              </div>
            </section>

            <!-- The ticket's days, kept apart so a plain ticket stays plain: with no schedule it has none. -->
            <section class="rounded-2xl border border-[color-mix(in_srgb,var(--accent)_22%,var(--line))] bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]" :class="lifecycleOn ? 'space-y-4 p-4' : 'px-4 py-3'" aria-labelledby="ticket-schedule-heading">
              <div class="flex flex-wrap items-center gap-3">
                <h3 id="ticket-schedule-heading" class="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><CalendarRange :size="14" /> Schedule</h3>
                <div role="radiogroup" aria-labelledby="ticket-schedule-heading" class="flex shrink-0 rounded-xl bg-[var(--panel)] p-0.5" data-schedule-switch>
                  <button
                    v-for="option in SCHEDULE_OPTIONS"
                    :key="option.value"
                    type="button"
                    role="radio"
                    :aria-checked="schedule === option.value"
                    :disabled="Boolean(ticket) && !canEdit"
                    :title="option.title"
                    class="focus-ring flex h-8 items-center gap-1.5 rounded-[10px] px-2.5 text-xs font-semibold transition disabled:cursor-not-allowed"
                    :class="schedule === option.value ? 'surface-strong text-[var(--ink)] shadow-sm' : 'muted hover:text-[var(--ink)]'"
                    @click="setSchedule(option.value)"
                  >
                    <Flag v-if="option.value === 'milestone'" :size="13" aria-hidden="true" />
                    <CalendarRange v-else-if="option.value === 'lifecycle'" :size="13" aria-hidden="true" />
                    {{ option.label }}
                  </button>
                </div>
              </div>

              <template v-if="lifecycleOn">
                <!-- A milestone is one day, kept as its due date: an event, so no start and no live window. -->
                <label v-if="schedule === 'milestone'" class="block sm:w-1/2 sm:pr-2">
                  <span class="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]">
                    <Flag :size="14" /> Date
                    <span
                      v-if="dueText"
                      class="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal"
                      :class="dueState === 'alert' ? 'bg-rose-600 text-white' : 'bg-orange-400/20 text-orange-700 dark:text-orange-300'"
                    ><AlarmClock :size="11" /> {{ dueText }}</span>
                  </span>
                  <input
                    v-model="form.dueDate"
                    type="date"
                    data-milestone-date
                    class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none"
                    :class="dueState === 'alert' ? 'ring-2 ring-rose-600' : dueState === 'warning' ? 'ring-2 ring-orange-400' : ''"
                    :readonly="!canEdit"
                    @change="commitMilestone"
                  >
                </label>
                <template v-else>
                <div class="grid gap-4 sm:grid-cols-2">
                  <label class="block">
                    <span class="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><CalendarArrowUp :size="14" /> Start date</span>
                    <!-- With the due date it spans the ticket on a timeline; the same day is a one-day bar. -->
                    <input
                      v-model="form.startDate"
                      type="date"
                      class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none"
                      :max="form.dueDate || undefined"
                      :readonly="!canEdit"
                      @change="commitSpan('startDate')"
                    >
                  </label>
                  <label class="block">
                    <span class="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]">
                      <Calendar :size="14" /> Due date
                      <span
                        v-if="dueText"
                        class="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal"
                        :class="dueState === 'alert' ? 'bg-rose-600 text-white' : 'bg-orange-400/20 text-orange-700 dark:text-orange-300'"
                      ><AlarmClock :size="11" /> {{ dueText }}</span>
                    </span>
                    <input
                      v-model="form.dueDate"
                      type="date"
                      class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none"
                      :class="dueState === 'alert' ? 'ring-2 ring-rose-600' : dueState === 'warning' ? 'ring-2 ring-orange-400' : ''"
                      :min="form.startDate || undefined"
                      :readonly="!canEdit"
                      @change="commitSpan('dueDate')"
                    >
                  </label>
                </div>

                <!-- The days it is out in the world, apart from the days it is worked on: a campaign's run, an approval until it expires. -->
                <div class="grid gap-4 sm:grid-cols-2">
                  <label class="block">
                    <span class="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]">
                      <Radio :size="14" /> Live from
                      <!-- Both dates go in one save. -->
                      <button
                        v-if="canEdit && (form.liveFrom || form.liveUntil)"
                        type="button"
                        class="focus-ring muted ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal hover:bg-[var(--panel)] hover:text-rose-600"
                        title="Remove the live window"
                        @click.prevent="removeLiveWindow"
                      ><X :size="11" aria-hidden="true" /> Clear</button>
                    </span>
                    <input
                      v-model="form.liveFrom"
                      type="date"
                      class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none"
                      :max="form.liveUntil || undefined"
                      :readonly="!canEdit"
                      @change="commitLiveWindow('liveFrom')"
                    >
                  </label>
                  <label class="block">
                    <span class="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]">
                      <Radio :size="14" /> Live until
                      <span
                        v-if="liveText"
                        class="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal"
                        :class="liveState === 'alert' ? 'bg-rose-600 text-white' : 'bg-orange-400/20 text-orange-700 dark:text-orange-300'"
                      >{{ liveText }}</span>
                    </span>
                    <input
                      v-model="form.liveUntil"
                      type="date"
                      class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none"
                      :class="liveState === 'alert' ? 'ring-2 ring-rose-600' : liveState === 'warning' ? 'ring-2 ring-orange-400' : ''"
                      :min="form.liveFrom || undefined"
                      :readonly="!canEdit"
                      @change="commitLiveWindow('liveUntil')"
                    >
                  </label>
                </div>
                </template>

                <!-- Moving the plan: these dates and everything waiting on them, by the same days. -->
                <div v-if="ticket && canEdit && (ticket.startDate || ticket.dueDate)" class="border-t border-[var(--line)] pt-3">
                  <button
                    v-if="!shiftOpen"
                    type="button"
                    class="focus-ring muted flex items-center gap-1.5 rounded-lg px-1 text-xs font-semibold hover:text-[var(--ink)]"
                    :title="dependents.length ? 'Move this ticket and everything waiting on it' : 'Move this ticket’s start and due date'"
                    @click="shiftOpen = true; shiftPreview = null; shiftError = ''"
                  ><CalendarClock :size="13" /> Shift dates{{ dependents.length ? ' with what waits on it' : '' }}…</button>
                  <div v-else class="space-y-2">
                    <div class="flex flex-wrap items-center gap-2">
                      <label class="flex items-center gap-2 text-xs font-semibold">
                        <CalendarClock :size="14" aria-hidden="true" /> Shift by
                        <input v-model.number="shiftDays" type="number" min="-366" max="366" step="1" class="focus-ring surface-strong h-9 w-20 rounded-lg px-2 text-sm tabular-nums outline-none" aria-label="Days to shift by; negative moves earlier">
                        days
                      </label>
                      <button type="button" class="focus-ring h-9 rounded-xl border border-[var(--line)] px-3 text-xs font-semibold hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:opacity-50" :disabled="shiftBusy || !shiftDays" @click="runShift(true)">Preview</button>
                      <button type="button" class="focus-ring muted ml-auto rounded-lg px-1.5 text-xs font-semibold hover:text-[var(--ink)]" @click="shiftOpen = false">Cancel</button>
                    </div>
                    <div v-if="shiftPreview" class="surface-strong space-y-1.5 rounded-xl p-3 text-xs">
                      <p class="font-semibold">{{ shiftPreview.moves.length }} {{ shiftPreview.moves.length === 1 ? 'ticket moves' : 'tickets move' }} by {{ shiftPreview.days > 0 ? '+' : '' }}{{ shiftPreview.days }} {{ Math.abs(shiftPreview.days) === 1 ? 'day' : 'days' }}:</p>
                      <ul class="space-y-0.5">
                        <li v-for="move in shiftPreview.moves" :key="move.ticketId" class="flex min-w-0 gap-2">
                          <span class="muted w-10 shrink-0 font-semibold tabular-nums">#{{ move.ticketNumber }}</span>
                          <span class="min-w-0 flex-1 truncate">{{ move.title }}</span>
                          <span class="muted shrink-0 tabular-nums">{{ shiftText(move) }}</span>
                        </li>
                      </ul>
                      <p v-if="shiftPreview.skipped.length" class="muted">
                        Stays put: <template v-for="(item, index) in shiftPreview.skipped" :key="item.ticketId">{{ index ? ', ' : '' }}#{{ item.ticketNumber }} ({{ item.reason === 'finished' ? 'finished' : 'no access' }})</template>
                      </p>
                      <button type="button" class="focus-ring h-9 rounded-xl bg-[var(--accent)] px-3 text-xs font-semibold text-white disabled:opacity-50" :disabled="shiftBusy" @click="runShift(false)">Shift {{ shiftPreview.moves.length }} {{ shiftPreview.moves.length === 1 ? 'ticket' : 'tickets' }}</button>
                    </div>
                    <p v-if="shiftError" class="text-xs text-rose-600">{{ shiftError }}</p>
                  </div>
                </div>
              </template>
            </section>
          </div>

          <!-- The way the work is laid out: its steps and subtickets, their timeline, and what it has to wait for. -->
          <div v-show="activeTab === 'plan'" data-editor-pane="plan" role="tabpanel" class="order-first space-y-6 px-5 py-6 sm:px-7">
            <section class="space-y-3">
              <div class="flex items-center gap-2">
                <h3 class="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><ListTodo :size="15" /> To-dos</h3>
                <span v-if="todos.length && light" class="ml-auto flex items-center gap-1.5 text-[11px] font-semibold" :title="TODO_LIGHT_LABELS[light]">
                  <TodoLight :light="light" />
                  <span class="muted">{{ todos.filter(todo => todo.completed).length }}/{{ todos.length }} completed</span>
                </span>
              </div>
              <p v-if="!todos.length" class="muted text-xs">No to-dos yet. Add steps, or subtickets that count as done once they are finished.</p>
              <div v-if="todos.length" ref="todoListElement">
                <TransitionGroup name="todo-sort" tag="div" data-todo-stack class="relative flex flex-col gap-2">
                  <div v-for="item in todoSortItems" :key="item?.key || '__todo-drop-placeholder'" :data-todo-sort-item="item?.key">
                    <div
                      v-if="item"
                      :data-todo-row="item.key"
                      class="surface-strong flex items-center gap-2 rounded-xl p-2 transition-[border-color,background-color,box-shadow] duration-150 hover:border-[color-mix(in_srgb,var(--line)_60%,var(--accent))]"
                    >
                      <button
                        type="button"
                        :data-todo-handle="item.key"
                        class="focus-ring muted grid size-8 shrink-0 cursor-grab touch-none place-items-center rounded-lg hover:bg-[var(--panel)] active:cursor-grabbing"
                        :aria-label="`Reorder to-do ${todoIndexOf(item.key) + 1}`"
                        title="Drag to reorder · Alt+arrow keys"
                        @pointerdown="beginTodoDrag($event, item.key)"
                        @keydown.alt.up.prevent="moveTodo(todoIndexOf(item.key), -1)"
                        @keydown.alt.down.prevent="moveTodo(todoIndexOf(item.key), 1)"
                      ><GripVertical :size="17" /></button>
                      <template v-if="item.subticketId">
                        <span class="grid size-4 shrink-0 place-items-center" :class="item.completed ? 'text-[var(--accent)]' : 'muted'" :title="item.completed ? 'Done: the subticket is in a done lane' : 'Open until the subticket reaches a done lane'">
                          <CircleCheck v-if="item.completed" :size="16" aria-label="Done" />
                          <Circle v-else :size="16" aria-label="Open" />
                        </span>
                        <NuxtLink
                          :to="item.subticket ? subticketHref(item.subticket) : undefined"
                          class="focus-ring group/sub flex min-w-0 flex-1 flex-col rounded-md px-1 py-0.5 hover:bg-[var(--panel)]"
                          :title="item.subticket ? `Open subticket #${item.subticket.ticketNumber}` : undefined"
                        >
                          <!-- The title alone on the first line; the number leads the second, where "Subticket" used to say what the arrow already does. -->
                          <span class="truncate text-sm group-hover/sub:underline" :class="item.completed ? 'muted line-through' : ''">{{ item.text }}</span>
                          <span v-if="item.subticket" class="muted flex min-w-0 items-center gap-1 text-[11px]">
                            <CornerDownRight :size="11" class="shrink-0" aria-hidden="true" />
                            <span class="shrink-0 font-semibold tabular-nums">#{{ item.subticket.ticketNumber }}</span>
                            <span class="truncate">· {{ item.subticket.boardName }} · {{ item.subticket.laneName }}{{ item.subticket.archived ? ' · archived' : '' }}</span>
                          </span>
                        </NuxtLink>
                      </template>
                      <template v-else>
                      <input v-model="item.completed" type="checkbox" class="focus-ring size-4 shrink-0 cursor-pointer accent-[var(--accent)]" :aria-label="`Mark to-do “${item.text || todoIndexOf(item.key) + 1}” as completed`" @change="commitTodos()">
                      <input
                        v-model="item.text"
                        :data-todo-input="item.key"
                        maxlength="500"
                        class="focus-ring min-w-0 flex-1 bg-transparent px-1 py-1.5 text-sm outline-none"
                        :class="item.completed ? 'muted line-through' : ''"
                        placeholder="What needs to be done?"
                        @keydown.enter.prevent="addTodo(todoIndexOf(item.key) + 1)"
                        @blur="commitTodos()"
                      >
                      </template>
                      <button
                        type="button"
                        class="focus-ring grid size-8 shrink-0 place-items-center rounded-lg text-rose-600 hover:bg-rose-500/10"
                        :aria-label="item.subticketId ? `Remove subticket ${todoIndexOf(item.key) + 1} from the list` : `Delete to-do ${todoIndexOf(item.key) + 1}`"
                        :title="item.subticketId ? 'Remove from the list — the subticket itself stays' : undefined"
                        @click="removeTodo(todoIndexOf(item.key))"
                      ><Trash2 :size="15" /></button>
                    </div>
                    <div
                      v-else
                      data-todo-placeholder
                      class="pointer-events-none rounded-xl border border-dashed border-[color-mix(in_srgb,var(--accent)_38%,var(--line))] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_8%,transparent)]"
                      :style="{ height: `${todoDragPreview?.height || 52}px` }"
                      aria-hidden="true"
                    />
                  </div>
                </TransitionGroup>
              </div>
              <!-- One quiet way to add: a to-do or a subticket. -->
              <div class="flex justify-end">
                <DropdownMenuRoot :modal="false">
                  <DropdownMenuTrigger
                    data-add-menu
                    class="focus-ring group flex h-9 items-center gap-1.5 rounded-xl border border-dashed border-[var(--line)] px-3 text-sm font-semibold hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] data-[state=open]:border-[var(--accent)] data-[state=open]:bg-[var(--accent-soft)]"
                  >
                    <Plus :size="16" aria-hidden="true" /> Add
                    <ChevronDown :size="14" class="muted transition-transform duration-150 group-data-[state=open]:rotate-180" aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuPortal>
                    <!-- Focus goes where the item sends it (a new to-do), not back here. -->
                    <DropdownMenuContent
                      align="end"
                      :side-offset="6"
                      class="ui-popover z-[100] min-w-52 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel-strong)] p-1 text-[var(--ink)] shadow-[0_18px_45px_rgba(0,0,0,.16),0_3px_12px_rgba(0,0,0,.08)]"
                      @close-auto-focus.prevent
                    >
                      <DropdownMenuItem :disabled="todos.length >= 100" class="flex h-10 cursor-default select-none items-center gap-2 rounded-lg px-3 text-sm font-medium outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-[var(--accent-soft)]" @select="addTodo()">
                        <Plus :size="15" aria-hidden="true" /> To-do
                      </DropdownMenuItem>
                      <DropdownMenuItem v-if="canAddSubticket" :disabled="todos.length >= 100" class="flex h-10 cursor-default select-none items-center gap-2 rounded-lg px-3 text-sm font-medium outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-[var(--accent-soft)]" @select="subticketOpen = true">
                        <CornerDownRight :size="15" aria-hidden="true" /> Subticket…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenuPortal>
                </DropdownMenuRoot>
              </div>
            </section>

            <!-- Only once there is a plan to draw: a ticket that bundles subtickets. -->
            <TicketTimeline v-if="ticket && hasSubtickets" :ticket-id="ticket.id" :refresh-key="timelineKey" />

            <!-- Finish-to-start: it starts once these end. Only an existing ticket can point at others. -->
            <section v-if="ticket" class="space-y-2 border-t border-[var(--line)] pt-6" aria-label="Waits on">
              <div class="flex items-center gap-2">
                <span class="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><Link2 :size="14" /> Waits on</span>
                <button
                  v-if="canEdit && !dependencyPicking && waitsOn.length < 50"
                  type="button"
                  class="focus-ring muted ml-auto flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-xs font-semibold hover:bg-[var(--panel)] hover:text-[var(--ink)]"
                  title="Pick a ticket this one can only start once it has ended"
                  @click="openDependencyPicker"
                ><Plus :size="13" /> Add</button>
              </div>
              <ul v-if="waitsOn.length" class="space-y-1">
                <li v-for="blocker in waitsOn" :key="blocker.id" class="surface-strong flex items-center gap-2 rounded-xl px-2.5 py-1.5">
                  <span class="grid size-4 shrink-0 place-items-center" :class="blocker.done ? 'text-[var(--accent)]' : 'muted'">
                    <CircleCheck v-if="blocker.done" :size="15" aria-label="Done" />
                    <Circle v-else :size="15" aria-label="Open" />
                  </span>
                  <NuxtLink :to="subticketHref(blocker)" class="focus-ring group/dep flex min-w-0 flex-1 flex-col rounded-md px-1 hover:bg-[var(--panel)]" :title="`Open #${blocker.ticketNumber}`">
                    <span class="truncate text-sm group-hover/dep:underline" :class="blocker.done ? 'muted line-through' : ''">{{ blocker.title }}</span>
                    <span class="muted flex min-w-0 items-center gap-1 text-[11px]">
                      <span class="shrink-0 font-semibold tabular-nums">#{{ blocker.ticketNumber }}</span>
                      <span class="truncate">· {{ blocker.boardName }} · {{ blocker.laneName }}<template v-if="blocker.dueDate"> · due {{ blocker.dueDate }}</template></span>
                    </span>
                  </NuxtLink>
                  <span
                    v-if="blockerConcern(blocker)"
                    class="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
                    :class="blockerConcern(blocker) === 'late' ? 'bg-rose-600 text-white' : 'bg-orange-400/20 text-orange-700 dark:text-orange-300'"
                    :title="blockerConcern(blocker) === 'late' ? 'It is past its due date and not done' : 'It ends after this ticket starts'"
                  >{{ blockerConcern(blocker) === 'late' ? 'Late' : 'Ends later' }}</span>
                  <button
                    v-if="canEdit"
                    type="button"
                    class="focus-ring muted grid size-7 shrink-0 place-items-center rounded-lg hover:bg-[var(--panel)] hover:text-rose-600"
                    :aria-label="`No longer wait on #${blocker.ticketNumber}`"
                    @click="removeDependency(blocker.id)"
                  ><X :size="14" /></button>
                </li>
              </ul>
              <p v-else-if="!dependencyPicking" class="muted text-xs">Nothing. Add the tickets that have to end before this one can start.</p>

              <div v-if="dependencyPicking" class="space-y-1" @keydown.esc.stop.prevent="dependencyPicking = false">
                <div class="relative">
                  <input
                    v-model="dependencyQuery"
                    data-dependency-search
                    class="focus-ring surface-strong h-10 w-full rounded-xl px-3 pr-9 text-sm outline-none"
                    placeholder="Search by title or #number"
                    aria-label="Search for a ticket to wait on"
                  >
                  <LoaderCircle v-if="dependencySearching" :size="14" class="muted absolute right-3 top-1/2 -translate-y-1/2 animate-spin" aria-hidden="true" />
                </div>
                <button
                  v-for="candidate in dependencyCandidates"
                  :key="candidate.id"
                  type="button"
                  class="focus-ring flex w-full items-center gap-2.5 rounded-xl border border-transparent px-3 py-1.5 text-left hover:border-[var(--line)] hover:bg-[var(--panel)]"
                  @click="addDependency(candidate)"
                >
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-medium">{{ candidate.title }}</span>
                    <span class="muted block truncate text-[11px]"><span class="font-semibold tabular-nums">#{{ candidate.ticketNumber }}</span> · {{ candidate.boardName }} · {{ candidate.laneName }}</span>
                  </span>
                  <CircleCheck v-if="candidate.done" :size="14" class="shrink-0 text-[var(--accent)]" aria-label="Done" />
                </button>
                <div class="flex items-center gap-2">
                  <p v-if="!dependencySearching && !dependencyCandidates.length" class="muted text-xs">{{ dependencyQuery.trim() ? 'No open ticket of this workspace matches.' : 'No ticket of this workspace to wait on.' }}</p>
                  <button type="button" class="focus-ring muted ml-auto rounded-lg px-1.5 py-0.5 text-xs font-semibold hover:text-[var(--ink)]" @click="dependencyPicking = false">Cancel</button>
                </div>
              </div>

              <ul v-if="dependencyIssues.length" class="space-y-1 rounded-xl bg-orange-400/10 p-2.5 text-xs text-orange-800 dark:text-orange-200">
                <li v-for="issue in dependencyIssues" :key="issue.message" class="flex items-start gap-1.5"><CircleAlert :size="13" class="mt-px shrink-0" aria-hidden="true" /> {{ issue.message }}</li>
              </ul>

              <p v-if="dependents.length" class="muted flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                <span>Waited on by</span>
                <NuxtLink v-for="item in dependents" :key="item.id" :to="subticketHref(item)" class="focus-ring rounded font-semibold tabular-nums hover:text-[var(--accent)] hover:underline" :title="item.title">#{{ item.ticketNumber }}</NuxtLink>
              </p>
            </section>
          </div>

          <!-- Where the ticket came from, and everything that happened to it since. -->
          <div v-if="ticket" v-show="activeTab === 'history'" data-editor-pane="history" role="tabpanel" class="order-first space-y-6 px-5 py-6 sm:px-7">
            <section v-if="ticket?.feedback" class="rounded-2xl bg-[var(--accent-soft)] p-4 sm:p-5">
              <div class="mb-4 flex items-center gap-2 text-sm font-bold"><TestTubeDiagonal :size="17" /> TestFlight metadata</div>
              <dl class="grid grid-cols-2 gap-x-5 gap-y-4 text-xs">
                <div><dt class="muted mb-1">Type</dt><dd class="font-semibold">{{ ticket.feedback.feedbackType === 'crash' ? 'Crash' : 'Screenshot feedback' }}</dd></div>
                <div><dt class="muted mb-1">Received</dt><dd class="font-semibold">{{ date(ticket.feedback.sourceCreatedAt) }}</dd></div>
                <div><dt class="muted mb-1">Build</dt><dd class="font-semibold">{{ ticket.feedback.buildVersion || '–' }}</dd></div>
                <div><dt class="muted mb-1">Bundle-ID</dt><dd class="truncate font-semibold" :title="ticket.feedback.buildBundleId || ''">{{ ticket.feedback.buildBundleId || '–' }}</dd></div>
                <div><dt class="muted mb-1">Device</dt><dd class="font-semibold">{{ ticket.feedback.deviceModel || '–' }}</dd></div>
                <div><dt class="muted mb-1">System</dt><dd class="font-semibold">{{ ticket.feedback.osVersion || '–' }}</dd></div>
                <div><dt class="muted mb-1">Language</dt><dd class="font-semibold">{{ ticket.feedback.locale || '–' }}</dd></div>
                <div><dt class="muted mb-1">Tester</dt><dd class="truncate font-semibold" :title="ticket.feedback.tester?.email || ''">{{ ticket.feedback.tester ? displayName(ticket.feedback.tester) : '–' }}</dd></div>
              </dl>
              <div v-if="ticket.feedback.comment" class="mt-4 border-t border-[color-mix(in_srgb,var(--accent)_20%,transparent)] pt-4">
                <p class="muted mb-1 text-[11px] font-semibold uppercase tracking-wider">Original message</p>
                <p class="whitespace-pre-wrap text-xs leading-relaxed">{{ ticket.feedback.comment }}</p>
              </div>
            </section>

            <section v-if="ticket?.jira" class="rounded-2xl bg-[var(--accent-soft)] p-4 sm:p-5">
              <div class="mb-4 flex items-center gap-2 text-sm font-bold"><SquareKanban :size="17" /> Jira issue</div>
              <dl class="grid grid-cols-2 gap-x-5 gap-y-4 text-xs">
                <div>
                  <dt class="muted mb-1">Issue</dt>
                  <dd class="font-semibold">
                    <a :href="ticket.jira.url" target="_blank" rel="noopener noreferrer" class="focus-ring inline-flex items-center gap-1 rounded underline decoration-dotted hover:text-[var(--accent)]">
                      {{ ticket.jira.issueKey }} <ExternalLink :size="11" aria-hidden="true" />
                    </a>
                  </dd>
                </div>
                <div><dt class="muted mb-1">Project</dt><dd class="font-semibold">{{ ticket.jira.projectKey || '–' }}</dd></div>
                <div><dt class="muted mb-1">Type</dt><dd class="font-semibold">{{ ticket.jira.issueType || '–' }}</dd></div>
                <div><dt class="muted mb-1">Status in Jira</dt><dd class="font-semibold">{{ ticket.jira.status || '–' }}<span v-if="ticket.jira.statusCategory && ticket.jira.statusCategory !== ticket.jira.status" class="muted"> · {{ ticket.jira.statusCategory }}</span></dd></div>
                <div><dt class="muted mb-1">Priority in Jira</dt><dd class="font-semibold">{{ ticket.jira.jiraPriority || '–' }}</dd></div>
                <div><dt class="muted mb-1">Reporter</dt><dd class="truncate font-semibold" :title="ticket.jira.reporter?.email || ''">{{ ticket.jira.reporter ? displayName(ticket.jira.reporter) : ticket.jira.reporterName || '–' }}</dd></div>
                <div><dt class="muted mb-1">Assignee in Jira</dt><dd class="truncate font-semibold">{{ ticket.jira.assigneeName || '–' }}</dd></div>
                <div><dt class="muted mb-1">Created</dt><dd class="font-semibold">{{ date(ticket.jira.sourceCreatedAt) }}</dd></div>
              </dl>
              <div v-if="ticket.jira.labels.length" class="mt-4 border-t border-[color-mix(in_srgb,var(--accent)_20%,transparent)] pt-4">
                <p class="muted mb-1 text-[11px] font-semibold uppercase tracking-wider">Labels in Jira</p>
                <p class="text-xs leading-relaxed">{{ ticket.jira.labels.join(', ') }}</p>
              </div>
              <p class="muted mt-4 text-[11px] leading-relaxed">Imported once; the ticket is carried on here and Jira is not updated.</p>
            </section>

            <TicketActivity :ticket-id="ticket.id" :refresh-key="commentRefreshKey" />
          </div>

          <!-- Pinned, the files ride as a narrow column at the far right, past pinned comments; on a phone they follow the fields. -->
          <div
            v-show="filesShown"
            data-editor-pane="files"
            :role="pinned.files ? 'complementary' : 'tabpanel'"
            class="relative"
            :class="pinned.files ? ['border-t border-[var(--line)] sm:border-l sm:border-t-0', commentsPinned ? 'lg:order-last' : ''] : 'order-first'"
          >
            <!-- The whole line can be grabbed; the handle in its middle shows where. -->
            <div v-if="pinned.files" class="absolute inset-y-0 -left-1.5 z-20 hidden w-3 cursor-col-resize sm:block" aria-hidden="true" @pointerdown="startFilesResize" @dblclick="resetFilesWidth" />
            <div :class="pinned.files ? 'sm:sticky sm:top-[var(--editor-header)] sm:h-[calc(100dvh-var(--editor-header)-4.5rem)]' : ''">
              <div
                v-if="pinned.files"
                role="separator"
                tabindex="0"
                aria-orientation="vertical"
                aria-label="Width of the assets column"
                :aria-valuenow="shownFilesWidth"
                :aria-valuemin="FILES_MIN_WIDTH"
                title="Drag to resize · double-click to reset"
                class="group/handle focus-ring absolute left-0 top-1/2 z-30 hidden h-12 w-3 -translate-x-1/2 -translate-y-1/2 cursor-col-resize place-items-center rounded-full sm:grid"
                @pointerdown="startFilesResize"
                @dblclick="resetFilesWidth"
                @keydown="resizeFilesByKey"
              >
                <span
                  class="flex h-full w-full flex-col items-center justify-center gap-[3px] rounded-full border bg-[var(--panel-strong)] shadow-sm transition-colors group-hover/handle:border-[var(--accent)] group-hover/handle:bg-[var(--accent-soft)]"
                  :class="resizingFiles ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--line)]'"
                >
                  <span v-for="dot in 3" :key="dot" class="size-[3px] rounded-full bg-[var(--muted)] group-hover/handle:bg-[var(--accent)]" />
                </span>
              </div>
          <div class="space-y-3 px-5 py-6 scrollbar-thin" :class="pinned.files ? 'sm:max-h-full sm:overflow-y-auto sm:px-3' : 'sm:px-7'">
            <div class="flex items-center justify-between gap-2">
              <h3 class="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><Paperclip :size="14" /> Assets</h3>
              <button type="button" :class="pinButton" :aria-pressed="pinned.files" :aria-label="pinned.files ? 'Unpin assets' : 'Pin assets beside the ticket'" :title="pinned.files ? 'Unpin' : 'Pin beside the ticket'" @click="togglePin('files')">
                <PinOff v-if="pinned.files" :size="15" aria-hidden="true" /><Pin v-else :size="15" aria-hidden="true" />
              </button>
            </div>
            <p v-if="!canEdit && !ticket?.attachments.length" class="muted text-xs">No files.</p>
            <div v-if="pendingFiles.length || ticket?.attachments.length" class="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
              <div v-for="(file, fileIndex) in pendingFiles" :key="`${file.name}-${file.size}-${file.lastModified}`" class="surface-strong min-w-0 rounded-xl p-2 text-xs">
                <div class="flex items-center gap-1.5 font-semibold" :title="file.name"><FileText :size="14" class="muted shrink-0" /> <span class="min-w-0 truncate">{{ file.name }}</span></div>
                <div class="mt-1 flex items-center">
                  <span class="muted text-[10px]">{{ formatSize(file.size) }}</span>
                  <button type="button" class="focus-ring ml-auto grid size-7 shrink-0 place-items-center rounded-lg text-rose-600 hover:bg-rose-500/10" :aria-label="`Remove ${file.name}`" @click="pendingFiles.splice(fileIndex, 1)"><X :size="14" /></button>
                </div>
              </div>
              <div v-for="attachment in ticket?.attachments" :key="attachment.id" class="surface-strong relative min-w-0 overflow-hidden rounded-xl text-xs">
                <button v-if="attachment.mimeType.startsWith('image/')" type="button" class="focus-ring group block w-full" :aria-label="`Open ${attachment.filename}`" @click="lightboxId = attachment.id">
                  <img :src="attachment.url" :alt="attachment.filename" class="h-36 w-full bg-black/5 object-contain transition group-hover:scale-[1.03]" loading="lazy">
                </button>
                <CardImageToggle v-if="cardImageOptions.has(attachment.id)" :checked="shownOnCard.has(attachment.id)" :can-edit="canEdit" :name="attachment.filename" @toggle="toggleCardImage(attachment.id)" />
                <div class="px-2 pb-1 pt-2">
                  <a v-if="!attachment.mimeType.startsWith('image/')" :href="attachment.url" target="_blank" class="focus-ring flex items-center gap-1.5 rounded font-semibold hover:text-[var(--accent)]" :title="attachment.filename"><FileText :size="14" class="muted shrink-0" /> <span class="min-w-0 truncate">{{ attachment.filename }}</span></a>
                  <div v-else class="truncate font-semibold" :title="attachment.filename">{{ attachment.filename }}</div>
                  <div class="mt-0.5 flex items-center">
                    <span class="muted mr-auto text-[10px]">{{ formatSize(attachment.size) }}</span>
                    <a :href="attachment.url" :download="attachment.filename" class="focus-ring grid size-7 shrink-0 place-items-center rounded-lg hover:bg-[var(--accent-soft)]" :aria-label="`Download ${attachment.filename}`" title="Download"><Download :size="14" /></a>
                    <button v-if="canEdit" type="button" class="focus-ring grid size-7 shrink-0 place-items-center rounded-lg text-rose-600 hover:bg-rose-500/10 disabled:opacity-40" :disabled="deletingAttachmentId === attachment.id" :aria-label="`Delete ${attachment.filename}`" title="Delete" @click="emit('removeAttachment', attachment)"><Trash2 :size="14" /></button>
                  </div>
                </div>
              </div>
            </div>
            <template v-if="canEdit">
              <input ref="fileInput" type="file" multiple class="sr-only" accept=".jpg,.jpeg,.png,.gif,.webp,.heic,.pdf,.txt,.log,.csv,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx" @change="chooseFiles">
              <button
                type="button"
                class="focus-ring surface-strong flex w-full flex-col items-center justify-center rounded-xl border-dashed px-2 py-4 text-center transition duration-150"
                :class="dragActive ? 'border-[var(--accent)] bg-[var(--accent-soft)] ring-2 ring-[color-mix(in_srgb,var(--accent)_35%,transparent)]' : 'hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]'"
                title="Images and documents · max. 25 MB per file"
                @click="fileInput?.click()"
                @dragenter.prevent="dragActive = true"
                @dragleave.prevent="dragActive = false"
                @dragover.prevent="dragActive = true"
                @drop.prevent="dropFiles"
              >
                <Upload :size="18" class="pointer-events-none mb-1.5 transition-colors" :class="dragActive ? 'text-[var(--accent)]' : 'muted'" />
                <span class="pointer-events-none text-xs font-semibold">{{ dragActive ? 'Drop here' : 'Add or drop files' }}</span>
                <span class="muted pointer-events-none mt-0.5 text-[10px]">max. 25 MB each</span>
              </button>
            </template>
            <p v-if="fileError" class="text-xs font-semibold text-rose-600" role="alert">{{ fileError }}</p>
            <TicketLinks :links="links" :saved="ticket?.links" :can-edit="canEdit" :card-image-options="cardImageOptions" :shown-on-card="shownOnCard" class="border-t border-[var(--line)] pt-4" @change="changeLinks" @toggle-card-image="toggleCardImage" />
          </div>
            </div>
          </div>

          <!-- The thread lives on the saved ticket, so a brand-new one gets it after the first save. -->
          <div
            v-if="ticket && commentsMounted"
            v-show="commentsShown"
            data-editor-pane="comments"
            :role="commentsPinned ? 'complementary' : 'tabpanel'"
            :class="commentsPinned ? ['border-t border-[var(--line)] lg:border-l lg:border-t-0', pinned.files ? 'sm:col-span-2 lg:col-span-1' : ''] : 'order-first'"
          >
          <div class="relative px-5 py-6 scrollbar-thin sm:px-7" :class="commentsPinned ? 'lg:sticky lg:top-[var(--editor-header)] lg:max-h-[calc(100dvh-var(--editor-header)-4.5rem)] lg:overflow-y-auto' : ''">
            <button type="button" :class="[pinButton, 'absolute right-4 top-5 sm:right-6']" :aria-pressed="pinned.comments" :aria-label="pinned.comments ? 'Unpin comments' : 'Pin comments beside the ticket'" :title="pinned.comments ? 'Unpin' : 'Pin beside the ticket'" @click="togglePin('comments')">
              <PinOff v-if="pinned.comments" :size="15" aria-hidden="true" /><Pin v-else :size="15" aria-hidden="true" />
            </button>
            <TicketComments
              :ticket-id="ticket.id"
              :can-moderate="canModerate"
              @changed="onCommented"
              @notify="(type, text) => emit('notify', type, text)"
            />
          </div>
          </div>
          </div>

          <footer class="sticky bottom-0 flex items-center gap-3 border-t border-[var(--line)] bg-[color-mix(in_srgb,var(--panel)_62%,var(--canvas))] px-5 py-4 sm:px-7">
            <button v-if="ticket && canEdit" type="button" class="focus-ring flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-rose-600 hover:bg-rose-500/10" @click="emit('archive', ticket)"><Archive :size="16" /> Archive</button>
            <p v-if="!canEdit" class="muted text-sm">You can read and comment on this board.</p>
            <!-- An existing ticket has no Save: every field saved itself, and this says how that went. -->
            <span v-if="isEdit && canEdit" class="ml-auto flex items-center gap-1.5 text-xs font-semibold" :class="saveState === 'error' ? 'text-rose-600' : 'muted'" role="status" aria-live="polite">
              <template v-if="saveState === 'saving'"><LoaderCircle :size="14" class="animate-spin" aria-hidden="true" /> Saving…</template>
              <template v-else-if="saveState === 'saved'"><Check :size="14" aria-hidden="true" /> Saved</template>
              <template v-else-if="saveState === 'error'"><CircleAlert :size="14" aria-hidden="true" /> Could not save</template>
            </span>
            <button type="button" class="focus-ring h-10 rounded-xl px-4 text-sm font-semibold hover:bg-[var(--panel-strong)]" :class="isEdit && canEdit ? '' : 'ml-auto'" @click="requestClose">{{ canEdit && !isEdit ? 'Cancel' : 'Close' }}</button>
            <button v-if="canEdit && !isEdit" type="submit" :disabled="saving || !form.title.trim()" class="focus-ring flex h-10 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] disabled:opacity-50"><Plus :size="16" /> {{ saving ? 'Creating…' : 'Create' }}</button>
          </footer>
        </form>

        <UiConfirmDialog
          v-if="discardOpen"
          :open="true"
          :title="isEdit ? 'Discard your changes?' : 'Discard this ticket?'"
          :description="isEdit ? 'The title or description has unsaved changes. They will be lost.' : 'Nothing has been saved yet. What you entered will be lost.'"
          confirm-label="Discard"
          @update:open="open => !open && (discardOpen = false)"
          @confirm="discard"
        />
        <SubticketDialog
          v-if="ticket"
          :open="subticketOpen"
          :boards="subticketBoards"
          :ticket-id="ticket.id"
          :default-board-id="ticket.boardId"
          :pending="subticketPending"
          @update:open="open => (subticketOpen = open)"
          @create="createSubticket"
          @link="linkSubticket"
        />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
  <Teleport to="body">
    <div
      v-if="draggedTodo && todoDragPreview"
      ref="todoDragPreviewElement"
      inert
      class="pointer-events-none fixed left-0 top-0 z-[110] will-change-transform"
      :style="{
        width: `${todoDragPreview.width}px`,
        transform: `translate3d(${todoDragPreview.x}px, ${todoDragPreview.y}px, 0)`,
      }"
      aria-hidden="true"
    >
      <div class="surface-strong flex items-center gap-2 rounded-xl border-[color-mix(in_srgb,var(--accent)_38%,var(--line))] p-2 shadow-[0_16px_38px_rgba(0,0,0,.18),0_4px_12px_rgba(0,0,0,.1)] [scale:1.015]">
        <span class="grid size-8 shrink-0 place-items-center rounded-lg text-[var(--accent)]"><GripVertical :size="17" /></span>
        <span class="grid size-4 shrink-0 place-items-center rounded-[4px] border" :class="draggedTodo.completed ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--line)]'">
          <Check v-if="draggedTodo.completed" :size="11" :stroke-width="3" />
        </span>
        <span class="min-w-0 flex-1 truncate px-1 py-1.5 text-sm" :class="draggedTodo.completed ? 'muted line-through' : ''"><span v-if="draggedTodo.subticket" class="muted mr-1.5 text-xs font-semibold tabular-nums">#{{ draggedTodo.subticket.ticketNumber }}</span>{{ draggedTodo.text || 'Empty to-do' }}</span>
        <span class="grid size-8 shrink-0 place-items-center rounded-lg text-rose-600"><Trash2 :size="15" /></span>
      </div>
    </div>
  </Teleport>
  <ImageLightbox v-if="lightboxId" :images="imageAttachments" :initial-id="lightboxId" @close="lightboxId = null" />
</template>

<style scoped>
.todo-sort-move {
  transition: transform 190ms cubic-bezier(.2, .8, .2, 1);
}
</style>
