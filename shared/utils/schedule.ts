import type { TicketSchedule } from '../types/domain'

/** The fields that say when a ticket happens, and how. */
export interface ScheduleFields {
  schedule: TicketSchedule
  startDate: string | null
  dueDate: string | null
  liveFrom: string | null
  liveUntil: string | null
}

const dateKeys = ['startDate', 'dueDate', 'liveFrom', 'liveUntil'] as const

export type ScheduleOutcome = { ok: true; value: ScheduleFields } | { ok: false; message: string }

/**
 * The schedule and dates as they will stand after `patch`, or why they cannot. Switching
 * clears what the new schedule has no room for: `none` every date, `milestone` the start and
 * the live window, keeping one day as the due date (the start, when that was all there was).
 * A date sent to an undated ticket without a schedule makes it a lifecycle, so callers that
 * only know dates keep working. A date the schedule has no room for, sent outright, is refused.
 */
export function settleSchedule(before: ScheduleFields, patch: Partial<ScheduleFields>): ScheduleOutcome {
  const next: ScheduleFields = { ...before }
  for (const key of dateKeys) if (patch[key] !== undefined) next[key] = patch[key] || null
  const sends = (key: typeof dateKeys[number]) => Boolean(patch[key])
  next.schedule = patch.schedule ?? (before.schedule === 'none' && dateKeys.some(sends) ? 'lifecycle' : before.schedule)

  if (next.schedule === 'none') {
    if (dateKeys.some(sends)) return { ok: false, message: 'A ticket without a schedule has no dates. Send schedule "milestone" or "lifecycle" with them.' }
    return { ok: true, value: { schedule: 'none', startDate: null, dueDate: null, liveFrom: null, liveUntil: null } }
  }
  if (next.schedule === 'milestone') {
    if (sends('startDate') || sends('liveFrom') || sends('liveUntil')) {
      return { ok: false, message: 'A milestone is one day, its dueDate: it has no start date and no live window.' }
    }
    const day = next.dueDate ?? next.startDate
    if (!day) return { ok: false, message: 'A milestone needs its day as dueDate.' }
    return { ok: true, value: { schedule: 'milestone', startDate: null, dueDate: day, liveFrom: null, liveUntil: null } }
  }
  return { ok: true, value: next }
}

/** Whether a patch touches the schedule or any of its dates. */
export function touchesSchedule(patch: Partial<ScheduleFields>): boolean {
  return patch.schedule !== undefined || dateKeys.some(key => patch[key] !== undefined)
}
