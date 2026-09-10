<script setup lang="ts">
import { Archive, ArrowDownToLine, ArrowRightLeft, ArrowUpToLine, Calendar, Check, CircleAlert, Download, ExternalLink, FileText, GripVertical, Image, Link as LinkIcon, ListTodo, LoaderCircle, MessageSquare, Paperclip, Plus, Shapes, SquareKanban, Tag, Tags, TestTubeDiagonal, Trash2, Upload, UserRound, X } from '@lucide/vue'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  VisuallyHidden,
} from 'reka-ui'
import type { Attachment, BoardMember, Category, LabelSummary, Lane, Ticket, TicketPatch, TicketPriority, TicketTodoInput, TicketType, BoardSummary } from '~~/shared/types/domain'
import { PRIORITY_LABELS } from '~~/shared/utils/constants'

const props = withDefaults(defineProps<{ ticket?: Ticket | null; lanes: Lane[]; members?: BoardMember[]; canEdit?: boolean; canModerate?: boolean; categories?: Category[]; labels?: LabelSummary[]; ticketTypes?: TicketType[]; saving?: boolean; /** How the last field-by-field save went; shown in the footer of an existing ticket. */ saveState?: 'idle' | 'saving' | 'saved' | 'error'; deletingAttachmentId?: string | null; initialLaneId?: string | null; initialPlacement?: 'top' | 'bottom'; laneTicketCount?: number; /** Other boards of the workspace the ticket may be moved onto. */ boards?: BoardSummary[] }>(), { canEdit: true, saveState: 'idle', initialLaneId: null, initialPlacement: 'bottom', laneTicketCount: 0, boards: () => [] })
const emit = defineEmits<{
  close: []
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
}>()

const form = reactive({ title: '', description: '', priority: 'medium' as TicketPriority, dueDate: '', buildNumber: '', link: '', assigneeId: 'unassigned', authorId: 'unassigned', labels: [] as string[], categoryName: '', typeId: 'none', laneId: '', placement: 'bottom' as 'top' | 'bottom' })
interface EditableTodo extends TicketTodoInput { key: string }
const todos = ref<EditableTodo[]>([])
// The category value whose save is still on its way, see `commitCategory`.
let categoryInFlight: string | null | undefined
let todoSequence = 0
const isEdit = computed(() => Boolean(props.ticket))
const isManual = computed(() => !props.ticket || props.ticket.source === 'manual')
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
const memberOptions = computed(() => (props.members || []).map(member => ({ value: member.userId, label: displayName(member) })))
const assigneeOptions = computed(() => [{ value: UNASSIGNED, label: 'Unassigned' }, ...memberOptions.value])
// The shortcut beside the label: only for a member of this board, and only while the
// ticket is not theirs already.
const { user } = useAuth()
const canAssignSelf = computed(() => {
  const id = user.value?.id
  return Boolean(props.canEdit && id && form.assigneeId !== id && (props.members || []).some(member => member.userId === id))
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
 * The thread gets its own column beside the ticket, but only once there is a conversation
 * to show — an empty one would cost half the drawer for nothing. `commentCount` comes with
 * the ticket, so the column is already open on the first paint rather than appearing late.
 */
const commentsOpen = ref(false)

function openComments() {
  commentsOpen.value = true
  nextTick(() => document.querySelector<HTMLTextAreaElement>('[data-comment-input]')?.focus())
}

function onCommented() {
  commentRefreshKey.value += 1
  emit('commented')
}
const fileInput = ref<HTMLInputElement | null>(null)
const pendingFiles = ref<File[]>([])
const fileError = ref('')
const dragActive = ref(false)
const lightboxId = ref<string | null>(null)
const imageAttachments = computed(() => props.ticket?.attachments.filter(attachment => attachment.mimeType.startsWith('image/')) || [])
const laneOptions = computed(() => props.lanes.map(lane => ({ value: lane.id, label: lane.name })))
// Whether the ticket already sits where a reorder button would take it.
const atTop = computed(() => (props.ticket?.position ?? 0) === 0)
const atBottom = computed(() => (props.ticket?.position ?? 0) >= props.laneTicketCount - 1)
const placementOptions = [{ value: 'top', label: 'Top of lane' }, { value: 'bottom', label: 'Bottom of lane' }]

// Moving onto another board hides behind a small pill beside the lane: pick the board, then
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
// The small pills beside a field label ("Assign to me", "Move to board"): one look for both.
const labelPill = 'focus-ring flex h-5 items-center gap-1 rounded-full border px-2 text-[11px] font-semibold leading-none transition'
const labelPillIdle = 'muted border-[var(--line)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]'
const labelPillActive = 'border-[var(--ink)] bg-[var(--ink)] text-[var(--canvas)]'
const priorityOptions = Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label }))
const categoryOptions = computed(() => (props.categories || []).map(category => category.name))
// Same sentinel trick as `UNASSIGNED`: "no type" needs a value the select can hold.
const NO_TYPE = 'none'
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
  form.dueDate = ticket?.dueDate || ''
  form.buildNumber = ticket?.buildNumber || ''
  form.link = ticket?.link || ''
  form.assigneeId = ticket?.assignee?.id || UNASSIGNED
  form.authorId = ticket?.author?.id || UNASSIGNED
  if (!sameTicket) commentsOpen.value = (ticket?.commentCount || 0) > 0
  form.labels = ticket?.labels.map(label => label.name) || []
  form.categoryName = ticket?.category?.name || ''
  categoryInFlight = undefined
  form.typeId = ticket?.type?.id || NO_TYPE
  // Only a new ticket picks its lane and position here; an existing one is moved through the lane select.
  form.laneId = ticket ? ticket.laneId : (props.initialLaneId || props.lanes[0]?.id || '')
  form.placement = ticket ? 'bottom' : props.initialPlacement
  const savedTodos = (ticket?.todos || []).map(todo => ({ text: todo.text, completed: todo.completed }))
  if (!sameTicket || JSON.stringify(savedTodos) !== JSON.stringify(payload.todos())) {
    todos.value = savedTodos.map(todo => ({ key: `todo-${++todoSequence}`, ...todo }))
  }
}, { immediate: true })

// The form's sentinels and blanks, turned into what the API expects. Used both by the
// single-field saves and by creating a ticket, so the two never disagree.
const payload = {
  assigneeId: () => form.assigneeId === UNASSIGNED ? null : form.assigneeId,
  authorId: () => form.authorId === UNASSIGNED ? null : form.authorId,
  typeId: () => form.typeId === NO_TYPE ? null : form.typeId,
  dueDate: () => form.dueDate || null,
  link: () => form.link.trim() || null,
  buildNumber: () => form.buildNumber.trim() || null,
  categoryName: () => form.categoryName.trim() || null,
  labels: () => [...form.labels],
  todos: () => todos.value.map(todo => ({ text: todo.text.trim(), completed: todo.completed })).filter(todo => todo.text),
}

/**
 * Saves the given fields of an existing ticket right away. A new ticket keeps them in the
 * form until it is created, so nothing happens there.
 */
function commit(changes: TicketPatch) {
  if (props.ticket && props.canEdit) emit('patch', props.ticket, changes)
}

// Text inputs save when they are left. Leaving one untouched must not cost a request (and an
// audit line), so the cleaned value is compared with what the ticket already has.
function commitLink() {
  if (payload.link() !== (props.ticket?.link || null)) commit({ link: payload.link() })
}
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
  const saved = (props.ticket?.todos || []).map(todo => ({ text: todo.text, completed: todo.completed }))
  if (JSON.stringify(next) !== JSON.stringify(saved)) commit({ todos: next })
}

// Escape (or anything else that unmounts the drawer) takes the focus away without a blur,
// so a value typed into one of these fields would otherwise be lost. Each commit compares
// with the ticket first, so an untouched field costs nothing here.
function flushPendingCommits() {
  if (!props.ticket || !props.canEdit) return
  commitLink()
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
  emit('save', { ...shared, ...manualFields, ...authorFields, laneId: form.laneId || undefined, placement: form.placement, title: form.title.trim(), description: form.description, priority: form.priority, dueDate: payload.dueDate(), link: payload.link(), labels: payload.labels(), categoryName: payload.categoryName(), typeId: payload.typeId(), stayOpen: options.stayOpen === true })
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
  <DialogRoot :open="true" @update:open="open => !open && emit('close')">
    <DialogPortal>
      <DialogOverlay class="ui-dialog-overlay fixed inset-0 z-50 bg-black/35" />
      <DialogContent
        data-ticket-editor-scroll
        class="ui-dialog-content fixed inset-y-0 right-0 z-[51] h-full w-full overflow-y-auto bg-[var(--panel)] shadow-2xl outline-none transition-[max-width] duration-200 ease-out"
        :class="commentsOpen ? 'max-w-xl lg:max-w-5xl' : 'max-w-xl'"
        @open-auto-focus="focusTitle"
      >
        <VisuallyHidden>
          <DialogDescription>{{ isEdit ? 'Edit the ticket. Changes are saved as you make them.' : 'Create a new ticket.' }}</DialogDescription>
        </VisuallyHidden>
        <form class="flex min-h-full flex-col" @submit.prevent="submit()">
          <header class="sticky top-0 z-10 grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--panel)_92%,transparent)] px-5 py-4 backdrop-blur-xl sm:px-7">
            <DialogTitle as-child>
              <h2 class="min-w-0 truncate text-xl font-bold tracking-[-.03em]">{{ ticket ? `Ticket #${ticket.ticketNumber}` : 'New ticket' }}</h2>
            </DialogTitle>
            <span
              v-if="person"
              class="surface-strong col-start-2 flex min-w-0 items-center gap-2 rounded-xl px-2.5 py-1"
              :title="`${person.role} · ${person.email}`"
            >
              <UserRound :size="15" class="muted shrink-0" aria-hidden="true" />
              <span class="truncate text-xs font-semibold">{{ person.name }}</span>
              <span class="sr-only">({{ person.role }}, {{ person.email }})</span>
            </span>
            <DialogClose as-child>
              <button type="button" class="focus-ring col-start-3 grid size-10 place-items-center justify-self-end rounded-xl hover:bg-[var(--panel-strong)]" aria-label="Close"><X :size="20" /></button>
            </DialogClose>
          </header>

          <div class="flex-1" :class="commentsOpen ? 'lg:grid lg:grid-cols-2 lg:items-start' : ''">
          <div class="space-y-6 px-5 py-6 sm:px-7">
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

            <section class="space-y-3">
              <div class="flex items-center gap-2">
                <h3 class="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><ListTodo :size="15" /> To-dos</h3>
                <span v-if="todos.length" class="muted ml-auto text-[11px] font-semibold">{{ todos.filter(todo => todo.completed).length }}/{{ todos.length }} completed</span>
              </div>
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
                      <button type="button" class="focus-ring grid size-8 shrink-0 place-items-center rounded-lg text-rose-600 hover:bg-rose-500/10" :aria-label="`Delete to-do ${todoIndexOf(item.key) + 1}`" @click="removeTodo(todoIndexOf(item.key))"><Trash2 :size="15" /></button>
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
              <div class="flex flex-wrap gap-2">
                <button type="button" :disabled="todos.length >= 100" class="focus-ring flex h-10 items-center gap-2 rounded-xl border border-dashed border-[var(--line)] px-3 text-sm font-semibold hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-50" @click="addTodo()"><Plus :size="16" /> Add to-do</button>
                <button v-if="ticket && !commentsOpen" type="button" class="focus-ring flex h-10 items-center gap-2 rounded-xl border border-dashed border-[var(--line)] px-3 text-sm font-semibold hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]" @click="openComments"><MessageSquare :size="16" /> Add comment</button>
              </div>
            </section>


            <div v-if="ticket" class="block border-t border-[var(--line)] pt-6">
              <div class="mb-2 flex h-5 items-center justify-between gap-2">
                <span class="text-xs font-bold uppercase tracking-[.08em]">Lane</span>
                <button
                  v-if="canEdit && boards.length"
                  type="button"
                  :class="[labelPill, transferOpen ? labelPillActive : labelPillIdle]"
                  :aria-expanded="transferOpen"
                  @click="toggleTransfer"
                >
                  <X v-if="transferOpen" :size="11" aria-hidden="true" /><ArrowRightLeft v-else :size="11" aria-hidden="true" />
                  {{ transferOpen ? 'Cancel' : 'Move to board' }}
                </button>
              </div>
              <div class="flex items-center gap-2">
                <div class="min-w-0 flex-1">
                  <UiSelect
                    :model-value="ticket.laneId"
                    :options="laneOptions"
                    :disabled="!canEdit"
                    aria-label="Lane"
                    @update:model-value="emit('move', ticket, $event)"
                  />
                </div>
                <button
                  v-if="canEdit"
                  type="button"
                  class="focus-ring muted flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--line)] transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--line)] disabled:hover:bg-transparent"
                  :disabled="atTop"
                  aria-label="Move to top of lane"
                  title="Move to top of lane"
                  @click="emit('reorder', ticket, 'top')"
                >
                  <ArrowUpToLine :size="16" aria-hidden="true" />
                </button>
                <button
                  v-if="canEdit"
                  type="button"
                  class="focus-ring muted flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--line)] transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--line)] disabled:hover:bg-transparent"
                  :disabled="atBottom"
                  aria-label="Move to bottom of lane"
                  title="Move to bottom of lane"
                  @click="emit('reorder', ticket, 'bottom')"
                >
                  <ArrowDownToLine :size="16" aria-hidden="true" />
                </button>
              </div>
              <!-- The transfer, folded out by the pill: destination board and lane, then one deliberate button. -->
              <div v-if="targetBoard" class="surface-strong mt-3 rounded-xl p-3">
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
            </div>
            <div v-else class="grid gap-4 border-t border-[var(--line)] pt-6 sm:grid-cols-2">
              <div class="block">
                <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Lane</span>
                <UiSelect :model-value="form.laneId" :options="laneOptions" aria-label="Lane" @update:model-value="form.laneId = $event" />
              </div>
              <div class="block">
                <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Position</span>
                <UiSelect :model-value="form.placement" :options="placementOptions" aria-label="Position in lane" @update:model-value="form.placement = $event as 'top' | 'bottom'" />
                <span class="muted mt-1.5 block text-[11px]">Top pushes the lane’s other tickets down.</span>
              </div>
            </div>

            <div class="grid gap-4 sm:grid-cols-2">
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
            </div>

            <div v-if="canAttribute" class="block">
              <span class="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><UserRound :size="14" /> Author</span>
              <UiSelect
                :model-value="form.authorId"
                :options="authorOptions"
                aria-label="Author"
                @update:model-value="form.authorId = $event; commit({ authorId: payload.authorId() })"
              />
              <p class="muted mt-2 text-xs">Who really reported this. Imports name their tester automatically when that person already has an account.</p>
            </div>

            <div class="grid gap-4 sm:grid-cols-2">
              <div class="block">
                <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Priority</span>
                <UiSelect
                  :model-value="form.priority"
                  :options="priorityOptions"
                  aria-label="Priority"
                  :disabled="!canEdit"
                  @update:model-value="form.priority = $event as TicketPriority; commit({ priority: form.priority })"
                />
              </div>
              <label class="block">
                <span class="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><Calendar :size="14" /> Due date</span>
                <input v-model="form.dueDate" type="date" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none" :readonly="!canEdit" @change="commit({ dueDate: payload.dueDate() })">
              </label>
            </div>

            <label v-if="isManual" class="block">
              <span class="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><TestTubeDiagonal :size="14" /> Build number</span>
              <input v-model="form.buildNumber" maxlength="100" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none" placeholder="e.g. 42 or 1.4.0 (42)" :readonly="!canEdit" @blur="commitBuildNumber" @keydown.enter.prevent="commitBuildNumber">
            </label>

            <div class="block">
              <label for="ticket-link" class="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><LinkIcon :size="14" /> Link</label>
              <div class="flex items-center gap-2">
                <input id="ticket-link" v-model="form.link" type="url" maxlength="2000" inputmode="url" spellcheck="false" class="focus-ring surface-strong h-11 min-w-0 flex-1 rounded-xl px-3 text-sm outline-none" placeholder="https://… — an issue, a document, anything this ticket refers to" :readonly="!canEdit" @blur="commitLink" @keydown.enter.prevent="commitLink">
                <a
                  v-if="ticket?.link"
                  :href="ticket.link"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="focus-ring flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-[var(--line)] px-3 text-sm font-semibold hover:bg-[var(--panel)]"
                  :title="ticket.link"
                ><ExternalLink :size="15" aria-hidden="true" /> Open</a>
              </div>
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
              <span class="muted mt-1.5 block text-[11px]">Optional · {{ isEdit ? 'A new name is created as soon as you leave the field.' : 'New names are created when the ticket is created.' }}</span>
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
              <span class="muted mt-1.5 block text-[11px]">{{ isEdit ? 'New names are created right away' : 'New names are created when the ticket is created' }} · a label no ticket uses any more is removed.</span>
            </div>

            <section v-if="ticket?.attachments.length" class="space-y-3">
              <h3 class="text-xs font-bold uppercase tracking-[.08em]">Existing attachments</h3>
              <div v-for="attachment in ticket.attachments" :key="attachment.id">
                <div v-if="attachment.mimeType.startsWith('image/')" class="surface-strong overflow-hidden rounded-2xl">
                  <button type="button" class="focus-ring group block w-full" @click="lightboxId = attachment.id">
                    <img :src="attachment.url" :alt="attachment.filename" class="max-h-72 w-full bg-black/5 object-contain transition group-hover:scale-[1.01]">
                  </button>
                  <div class="flex items-center gap-2 px-3 py-2 text-xs font-semibold">
                    <Image :size="14" /> <span class="min-w-0 truncate">{{ attachment.filename }}</span>
                    <span class="muted ml-auto shrink-0">{{ formatSize(attachment.size) }}</span>
                    <a :href="attachment.url" :download="attachment.filename" class="focus-ring grid size-8 shrink-0 place-items-center rounded-lg hover:bg-[var(--accent-soft)]" :aria-label="`Download ${attachment.filename}`"><Download :size="15" /></a>
                    <button v-if="isManual && attachment.kind === 'file'" type="button" class="focus-ring grid size-8 shrink-0 place-items-center rounded-lg text-rose-600 hover:bg-rose-500/10 disabled:opacity-40" :disabled="deletingAttachmentId === attachment.id" :aria-label="`Delete ${attachment.filename}`" @click="emit('removeAttachment', attachment)"><Trash2 :size="15" /></button>
                  </div>
                </div>
                <div v-else class="surface-strong flex items-center gap-3 rounded-xl p-3 text-sm font-semibold">
                  <FileText :size="17" class="muted shrink-0" />
                  <a :href="attachment.url" target="_blank" class="focus-ring min-w-0 flex-1 truncate rounded-lg hover:text-[var(--accent)]">{{ attachment.filename }}</a>
                  <span class="muted shrink-0 text-xs">{{ formatSize(attachment.size) }}</span>
                  <a :href="attachment.url" class="focus-ring grid size-8 shrink-0 place-items-center rounded-lg hover:bg-[var(--accent-soft)]" :aria-label="`Download ${attachment.filename}`"><Download :size="15" /></a>
                  <button v-if="isManual && attachment.kind === 'file'" type="button" class="focus-ring grid size-8 shrink-0 place-items-center rounded-lg text-rose-600 hover:bg-rose-500/10 disabled:opacity-40" :disabled="deletingAttachmentId === attachment.id" :aria-label="`Delete ${attachment.filename}`" @click="emit('removeAttachment', attachment)"><Trash2 :size="15" /></button>
                </div>
              </div>
            </section>

            <section v-if="isManual" class="space-y-3">
              <h3 class="flex items-center gap-2 text-xs font-bold uppercase tracking-[.08em]"><Paperclip :size="15" /> Add attachments</h3>
              <input ref="fileInput" type="file" multiple class="sr-only" accept=".jpg,.jpeg,.png,.gif,.webp,.heic,.pdf,.txt,.log,.csv,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx" @change="chooseFiles">
              <button
                type="button"
                class="focus-ring surface-strong flex w-full flex-col items-center justify-center rounded-2xl border-dashed px-5 py-7 text-center transition duration-150"
                :class="dragActive ? 'scale-[1.01] border-[var(--accent)] bg-[var(--accent-soft)] ring-2 ring-[color-mix(in_srgb,var(--accent)_35%,transparent)]' : 'hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]'"
                @click="fileInput?.click()"
                @dragenter.prevent="dragActive = true"
                @dragleave.prevent="dragActive = false"
                @dragover.prevent="dragActive = true"
                @drop.prevent="dropFiles"
              >
                <Upload :size="22" class="pointer-events-none mb-2 transition-colors" :class="dragActive ? 'text-[var(--accent)]' : 'muted'" />
                <span class="pointer-events-none text-sm font-semibold">{{ dragActive ? 'Drop files here' : 'Select files or drop them here' }}</span>
                <span class="muted pointer-events-none mt-1 text-[11px]">Images and documents · max. 25 MB per file</span>
              </button>
              <p v-if="fileError" class="text-xs font-semibold text-rose-600" role="alert">{{ fileError }}</p>
              <div v-if="pendingFiles.length" class="space-y-2">
                <div v-for="(file, fileIndex) in pendingFiles" :key="`${file.name}-${file.size}-${file.lastModified}`" class="surface-strong flex items-center gap-3 rounded-xl p-3 text-sm">
                  <FileText :size="17" class="muted shrink-0" />
                  <span class="min-w-0 flex-1 truncate font-semibold">{{ file.name }}</span>
                  <span class="muted shrink-0 text-xs">{{ formatSize(file.size) }}</span>
                  <button type="button" class="focus-ring grid size-8 shrink-0 place-items-center rounded-lg text-rose-600 hover:bg-rose-500/10" :aria-label="`Remove ${file.name}`" @click="pendingFiles.splice(fileIndex, 1)"><X :size="15" /></button>
                </div>
              </div>
            </section>

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

            <TicketActivity v-if="ticket" :ticket-id="ticket.id" :refresh-key="commentRefreshKey" />
          </div>

          <!-- The thread lives on the saved ticket, so a brand-new one gets it after the first save. -->
          <aside
            v-if="ticket && commentsOpen"
            class="border-t border-[var(--line)] px-5 py-6 sm:px-7 lg:sticky lg:top-[4.5rem] lg:border-l lg:border-t-0"
          >
            <TicketComments
              :ticket-id="ticket.id"
              :can-moderate="canModerate"
              @changed="onCommented"
              @notify="(type, text) => emit('notify', type, text)"
            />
          </aside>
          </div>

          <footer class="sticky bottom-0 flex items-center gap-3 border-t border-[var(--line)] bg-[color-mix(in_srgb,var(--panel)_92%,transparent)] px-5 py-4 backdrop-blur-xl sm:px-7">
            <button v-if="ticket && canEdit" type="button" class="focus-ring flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-rose-600 hover:bg-rose-500/10" @click="emit('archive', ticket)"><Archive :size="16" /> Archive</button>
            <p v-if="!canEdit" class="muted text-sm">You can read and comment on this board.</p>
            <!-- An existing ticket has no Save: every field saved itself, and this says how that went. -->
            <span v-if="isEdit && canEdit" class="ml-auto flex items-center gap-1.5 text-xs font-semibold" :class="saveState === 'error' ? 'text-rose-600' : 'muted'" role="status" aria-live="polite">
              <template v-if="saveState === 'saving'"><LoaderCircle :size="14" class="animate-spin" aria-hidden="true" /> Saving…</template>
              <template v-else-if="saveState === 'saved'"><Check :size="14" aria-hidden="true" /> Saved</template>
              <template v-else-if="saveState === 'error'"><CircleAlert :size="14" aria-hidden="true" /> Could not save</template>
            </span>
            <DialogClose as-child>
              <button type="button" class="focus-ring h-10 rounded-xl px-4 text-sm font-semibold hover:bg-[var(--panel-strong)]" :class="isEdit && canEdit ? '' : 'ml-auto'">{{ canEdit && !isEdit ? 'Cancel' : 'Close' }}</button>
            </DialogClose>
            <button v-if="canEdit && !isEdit" type="submit" :disabled="saving || !form.title.trim()" class="focus-ring flex h-10 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] disabled:opacity-50"><Plus :size="16" /> {{ saving ? 'Creating…' : 'Create' }}</button>
          </footer>
        </form>
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
        <span class="min-w-0 flex-1 truncate px-1 py-1.5 text-sm" :class="draggedTodo.completed ? 'muted line-through' : ''">{{ draggedTodo.text || 'Empty to-do' }}</span>
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
