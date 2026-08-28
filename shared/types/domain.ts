export const ticketPriorities = ['low', 'medium', 'high', 'urgent'] as const
export const ticketSources = ['manual', 'testflight_screenshot', 'testflight_crash'] as const
export const categoryColors = ['neutral', 'rose', 'amber', 'emerald', 'teal', 'blue', 'violet', 'fuchsia'] as const
export const userRoles = ['owner', 'admin', 'member'] as const
export const userStatuses = ['invited', 'active', 'disabled'] as const
export const boardRoles = ['admin', 'editor', 'viewer'] as const

export type TicketPriority = typeof ticketPriorities[number]
export type TicketSource = typeof ticketSources[number]
export type CategoryColor = typeof categoryColors[number]
export type UserRole = typeof userRoles[number]
export type UserStatus = typeof userStatuses[number]
export type BoardRole = typeof boardRoles[number]

/**
 * Someone referenced by a ticket, comment, or activity entry. The email is the identity
 * key and the only thing actually stored; `userId` is filled in at read time when an
 * account with that address exists, which is what makes an imported TestFlight tester
 * turn into a team member the moment somebody adds them.
 */
export interface Person {
  email: string
  firstName: string
  lastName: string
  /** null while no account carries this address. */
  userId: string | null
  status: UserStatus | null
}

export interface UserAccount {
  id: string
  email: string
  firstName: string
  lastName: string
  role: UserRole
  status: UserStatus
  createdAt: string
  lastLoginAt: string | null
  /** When the outstanding invitation lapses; null once it is used, revoked, or never issued. */
  inviteExpiresAt: string | null
  /** How many boards the account is an explicit member of. */
  boardCount: number
}

export interface BoardMember {
  userId: string
  email: string
  firstName: string
  lastName: string
  status: UserStatus
  role: BoardRole
  addedAt: string
}

export interface TicketComment {
  id: string
  ticketId: string
  author: Person | null
  authorEmail: string
  body: string
  createdAt: string
  updatedAt: string
}

export const activityKinds = ['created', 'moved', 'assigned', 'unassigned', 'priority', 'due_date', 'archived', 'restored', 'commented'] as const
export type ActivityKind = typeof activityKinds[number]

export interface TicketActivityEntry {
  id: string
  ticketId: string
  actor: Person | null
  kind: ActivityKind
  payload: Record<string, string | null>
  createdAt: string
}

export interface Lane {
  id: string
  boardId: string
  name: string
  position: number
  isImport: boolean
}

export interface LaneSummary extends Lane {
  ticketCount: number
  archivedCount: number
}

export interface BoardCredentials {
  issuerId: string
  keyId: string
  appId: string
  keyFilename: string | null
  keyUploadedAt: string | null
  complete: boolean
}

export interface Board {
  id: string
  name: string
  position: number
  /** How many of the newest TestFlight submissions each sync looks at, per feedback type. */
  syncLimit: number
  createdAt: string
}

export interface TestFlightConnection {
  name: string | null
  bundleId: string | null
}

export interface BoardSummary extends Board {
  lanes: LaneSummary[]
  ticketCount: number
  credentials: BoardCredentials
  members: BoardMember[]
  /** The requesting user's own role on this board, so the UI can gate controls. */
  role: BoardRole
}

export interface Label {
  id: string
  name: string
}

export interface LabelSummary extends Label {
  ticketCount: number
}

export interface Category {
  id: string
  name: string
  color: CategoryColor
}

export interface CategorySummary extends Category {
  ticketCount: number
}

export interface Attachment {
  id: string
  kind: 'screenshot' | 'crashlog' | 'file'
  filename: string
  mimeType: string
  size: number
  url: string
}

export interface TicketTodoInput {
  text: string
  completed: boolean
}

export interface TicketTodo extends TicketTodoInput {
  id: string
  position: number
}

export interface AppleFeedback {
  feedbackType: 'screenshot' | 'crash'
  comment: string | null
  testerEmail: string | null
  /** The account behind `testerEmail`, once one exists. */
  tester: Person | null
  deviceModel: string | null
  osVersion: string | null
  locale: string | null
  buildId: string | null
  buildVersion: string | null
  buildBundleId: string | null
  sourceCreatedAt: string
}

/** Kept as the historic name for a ticket's author; identical to `Person`. */
export type TicketAuthor = Person

export interface Ticket {
  id: string
  ticketNumber: number
  boardId: string
  laneId: string
  title: string
  description: string
  position: number
  priority: TicketPriority
  dueDate: string | null
  buildNumber: string | null
  source: TicketSource
  externalId: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  author: TicketAuthor | null
  assignee: Person | null
  commentCount: number
  category: Category | null
  labels: Label[]
  feedback: AppleFeedback | null
  attachments: Attachment[]
  todos: TicketTodo[]
}

export interface SyncRun {
  id: string
  boardId: string
  startedAt: string
  finishedAt: string | null
  status: 'running' | 'success' | 'partial' | 'failed'
  importedCount: number
  skippedCount: number
  failedCount: number
  errorMessage: string | null
}
