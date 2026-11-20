import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describeRecurrence, nextRound, occurrence, occurrenceAfter, occurrenceOnOrAfter, occurrenceOnOrBefore, occurrencesBetween, roundCloses
} from '../shared/utils/recurrence'
import { settleSchedule, type ScheduleFields } from '../shared/utils/schedule'
import type { TicketRecurrence } from '../shared/types/domain'

const weekly = (anchor: string, extra: Partial<TicketRecurrence> = {}): TicketRecurrence =>
  ({ frequency: 'weekly', interval: 1, anchor, until: null, resetTodos: true, returnLaneId: null, ...extra })

describe('the calendar of a series', () => {
  it('keeps the weekday, the day of the month and the date', () => {
    expect(occurrencesBetween(weekly('2026-11-02'), '2026-11-01', '2026-11-30')).toEqual(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'])
    expect(occurrencesBetween({ frequency: 'weekly', interval: 2, anchor: '2026-11-02' }, '2026-11-03', '2026-12-31')).toEqual(['2026-11-16', '2026-11-30', '2026-12-14', '2026-12-28'])
    expect(occurrencesBetween({ frequency: 'daily', interval: 3, anchor: '2026-11-01' }, '2026-11-01', '2026-11-10')).toEqual(['2026-11-01', '2026-11-04', '2026-11-07', '2026-11-10'])
    expect(occurrence({ frequency: 'yearly', interval: 1, anchor: '2024-02-29' }, 1)).toBe('2025-02-28')
    expect(occurrence({ frequency: 'yearly', interval: 1, anchor: '2024-02-29' }, 4)).toBe('2028-02-29')
  })

  it('takes the last day of a short month, and goes back to the day after', () => {
    const monthly = { frequency: 'monthly' as const, interval: 1, anchor: '2026-01-31' }
    expect(occurrencesBetween(monthly, '2026-01-01', '2026-05-31')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'])
    const quarterly = { frequency: 'monthly' as const, interval: 3, anchor: '2026-10-31' }
    expect(occurrencesBetween(quarterly, '2026-11-01', '2027-12-31')).toEqual(['2027-01-31', '2027-04-30', '2027-07-31', '2027-10-31'])
  })

  it('finds the round around any day', () => {
    const rule = weekly('2026-11-02')
    expect(occurrenceOnOrAfter(rule, '2026-11-20')).toBe('2026-11-23')
    expect(occurrenceOnOrAfter(rule, '2026-11-23')).toBe('2026-11-23')
    expect(occurrenceOnOrAfter(rule, '2026-01-01')).toBe('2026-11-02')
    expect(occurrenceOnOrBefore(rule, '2026-11-20')).toBe('2026-11-16')
    expect(occurrenceOnOrBefore(rule, '2026-11-01')).toBeNull()
    expect(occurrenceAfter(rule, '2026-11-23')).toBe('2026-11-30')
    // Far out the estimate from elapsed time still lands on the right month.
    const monthly = { frequency: 'monthly' as const, interval: 1, anchor: '2000-01-31' }
    expect(occurrenceOnOrAfter(monthly, '2030-02-15')).toBe('2030-02-28')
    expect(occurrenceOnOrBefore(monthly, '2030-02-27')).toBe('2030-01-31')
  })

  it('ends a series at its last day', () => {
    const rule = weekly('2026-11-02', { until: '2026-11-20' })
    expect(nextRound(rule, '2026-11-09')).toBe('2026-11-16')
    expect(nextRound(rule, '2026-11-16')).toBeNull()
    expect(roundCloses(rule, '2026-11-09')).toBe('2026-11-16')
    expect(roundCloses(rule, '2026-11-16')).toBe('2026-11-17')
  })

  it('says the rule in words', () => {
    expect(describeRecurrence(weekly('2026-11-02'))).toBe('Weekly on Monday')
    expect(describeRecurrence({ frequency: 'weekly', interval: 2, anchor: '2026-11-02' })).toBe('Every 2 weeks on Monday')
    expect(describeRecurrence({ frequency: 'monthly', interval: 3, anchor: '2026-10-31' })).toBe('Quarterly on the 31st')
    expect(describeRecurrence({ frequency: 'monthly', interval: 1, anchor: '2026-10-22' })).toBe('Monthly on the 22nd')
    expect(describeRecurrence({ frequency: 'yearly', interval: 1, anchor: '2026-11-03' })).toBe('Yearly on 3 Nov')
  })
})

describe('settling a recurring schedule', () => {
  const plain: ScheduleFields = { schedule: 'none', startDate: null, dueDate: null, liveFrom: null, liveUntil: null, recurrence: null }
  const value = (outcome: ReturnType<typeof settleSchedule>) => {
    if (!outcome.ok) throw new Error(outcome.message)
    return outcome.value
  }

  it('starts at the first round from today and keeps it while the rule keeps its days', () => {
    const started = value(settleSchedule(plain, { recurrence: weekly('2026-11-02') }, '2026-11-20'))
    expect(started).toMatchObject({ schedule: 'recurring', dueDate: '2026-11-23', startDate: null })
    // Only the settings: the current round stays.
    expect(value(settleSchedule(started, { recurrence: weekly('2026-11-02', { resetTodos: false }) }, '2026-11-25')).dueDate).toBe('2026-11-23')
    // Other days: the series starts again from today.
    expect(value(settleSchedule(started, { recurrence: weekly('2026-11-04') }, '2026-11-20')).dueDate).toBe('2026-11-25')
    // A due date moves only this round.
    expect(value(settleSchedule(started, { dueDate: '2026-11-24' }, '2026-11-20'))).toMatchObject({ schedule: 'recurring', dueDate: '2026-11-24' })
  })

  it('stops as a milestone and refuses what a round has no room for', () => {
    const started = value(settleSchedule(plain, { recurrence: weekly('2026-11-02') }, '2026-11-20'))
    expect(value(settleSchedule(started, { recurrence: null }))).toMatchObject({ schedule: 'milestone', dueDate: '2026-11-23', recurrence: null })
    expect(value(settleSchedule(started, { schedule: 'lifecycle' }))).toMatchObject({ schedule: 'lifecycle', recurrence: null })
    expect(settleSchedule(plain, { schedule: 'recurring' }).ok).toBe(false)
    expect(settleSchedule(started, { startDate: '2026-11-20' }).ok).toBe(false)
    // Clearing the round's day keeps the round: a recurring ticket always has one.
    expect(value(settleSchedule(started, { dueDate: null })).dueDate).toBe('2026-11-23')
    expect(settleSchedule(plain, { schedule: 'milestone', dueDate: '2026-11-20', recurrence: weekly('2026-11-02') }).ok).toBe(false)
    expect(settleSchedule(plain, { recurrence: weekly('2026-11-02', { until: '2026-10-01' }) }).ok).toBe(false)
  })
})

/** The server's side: a round closing, by hand and by the calendar, and what it leaves behind. */
describe('rounds of a recurring ticket', () => {
  let db: typeof import('../server/utils/db')
  let ops: typeof import('../server/operations')
  let actorModule: typeof import('../server/utils/actor')

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-rounds-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    process.env.APP_PASSWORD_HASH = 'scrypt$abc$def'
    process.env.APP_ADMIN_EMAIL = 'owner@example.com'
    db = await import('../server/utils/db')
    ops = await import('../server/operations')
    actorModule = await import('../server/utils/actor')
  })

  function weeklyBoard(name: string) {
    const board = db.createBoard(name, db.listUsers()[0]!.id)
    const weeklyLane = db.createLane(board.id, 'Weekly')!
    const done = board.lanes.find(lane => lane.isDone)!
    return { board, weeklyLane, done }
  }
  const series = (anchor: string, returnLaneId: string | null) => weekly(anchor, { returnLaneId })
  const todos = [{ text: 'Run the scan', completed: true }, { text: 'Write the note', completed: false }]

  it('misses a round left open, starts the next one fresh and back in its lane', () => {
    const { board, weeklyLane } = weeklyBoard('Missed')
    const ticket = db.createTicket(board.id, { title: 'Review', laneId: weeklyLane.id, schedule: 'recurring', dueDate: '2026-11-16', recurrence: series('2026-11-02', weeklyLane.id), todos })!
    expect(ticket).toMatchObject({ schedule: 'recurring', nextRound: '2026-11-23', rounds: [] })

    expect(db.sweepRounds('2026-11-22')).toEqual([])
    const [signal] = db.sweepRounds('2026-11-23').filter(item => item.ticketId === ticket.id)
    expect(signal).toMatchObject({ ticketId: ticket.id, kind: 'round_missed', date: '2026-11-16', outcome: 'missed', next: '2026-11-23' })
    expect(db.sweepRounds('2026-11-23')).toEqual([])

    const after = db.findTicket(ticket.id)!
    expect(after.dueDate).toBe('2026-11-23')
    expect(after.todos.map(todo => todo.completed)).toEqual([false, false])
    expect(after.rounds[0]).toMatchObject({ date: '2026-11-16', outcome: 'missed', todosDone: 1, todosTotal: 2, openTodos: ['Write the note'], closedBy: null })
    const entry = db.listActivity(ticket.id).find(item => item.kind === 'round_missed')!
    expect(entry).toMatchObject({ channel: 'system', payload: { date: '2026-11-16', next: '2026-11-23' } })
  })

  it('counts a card in the done lane as done and brings it back to its return lane', () => {
    const { board, weeklyLane, done } = weeklyBoard('Done')
    const ticket = db.createTicket(board.id, { title: 'Ads', laneId: done.id, schedule: 'recurring', dueDate: '2026-11-16', recurrence: series('2026-11-02', weeklyLane.id), todos })!
    const [signal] = db.sweepRounds('2026-11-23').filter(item => item.ticketId === ticket.id)
    expect(signal).toMatchObject({ kind: 'new_round', outcome: 'done' })
    expect(db.findTicket(ticket.id)!.laneId).toBe(weeklyLane.id)
  })

  it('catches up on the current round after the server was down, without stacking rounds', () => {
    const { board, weeklyLane } = weeklyBoard('Down')
    const ticket = db.createTicket(board.id, { title: 'Reviews', laneId: weeklyLane.id, schedule: 'recurring', dueDate: '2026-11-02', recurrence: series('2026-11-02', null), todos: [{ text: 'Count', completed: true }] })!
    const signals = db.sweepRounds('2026-11-25').filter(item => item.ticketId === ticket.id)
    expect(signals.map(item => [item.outcome, item.next])).toEqual([['done', '2026-11-23']])
    expect(db.findTicket(ticket.id)!.dueDate).toBe('2026-11-23')
  })

  it('closes a round by hand, and refuses a ticket that does not recur', async () => {
    const { board, weeklyLane } = weeklyBoard('By hand')
    const owner = actorModule.actorFor(db.findUser(db.listUsers()[0]!.id)!)
    const created = await ops.run(ops.ticketCreate, owner, { boardId: board.id, title: 'Keywords', laneId: weeklyLane.id, recurrence: { frequency: 'weekly', anchor: '2026-11-02' }, todos })
    const id = (created as { ticket: { id: string; dueDate: string } }).ticket.id
    const closed = await ops.run(ops.ticketRoundClose, owner, { ticketId: id, outcome: 'skipped' }) as { ticket: { dueDate: string; todos: Array<{ completed: boolean }> }; round: { date: string; outcome: string; next: string } }
    expect(closed.round.outcome).toBe('skipped')
    expect(closed.round.next > closed.round.date).toBe(true)
    expect(closed.ticket.dueDate).toBe(closed.round.next)
    expect(closed.ticket.todos.every(todo => !todo.completed)).toBe(true)

    const plain = db.createTicket(board.id, { title: 'Once' })!
    await expect(ops.run(ops.ticketRoundClose, owner, { ticketId: plain.id })).rejects.toMatchObject({ statusCode: 422 })
    // A return lane has to be one of the board's own.
    const other = weeklyBoard('Elsewhere')
    await expect(ops.run(ops.ticketUpdate, owner, { ticketId: id, recurrence: { frequency: 'weekly', anchor: '2026-11-02', returnLaneId: other.weeklyLane.id } })).rejects.toMatchObject({ statusCode: 422 })
  })

  it('ends a series after its last round', () => {
    const { board, weeklyLane } = weeklyBoard('Ending')
    const ticket = db.createTicket(board.id, { title: 'Pilot', laneId: weeklyLane.id, schedule: 'recurring', dueDate: '2026-11-16', recurrence: weekly('2026-11-02', { until: '2026-11-20' }) })!
    expect(ticket.nextRound).toBeNull()
    const mine = (signals: import('../server/utils/db').RoundSignal[]) => signals.filter(item => item.ticketId === ticket.id).map(item => [item.outcome, item.next])
    expect(mine(db.sweepRounds('2026-11-16'))).toEqual([])
    expect(mine(db.sweepRounds('2026-11-17'))).toEqual([['missed', null]])
    expect(mine(db.sweepRounds('2026-11-30'))).toEqual([])
    expect(db.findTicket(ticket.id)!.dueDate).toBe('2026-11-16')
  })

  it('stores a recurring ticket as a milestone with a rule, and back', () => {
    const { board } = weeklyBoard('Stored')
    const ticket = db.createTicket(board.id, { title: 'Stored', schedule: 'recurring', dueDate: '2026-11-23', recurrence: weekly('2026-11-02') })!
    const row = db.getDb().prepare('SELECT schedule, recurrence_frequency FROM tickets WHERE id = ?').get(ticket.id)
    expect(row).toEqual({ schedule: 'milestone', recurrence_frequency: 'weekly' })
    const stopped = db.updateTicket(ticket.id, { schedule: 'milestone', recurrence: null })!
    expect(stopped).toMatchObject({ schedule: 'milestone', recurrence: null, nextRound: null })
  })
})
