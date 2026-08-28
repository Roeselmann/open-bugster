import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

describe('accounts and membership', () => {
  let db: typeof import('../server/utils/db')
  let boardId = ''
  let ownerId = ''
  let laneIdByName: Record<string, string> = {}

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-accounts-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    // The bootstrap identity an upgrading installation already has in its .env.
    process.env.APP_PASSWORD_HASH = 'scrypt$abc$def'
    process.env.APP_ADMIN_EMAIL = 'Owner@Example.com'
    process.env.APP_ADMIN_FIRST_NAME = 'Grace'
    process.env.APP_ADMIN_LAST_NAME = 'Hopper'
    db = await import('../server/utils/db')
    const board = db.listBoards()[0]!
    boardId = board.id
    ownerId = db.listUsers()[0]!.id
    laneIdByName = Object.fromEntries(board.lanes.map(lane => [lane.name, lane.id]))
  })

  it('seeds the owner from the bootstrap variables and hands them the existing board', () => {
    const owner = db.findUserByEmail('owner@example.com')!
    expect(owner).toMatchObject({ firstName: 'Grace', lastName: 'Hopper', role: 'owner', status: 'active' })
    // Normalised on the way in, so the email stays a usable key.
    expect(owner.email).toBe('owner@example.com')
    expect(db.boardRoleFor(boardId, owner.id)).toBe('admin')
    expect(db.countUsers()).toBe(1)
  })

  it('leaves the seed alone once an account exists', () => {
    expect(db.ensureUsers(db.getDb(), { email: 'second@example.com', firstName: 'A', lastName: 'B', passwordHash: 'x' })).toBe(false)
    expect(db.countUsers()).toBe(1)
  })

  it('associates a ticket with an account that is created later', () => {
    const ticket = db.createTicket(boardId, { title: 'Written before the account existed' }, {
      firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', userId: null, status: null
    })!
    expect(db.findTicket(ticket.id)?.author).toMatchObject({ email: 'jane@example.com', userId: null, status: null })

    const jane = db.createUser({ email: 'JANE@example.com', firstName: 'Jane', lastName: 'Roe', role: 'member' })
    const resolved = db.findTicket(ticket.id)!.author!
    // Retroactive, and the account's own name wins over the snapshot taken at write time.
    expect(resolved).toMatchObject({ userId: jane.id, lastName: 'Roe', status: 'invited' })
  })

  it('associates an imported TestFlight tester with an account that is created later', () => {
    const importLane = db.importLaneFor(boardId)!
    const ticket = db.insertImportedTicket({
      boardId, laneId: importLane.id, externalId: 'apple-tester-binding', type: 'screenshot',
      title: 'Tester feedback', comment: 'Looks wrong', testerEmail: 'tester@example.com',
      deviceModel: null, osVersion: null, locale: null, buildId: null, buildVersion: null,
      buildBundleId: null, sourceCreatedAt: new Date().toISOString(), raw: {}
    })
    expect(db.findTicket(ticket.id)?.feedback?.tester).toMatchObject({ email: 'tester@example.com', userId: null })

    const tester = db.createUser({ email: 'tester@example.com', firstName: 'Tess', lastName: 'Ter', role: 'member' })
    expect(db.findTicket(ticket.id)?.feedback?.tester).toMatchObject({ userId: tester.id, firstName: 'Tess' })
    // The raw address is still reported next to it, unchanged.
    expect(db.findTicket(ticket.id)?.feedback?.testerEmail).toBe('tester@example.com')
  })

  it('retires an invitation without touching the account', () => {
    const invited = db.createUser({ email: 'pending@example.com', firstName: 'Pat', lastName: 'Ending', role: 'member' })
    db.setInviteToken(invited.id, 'a-token-hash', new Date(Date.now() + 60_000).toISOString())
    expect(db.findUserByInviteToken('a-token-hash')?.id).toBe(invited.id)
    expect(db.listUsers().find(user => user.id === invited.id)?.inviteExpiresAt).toBeTruthy()

    const revoked = db.clearInviteToken(invited.id)!
    expect(revoked).toMatchObject({ status: 'invited', inviteTokenHash: null, inviteExpiresAt: null })
    expect(db.findUserByInviteToken('a-token-hash')).toBeNull()
    // The account survives, it simply has no way in until a new link is issued.
    expect(db.findUser(invited.id)).not.toBeNull()
    db.deleteUser(invited.id)
  })

  it('shows a user only the boards they are a member of', () => {
    const outsider = db.createUser({ email: 'outsider@example.com', firstName: 'Otto', lastName: 'Sider', role: 'member' })
    const second = db.createBoard('Second board', ownerId)

    expect(db.listBoards({ userId: outsider.id, instanceAdmin: false })).toEqual([])
    expect(db.accessibleBoardIds({ userId: outsider.id, instanceAdmin: false })).toEqual([])
    // An instance administrator keeps sight of everything.
    expect(db.accessibleBoardIds({ userId: outsider.id, instanceAdmin: true })).toBeNull()
    expect(db.listBoards({ userId: ownerId, instanceAdmin: false }).map(board => board.id).sort())
      .toEqual([boardId, second.id].sort())

    db.setBoardMember(second.id, outsider.id, 'viewer')
    const visible = db.listBoards({ userId: outsider.id, instanceAdmin: false })
    expect(visible.map(board => board.id)).toEqual([second.id])
    expect(visible[0]!.role).toBe('viewer')
    expect(db.findBoardSummary(second.id, { userId: outsider.id, instanceAdmin: false })?.role).toBe('viewer')

    expect(db.countBoardAdmins(second.id)).toBe(1)
    expect(db.removeBoardMember(second.id, outsider.id)).toBe(true)
    expect(db.listBoards({ userId: outsider.id, instanceAdmin: false })).toEqual([])
    db.deleteBoard(second.id)
  })

  it('keeps an instance administrator in charge of a board they only view', () => {
    const board = db.createBoard('Outranked board', ownerId)
    db.setBoardMember(board.id, ownerId, 'viewer')
    // The owner is an instance administrator, so the membership row must not demote them.
    expect(db.findBoardSummary(board.id, { userId: ownerId, instanceAdmin: true })?.role).toBe('admin')
    // A plain member with the same row is a viewer.
    expect(db.findBoardSummary(board.id, { userId: ownerId, instanceAdmin: false })?.role).toBe('viewer')
    db.deleteBoard(board.id)
  })

  it('reports the board creator as its administrator', () => {
    const board = db.createBoard('Creator board', ownerId)
    expect(board.role).toBe('admin')
    expect(board.members.map(member => member.userId)).toEqual([ownerId])
    db.deleteBoard(board.id)
  })

  it('assigns a ticket and records the change', () => {
    const ticket = db.createTicket(boardId, { title: 'Needs an owner', laneId: laneIdByName.Backlog }, null)!
    expect(ticket.assignee).toBeNull()

    const assigned = db.updateTicket(ticket.id, { assigneeEmail: 'owner@example.com' }, 'owner@example.com')!
    expect(assigned.assignee).toMatchObject({ userId: ownerId, email: 'owner@example.com' })
    expect(db.listActivity(ticket.id).map(entry => entry.kind)).toContain('assigned')

    const cleared = db.updateTicket(ticket.id, { assigneeEmail: null }, 'owner@example.com')!
    expect(cleared.assignee).toBeNull()
    expect(db.listActivity(ticket.id).map(entry => entry.kind)).toContain('unassigned')
    db.archiveTicket(ticket.id)
  })

  it('keeps a comment thread per ticket and counts it on the ticket', () => {
    const ticket = db.createTicket(boardId, { title: 'Discussed ticket', laneId: laneIdByName.Backlog }, null)!
    expect(ticket.commentCount).toBe(0)

    const comment = db.createComment(ticket.id, 'owner@example.com', 'First note')!
    expect(comment.author).toMatchObject({ userId: ownerId })
    expect(db.createComment(ticket.id, 'nobody@example.com', 'Second note')?.author).toMatchObject({ userId: null })
    expect(db.findTicket(ticket.id)?.commentCount).toBe(2)
    expect(db.listComments(ticket.id).map(entry => entry.body)).toEqual(['First note', 'Second note'])
    expect(db.listActivity(ticket.id).filter(entry => entry.kind === 'commented')).toHaveLength(2)

    expect(db.updateComment(comment.id, 'Edited note')?.body).toBe('Edited note')
    expect(db.deleteComment(comment.id)).toBe(true)
    expect(db.findTicket(ticket.id)?.commentCount).toBe(1)
    db.archiveTicket(ticket.id)
  })

  it('stops resolving a person once the account is gone, without losing the history', () => {
    const ghost = db.createUser({ email: 'ghost@example.com', firstName: 'Gil', lastName: 'Ost', role: 'member' })
    const ticket = db.createTicket(boardId, { title: 'Written by a leaver', laneId: laneIdByName.Backlog }, {
      firstName: 'Gil', lastName: 'Ost', email: 'ghost@example.com', userId: ghost.id, status: 'invited'
    })!
    expect(db.findTicket(ticket.id)?.author).toMatchObject({ userId: ghost.id })

    db.deleteUser(ghost.id)
    const orphaned = db.findTicket(ticket.id)!.author!
    expect(orphaned).toMatchObject({ email: 'ghost@example.com', userId: null, firstName: 'Gil' })
    db.archiveTicket(ticket.id)
  })
})

describe('the comment-thread migration', () => {
  function legacyDatabase() {
    const legacy = new Database(':memory:')
    legacy.exec(`
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        author_email TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tickets (id, title, comment, author_email, created_at, updated_at)
      VALUES ('t1', 'Carried over', 'An internal note', 'ada@example.com', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
             ('t2', 'Nothing to carry', '', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `)
    return legacy
  }

  it('moves the internal note into the thread and drops the column', async () => {
    const db = await import('../server/utils/db')
    const legacy = legacyDatabase()

    expect(db.ensureTicketCommentThread(legacy)).toBe(true)
    expect(db.ensureTicketCommentThread(legacy)).toBe(false)

    const carried = legacy.prepare('SELECT ticket_id, author_email, body, created_at FROM ticket_comments').all()
    expect(carried).toEqual([
      { ticket_id: 't1', author_email: 'ada@example.com', body: 'An internal note', created_at: '2026-01-02T00:00:00.000Z' }
    ])
    // Nothing is left behind that could diverge from the thread.
    expect(legacy.pragma('table_info(tickets)') as Array<{ name: string }>).not.toContainEqual(expect.objectContaining({ name: 'comment' }))
    expect(legacy.prepare('SELECT COUNT(*) AS value FROM tickets').get()).toEqual({ value: 2 })
    expect(legacy.pragma('foreign_key_check')).toEqual([])
    legacy.close()
  })

  it('creates the accounts tables on a database that has never had them', async () => {
    const db = await import('../server/utils/db')
    const legacy = new Database(':memory:')
    legacy.exec("CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO boards VALUES ('b1', 'Workboard');")

    expect(db.ensureUsers(legacy, { email: 'owner@example.com', firstName: 'Grace', lastName: 'Hopper', passwordHash: 'scrypt$a$b' })).toBe(true)
    expect(db.ensureUsers(legacy, { email: 'owner@example.com', firstName: 'Grace', lastName: 'Hopper', passwordHash: 'scrypt$a$b' })).toBe(false)

    expect(legacy.prepare('SELECT email, role, status FROM users').all()).toEqual([
      { email: 'owner@example.com', role: 'owner', status: 'active' }
    ])
    expect(legacy.prepare('SELECT board_id, role FROM board_members').all()).toEqual([{ board_id: 'b1', role: 'admin' }])
    expect(legacy.pragma('foreign_key_check')).toEqual([])
    legacy.close()
  })
})
