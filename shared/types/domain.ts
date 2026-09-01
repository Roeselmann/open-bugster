export const ticketPriorities = ['low', 'medium', 'high', 'urgent'] as const
export const ticketSources = ['manual', 'testflight_screenshot', 'testflight_crash'] as const
export const categoryColors = ['neutral', 'rose', 'amber', 'emerald', 'teal', 'blue', 'violet', 'fuchsia'] as const
export const userRoles = ['owner', 'admin', 'member'] as const
export const userStatuses = ['invited', 'active', 'disabled'] as const
export const boardRoles = ['admin', 'editor', 'viewer'] as const
export const workspaceRoles = ['admin', 'member'] as const

export type TicketPriority = typeof ticketPriorities[number]
export type TicketSource = typeof ticketSources[number]
export type CategoryColor = typeof categoryColors[number]
export type UserRole = typeof userRoles[number]
export type UserStatus = typeof userStatuses[number]
export type BoardRole = typeof boardRoles[number]
export type WorkspaceRole = typeof workspaceRoles[number]

/**
 * Someone referenced by a ticket, comment, or activity entry. Everybody gets a row in
 * `users`, so a person is always addressed by id: an imported TestFlight tester exists as a
 * `contact` and turns into a team member the moment somebody invites that address, without
 * anything that points at them having to change.
 */
export interface Person {
  id: string
  /** null once the person has been anonymized. */
  email: string | null
  firstName: string
  lastName: string
  /** Whether this person can sign in. False for a contact and for a service identity alike. */
  isAccount: boolean
  /** A machine principal: it holds roles and appears in the history, but never signs in. */
  isService: boolean
  /** null for contacts, which have no account lifecycle. */
  status: UserStatus | null
  anonymizedAt: string | null
}

export interface UserAccount {
  id: string
  /** null once the account has been anonymized. */
  email: string | null
  firstName: string
  lastName: string
  role: UserRole
  status: UserStatus
  createdAt: string
  lastLoginAt: string | null
  anonymizedAt: string | null
  /** When the outstanding invitation lapses; null once it is used, revoked, or never issued. */
  inviteExpiresAt: string | null
  /** Every board the account is an explicit member of, with the role it holds there. */
  boards: UserBoardMembership[]
}

/** One board an account belongs to, as listed on the account itself. */
export interface UserBoardMembership {
  boardId: string
  boardName: string
  role: BoardRole
}

export interface BoardMember {
  userId: string
  /** null for a service identity, which holds a role without having an address. */
  email: string | null
  firstName: string
  lastName: string
  status: UserStatus
  role: BoardRole
  /**
   * Whether this membership may be worked through a token — the API, or an agent over MCP.
   * Independent of the role: it says how somebody may act on the board, not how much.
   * Shown as the **Integration** box under Board settings → Users.
   */
  mayAutomate: boolean
  addedAt: string
}

export interface TicketComment {
  id: string
  ticketId: string
  author: Person | null
  /** null once the author's account was hard-deleted. */
  authorId: string | null
  body: string
  createdAt: string
  updatedAt: string
}

export const activityKinds = ['created', 'moved', 'assigned', 'unassigned', 'author', 'priority', 'due_date', 'archived', 'restored', 'commented'] as const
export type ActivityKind = typeof activityKinds[number]

/** How a change reached the server. Everything written before agents existed reads `web`. */
export const activityChannels = ['web', 'api', 'mcp'] as const
export type ActivityChannel = typeof activityChannels[number]

export interface TicketActivityEntry {
  id: string
  ticketId: string
  /** Who answers for the change. */
  actor: Person | null
  /** What performed it — "Claude Desktop", "n8n prod" — or null when a person did it directly. */
  agentId: string | null
  channel: ActivityChannel
  kind: ActivityKind
  /** Person-valued keys hold user ids, not names — resolve them through `payloadPeople`. */
  payload: Record<string, string | null>
  /** The people named by this entry's payload, by payload key. */
  payloadPeople: Record<string, Person | null>
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

/**
 * The level above boards: a workspace groups them and will own everything meant to be
 * shared across them. It grants no board access by itself — board membership stays the
 * only key to a board; the workspace decides what is *around* the boards, not who is in.
 */
export interface Workspace {
  id: string
  name: string
  /** Shown next to the workspace name in the header. Empty when the workspace has none. */
  description: string
  position: number
  createdAt: string
}

export interface WorkspaceMember {
  userId: string
  /** null for a service identity, which holds a role without having an address. */
  email: string | null
  firstName: string
  lastName: string
  status: UserStatus
  role: WorkspaceRole
  addedAt: string
}

export interface WorkspaceSummary extends Workspace {
  members: WorkspaceMember[]
  /** Counts every board in the workspace, whether or not the caller can open it. */
  boardCount: number
  /**
   * The requesting user's own role. null when they see the workspace only because one of
   * its boards lets them in — they can pick it in the switcher, but not manage it.
   */
  role: WorkspaceRole | null
}

export interface Board {
  id: string
  workspaceId: string
  name: string
  /** Shown under the board title. Empty when the board has none. */
  description: string
  position: number
  /** How many of the newest TestFlight submissions each sync looks at, per feedback type. */
  syncLimit: number
  /** Whether an import whose tester has an account records that account as the author. */
  autoAuthor: boolean
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
  /** The tester Apple reported, as a contact or — once invited — a full account. */
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
