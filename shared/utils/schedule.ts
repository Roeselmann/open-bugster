import type { TicketRecurrence, TicketSchedule } from '../types/domain'
import { boardToday } from './due-date'
import { occurrenceOnOrAfter, occurrenceOnOrBefore } from './recurrence'

/** The fields that say when a ticket happens, and how. */
export interface ScheduleFields {
  schedule: TicketSchedule
  startDate: string | null
  dueDate: string | null
  liveFrom: string | null
  liveUntil: string | null
  /** The rule of a recurring ticket; null for every other schedule. */
  recurrence: TicketRecurrence | null
}

/** Whether two rules put their rounds on different days; the series' other settings do not. */
function movesRounds(before: TicketRecurrence | null, after: TicketRecurrence): boolean {
  return !before || before.frequency !== after.frequency || before.interval !== after.interval || before.anchor !== after.anchor
}

const dateKeys = ['startDate', 'dueDate', 'liveFrom', 'liveUntil'] as const

export type ScheduleOutcome = { ok: true; value: ScheduleFields } | { ok: false; message: string }

/**
 * The schedule and dates as they will stand after `patch`, or why they cannot. Switching
 * clears what the new schedule has no room for: `none` every date, `milestone` the start and
 * the live window, keeping one day as the due date (the start, when that was all there was).
 * A date sent to an undated ticket without a schedule makes it a lifecycle, so callers that
 * only know dates keep working. A date the schedule has no room for, sent outright, is refused.
 *
 * A recurring ticket is one day per round, like a milestone, and that day is its due date: the
 * round that is on now. Sending a rule makes a ticket recurring, and null for the rule stops
 * the series, leaving the round that was on as a milestone. A new rule — or one that puts the
 * rounds on other days — starts at the first of its rounds from `today` on; a due date sent
 * with it, or alone, moves only the current round, and the series carries on from its rule.
 */
export function settleSchedule(before: ScheduleFields, patch: Partial<ScheduleFields>, today = boardToday()): ScheduleOutcome {
  // Only the schedule's own fields: `before` is often a whole ticket, whose labels, to-dos and
  // the rest must not ride along into the update.
  const next: ScheduleFields = { schedule: before.schedule, startDate: before.startDate, dueDate: before.dueDate, liveFrom: before.liveFrom, liveUntil: before.liveUntil, recurrence: before.recurrence ?? null }
  for (const key of dateKeys) if (patch[key] !== undefined) next[key] = patch[key] || null
  if (patch.recurrence !== undefined) next.recurrence = patch.recurrence
  const sends = (key: typeof dateKeys[number]) => Boolean(patch[key])
  next.schedule = patch.schedule
    ?? (patch.recurrence ? 'recurring'
      : patch.recurrence === null && before.schedule === 'recurring' ? 'milestone'
      : before.schedule === 'none' && dateKeys.some(sends) ? 'lifecycle' : before.schedule)

  if (next.schedule !== 'recurring' && patch.recurrence) {
    return { ok: false, message: 'A recurrence rule only goes with schedule "recurring".' }
  }
  if (next.schedule === 'none') {
    if (dateKeys.some(sends)) return { ok: false, message: 'A ticket without a schedule has no dates. Send schedule "milestone" or "lifecycle" with them.' }
    return { ok: true, value: { schedule: 'none', startDate: null, dueDate: null, liveFrom: null, liveUntil: null, recurrence: null } }
  }
  if (next.schedule === 'milestone') {
    if (sends('startDate') || sends('liveFrom') || sends('liveUntil')) {
      return { ok: false, message: 'A milestone is one day, its dueDate: it has no start date and no live window.' }
    }
    const day = next.dueDate ?? next.startDate
    if (!day) return { ok: false, message: 'A milestone needs its day as dueDate.' }
    return { ok: true, value: { schedule: 'milestone', startDate: null, dueDate: day, liveFrom: null, liveUntil: null, recurrence: null } }
  }
  if (next.schedule === 'recurring') {
    if (sends('startDate') || sends('liveFrom') || sends('liveUntil')) {
      return { ok: false, message: 'A recurring ticket is one day per round, its dueDate: it has no start date and no live window.' }
    }
    const rule = next.recurrence
    if (!rule) return { ok: false, message: 'A recurring ticket needs its rule: recurrence with at least frequency and anchor.' }
    if (rule.until && rule.until < rule.anchor) return { ok: false, message: 'A series cannot end before its first round.' }
    // A due date cleared reads as none sent: a recurring ticket always has its round.
    let day = patch.dueDate || null
    if (!day && (before.schedule !== 'recurring' || !before.dueDate || movesRounds(before.recurrence ?? null, rule))) {
      day = occurrenceOnOrAfter(rule, today)
      // A series whose end has passed already keeps its last round, to show how it went.
      if (rule.until && day > rule.until) day = occurrenceOnOrBefore(rule, rule.until)
    }
    day ??= before.dueDate
    if (!day) return { ok: false, message: 'A recurring ticket needs a round: its series ends before the first one.' }
    return { ok: true, value: { schedule: 'recurring', startDate: null, dueDate: day, liveFrom: null, liveUntil: null, recurrence: rule } }
  }
  return { ok: true, value: { ...next, recurrence: null } }
}

/** Whether a patch touches the schedule, any of its dates, or a recurring ticket's rule. */
export function touchesSchedule(patch: Partial<ScheduleFields>): boolean {
  return patch.schedule !== undefined || patch.recurrence !== undefined || dateKeys.some(key => patch[key] !== undefined)
}
