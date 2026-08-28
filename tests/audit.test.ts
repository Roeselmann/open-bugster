import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('the audit trail', () => {
  let db: typeof import('../server/utils/db')
  let audit: typeof import('../server/utils/audit')
  let actorModule: typeof import('../server/utils/actor')

  let boardId = ''
  let laneId = ''
  let ownerId = ''

  const ownerActor = () => actorModule.actorFor(db.findUser(ownerId)!)
  const agentActor = () => actorModule.actorFor(db.findUser(ownerId)!, { channel: 'mcp', agentId: 'claude-desktop', tokenId: 'tok_9' })

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-audit-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    process.env.APP_PASSWORD_HASH = 'scrypt$abc$def'
    process.env.APP_ADMIN_EMAIL = 'owner@example.com'
    process.env.APP_ADMIN_FIRST_NAME = 'Grace'
    process.env.APP_ADMIN_LAST_NAME = 'Hopper'

    db = await import('../server/utils/db')
    audit = await import('../server/utils/audit')
    actorModule = await import('../server/utils/actor')

    const board = db.listBoards()[0]!
    boardId = board.id
    laneId = board.lanes.find(lane => !lane.isImport)!.id
    ownerId = db.listUsers()[0]!.id
  })

  describe('ticket_activity carries the agent alongside the actor', () => {
    it('records a direct change with no agent and the web channel', () => {
      const ticket = db.createTicket(boardId, { title: 'Filed by hand', laneId } as never, db.personById(ownerId), ownerActor())!
      const created = db.listActivity(ticket.id).find(entry => entry.kind === 'created')!
      expect(created.actor?.id).toBe(ownerId)
      expect(created.agentId).toBeNull()
      expect(created.channel).toBe('web')
    })

    it('names the agent without changing who answers for the change', () => {
      const ticket = db.createTicket(boardId, { title: 'Filed by an agent', laneId } as never, db.personById(ownerId), agentActor())!
      db.updateTicket(ticket.id, { priority: 'urgent' }, agentActor())

      const entries = db.listActivity(ticket.id)
      for (const entry of entries) {
        // The person is still accountable; the agent is only how it arrived.
        expect(entry.actor?.id).toBe(ownerId)
        expect(entry.agentId).toBe('claude-desktop')
        expect(entry.channel).toBe('mcp')
      }
    })

    it('leaves entries written before agents existed reading as web', () => {
      // The column default, which is what every pre-migration row gets.
      const ticket = db.createTicket(boardId, { title: 'No actor at all', laneId } as never, null)!
      const created = db.listActivity(ticket.id)[0]!
      expect(created.channel).toBe('web')
      expect(created.agentId).toBeNull()
    })
  })

  describe('writeAudit', () => {
    it('keeps the full provenance of an operation', () => {
      audit.writeAudit({ actor: agentActor(), operation: 'ticket.move', targetType: 'ticket', targetId: 't_1', boardId, changes: { laneId: 'l_2', index: 0 } })
      const entry = audit.listAudit({ operation: 'ticket.move' })[0]!
      expect(entry).toMatchObject({
        principalId: ownerId,
        agentId: 'claude-desktop',
        tokenId: 'tok_9',
        channel: 'mcp',
        operation: 'ticket.move',
        targetType: 'ticket',
        targetId: 't_1',
        boardId,
        result: 'ok'
      })
      expect(entry.changes).toEqual({ laneId: 'l_2', index: 0 })
    })

    it('records a refusal, which is the entry worth having most', () => {
      audit.writeAudit({ actor: ownerActor(), operation: 'board.delete', targetType: 'board', targetId: boardId, result: 'denied' })
      expect(audit.listAudit({ operation: 'board.delete' })[0]?.result).toBe('denied')
    })

    it('records an attempt that failed before anybody was identified', () => {
      // A rejected token has no actor to read a principal from, and still belongs in the log.
      audit.writeAudit({ operation: 'auth.token', targetType: 'token', result: 'denied', channel: 'api', ip: '198.51.100.7' })
      const entry = audit.listAudit({ operation: 'auth.token' })[0]!
      expect(entry.principalId).toBeNull()
      expect(entry.channel).toBe('api')
      expect(entry.ip).toBe('198.51.100.7')
    })

    it('never lets a broken write take the operation down with it', () => {
      // `changes` holding something unserializable must not throw out of writeAudit.
      const circular: Record<string, unknown> = {}
      circular.self = circular
      expect(() => audit.writeAudit({ actor: ownerActor(), operation: 'ticket.update', targetType: 'ticket', changes: circular })).not.toThrow()
    })
  })

  describe('filtering', () => {
    it('narrows by board, principal and operation', () => {
      const before = audit.countAudit()
      audit.writeAudit({ actor: ownerActor(), operation: 'lane.rename', targetType: 'lane', targetId: laneId, boardId })
      expect(audit.countAudit()).toBe(before + 1)
      expect(audit.listAudit({ boardId, operation: 'lane.rename' })).toHaveLength(1)
      expect(audit.listAudit({ principalId: ownerId, operation: 'lane.rename' })).toHaveLength(1)
      expect(audit.listAudit({ principalId: 'somebody-else', operation: 'lane.rename' })).toHaveLength(0)
    })

    it('separates instance-level entries from board ones', () => {
      audit.writeAudit({ actor: ownerActor(), operation: 'user.invite', targetType: 'user', targetId: ownerId })
      expect(audit.listAudit({ boardId: null, operation: 'user.invite' })).toHaveLength(1)
      expect(audit.listAudit({ boardId, operation: 'user.invite' })).toHaveLength(0)
    })

    it('returns the newest first and honours the limit', () => {
      for (let i = 0; i < 5; i++) audit.writeAudit({ actor: ownerActor(), operation: 'label.create', targetType: 'label', targetId: `l_${i}` })
      const page = audit.listAudit({ operation: 'label.create', limit: 2 })
      expect(page).toHaveLength(2)
      expect(new Date(page[0]!.at).getTime()).toBeGreaterThanOrEqual(new Date(page[1]!.at).getTime())
    })
  })

  describe('the properties that keep the log honest', () => {
    it('outlives the ticket it describes, unlike the ticket timeline', () => {
      const ticket = db.createTicket(boardId, { title: 'Doomed', laneId } as never, db.personById(ownerId), ownerActor())!
      audit.writeAudit({ actor: ownerActor(), operation: 'ticket.create', targetType: 'ticket', targetId: ticket.id, boardId })

      db.getDb().prepare('DELETE FROM tickets WHERE id = ?').run(ticket.id)

      // The timeline cascaded away with the ticket; the audit entry did not.
      expect(db.listActivity(ticket.id)).toHaveLength(0)
      expect(audit.listAudit({ operation: 'ticket.create' }).some(entry => entry.targetId === ticket.id)).toBe(true)
    })

    it('survives the deletion of the board it names', () => {
      const doomed = db.createBoard('Doomed board')
      audit.writeAudit({ actor: ownerActor(), operation: 'board.update', targetType: 'board', targetId: doomed.id, boardId: doomed.id })
      db.deleteBoard(doomed.id)
      // No foreign key on board_id, precisely so this entry is still here to read.
      expect(audit.listAudit({ boardId: doomed.id })).toHaveLength(1)
    })

    it('holds ids only, so anonymizing a person empties it of identifying data', () => {
      const leaver = db.createUser({ email: 'leaver@example.com', firstName: 'Lee', lastName: 'Ver', role: 'member' })
      const leaverActor = actorModule.actorFor(db.findUser(leaver.id)!)
      audit.writeAudit({ actor: leaverActor, operation: 'ticket.archive', targetType: 'ticket', targetId: 'x', boardId, changes: { assigneeId: leaver.id } })

      db.anonymizeUser(leaver.id)

      const entry = audit.listAudit({ principalId: leaver.id })[0]!
      // The entry is intact and still points at the person, without ever naming them.
      expect(entry.principalId).toBe(leaver.id)
      expect(JSON.stringify(entry)).not.toContain('leaver@example.com')
      expect(JSON.stringify(entry)).not.toContain('Lee')
    })
  })

  /**
   * The path a live instance actually takes. The fresh-database tests above never exercise
   * an ALTER over rows that are already there, which is the only way this can go wrong.
   */
  describe('upgrading a database that already has history', () => {
    it('backfills existing entries as web rather than refusing the column', async () => {
      const Database = (await import('better-sqlite3')).default
      const directory = await mkdtemp(join(tmpdir(), 'open-bugster-upgrade-'))
      const legacy = new Database(join(directory, 'legacy.sqlite'))
      legacy.exec(`
        CREATE TABLE tickets (id TEXT PRIMARY KEY);
        CREATE TABLE ticket_activity (
          id TEXT PRIMARY KEY,
          ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
          actor_id TEXT,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        INSERT INTO tickets (id) VALUES ('t_old');
        INSERT INTO ticket_activity (id, ticket_id, actor_id, kind, created_at)
          VALUES ('a_old', 't_old', 'u_old', 'moved', '2024-01-01T00:00:00.000Z');
      `)

      expect(db.ensureActorContext(legacy)).toBe(true)
      // Running it again must be a no-op, because migrations run on every boot.
      expect(db.ensureActorContext(legacy)).toBe(false)

      const row = legacy.prepare('SELECT * FROM ticket_activity WHERE id = ?').get('a_old') as { actor_id: string; agent_id: string | null; channel: string }
      expect(row).toMatchObject({ actor_id: 'u_old', agent_id: null, channel: 'web' })

      expect(db.ensureAuditLog(legacy)).toBe(true)
      expect(db.ensureAuditLog(legacy)).toBe(false)
      legacy.close()
    })
  })

  describe('retention', () => {
    it('drops entries past the window and keeps the ones inside it', () => {
      const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
      const recent = new Date(Date.now() - 5 * 86_400_000).toISOString()
      db.getDb().prepare("INSERT INTO audit_log (id, at, operation, target_type, result) VALUES ('old', ?, 'x.old', 'thing', 'ok')").run(old)
      db.getDb().prepare("INSERT INTO audit_log (id, at, operation, target_type, result) VALUES ('recent', ?, 'x.recent', 'thing', 'ok')").run(recent)

      expect(audit.pruneAudit(30)).toBe(1)
      expect(audit.listAudit({ operation: 'x.old' })).toHaveLength(0)
      expect(audit.listAudit({ operation: 'x.recent' })).toHaveLength(1)
    })

    it('keeps everything when retention is switched off', () => {
      const before = audit.countAudit()
      expect(audit.pruneAudit(0)).toBe(0)
      expect(audit.countAudit()).toBe(before)
    })

    it('reads the window from the environment and falls back to a year', () => {
      delete process.env.AUDIT_RETENTION_DAYS
      expect(audit.auditRetentionDays()).toBe(365)
      process.env.AUDIT_RETENTION_DAYS = '30'
      expect(audit.auditRetentionDays()).toBe(30)
      process.env.AUDIT_RETENTION_DAYS = 'nonsense'
      expect(audit.auditRetentionDays()).toBe(365)
      delete process.env.AUDIT_RETENTION_DAYS
    })
  })
})
