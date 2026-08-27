export const ticketPriorities = ['low', 'medium', 'high', 'urgent'] as const
export const ticketSources = ['manual', 'testflight_screenshot', 'testflight_crash'] as const
export const categoryColors = ['neutral', 'rose', 'amber', 'emerald', 'teal', 'blue', 'violet', 'fuchsia'] as const

export type TicketPriority = typeof ticketPriorities[number]
export type TicketSource = typeof ticketSources[number]
export type CategoryColor = typeof categoryColors[number]

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
  deviceModel: string | null
  osVersion: string | null
  locale: string | null
  buildId: string | null
  buildVersion: string | null
  buildBundleId: string | null
  sourceCreatedAt: string
}

export interface TicketAuthor {
  firstName: string
  lastName: string
  email: string
}

export interface Ticket {
  id: string
  ticketNumber: number
  boardId: string
  laneId: string
  title: string
  description: string
  comment: string
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
