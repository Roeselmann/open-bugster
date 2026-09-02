import { beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Ticket types: a workspace-owned vocabulary, a nullable pointer on each ticket. These cover
 * the migration and its one-time seeding, the data layer, the two ways the list is reached,
 * and the rule that a ticket only speaks the types of the workspace its board is in.
 */
describe('ticket types', () => {
  let db: typeof import('../server/utils/db')
  let actorModule: typeof import('../server/utils/actor')
  let ops: typeof import('../server/operations')
  let audit: typeof import('../server/utils/audit')

  let workspaceId = ''
  let boardId = ''
  const people: Record<string, string> = {}
  const typeIds: Record<string, string> = {}

  const actorOf = (who: string) => actorModule.actorFor(db.findUser(people[who]!)!)
  const statusOf = async (promise: Promise<unknown>) => {
    try {
      await promise
      return 200
    } catch (error) {
      return (error as { statusCode?: number }).statusCode ?? 500
    }
  }

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-ticket-types-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.ATTACHMENTS_PATH = join(directory, 'attachments')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    process.env.APP_PASSWORD_HASH = 'scrypt$abc$def'
    process.env.APP_ADMIN_EMAIL = 'owner@example.com'
    process.env.APP_ADMIN_FIRST_NAME = 'Grace'
    process.env.APP_ADMIN_LAST_NAME = 'Hopper'

    db = await import('../server/utils/db')
    actorModule = await import('../server/utils/actor')
    ops = await import('../server/operations')
    audit = await import('../server/utils/audit')

    people.owner = db.listUsers()[0]!.id
    for (const who of ['wsAdmin', 'boardEditor', 'stranger']) {
      people[who] = db.createUser({ email: `${who}@example.com`, firstName: who, lastName: 'Test', role: 'member' }).id
    }
    workspaceId = db.defaultWorkspaceId()
    boardId = db.listBoards()[0]!.id
    db.setWorkspaceMember(workspaceId, people.wsAdmin!, 'admin')
    db.setBoardMember(boardId, people.boardEditor!, 'editor')
    for (const type of db.listTicketTypes(workspaceId)) typeIds[type.name] = type.id
  })

  describe('the migration', () => {
    it('seeds the default set into every workspace, in order', () => {
      expect(db.listTicketTypes(workspaceId).map(type => [type.name, type.color, type.icon])).toEqual([
        ['Ticket', 'neutral', { kind: 'lucide', name: 'Ticket' }],
        ['Email', 'blue', { kind: 'lucide', name: 'Mail' }],
        ['Social Post', 'fuchsia', { kind: 'lucide', name: 'Megaphone' }],
        ['Todo', 'emerald', { kind: 'lucide', name: 'ListTodo' }],
        ['Idea', 'amber', { kind: 'lucide', name: 'Lightbulb' }]
      ])
    })

    it('is a no-op on a rerun, and never brings a deleted default back', () => {
      const raw = db.getDb()
      expect(db.ensureTicketTypes(raw)).toBe(false)
      const created = db.createTicketType(workspaceId, { name: 'Doomed', color: 'rose', icon: { kind: 'lucide', name: 'Bug' } })!
      expect(db.deleteTicketType(created.id)).toBe(true)
      expect(db.ensureTicketTypes(raw)).toBe(false)
      expect(db.listTicketTypes(workspaceId)).toHaveLength(5)
    })

    it('adds the column to a database from before types existed, and seeds once', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'open-bugster-legacy-types-'))
      const raw = new Database(join(directory, 'legacy.sqlite'))
      raw.exec(`
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE tickets (id TEXT PRIMARY KEY, title TEXT NOT NULL);
        INSERT INTO workspaces VALUES ('ws-1', 'One', 0, '2026-01-01T00:00:00.000Z'), ('ws-2', 'Two', 1, '2026-01-01T00:00:00.000Z');
      `)
      expect(db.ensureTicketTypes(raw)).toBe(true)
      expect((raw.prepare('PRAGMA table_info(tickets)').all() as Array<{ name: string }>).map(column => column.name)).toContain('type_id')
      expect((raw.prepare('SELECT workspace_id, COUNT(*) AS n FROM ticket_types GROUP BY workspace_id ORDER BY workspace_id').all())).toEqual([
        { workspace_id: 'ws-1', n: 5 }, { workspace_id: 'ws-2', n: 5 }
      ])
      expect(db.ensureTicketTypes(raw)).toBe(false)
      raw.close()
    })

    it('points every board at its workspace’s "Ticket" type for imports, once', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'open-bugster-legacy-import-type-'))
      const raw = new Database(join(directory, 'legacy.sqlite'))
      raw.exec(`
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE boards (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT NOT NULL);
        CREATE TABLE tickets (id TEXT PRIMARY KEY, title TEXT NOT NULL);
        INSERT INTO workspaces VALUES ('ws-1', 'One', 0, '2026-01-01T00:00:00.000Z');
        INSERT INTO boards VALUES ('b-1', 'ws-1', 'Board');
      `)
      db.ensureTicketTypes(raw)
      expect(db.ensureBoardImportType(raw)).toBe(true)
      const ticketType = raw.prepare("SELECT id FROM ticket_types WHERE workspace_id = 'ws-1' AND name = 'Ticket'").get() as { id: string }
      expect(raw.prepare("SELECT import_type_id FROM boards WHERE id = 'b-1'").get()).toEqual({ import_type_id: ticketType.id })
      raw.prepare("UPDATE boards SET import_type_id = NULL").run()
      expect(db.ensureBoardImportType(raw)).toBe(false)
      expect(raw.prepare("SELECT import_type_id FROM boards WHERE id = 'b-1'").get()).toEqual({ import_type_id: null })
      raw.close()
    })

    it('gives a new workspace the default set too', () => {
      const workspace = db.createWorkspace('Fresh', people.owner)
      expect(db.listTicketTypes(workspace.id).map(type => type.name)).toEqual(['Ticket', 'Email', 'Social Post', 'Todo', 'Idea'])
    })
  })

  describe('the data layer', () => {
    it('creates, renames and refuses a duplicate name per workspace', () => {
      const type = db.createTicketType(workspaceId, { name: ' Presentation ', color: 'violet', icon: { kind: 'lucide', name: 'Presentation' } })!
      expect(type).toMatchObject({ name: 'Presentation', color: 'violet', position: 5, workspaceId })
      typeIds.Presentation = type.id
      expect(() => db.createTicketType(workspaceId, { name: 'email', color: 'neutral', icon: { kind: 'lucide', name: 'Mail' } })).toThrow(db.TicketTypeNameTakenError)
      expect(() => db.updateTicketType(type.id, { name: 'TODO' })).toThrow(db.TicketTypeNameTakenError)
      expect(db.updateTicketType(type.id, { icon: { kind: 'image', dataUrl: 'data:image/png;base64,AAAA' } })!.icon).toEqual({ kind: 'image', dataUrl: 'data:image/png;base64,AAAA' })
      expect(db.updateTicketType(type.id, { color: 'teal' })).toMatchObject({ name: 'Presentation', color: 'teal', icon: { kind: 'image' } })
      // The same name is fine one workspace over.
      const elsewhere = db.createWorkspace('Elsewhere', people.owner)
      expect(db.createTicketType(elsewhere.id, { name: 'Presentation', color: 'neutral', icon: { kind: 'lucide', name: 'Presentation' } })).toBeTruthy()
    })

    it('hangs the type off the ticket, counts it, and records the change by name', () => {
      const ticket = db.createTicket(boardId, { title: 'Newsletter', typeId: typeIds.Email }, null, actorOf('owner'))!
      expect(ticket.type).toMatchObject({ id: typeIds.Email, name: 'Email' })
      expect(db.listTicketTypes(workspaceId).find(type => type.id === typeIds.Email)!.ticketCount).toBe(1)
      expect(db.listActivity(ticket.id).map(entry => [entry.kind, entry.payload])).toContainEqual(['type', { from: null, to: 'Email' }])

      const retyped = db.updateTicket(ticket.id, { typeId: typeIds.Todo }, actorOf('owner'))!
      expect(retyped.type!.name).toBe('Todo')
      const cleared = db.updateTicket(ticket.id, { typeId: null }, actorOf('owner'))!
      expect(cleared.type).toBeNull()
      // Touching another field leaves the type alone.
      expect(db.updateTicket(ticket.id, { typeId: typeIds.Todo })!.type!.name).toBe('Todo')
      expect(db.updateTicket(ticket.id, { title: 'Newsletter, revised' })!.type!.name).toBe('Todo')
      const changes = db.listActivity(ticket.id).filter(entry => entry.kind === 'type').map(entry => entry.payload)
      expect(changes).toHaveLength(4)
      expect(changes).toEqual(expect.arrayContaining([
        { from: null, to: 'Email' }, { from: 'Email', to: 'Todo' }, { from: 'Todo', to: null }, { from: null, to: 'Todo' }
      ]))
    })

    it('hands a ticket only a reference to its type, never the image bytes', () => {
      const pictured = db.createTicketType(workspaceId, { name: 'Pictured ref', color: 'teal', icon: { kind: 'image', dataUrl: 'data:image/png;base64,AAAA' } })!
      const ticket = db.createTicket(boardId, { title: 'With a picture', typeId: pictured.id })!
      expect(ticket.type).toEqual({ id: pictured.id, name: 'Pictured ref', color: 'teal', icon: { kind: 'image' } })
      expect(JSON.stringify(ticket)).not.toContain('base64')
    })

    it('leaves tickets untyped when their type is deleted', () => {
      const doomed = db.createTicketType(workspaceId, { name: 'Ephemeral', color: 'amber', icon: { kind: 'lucide', name: 'Zap' } })!
      const ticket = db.createTicket(boardId, { title: 'Short-lived', typeId: doomed.id })!
      expect(ticket.type!.id).toBe(doomed.id)
      expect(db.deleteTicketType(doomed.id)).toBe(true)
      expect(db.findTicket(ticket.id)!.type).toBeNull()
      expect(db.deleteTicketType(doomed.id)).toBe(false)
    })

    it('reorders only with the complete list', () => {
      const ids = db.listTicketTypes(workspaceId).map(type => type.id)
      expect(db.reorderTicketTypes(workspaceId, ids.slice(1))).toBeNull()
      expect(db.reorderTicketTypes(workspaceId, [...ids, 'ghost'])).toBeNull()
      const reversed = [...ids].reverse()
      expect(db.reorderTicketTypes(workspaceId, reversed)!.map(type => type.id)).toEqual(reversed)
      db.reorderTicketTypes(workspaceId, ids)
    })

    it('re-points a board’s tickets by type name when the board changes workspace', () => {
      const target = db.createWorkspace('Target', people.owner)
      const board = db.createBoard('Travelling', people.owner, workspaceId)
      const email = db.createTicket(board.id, { title: 'Keeps its type', typeId: typeIds.Email })!
      const presentation = db.createTicket(board.id, { title: 'Loses its type', typeId: typeIds.Presentation })!
      db.moveBoardToWorkspace(board.id, target.id)
      const targetEmail = db.listTicketTypes(target.id).find(type => type.name === 'Email')!
      expect(db.findTicket(email.id)!.type).toMatchObject({ id: targetEmail.id })
      expect(db.findTicket(presentation.id)!.type).toBeNull()
    })

    it('copies types across on a duplicate, and re-points them when the copy lands elsewhere', () => {
      const source = db.createBoard('Original', people.owner, workspaceId)
      db.createTicket(source.id, { title: 'Typed', typeId: typeIds.Email })
      const same = db.duplicateBoard(source.id, { name: 'Copy here', workspaceId, includeTickets: true, creatorId: people.owner! })!
      expect(db.listTickets(same.board.id)[0]!.type!.id).toBe(typeIds.Email)
      const target = db.createWorkspace('Copy target', people.owner)
      const moved = db.duplicateBoard(source.id, { name: 'Copy there', workspaceId: target.id, includeTickets: true, creatorId: people.owner! })!
      expect(db.listTickets(moved.board.id)[0]!.type).toMatchObject({ id: db.listTicketTypes(target.id).find(type => type.name === 'Email')!.id })
    })
  })

  describe('imports', () => {
    const feedback = (boardId: string, laneId: string, externalId: string, typeId: string | null | undefined) => ({
      boardId, laneId, externalId, type: 'screenshot' as const, title: 'Imported', comment: null, testerEmail: 'tester@example.com',
      deviceModel: null, osVersion: null, locale: null, buildId: null, buildVersion: null, buildBundleId: null,
      sourceCreatedAt: '2026-01-01T00:00:00.000Z', raw: {}, typeId
    })

    it('lands imports with the board’s type, and records that in the history', () => {
      const board = db.createBoard('Imports', people.owner, workspaceId)
      const lane = db.importLaneFor(board.id)!
      db.updateBoard(board.id, { importTypeId: typeIds.Email })
      const typeId = db.boardSyncCredentials(board.id)!.importTypeId
      const ticket = db.insertImportedTicket(feedback(board.id, lane.id, 'fb-1', typeId))
      expect(ticket.type).toMatchObject({ id: typeIds.Email, name: 'Email' })
      expect(db.listActivity(ticket.id).map(entry => [entry.kind, entry.payload])).toContainEqual(['type', { from: null, to: 'Email' }])
      expect(db.insertImportedTicket(feedback(board.id, lane.id, 'fb-2', null)).type).toBeNull()
    })

    it('keeps importing, untyped, once the import type is deleted — even mid-sync', () => {
      const board = db.createBoard('Imports after delete', people.owner, workspaceId)
      const lane = db.importLaneFor(board.id)!
      const doomed = db.createTicketType(workspaceId, { name: 'Short-lived import type', color: 'rose', icon: { kind: 'lucide', name: 'Bug' } })!
      db.updateBoard(board.id, { importTypeId: doomed.id })
      // A sync reads its settings once …
      const settings = db.boardSyncCredentials(board.id)!
      expect(settings.importTypeId).toBe(doomed.id)
      // … and somebody deletes the type while it runs.
      expect(db.deleteTicketType(doomed.id)).toBe(true)
      expect(db.findBoard(board.id)!.importTypeId).toBeNull()
      expect(db.boardSyncCredentials(board.id)!.importTypeId).toBeNull()
      const ticket = db.insertImportedTicket(feedback(board.id, lane.id, 'fb-3', settings.importTypeId))
      expect(ticket.type).toBeNull()
      expect(db.listActivity(ticket.id).some(entry => entry.kind === 'type')).toBe(false)
    })

    it('refuses an import type from another workspace, and re-points it when the board moves', async () => {
      const board = db.createBoard('Moving imports', people.owner, workspaceId)
      const elsewhere = db.createWorkspace('Import elsewhere', people.owner)
      const foreign = db.listTicketTypes(elsewhere.id).find(type => type.name === 'Email')!
      expect(await statusOf(ops.run(ops.boardUpdate, actorOf('owner'), { boardId: board.id, importTypeId: foreign.id }))).toBe(422)
      expect(await statusOf(ops.run(ops.boardUpdate, actorOf('owner'), { boardId: board.id, importTypeId: 'ghost' }))).toBe(422)
      await expect(ops.run(ops.boardUpdate, actorOf('owner'), { boardId: board.id, importTypeId: typeIds.Email })).resolves.toMatchObject({ board: { importTypeId: typeIds.Email } })
      await expect(ops.run(ops.boardUpdate, actorOf('owner'), { boardId: board.id, importTypeId: null })).resolves.toMatchObject({ board: { importTypeId: null } })

      // A name the target workspace knows follows by name; one it does not becomes "no type".
      const target = db.createTicketType(elsewhere.id, { name: 'presentation', color: 'teal', icon: { kind: 'lucide', name: 'Presentation' } })!
      db.updateBoard(board.id, { importTypeId: typeIds.Presentation })
      db.moveBoardToWorkspace(board.id, elsewhere.id)
      expect(db.findBoard(board.id)!.importTypeId).toBe(target.id)
      const stranded = db.createBoard('Stranded imports', people.owner, workspaceId)
      db.updateBoard(stranded.id, { importTypeId: typeIds.Todo })
      db.deleteTicketType(db.listTicketTypes(elsewhere.id).find(type => type.name === 'Todo')!.id)
      db.moveBoardToWorkspace(stranded.id, elsewhere.id)
      expect(db.findBoard(stranded.id)!.importTypeId).toBeNull()
      const copy = db.duplicateBoard(board.id, { name: 'Copy', workspaceId, includeTickets: false, creatorId: people.owner! })!
      expect(copy.board.importTypeId).toBe(typeIds.Presentation)
    })
  })

  describe('the operations', () => {
    it('lets anyone who can see the workspace read its types, by workspace or by board', async () => {
      await expect(ops.run(ops.ticketTypeList, actorOf('boardEditor'), { workspaceId })).resolves.toMatchObject({ types: expect.any(Array) })
      await expect(ops.run(ops.ticketTypeList, actorOf('boardEditor'), { boardId })).resolves.toMatchObject({ types: expect.any(Array) })
      expect(await statusOf(ops.run(ops.ticketTypeList, actorOf('stranger'), { workspaceId }))).toBe(404)
      expect(await statusOf(ops.run(ops.ticketTypeList, actorOf('stranger'), { boardId }))).toBe(404)
      expect(await statusOf(ops.run(ops.ticketTypeList, actorOf('boardEditor'), {}))).toBe(422)
    })

    it('lets a board-pinned token read them through its board, and only that way', async () => {
      const pinned = actorModule.actorFor(db.findUser(people.owner!)!, { channel: 'api', tokenId: 'tok_pinned', scopes: ['read'], boardScope: boardId })
      await expect(ops.run(ops.ticketTypeList, pinned, { boardId })).resolves.toBeTruthy()
      expect(await statusOf(ops.run(ops.ticketTypeList, pinned, { workspaceId }))).toBe(404)
    })

    it('keeps managing the vocabulary with workspace administrators', async () => {
      expect(await statusOf(ops.run(ops.ticketTypeCreate, actorOf('boardEditor'), { workspaceId, name: 'Nope' }))).toBe(403)
      expect(await statusOf(ops.run(ops.ticketTypeCreate, actorOf('stranger'), { workspaceId, name: 'Nope' }))).toBe(404)
      const { type } = await ops.run(ops.ticketTypeCreate, actorOf('wsAdmin'), { workspaceId, name: 'Brief', color: 'amber', icon: { kind: 'lucide', name: 'FileText' } }) as { type: { id: string } }
      expect(await statusOf(ops.run(ops.ticketTypeUpdate, actorOf('boardEditor'), { typeId: type.id, name: 'Nope' }))).toBe(403)
      await expect(ops.run(ops.ticketTypeUpdate, actorOf('wsAdmin'), { typeId: type.id, name: 'Creative brief' })).resolves.toMatchObject({ type: { name: 'Creative brief' } })
      expect(await statusOf(ops.run(ops.ticketTypeCreate, actorOf('wsAdmin'), { workspaceId, name: 'creative BRIEF' }))).toBe(409)
      expect(await statusOf(ops.run(ops.ticketTypeReorder, actorOf('wsAdmin'), { workspaceId, typeIds: [type.id] }))).toBe(422)
      expect(await statusOf(ops.run(ops.ticketTypeDelete, actorOf('boardEditor'), { typeId: type.id }))).toBe(403)
      await expect(ops.run(ops.ticketTypeDelete, actorOf('wsAdmin'), { typeId: type.id })).resolves.toBeNull()
      expect(await statusOf(ops.run(ops.ticketTypeDelete, actorOf('wsAdmin'), { typeId: type.id }))).toBe(404)
    })

    it('never writes an uploaded icon into the audit log', async () => {
      const marker = Buffer.from('a distinctive icon payload').toString('base64')
      const revised = Buffer.from('a distinctive icon payload, revised').toString('base64')
      const { type } = await ops.run(ops.ticketTypeCreate, actorOf('wsAdmin'), {
        workspaceId, name: 'Pictured', icon: { kind: 'image', dataUrl: `data:image/png;base64,${marker}` }
      }) as { type: { id: string } }
      await ops.run(ops.ticketTypeUpdate, actorOf('wsAdmin'), { typeId: type.id, icon: { kind: 'image', dataUrl: `data:image/png;base64,${revised}` } })
      const entries = audit.listAudit({ boardId: null }).filter(entry => entry.operation.startsWith('ticket.type.'))
      expect(entries.length).toBeGreaterThanOrEqual(2)
      expect(JSON.stringify(entries)).not.toContain(marker.slice(0, 20))
      expect(entries.find(entry => entry.operation === 'ticket.type.update')!.changes).toEqual({ fields: ['icon'] })
    })

    it('refuses a type from another workspace on a ticket', async () => {
      const elsewhere = db.createWorkspace('Foreign', people.owner)
      const foreign = db.listTicketTypes(elsewhere.id)[0]!
      expect(await statusOf(ops.run(ops.ticketCreate, actorOf('owner'), { boardId, title: 'Wrong vocabulary', typeId: foreign.id }))).toBe(422)
      expect(await statusOf(ops.run(ops.ticketCreate, actorOf('owner'), { boardId, title: 'Unknown', typeId: 'ghost' }))).toBe(422)
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('owner'), { boardId, title: 'Right vocabulary', typeId: typeIds.Email }) as { ticket: { id: string } }
      expect(await statusOf(ops.run(ops.ticketUpdate, actorOf('owner'), { ticketId: ticket.id, typeId: foreign.id }))).toBe(422)
      await expect(ops.run(ops.ticketUpdate, actorOf('owner'), { ticketId: ticket.id, typeId: null })).resolves.toMatchObject({ ticket: { type: null } })
    })
  })
})
