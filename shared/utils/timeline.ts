import type { TimelineNode } from '../types/domain'

/** A node's days on a timeline. One date alone makes a one-day span; neither leaves it off. */
export interface Span {
  start: string
  end: string
}

/** The ticket's own span: start to due date. Either one alone is a single day, a milestone. */
export function spanOf(node: Pick<TimelineNode, 'startDate' | 'dueDate'>): Span | null {
  const start = node.startDate ?? node.dueDate
  const end = node.dueDate ?? node.startDate
  return start && end ? { start, end } : null
}

/** Whether the ticket is a single day: a start equal to its due date, or only one of the two. */
export function isMilestone(node: Pick<TimelineNode, 'startDate' | 'dueDate'>): boolean {
  const span = spanOf(node)
  return Boolean(span && span.start === span.end)
}

/** Every node of the tree in display order, each with how deep it sits; the root is depth 0. */
export function flattenTimeline(root: TimelineNode, collapsed: ReadonlySet<string> = new Set()): Array<{ node: TimelineNode; depth: number; path: string }> {
  const rows: Array<{ node: TimelineNode; depth: number; path: string }> = []
  const walk = (node: TimelineNode, depth: number, path: string) => {
    rows.push({ node, depth, path })
    if (collapsed.has(path)) return
    node.children.forEach((child, index) => walk(child, depth + 1, `${path}/${index}`))
  }
  walk(root, 0, '0')
  return rows
}

/** The days the whole tree covers, from the earliest start to the latest end; null when nothing is dated. */
export function timelineBounds(root: TimelineNode): Span | null {
  const spans = flattenTimeline(root).map(({ node }) => spanOf(node)).filter((span): span is Span => Boolean(span))
  if (!spans.length) return null
  return {
    start: spans.reduce((earliest, span) => (span.start < earliest ? span.start : earliest), spans[0]!.start),
    end: spans.reduce((latest, span) => (span.end > latest ? span.end : latest), spans[0]!.end)
  }
}

export type TimelineWarningKind = 'overdue' | 'ends_after_plan' | 'starts_before_plan'

export interface TimelineWarning {
  kind: TimelineWarningKind
  ticketId: string
  ticketNumber: number
  message: string
}

/**
 * What a planner should look at: open tickets past their due date, and tickets that run
 * outside the window of the ticket the timeline is drawn for — the campaign, say, whose dates
 * are the promise. Only that window counts: a review below a fragment follows the fragment's
 * production by design, so measuring it against the fragment's due date would warn about the
 * plan working as intended. Each ticket warns once per kind, even when it sits under two parents.
 */
export function timelineWarnings(root: TimelineNode, today: string): TimelineWarning[] {
  const warnings: TimelineWarning[] = []
  const seen = new Set<string>()
  const walk = (node: TimelineNode) => {
    if (seen.has(node.id)) return
    seen.add(node.id)
    const span = spanOf(node)
    if (!node.done && node.dueDate && node.dueDate < today) {
      warnings.push({ kind: 'overdue', ticketId: node.id, ticketNumber: node.ticketNumber, message: `#${node.ticketNumber} was due ${node.dueDate} and is not done.` })
    }
    if (node !== root && span) {
      if (root.dueDate && span.end > root.dueDate) {
        warnings.push({ kind: 'ends_after_plan', ticketId: node.id, ticketNumber: node.ticketNumber, message: `#${node.ticketNumber} ends ${span.end}, after #${root.ticketNumber} is due (${root.dueDate}).` })
      }
      if (root.startDate && span.start < root.startDate) {
        warnings.push({ kind: 'starts_before_plan', ticketId: node.id, ticketNumber: node.ticketNumber, message: `#${node.ticketNumber} starts ${span.start}, before #${root.ticketNumber} does (${root.startDate}).` })
      }
    }
    node.children.forEach(walk)
  }
  walk(root)
  return warnings
}
