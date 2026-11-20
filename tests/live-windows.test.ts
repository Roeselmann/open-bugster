import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The calendar's side of a live window: what the header lists, and what the sweep writes into
 * a ticket's history (and with that into `whats_new`) once, and only once, per date.
 */
describe('live windows', () => {
  let db: typeof import('../server/utils/db')
  const admin = { userId: 'nobody', instanceAdmin: true }

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-live-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    db = await import('../server/utils/db')
  })

  /** A board whose "In Progress" lane holds live work, and the lanes to put tickets in. */
  function liveBoard(name: string) {
    const board = db.createBoard(name)
    const live = board.lanes.find(lane => lane.name === 'In Progress')!
    db.updateLane(live.id, { isLive: true })
    const open = board.lanes.find(lane => lane.name === 'Backlog')!
    const done = board.lanes.find(lane => lane.isDone)!
    return { board, live, open, done }
  }
  const signalsFor = (signals: import('../server/utils/db').LiveSignal[], ticketId: string) =>
    signals.filter(signal => signal.ticketId === ticketId).map(signal => [signal.kind, signal.date])

  it('lists a live ticket in the header by the end of its window, not its due date', () => {
    const { board, live, open } = liveBoard('Header')
    db.createTicket(board.id, { title: 'Open work', dueDate: '2026-11-03', laneId: open.id })
    db.createTicket(board.id, { title: 'Out and ending', dueDate: '2026-10-01', liveFrom: '2026-10-01', liveUntil: '2026-11-04', laneId: live.id })
    db.createTicket(board.id, { title: 'Out and over', liveFrom: '2026-10-01', liveUntil: '2026-10-30', laneId: live.id })
    db.createTicket(board.id, { title: 'Out for months', liveFrom: '2026-10-01', liveUntil: '2027-06-30', laneId: live.id })
    // Live but without an end: nothing to watch.
    db.createTicket(board.id, { title: 'Out for good', dueDate: '2026-10-01', liveFrom: '2026-10-01', laneId: live.id })

    const listed = db.listDueTickets(admin, '2026-11-02').filter(ticket => ticket.boardId === board.id)
    expect(listed.map(ticket => [ticket.title, ticket.kind, ticket.date, ticket.level])).toEqual([
      ['Out and over', 'live', '2026-10-30', 'alert'],
      ['Open work', 'due', '2026-11-03', 'alert'],
      ['Out and ending', 'live', '2026-11-04', 'warning'],
      ['Out for months', 'live', '2027-06-30', 'none'],
    ])
  })

  it('announces a go-live once, whatever lane the ticket is in', () => {
    const { board, open } = liveBoard('Go-live')
    const ticket = db.createTicket(board.id, { title: 'Campaign', dueDate: '2026-11-01', liveFrom: '2026-11-02', liveUntil: '2026-12-31', laneId: open.id })!

    expect(signalsFor(db.sweepLiveWindows('2026-11-01'), ticket.id)).toEqual([])
    expect(signalsFor(db.sweepLiveWindows('2026-11-02'), ticket.id)).toEqual([['went_live', '2026-11-02']])
    expect(signalsFor(db.sweepLiveWindows('2026-11-02'), ticket.id)).toEqual([])
    expect(signalsFor(db.sweepLiveWindows('2026-11-03'), ticket.id)).toEqual([])

    const entry = db.listActivity(ticket.id).find(item => item.kind === 'went_live')!
    expect(entry).toMatchObject({ actor: null, agentId: null, channel: 'system', payload: { date: '2026-11-02' } })
    // And with that, it is in the board's digest that whats_new reads.
    expect(db.listBoardActivity(board.id).some(item => item.kind === 'went_live' && item.ticketId === ticket.id)).toBe(true)
  })

  it('announces a moved window again, for its new date', () => {
    const { board, open } = liveBoard('Moved go-live')
    const ticket = db.createTicket(board.id, { title: 'Campaign', liveFrom: '2026-11-02', laneId: open.id })!
    expect(signalsFor(db.sweepLiveWindows('2026-11-02'), ticket.id)).toEqual([['went_live', '2026-11-02']])
    db.updateTicket(ticket.id, { liveFrom: '2026-11-05' })
    expect(signalsFor(db.sweepLiveWindows('2026-11-04'), ticket.id)).toEqual([])
    expect(signalsFor(db.sweepLiveWindows('2026-11-05'), ticket.id)).toEqual([['went_live', '2026-11-05']])
  })

  it('does not announce go-lives long past or windows already closed', () => {
    const { board, live } = liveBoard('Old news')
    const months = db.createTicket(board.id, { title: 'Out since summer', liveFrom: '2026-06-01', laneId: live.id })!
    const lateButFair = db.createTicket(board.id, { title: 'Went out on Friday', liveFrom: '2026-10-30', laneId: live.id })!
    const closed = db.createTicket(board.id, { title: 'Over', liveFrom: '2026-10-30', liveUntil: '2026-10-31', laneId: board.lanes.find(lane => lane.name === 'Backlog')!.id })!

    const signals = db.sweepLiveWindows('2026-11-02')
    expect(signalsFor(signals, months.id)).toEqual([])
    expect(signalsFor(signals, lateButFair.id)).toEqual([['went_live', '2026-10-30']])
    expect(signalsFor(signals, closed.id)).toEqual([])
  })

  it('warns before the end and reports the end once, only while the ticket is live', () => {
    const { board, live, done } = liveBoard('Ending')
    // The board's default warning range is the one the cards use.
    const warningDays = db.findBoard(board.id)!.dueWarningDays
    const until = '2026-11-20'
    const ticket = db.createTicket(board.id, { title: 'Banner', liveFrom: '2026-01-01', liveUntil: until, laneId: live.id })!
    const takenDown = db.createTicket(board.id, { title: 'Banner already off', liveFrom: '2026-01-01', liveUntil: until, laneId: done.id })!

    const before = new Date(Date.parse(`${until}T00:00:00Z`) - (warningDays + 1) * 86_400_000).toISOString().slice(0, 10)
    const inRange = new Date(Date.parse(`${until}T00:00:00Z`) - warningDays * 86_400_000).toISOString().slice(0, 10)
    expect(signalsFor(db.sweepLiveWindows(before), ticket.id)).toEqual([])
    expect(signalsFor(db.sweepLiveWindows(inRange), ticket.id)).toEqual([['live_ending', until]])
    expect(signalsFor(db.sweepLiveWindows(until), ticket.id)).toEqual([])
    expect(signalsFor(db.sweepLiveWindows('2026-11-21'), ticket.id)).toEqual([['live_ended', until]])
    expect(signalsFor(db.sweepLiveWindows('2026-11-25'), ticket.id)).toEqual([])

    const later = db.sweepLiveWindows('2026-11-21')
    expect(signalsFor(later, takenDown.id)).toEqual([])
  })
})
