/** How urgently a card's due date calls for attention: nothing, orange, or red. */
export type DueLevel = 'none' | 'warning' | 'alert'

/** The board's clock: due dates are calendar days, and the cards read them in Berlin time. */
const todayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' })

/** Today as YYYY-MM-DD in the board's time zone. */
export function boardToday(now = new Date()): string {
  return todayFormatter.format(now)
}

/** Whole days from `today` to `dueDate`, both YYYY-MM-DD; negative once it is overdue. */
export function daysUntil(dueDate: string, today: string): number | null {
  const due = Date.parse(`${dueDate}T00:00:00Z`)
  const base = Date.parse(`${today}T00:00:00Z`)
  if (Number.isNaN(due) || Number.isNaN(base)) return null
  return Math.round((due - base) / 86_400_000)
}

/** How a lit card says when it is due: "Due today", "Due in 3 days", "Overdue by 2 days". */
export function dueDescription(dueDate: string, today: string): string | null {
  const days = daysUntil(dueDate, today)
  if (days === null) return null
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  if (days > 1) return `Due in ${days} days`
  return days === -1 ? 'Overdue by 1 day' : `Overdue by ${-days} days`
}

/**
 * Red from `alertDays` before the due date on, and for as long as it stays overdue; orange
 * from `warningDays` before. Red wins where the two overlap.
 */
export function dueLevel(dueDate: string | null, today: string, thresholds: { warningDays: number; alertDays: number }): DueLevel {
  if (!dueDate) return 'none'
  const days = daysUntil(dueDate, today)
  if (days === null) return 'none'
  if (days <= thresholds.alertDays) return 'alert'
  if (days <= thresholds.warningDays) return 'warning'
  return 'none'
}
