import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('boards and lanes', () => {
  let db: typeof import('../server/utils/db')

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-lanes-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    db = await import('../server/utils/db')
  })

  it('gives a new board its own lanes with one import lane', () => {
    const board = db.createBoard('Radio app')
    expect(board.lanes.map(lane => lane.name)).toEqual(['Import', 'Backlog', 'In Progress', 'Done'])
    expect(board.lanes.filter(lane => lane.isImport)).toHaveLength(1)
    expect(board.ticketCount).toBe(0)
    expect(board.credentials.complete).toBe(false)
  })

  it('adds, renames and reorders lanes', () => {
    const board = db.createBoard('Reorder')
    const lanes = db.createLane(board.id, 'Review') && db.listLanes(board.id)
    expect(lanes!.map(lane => lane.name)).toEqual(['Import', 'Backlog', 'In Progress', 'Done', 'Review'])

    const review = lanes!.at(-1)!
    expect(db.updateLane(review.id, { name: 'Code review' })).toMatchObject({ name: 'Code review' })

    const reversed = [...lanes!].reverse().map(lane => lane.id)
    expect(db.reorderLanes(board.id, reversed)!.map(lane => lane.name)).toEqual(['Code review', 'Done', 'In Progress', 'Backlog', 'Import'])
    // The import lane keeps its role wherever it sits.
    expect(db.importLaneFor(board.id)?.name).toBe('Import')
    expect(db.reorderLanes(board.id, reversed.slice(1))).toBeNull()
  })

  it('renames the import lane but refuses to delete it', () => {
    const board = db.createBoard('Import lane')
    const importLane = db.importLaneFor(board.id)!
    expect(db.updateLane(importLane.id, { name: 'TestFlight' })).toMatchObject({ name: 'TestFlight', isImport: true })
    expect(db.importLaneFor(board.id)?.name).toBe('TestFlight')
    expect(() => db.deleteLane(importLane.id, 'archive')).toThrow(db.LaneDeleteError)
  })

  it('moves tickets to another lane when their lane is deleted', () => {
    const board = db.createBoard('Move on delete')
    const lanes = db.listLanes(board.id)
    const doomed = lanes.find(lane => lane.name === 'In Progress')!
    const target = lanes.find(lane => lane.name === 'Backlog')!

    const keep = db.createTicket(board.id, { title: 'Already in backlog' })!
    const first = db.createTicket(board.id, { title: 'First' })!
    const second = db.createTicket(board.id, { title: 'Second' })!
    db.moveTicket(first.id, doomed.id, 0)
    db.moveTicket(second.id, doomed.id, 1)

    const remaining = db.deleteLane(doomed.id, 'move', target.id)
    expect(remaining.map(lane => lane.name)).toEqual(['Import', 'Backlog', 'Done'])
    expect(remaining.map(lane => lane.position)).toEqual([0, 1, 2])

    const moved = [keep, first, second].map(ticket => db.findTicket(ticket.id)!)
    expect(moved.every(ticket => ticket.laneId === target.id)).toBe(true)
    expect(moved.every(ticket => ticket.archivedAt === null)).toBe(true)
    // Positions stay dense after the two lanes are merged.
    expect([...moved].map(ticket => ticket.position).sort()).toEqual([0, 1, 2])
  })

  it('archives tickets when their lane is deleted without a target', () => {
    const board = db.createBoard('Archive on delete')
    const doomed = db.listLanes(board.id).find(lane => lane.name === 'In Progress')!
    const active = db.createTicket(board.id, { title: 'Active' })!
    const alreadyArchived = db.createTicket(board.id, { title: 'Already archived' })!
    db.moveTicket(active.id, doomed.id, 0)
    db.moveTicket(alreadyArchived.id, doomed.id, 1)
    db.archiveTicket(alreadyArchived.id)

    db.deleteLane(doomed.id, 'archive')

    const fallback = db.defaultLaneFor(board.id)!
    for (const ticket of [active, alreadyArchived]) {
      const stored = db.findTicket(ticket.id)!
      expect(stored.archivedAt).toBeTruthy()
      // Reassigned to a surviving lane so restoring still has somewhere to go.
      expect(stored.laneId).toBe(fallback.id)
    }
    expect(db.listTickets(board.id)).toHaveLength(0)
    expect(db.listTickets(board.id, true)).toHaveLength(2)
    expect(db.restoreTicket(active.id)?.laneId).toBe(fallback.id)
  })

  it('requires a target lane when moving tickets off a deleted lane', () => {
    const board = db.createBoard('Missing target')
    const doomed = db.listLanes(board.id).find(lane => lane.name === 'Done')!
    expect(() => db.deleteLane(doomed.id, 'move', 'not-a-lane')).toThrow(/Pick a lane/)
    expect(db.listLanes(board.id)).toHaveLength(4)
  })

  it('stores App Store Connect credentials encrypted and never in the clear', () => {
    const board = db.createBoard('Credentials')
    db.updateBoard(board.id, { issuerId: 'issuer', keyId: 'KEY123', appId: '1234567890' })
    const pem = '-----BEGIN PRIVATE KEY-----\nMIGHAgEA\n-----END PRIVATE KEY-----\n'
    const updated = db.setBoardPrivateKey(board.id, pem, 'AuthKey_KEY123.p8')!

    expect(updated.credentials).toMatchObject({ issuerId: 'issuer', keyId: 'KEY123', appId: '1234567890', keyFilename: 'AuthKey_KEY123.p8', complete: true })
    expect(JSON.stringify(updated)).not.toContain('BEGIN PRIVATE KEY')
    const stored = db.getDb().prepare('SELECT asc_private_key AS key FROM boards WHERE id = ?').get(board.id) as { key: string }
    expect(stored.key).not.toContain('BEGIN PRIVATE KEY')
    expect(db.boardSyncCredentials(board.id)?.privateKeyPem).toBe(pem)

    expect(db.clearBoardPrivateKey(board.id)?.credentials).toMatchObject({ complete: false, keyFilename: null })
    expect(db.boardSyncCredentials(board.id)?.privateKeyPem).toBeNull()
  })

  it('keeps a per-board submission limit', () => {
    const board = db.createBoard('Limits')
    expect(board.syncLimit).toBe(db.DEFAULT_SYNC_LIMIT)

    expect(db.updateBoard(board.id, { syncLimit: 25 })?.syncLimit).toBe(25)
    expect(db.boardSyncCredentials(board.id)?.syncLimit).toBe(25)

    // An unrelated update must not reset it.
    expect(db.updateBoard(board.id, { name: 'Limits renamed' })?.syncLimit).toBe(25)
  })

  it('deletes a board with everything on it', () => {
    const board = db.createBoard('Disposable')
    const ticket = db.createTicket(board.id, { title: 'Goes away', categoryName: 'Temp' })!
    const before = db.countBoards()

    expect(db.deleteBoard(board.id)?.ticketIds).toEqual([ticket.id])
    expect(db.countBoards()).toBe(before - 1)
    expect(db.findTicket(ticket.id)).toBeNull()
    expect(db.findBoard(board.id)).toBeNull()
    expect(db.listLanes(board.id)).toEqual([])
  })
})
