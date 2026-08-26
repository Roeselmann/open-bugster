export const ticketStatuses = ['import', 'backlog', 'open', 'question', 'in_progress', 'done'] as const
export const ticketPriorities = ['low', 'medium', 'high', 'urgent'] as const
export const ticketSources = ['manual', 'testflight_screenshot', 'testflight_crash'] as const

export type TicketStatus = typeof ticketStatuses[number]
export type TicketPriority = typeof ticketPriorities[number]
export type TicketSource = typeof ticketSources[number]

export interface Label {
  id: string
  name: string
  color: string
}

export interface Category {
  id: string
  name: string
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
  title: string
  description: string
  comment: string
  status: TicketStatus
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
  startedAt: string
  finishedAt: string | null
  status: 'running' | 'success' | 'partial' | 'failed'
  importedCount: number
  skippedCount: number
  failedCount: number
  errorMessage: string | null
}
