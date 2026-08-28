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

  it('gives an address with no account a contact row, and hands the same row to the invitation', () => {
    const contactId = db.upsertContactByEmail('jane@example.com', { firstName: 'Jane', lastName: 'Doe' })
    const ticket = db.createTicket(boardId, { title: 'Written before the account existed' }, db.personById(contactId))!
    expect(db.findTicket(ticket.id)?.author).toMatchObject({ id: contactId, email: 'jane@example.com', isAccount: false, status: null })
    // A contact is not an account: it must not show up in the admin list or the login path.
    expect(db.listUsers().some(user => user.id === contactId)).toBe(false)
    expect(db.findUserByEmail('jane@example.com')).toBeNull()

    const jane = db.createUser({ email: 'JANE@example.com', firstName: 'Jane', lastName: 'Roe', role: 'member' })
    // The invitation claimed the contact rather than opening a second row, so the ticket is
    // already hers — nothing pointing at her had to be rewritten.
    expect(jane.id).toBe(contactId)
    expect(db.findTicket(ticket.id)?.author).toMatchObject({ id: contactId, lastName: 'Roe', isAccount: true, status: 'invited' })
  })

  it('associates an imported TestFlight tester with an account that is created later', () => {
    const importLane = db.importLaneFor(boardId)!
    const ticket = db.insertImportedTicket({
      boardId, laneId: importLane.id, externalId: 'apple-tester-binding', type: 'screenshot',
      title: 'Tester feedback', comment: 'Looks wrong', testerEmail: 'tester@example.com',
      deviceModel: null, osVersion: null, locale: null, buildId: null, buildVersion: null,
      buildBundleId: null, sourceCreatedAt: new Date().toISOString(), raw: {}
    })
    const tester = db.findTicket(ticket.id)!.feedback!.tester!
    expect(tester).toMatchObject({ email: 'tester@example.com', isAccount: false })
    // Nobody had an account at import time, so there is no author to attribute it to.
    expect(db.findTicket(ticket.id)?.author).toBeNull()

    const account = db.createUser({ email: 'tester@example.com', firstName: 'Tess', lastName: 'Ter', role: 'member' })
    expect(account.id).toBe(tester.id)
    expect(db.findTicket(ticket.id)?.feedback?.tester).toMatchObject({ id: tester.id, firstName: 'Tess', isAccount: true })
  })

  it('attributes an import to the tester when they already have an account, unless the board says otherwise', () => {
    const importLane = db.importLaneFor(boardId)!
    const known = db.createUser({ email: 'known@example.com', firstName: 'Nova', lastName: 'Known', role: 'member' })
    const base = {
      boardId, laneId: importLane.id, type: 'screenshot' as const, title: 'From a colleague',
      comment: 'Broken', testerEmail: 'known@example.com', deviceModel: null, osVersion: null,
      locale: null, buildId: null, buildVersion: null, buildBundleId: null,
      sourceCreatedAt: new Date().toISOString(), raw: {}
    }

    const attributed = db.insertImportedTicket({ ...base, externalId: 'apple-auto-author-on' })
    expect(db.findTicket(attributed.id)?.author).toMatchObject({ id: known.id, isAccount: true })

    const anonymous = db.insertImportedTicket({ ...base, externalId: 'apple-auto-author-off', autoAuthor: false })
    // The tester is still recorded on the feedback; only the attribution is withheld.
    expect(db.findTicket(anonymous.id)?.author).toBeNull()
    expect(db.findTicket(anonymous.id)?.feedback?.tester).toMatchObject({ id: known.id })
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

  it('lets a forgotten password be replaced through a fresh link, and drops the old sessions', () => {
    const forgetful = db.createUser({ email: 'forgetful@example.com', firstName: 'Fred', lastName: 'Getful', role: 'member' })
    const active = db.setUserPassword(forgetful.id, 'scrypt$first$hash')!
    expect(active).toMatchObject({ status: 'active', inviteTokenHash: null })

    // The same mechanism the invitation uses, on an account that already has a password.
    db.setInviteToken(forgetful.id, 'reset-token-hash', new Date(Date.now() + 60_000).toISOString())
    const pending = db.findUserByInviteToken('reset-token-hash')!
    expect(pending).toMatchObject({ id: forgetful.id, status: 'active' })
    // The old password keeps working until the link is used, so a link left uncollected
    // does not lock anybody out.
    expect(pending.passwordHash).toBe('scrypt$first$hash')

    const reset = db.setUserPassword(forgetful.id, 'scrypt$second$hash')!
    expect(reset).toMatchObject({ status: 'active', passwordHash: 'scrypt$second$hash', inviteTokenHash: null, inviteExpiresAt: null })
    // Every session signed in with the forgotten password is invalidated, and the link
    // itself is single-use.
    expect(reset.sessionVersion).toBe(active.sessionVersion + 1)
    expect(db.findUserByInviteToken('reset-token-hash')).toBeNull()
    db.deleteUser(forgetful.id)
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

    const assigned = db.updateTicket(ticket.id, { assigneeId: ownerId }, ownerId)!
    expect(assigned.assignee).toMatchObject({ id: ownerId, email: 'owner@example.com' })
    const entry = db.listActivity(ticket.id).find(item => item.kind === 'assigned')!
    // The payload holds the id, and the reader gets the person back resolved from it.
    expect(entry.payload.to).toBe(ownerId)
    expect(entry.payloadPeople.to).toMatchObject({ id: ownerId, email: 'owner@example.com' })

    const cleared = db.updateTicket(ticket.id, { assigneeId: null }, ownerId)!
    expect(cleared.assignee).toBeNull()
    expect(db.listActivity(ticket.id).map(entry => entry.kind)).toContain('unassigned')
    db.archiveTicket(ticket.id)
  })

  it('keeps a comment thread per ticket and counts it on the ticket', () => {
    const ticket = db.createTicket(boardId, { title: 'Discussed ticket', laneId: laneIdByName.Backlog }, null)!
    expect(ticket.commentCount).toBe(0)

    const comment = db.createComment(ticket.id, ownerId, 'First note')!
    expect(comment.author).toMatchObject({ id: ownerId })
    const stranger = db.upsertContactByEmail('nobody@example.com')
    expect(db.createComment(ticket.id, stranger, 'Second note')?.author).toMatchObject({ id: stranger, isAccount: false })
    expect(db.findTicket(ticket.id)?.commentCount).toBe(2)
    expect(db.listComments(ticket.id).map(entry => entry.body)).toEqual(['First note', 'Second note'])
    expect(db.listActivity(ticket.id).filter(entry => entry.kind === 'commented')).toHaveLength(2)

    expect(db.updateComment(comment.id, 'Edited note')?.body).toBe('Edited note')
    expect(db.deleteComment(comment.id)).toBe(true)
    expect(db.findTicket(ticket.id)?.commentCount).toBe(1)
    db.archiveTicket(ticket.id)
  })

  it('keeps the ticket when the account behind it is deleted outright', () => {
    const ghost = db.createUser({ email: 'ghost@example.com', firstName: 'Gil', lastName: 'Ost', role: 'member' })
    const ticket = db.createTicket(boardId, { title: 'Written by a leaver', laneId: laneIdByName.Backlog }, db.personById(ghost.id))!
    expect(db.findTicket(ticket.id)?.author).toMatchObject({ id: ghost.id })

    db.deleteUser(ghost.id)
    // The row is gone, so there is nobody left to name — but the ticket itself survives.
    expect(db.findTicket(ticket.id)?.author).toBeNull()
    expect(db.findTicket(ticket.id)?.title).toBe('Written by a leaver')
    db.archiveTicket(ticket.id)
  })

  it('anonymizes an account while every trace of what they did stays attached', () => {
    const leaver = db.createUser({ email: 'leaver@example.com', firstName: 'Lee', lastName: 'Ver', role: 'member' })
    db.setBoardMember(boardId, leaver.id, 'editor')
    const ticket = db.createTicket(boardId, { title: 'Filed then erased', laneId: laneIdByName.Backlog }, db.personById(leaver.id))!
    db.createComment(ticket.id, leaver.id, 'A note from the leaver')
    db.updateTicket(ticket.id, { assigneeId: leaver.id }, ownerId)

    db.anonymizeUser(leaver.id)

    const erased = db.findTicket(ticket.id)!
    // Still one identifiable person's worth of history, with nothing identifying left in it.
    expect(erased.author).toMatchObject({ id: leaver.id, email: null, firstName: '', anonymizedAt: expect.any(String) })
    expect(erased.assignee?.id).toBe(leaver.id)
    expect(db.listComments(ticket.id).map(entry => entry.body)).toContain('A note from the leaver')
    expect(db.listComments(ticket.id)[0]?.author?.email).toBeNull()

    const assignment = db.listActivity(ticket.id).find(item => item.kind === 'assigned')!
    expect(assignment.payloadPeople.to?.email).toBeNull()
    expect(JSON.stringify(assignment.payload)).not.toContain('leaver@example.com')

    // No way back in, and no longer offerable on any board.
    expect(db.findUserByEmail('leaver@example.com')).toBeNull()
    expect(db.findUser(leaver.id)).toMatchObject({ status: 'disabled', passwordHash: null })
    expect(db.boardRoleFor(boardId, leaver.id)).toBeNull()
    db.archiveTicket(ticket.id)
  })

  it('changes an address without disturbing anything that points at the person', () => {
    const mover = db.createUser({ email: 'old@example.com', firstName: 'Mo', lastName: 'Ver', role: 'member' })
    const ticket = db.createTicket(boardId, { title: 'Survives a rename', laneId: laneIdByName.Backlog }, db.personById(mover.id))!

    db.updateUser(mover.id, { email: 'New@Example.com' })

    expect(db.findUser(mover.id)?.email).toBe('new@example.com')
    expect(db.findUserByEmail('new@example.com')?.id).toBe(mover.id)
    expect(db.findTicket(ticket.id)?.author).toMatchObject({ id: mover.id, email: 'new@example.com' })
    // The address somebody else already holds is still refused.
    expect(() => db.updateUser(mover.id, { email: 'owner@example.com' })).toThrow(db.EmailTakenError)
    db.archiveTicket(ticket.id)
  })

  it('folds a contact into the account that takes its address', () => {
    // The tester who turns out to be a colleague: the same address, so the same person.
    const contactId = db.upsertContactByEmail('both@example.com')
    const theirs = db.createTicket(boardId, { title: 'Filed as a stranger', laneId: laneIdByName.Backlog }, db.personById(contactId))!
    db.createComment(theirs.id, contactId, 'Written before they had an account')
    const account = db.createUser({ email: 'work@example.com', firstName: 'Same', lastName: 'Person', role: 'member' })
    db.setBoardMember(boardId, account.id, 'editor')
    const assigned = db.createTicket(boardId, { title: 'Assigned to them', laneId: laneIdByName.Backlog, assigneeId: account.id }, null)!

    const merged = db.updateUser(account.id, { email: 'both@example.com' })!

    // One row survives, and everything either of them was named on now belongs to it.
    expect(merged.id).toBe(account.id)
    expect(db.personById(contactId)).toBeNull()
    expect(db.findTicket(theirs.id)?.author).toMatchObject({ id: account.id, isAccount: true })
    expect(db.listComments(theirs.id)[0]?.author?.id).toBe(account.id)
    // Including inside the history, which would otherwise point at a row that is gone.
    expect(db.listActivity(assigned.id).find(entry => entry.kind === 'assigned')?.payloadPeople.to?.id).toBe(account.id)
    db.archiveTicket(theirs.id)
    db.archiveTicket(assigned.id)
  })

  it('refuses to bring an anonymized account back', () => {
    const erased = db.createUser({ email: 'erased@example.com', firstName: 'E', lastName: 'Rased', role: 'member' })
    const ticket = db.createTicket(boardId, { title: 'Left behind', laneId: laneIdByName.Backlog }, db.personById(erased.id))!
    db.anonymizeUser(erased.id)

    // Renaming or re-inviting the row would hand their history to whoever came next.
    expect(() => db.updateUser(erased.id, { email: 'new@example.com', status: 'active' })).toThrow(db.AnonymizedAccountError)
    expect(() => db.setInviteToken(erased.id, 'hash', new Date(Date.now() + 60_000).toISOString())).toThrow(db.AnonymizedAccountError)
    expect(db.findUser(erased.id)).toMatchObject({ email: null, firstName: '', status: 'disabled' })
    // The ticket stays attached to the tombstone, which is the point of anonymizing.
    expect(db.findTicket(ticket.id)?.author?.id).toBe(erased.id)
    db.archiveTicket(ticket.id)
  })

  it('lets an imported ticket be attributed to somebody afterwards', () => {
    const importLane = db.importLaneFor(boardId)!
    const ticket = db.insertImportedTicket({
      boardId, laneId: importLane.id, externalId: 'apple-late-attribution', type: 'crash',
      title: 'Crashed for somebody', comment: null, testerEmail: null,
      deviceModel: null, osVersion: null, locale: null, buildId: null, buildVersion: null,
      buildBundleId: null, sourceCreatedAt: new Date().toISOString(), raw: {}
    })
    expect(ticket.author).toBeNull()

    const attributed = db.updateTicket(ticket.id, { authorId: ownerId }, ownerId)!
    expect(attributed.author).toMatchObject({ id: ownerId })
    const entry = db.listActivity(ticket.id).find(item => item.kind === 'author')!
    expect(entry.payload).toMatchObject({ from: null, to: ownerId })
    expect(entry.payloadPeople.to).toMatchObject({ id: ownerId })

    expect(db.updateTicket(ticket.id, { authorId: null }, ownerId)?.author).toBeNull()
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
