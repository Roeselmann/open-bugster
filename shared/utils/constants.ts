import type { TicketPriority, TicketStatus } from '../types/domain'

export const STATUS_LABELS: Record<TicketStatus, string> = {
  import: 'Import',
  backlog: 'Backlog',
  open: 'Open',
  question: 'Question',
  in_progress: 'In Progress',
  done: 'Done'
}

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent'
}
