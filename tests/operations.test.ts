import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('the operation registry', () => {
  let db: typeof import('../server/utils/db')
  let audit: typeof import('../server/utils/audit')
  let actorModule: typeof import('../server/utils/actor')
  let ops: typeof import('../server/operations')

  let boardId = ''
  let laneId = ''
  const people: Record<string, string> = {}

  const actorOf = (who: string) => actorModule.actorFor(db.findUser(people[who]!)!)
  const agentOf = (who: string) =>
    actorModule.actorFor(db.findUser(people[who]!)!, { channel: 'mcp', agentId: 'claude-desktop', tokenId: 'tok_3' })

  const statusOf = async (promise: Promise<unknown>) => {
    try {
      await promise
      return 200
    } catch (error) {
      return (error as { statusCode?: number }).statusCode ?? 500
    }
  }

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-operations-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.ATTACHMENTS_PATH = join(directory, 'attachments')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    process.env.APP_PASSWORD_HASH = 'scrypt$abc$def'
    process.env.APP_ADMIN_EMAIL = 'owner@example.com'
    process.env.APP_ADMIN_FIRST_NAME = 'Grace'
    process.env.APP_ADMIN_LAST_NAME = 'Hopper'

    db = await import('../server/utils/db')
    audit = await import('../server/utils/audit')
    actorModule = await import('../server/utils/actor')
    ops = await import('../server/operations')

    people.owner = db.listUsers()[0]!.id
    for (const who of ['editor', 'viewer', 'stranger']) {
      people[who] = db.createUser({ email: `${who}@example.com`, firstName: who, lastName: 'T', role: 'member' }).id
    }
    const board = db.listBoards()[0]!
    boardId = board.id
    laneId = board.lanes.find(lane => !lane.isImport)!.id
    db.setBoardMember(boardId, people.editor!, 'editor')
    db.setBoardMember(boardId, people.viewer!, 'viewer')
  })

  describe('shape', () => {
    it('registers every operation under a unique dotted name', () => {
      expect(ops.operations.size).toBeGreaterThan(20)
      for (const [name, operation] of ops.operations) {
        expect(name).toMatch(/^[a-z]+\.[a-zA-Z]+$/)
        // The key and the operation's own name are the same published identifier.
        expect(operation.name).toBe(name)
      }
    })

    it('finds an operation by name and nothing by a made-up one', () => {
      expect(ops.findOperation('ticket.move')?.name).toBe('ticket.move')
      expect(ops.findOperation('ticket.teleport')).toBeNull()
    })
  })

  describe('validation happens before anything else', () => {
    it('refuses bad input with 422 without touching access', async () => {
      // A stranger would get 404 from the guard; the 422 proves the schema ran first.
      expect(await statusOf(ops.run(ops.ticketCreate, actorOf('stranger'), { boardId, title: '' }))).toBe(422)
    })

    it('applies the schema’s defaults', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Defaults', laneId }) as { ticket: { priority: string; description: string } }
      expect(ticket.priority).toBe('medium')
      expect(ticket.description).toBe('')
    })
  })

  describe('access is resolved from the requirement', () => {
    it('keeps the board rules the guards already enforced', async () => {
      expect(await statusOf(ops.run(ops.ticketCreate, actorOf('viewer'), { boardId, title: 'Nope', laneId }))).toBe(403)
      expect(await statusOf(ops.run(ops.ticketCreate, actorOf('stranger'), { boardId, title: 'Nope', laneId }))).toBe(404)
      expect(await statusOf(ops.run(ops.boardCreate, actorOf('editor'), { name: 'Nope' }))).toBe(403)
    })

    it('resolves a ticket-scoped operation through to its board', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Scoped', laneId }) as { ticket: { id: string } }
      expect(await statusOf(ops.run(ops.ticketGet, actorOf('viewer'), { ticketId: ticket.id }))).toBe(200)
      expect(await statusOf(ops.run(ops.ticketMove, actorOf('viewer'), { ticketId: ticket.id, laneId, index: 0 }))).toBe(403)
    })

    it('an agent still cannot exceed its principal', async () => {
      expect(await statusOf(ops.run(ops.ticketCreate, agentOf('viewer'), { boardId, title: 'Nope', laneId }))).toBe(403)
      expect(await statusOf(ops.run(ops.boardCreate, agentOf('editor'), { name: 'Nope' }))).toBe(403)
    })

    it('reads a lane operation’s board from the input rather than the lane', async () => {
      // A lane belonging to another board must not be reachable by naming this one.
      const other = db.createBoard('Other board')
      const foreignLane = other.lanes[0]!.id
      expect(await statusOf(ops.run(ops.laneUpdate, actorOf('owner'), { boardId, laneId: foreignLane, name: 'Hijacked' }))).toBe(404)
    })
  })

  describe('audit by construction', () => {
    it('records a write without the operation asking', async () => {
      const before = audit.countAudit()
      const { ticket } = await ops.run(ops.ticketCreate, agentOf('editor'), { boardId, title: 'Audited', laneId, priority: 'high' }) as { ticket: { id: string } }
      expect(audit.countAudit()).toBe(before + 1)

      const entry = audit.listAudit({ operation: 'ticket.create' })[0]!
      expect(entry).toMatchObject({
        principalId: people.editor,
        agentId: 'claude-desktop',
        tokenId: 'tok_3',
        channel: 'mcp',
        targetType: 'ticket',
        targetId: ticket.id,
        boardId,
        result: 'ok'
      })
    })

    it('logs only the fields the operation named', async () => {
      await ops.run(ops.ticketCreate, actorOf('editor'), {
        boardId, laneId, title: 'Allowlist', priority: 'urgent',
        description: 'This body is long and has no business being in an audit entry.'
      })
      const entry = audit.listAudit({ operation: 'ticket.create' })[0]!
      expect(Object.keys(entry.changes).sort()).toEqual(['laneId', 'priority', 'title'])
      // A field nobody listed cannot reach the log, however sensitive it turns out to be.
      expect(entry.changes).not.toHaveProperty('description')
      expect(JSON.stringify(entry)).not.toContain('no business')
    })

    it('records a refusal, with no changes attached', async () => {
      await statusOf(ops.run(ops.ticketCreate, actorOf('viewer'), { boardId, title: 'Refused', laneId }))
      const entry = audit.listAudit({ operation: 'ticket.create' })[0]!
      expect(entry.result).toBe('denied')
      expect(entry.changes).toEqual({})
      expect(entry.principalId).toBe(people.viewer)
    })

    it('does not log a successful read, which would bury the writes', async () => {
      const before = audit.countAudit()
      await ops.run(ops.ticketList, actorOf('viewer'), { boardId })
      await ops.run(ops.boardList, actorOf('viewer'), {})
      expect(audit.countAudit()).toBe(before)
    })

    it('does log a refused read, which leaves no other trace', async () => {
      const before = audit.countAudit()
      await statusOf(ops.run(ops.ticketList, actorOf('stranger'), { boardId }))
      expect(audit.countAudit()).toBe(before + 1)
      expect(audit.listAudit({ operation: 'ticket.list' })[0]).toMatchObject({ result: 'denied', principalId: people.stranger })
    })

    it('logs a ticket update by which fields moved, not by their contents', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Editable', laneId }) as { ticket: { id: string } }
      await ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: ticket.id, title: 'Renamed', description: 'A very long description indeed.' })
      const entry = audit.listAudit({ operation: 'ticket.update' })[0]!
      expect(entry.changes).toEqual({ fields: ['description', 'title'] })
      expect(JSON.stringify(entry)).not.toContain('very long description')
    })

    /**
     * The guarantee the registry exists for. If this ever fails, somebody has added a write
     * that the audit log cannot see.
     */
    it('leaves no mutating operation unaudited', () => {
      const unaudited = [...ops.operations.values()]
        .filter(operation => operation.audit === false)
        .map(operation => operation.name)
      // Everything left is a read; the naming convention is what makes that checkable.
      expect(unaudited.every(name => /\.(list|get|activity|status|candidates)$/.test(name))).toBe(true)
    })
  })

  describe('the operations behave as the routes did', () => {
    it('refuses to assign a ticket to somebody who is not on the board', async () => {
      expect(await statusOf(ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Bad assignee', laneId, assigneeId: people.stranger }))).toBe(422)
    })

    it('keeps attribution with the board admins, on the tickets that have it', async () => {
      const importLane = db.listLanes(boardId).find(lane => lane.isImport)!
      const imported = db.insertImportedTicket({
        boardId, laneId: importLane.id, externalId: 'feedback-1', type: 'screenshot',
        title: 'Reported from TestFlight', comment: 'It crashed', testerEmail: 'tester@example.com',
        deviceModel: null, osVersion: null, locale: null, buildId: null, buildVersion: null,
        buildBundleId: null, sourceCreatedAt: new Date().toISOString(), raw: {}
      })

      // An imported ticket arrives unattributed, and naming who really filed it is an
      // admin's call rather than any editor's.
      expect(await statusOf(ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: imported.id, authorId: people.editor }))).toBe(403)
      expect(await statusOf(ops.run(ops.ticketUpdate, actorOf('owner'), { ticketId: imported.id, authorId: people.editor }))).toBe(200)
      // Somebody who is not on the board cannot be named either.
      expect(await statusOf(ops.run(ops.ticketUpdate, actorOf('owner'), { ticketId: imported.id, authorId: people.stranger }))).toBe(422)
    })

    it('ignores a field the ticket’s own schema does not have', async () => {
      // A manual ticket has no `authorId`, and zod strips what it does not know rather than
      // rejecting it — the same answer the route gave before the operation existed.
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Manual', laneId }) as { ticket: { id: string; author: { id: string } } }
      expect(ticket.author.id).toBe(people.editor)
      const updated = await ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: ticket.id, authorId: people.stranger }) as { ticket: { author: { id: string } } }
      // Stripped, not honoured: the author it was filed under is still the author.
      expect(updated.ticket.author.id).toBe(people.editor)
    })

    it('will not delete the last board', async () => {
      for (const board of db.listBoards().slice(1)) await ops.run(ops.boardDelete, actorOf('owner'), { boardId: board.id })
      expect(db.listBoards()).toHaveLength(1)
      expect(await statusOf(ops.run(ops.boardDelete, actorOf('owner'), { boardId: db.listBoards()[0]!.id }))).toBe(409)
    })

    it('runs a comment through the thread and the history', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Discussed', laneId }) as { ticket: { id: string } }
      const { comment } = await ops.run(ops.commentAdd, agentOf('editor'), { ticketId: ticket.id, body: 'Said by an agent' }) as { comment: { id: string } }

      const { comments } = await ops.run(ops.commentList, actorOf('viewer'), { ticketId: ticket.id }) as { comments: Array<{ id: string }> }
      expect(comments.map(entry => entry.id)).toContain(comment.id)

      const commented = db.listActivity(ticket.id).find(entry => entry.kind === 'commented')!
      expect(commented).toMatchObject({ agentId: 'claude-desktop', channel: 'mcp' })
      expect(commented.actor?.id).toBe(people.editor)

      // Somebody else's comment is not theirs to edit.
      expect(await statusOf(ops.run(ops.commentUpdate, actorOf('viewer'), { commentId: comment.id, body: 'Not mine' }))).toBe(403)
      expect(await statusOf(ops.run(ops.commentUpdate, actorOf('editor'), { commentId: comment.id, body: 'Mine' }))).toBe(200)
    })
  })
})
