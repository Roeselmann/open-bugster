import type { RecurrenceFrequency, TicketRecurrence } from '../types/domain'

/**
 * The calendar of a recurring ticket: which days its rounds fall on.
 *
 * A rule counts from its anchor, the day of the first round, the way a calendar series does:
 * weekly keeps the anchor's weekday, monthly its day of the month, yearly its date. A month
 * too short for the day takes its last day instead — "monthly on the 31st" is the 30th in
 * April and the 28th or 29th in February — and the next month goes back to the 31st.
 * Dates are whole days, YYYY-MM-DD, and are reckoned in UTC so a change of daylight saving
 * time never moves one.
 */
export type RecurrenceRule = Pick<TicketRecurrence, 'frequency' | 'interval' | 'anchor'>

const DAY = 86_400_000

function toTime(date: string): number {
  return Date.parse(`${date}T00:00:00Z`)
}

function toDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

/** Round number `n` (0 is the anchor). */
export function occurrence(rule: RecurrenceRule, n: number): string {
  const anchor = new Date(toTime(rule.anchor))
  const step = Math.max(1, Math.floor(rule.interval))
  if (rule.frequency === 'daily') return toDate(anchor.getTime() + n * step * DAY)
  if (rule.frequency === 'weekly') return toDate(anchor.getTime() + n * step * 7 * DAY)
  const months = rule.frequency === 'monthly' ? n * step : n * step * 12
  const total = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + months
  const year = Math.floor(total / 12)
  const month = total - year * 12
  return toDate(Date.UTC(year, month, Math.min(anchor.getUTCDate(), daysInMonth(year, month))))
}

/**
 * The number of the last round on or before `date`, counted from the anchor; -1 before the
 * first. An estimate from the elapsed time, then corrected by a step or two — month lengths
 * make the estimate land next to the answer, never far from it.
 */
function indexOnOrBefore(rule: RecurrenceRule, date: string): number {
  if (date < rule.anchor) return -1
  const step = Math.max(1, Math.floor(rule.interval))
  const elapsed = (toTime(date) - toTime(rule.anchor)) / DAY
  const unitDays = rule.frequency === 'daily' ? 1 : rule.frequency === 'weekly' ? 7 : rule.frequency === 'monthly' ? 30.436875 : 365.2425
  let n = Math.max(0, Math.floor(elapsed / (unitDays * step)))
  while (n > 0 && occurrence(rule, n) > date) n -= 1
  while (occurrence(rule, n + 1) <= date) n += 1
  return n
}

/** The first round on or after `date`; the anchor itself while `date` lies before it. */
export function occurrenceOnOrAfter(rule: RecurrenceRule, date: string): string {
  const n = indexOnOrBefore(rule, date)
  if (n < 0) return rule.anchor
  const at = occurrence(rule, n)
  return at === date ? at : occurrence(rule, n + 1)
}

/** The last round on or before `date`; null before the first. */
export function occurrenceOnOrBefore(rule: RecurrenceRule, date: string): string | null {
  const n = indexOnOrBefore(rule, date)
  return n < 0 ? null : occurrence(rule, n)
}

/** The first round strictly after `date`. */
export function occurrenceAfter(rule: RecurrenceRule, date: string): string {
  const n = indexOnOrBefore(rule, date)
  return occurrence(rule, n + 1)
}

/** Every round from `from` to `to`, both inclusive, at most `limit` of them. */
export function occurrencesBetween(rule: RecurrenceRule, from: string, to: string, limit = 200): string[] {
  const days: string[] = []
  let day = occurrenceOnOrAfter(rule, from)
  while (day <= to && days.length < limit) {
    days.push(day)
    day = occurrenceAfter(rule, day)
  }
  return days
}

/** Whether a rule says a day a round may fall on: the anchor's weekday, day of the month, date. */
export function isOccurrence(rule: RecurrenceRule, date: string): boolean {
  return occurrenceOnOrBefore(rule, date) === date
}

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function ordinal(day: number): string {
  const tens = day % 100
  if (tens >= 11 && tens <= 13) return `${day}th`
  return `${day}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th'}`
}

const units: Record<RecurrenceFrequency, [string, string]> = {
  daily: ['day', 'days'],
  weekly: ['week', 'weeks'],
  monthly: ['month', 'months'],
  yearly: ['year', 'years']
}

/** "Weekly on Monday", "Every 2 weeks on Monday", "Quarterly on the 3rd", "Yearly on 3 Nov". */
export function describeRecurrence(rule: RecurrenceRule): string {
  const anchor = new Date(toTime(rule.anchor))
  const step = Math.max(1, Math.floor(rule.interval))
  const on = rule.frequency === 'weekly' ? ` on ${weekdays[anchor.getUTCDay()]}`
    : rule.frequency === 'monthly' ? ` on the ${ordinal(anchor.getUTCDate())}`
    : rule.frequency === 'yearly' ? ` on ${anchor.getUTCDate()} ${months[anchor.getUTCMonth()]}`
    : ''
  if (step === 1) return `${{ daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' }[rule.frequency]}${on}`
  if (rule.frequency === 'monthly' && step === 3) return `Quarterly${on}`
  if (rule.frequency === 'monthly' && step === 6) return `Every half year${on}`
  return `Every ${step} ${units[rule.frequency][1]}${on}`
}

/** The short form for a card: "Weekly", "Every 2 weeks", "Quarterly". */
export function recurrenceLabel(rule: Pick<TicketRecurrence, 'frequency' | 'interval'>): string {
  const step = Math.max(1, Math.floor(rule.interval))
  if (step === 1) return { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' }[rule.frequency]
  if (rule.frequency === 'monthly' && step === 3) return 'Quarterly'
  if (rule.frequency === 'monthly' && step === 6) return 'Half-yearly'
  return `Every ${step} ${units[rule.frequency][1]}`
}

/**
 * The round after `current`, or null once the series is over: the next day the rule gives
 * that is still within `until`.
 */
export function nextRound(recurrence: Pick<TicketRecurrence, 'frequency' | 'interval' | 'anchor' | 'until'>, current: string): string | null {
  const next = occurrenceAfter(recurrence, current)
  return recurrence.until && next > recurrence.until ? null : next
}

/**
 * The day the clock closes the round due on `current`: the day the next one is due, or, for
 * the last round of a series, the day after it.
 */
export function roundCloses(recurrence: Pick<TicketRecurrence, 'frequency' | 'interval' | 'anchor' | 'until'>, current: string): string {
  return nextRound(recurrence, current) ?? toDate(toTime(current) + DAY)
}
