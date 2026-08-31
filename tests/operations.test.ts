import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('the operation registry', () => {
  let db: typeof import('../server/utils/db')
  let audit: typeof import('../server/utils/audit')
  let actorModule: typeof import('../server/utils/actor')
  let ops: typeof import('../server/operations')
  let invite: typeof import('../server/utils/invite')
  let password: typeof import('../server/utils/password')

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
    invite = await import('../server/utils/invite')
    password = await import('../server/utils/password')

    people.owner = db.listUsers()[0]!.id
    for (const who of ['editor', 'viewer', 'stranger']) {
      people[who] = db.createUser({ email: `${who}@example.com`, firstName: who, lastName: 'T', role: 'member' }).id
    }
    const board = db.listBoards()[0]!
    boardId = board.id
    laneId = board.lanes.find(lane => !lane.isImport)!.id
    // This board is worked through tokens further down, so it permits automation.
    db.setBoardMember(boardId, people.editor!, 'editor', true)
    db.setBoardMember(boardId, people.viewer!, 'viewer', true)
  })

  describe('shape', () => {
    it('registers every operation under a unique dotted name', () => {
      expect(ops.operations.size).toBeGreaterThan(20)
      for (const [name, operation] of ops.operations) {
        // Two segments, or three for a nested family like `workspace.member.set`; camel case
        // only ever in the final verb.
        expect(name).toMatch(/^[a-z]+(\.[a-z]+)?\.[a-zA-Z]+$/)
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

    it('checks a ticket number against the ticket it names, not the caller', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Numbered', laneId }) as { ticket: { id: string; ticketNumber: number } }
      expect(await statusOf(ops.run(ops.ticketGetByNumber, actorOf('viewer'), { ticketNumber: ticket.ticketNumber }))).toBe(200)
      // A number is a global handle, so it must not become a way to read across boards. A
      // stranger gets the same 404 as for a number that was never issued — no existence leak.
      expect(await statusOf(ops.run(ops.ticketGetByNumber, actorOf('stranger'), { ticketNumber: ticket.ticketNumber }))).toBe(404)
      expect(await statusOf(ops.run(ops.ticketGetByNumber, actorOf('viewer'), { ticketNumber: 999_999 }))).toBe(404)
    })

    it('checks an attachment against the board of the ticket holding it', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'With a file', laneId }) as { ticket: { id: string } }
      const attachmentId = db.addAttachment(ticket.id, 'file', 'shot.png', 'image/png', 11, `${ticket.id}/shot.png`)
      // An attachment id names a file with no board and no ticket in the request, so the
      // check has to reach the owning ticket itself rather than trust what was asked for.
      expect(await statusOf(ops.run(ops.attachmentGet, actorOf('viewer'), { attachmentId }))).toBe(200)
      expect(await statusOf(ops.run(ops.attachmentGet, actorOf('stranger'), { attachmentId }))).toBe(404)
      expect(await statusOf(ops.run(ops.attachmentGet, actorOf('viewer'), { attachmentId: 'att_nope' }))).toBe(404)
    })

    it('takes a file in and gives the same file back', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Round trip', laneId }) as { ticket: { id: string } }
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')])
      const { attachment } = await ops.run(ops.attachmentAdd, actorOf('editor'), {
        ticketId: ticket.id, filename: 'shot.png', mimeType: 'image/png', content: png.toString('base64')
      }) as { attachment: { id: string; size: number; mimeType: string; url: string } }

      expect(attachment).toMatchObject({ size: png.length, mimeType: 'image/png' })
      // The url points at the surface a token can actually reach, not the UI's own path.
      expect(attachment.url).toBe(`/api/v1/attachments/${attachment.id}`)

      const stored = await ops.run(ops.attachmentGet, actorOf('viewer'), { attachmentId: attachment.id }) as { attachment: { relative_path: string } }
      const file = await import('../server/utils/attachment-file')
      const onDisk = await readFile(await file.resolveAttachmentFile(stored.attachment.relative_path))
      expect(onDisk.equals(png)).toBe(true)
    })

    it('holds an upload to the same policy the browser goes through', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Policed', laneId }) as { ticket: { id: string } }
      const upload = (input: Record<string, unknown>) => ops.run(ops.attachmentAdd, actorOf('editor'), { ticketId: ticket.id, ...input })

      // Claims to be a PNG, is not one. Decoding base64 is lenient, so this is the check that
      // stops a body that was never really a file.
      expect(await statusOf(upload({ filename: 'fake.png', mimeType: 'image/png', content: Buffer.from('<html>').toString('base64') }))).toBe(422)
      expect(await statusOf(upload({ filename: 'evil.svg', content: Buffer.from('<svg/>').toString('base64') }))).toBe(422)
      // Viewers read a board; attaching to it is an editor's.
      expect(await statusOf(ops.run(ops.attachmentAdd, actorOf('viewer'), {
        ticketId: ticket.id, filename: 'note.txt', content: Buffer.from('hi').toString('base64')
      }))).toBe(403)
    })

    it('refuses to attach to a ticket that has left the board', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Gone', laneId }) as { ticket: { id: string } }
      await ops.run(ops.ticketArchive, actorOf('owner'), { ticketId: ticket.id })
      expect(await statusOf(ops.run(ops.attachmentAdd, actorOf('owner'), {
        ticketId: ticket.id, filename: 'note.txt', content: Buffer.from('too late').toString('base64')
      }))).toBe(409)
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
      // Everything left is a read; the naming convention is what makes that checkable. A write
      // that does not end in one of these words fails here, which is the point. `get` and
      // `list` may carry a qualifier for how the subject is named — `getByNumber` — because
      // that changes the lookup and never the verb; nothing that mutates is named `getX`.
      expect(unaudited.every(name => /\.((list|get)([A-Z]\w*)?|activity|status|candidates|deliveries)$/.test(name)), unaudited.join(', ')).toBe(true)
    })
  })

  /**
   * The routes that were left calling `db.ts` directly until now. Role changes, invitations
   * and account deletions are exactly what an audit log is for, and they were invisible to it.
   */
  describe('account administration', () => {
    it('audits a role change by value, and a rename by field name only', async () => {
      const target = db.createUser({ email: 'promoted@example.com', firstName: 'Pat', lastName: 'R', role: 'member' })

      await ops.run(ops.userUpdate, actorOf('owner'), { userId: target.id, role: 'admin' })
      expect(audit.listAudit({ operation: 'user.update' })[0]!.changes).toEqual({ fields: ['role'], role: 'admin' })

      await ops.run(ops.userUpdate, actorOf('owner'), { userId: target.id, firstName: 'Patricia' })
      const renamed = audit.listAudit({ operation: 'user.update' })[0]!
      expect(renamed.changes).toEqual({ fields: ['firstName'] })
      // A name in the log would survive anonymizing the person it names.
      expect(JSON.stringify(renamed)).not.toContain('Patricia')
    })

    it('keeps the owner and the caller’s own account out of reach', async () => {
      const self = db.findUser(people.owner!)!
      expect(await statusOf(ops.run(ops.userUpdate, actorOf('owner'), { userId: self.id, role: 'member' }))).toBe(409)
      expect(await statusOf(ops.run(ops.userDelete, actorOf('owner'), { userId: self.id }))).toBe(409)
      expect(await statusOf(ops.run(ops.userAnonymize, actorOf('owner'), { userId: self.id }))).toBe(409)
    })

    it('is closed to anyone who is not an instance admin', async () => {
      expect(await statusOf(ops.run(ops.userList, actorOf('editor'), {}))).toBe(403)
      expect(await statusOf(ops.run(ops.userCreate, agentOf('editor'), { email: 'x@example.com', firstName: 'X', lastName: 'Y', role: 'member' }))).toBe(403)
    })

    it('never lets an invite token reach the log', async () => {
      const { user, inviteToken } = await ops.run(ops.userCreate, actorOf('owner'), {
        email: 'invited@example.com', firstName: 'In', lastName: 'Vited', role: 'member'
      }) as { user: { id: string }; inviteToken: string }

      expect(inviteToken).toMatch(/^[A-Za-z0-9_-]{20,}$/)
      const entry = audit.listAudit({ operation: 'user.create' })[0]!
      expect(entry.targetId).toBe(user.id)
      expect(entry.changes).toEqual({ role: 'member' })
      // Neither the token nor the address the account was opened under.
      expect(JSON.stringify(entry)).not.toContain(inviteToken)
      expect(JSON.stringify(entry)).not.toContain('invited@example.com')
    })

    it('hands back a token an administrator can turn into a link, and can revoke it', async () => {
      const target = db.findUserByEmail('invited@example.com')!
      const { inviteToken, purpose } = await ops.run(ops.userInvite, actorOf('owner'), { userId: target.id }) as { inviteToken: string; purpose: string }
      expect(purpose).toBe('invite')
      // The operation returns the raw token; only the transport knows what origin to put it on.
      expect(db.findUserByInviteToken(invite.hashInviteToken(inviteToken))?.id).toBe(target.id)

      await ops.run(ops.userRevokeInvite, actorOf('owner'), { userId: target.id })
      expect(db.findUserByInviteToken(invite.hashInviteToken(inviteToken))).toBeNull()
    })

    it('refuses a link for a disabled account', async () => {
      const target = db.findUserByEmail('invited@example.com')!
      db.updateUser(target.id, { status: 'disabled' })
      expect(await statusOf(ops.run(ops.userInvite, actorOf('owner'), { userId: target.id }))).toBe(409)
    })
  })

  describe('secrets never reach the audit log', () => {
    it('records a password change without anything derived from the password', async () => {
      const person = db.createUser({ email: 'pw@example.com', firstName: 'P', lastName: 'W', role: 'member' })
      db.setUserPassword(person.id, password.hashStoredPassword('the-old-password-here'))
      const self = actorModule.actorFor(db.findUser(person.id)!)

      expect(await statusOf(ops.run(ops.profileChangePassword, self, { currentPassword: 'wrong-password-here', newPassword: 'a-brand-new-password' }))).toBe(401)
      await ops.run(ops.profileChangePassword, self, { currentPassword: 'the-old-password-here', newPassword: 'a-brand-new-password' })

      for (const entry of audit.listAudit({ operation: 'profile.changePassword' })) {
        expect(entry.changes).toEqual({})
        const text = JSON.stringify(entry)
        expect(text).not.toContain('the-old-password-here')
        expect(text).not.toContain('a-brand-new-password')
      }
    })

    it('records an attachment by filename and never by its bytes', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Has a file', laneId }) as { ticket: { id: string } }
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('RECOGNISABLE-PIXELS')])
      await ops.run(ops.attachmentAdd, actorOf('editor'), {
        ticketId: ticket.id, filename: 'shot.png', mimeType: 'image/png', content: png.toString('base64')
      })

      const entry = audit.listAudit({ operation: 'attachment.add' })[0]!
      expect(entry.changes).toMatchObject({ filename: 'shot.png' })
      // A 20 MB file in the log would bury everything worth finding, quite apart from what
      // it might contain. The allowlist is what keeps it out.
      expect(JSON.stringify(entry)).not.toContain('RECOGNISABLE-PIXELS')
      expect(JSON.stringify(entry)).not.toContain(png.toString('base64'))
    })

    it('records a key upload by filename and never by its contents', async () => {
      const pem = '-----BEGIN PRIVATE KEY-----\nSUPERSECRETKEYMATERIAL\n-----END PRIVATE KEY-----'
      await ops.run(ops.boardKeySet, actorOf('owner'), { boardId, filename: 'AuthKey_ABC123.p8', pem })

      const entry = audit.listAudit({ operation: 'board.setKey' })[0]!
      expect(entry.changes).toEqual({ filename: 'AuthKey_ABC123.p8' })
      // The allowlist is what makes this true, rather than anybody having remembered.
      expect(JSON.stringify(entry)).not.toContain('SUPERSECRETKEYMATERIAL')
      expect(JSON.stringify(entry)).not.toContain('PRIVATE KEY')
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
