import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The tools are registered against a stub that records what they declare and lets a test call
 * them, rather than standing up a transport. What matters here is the surface — how many
 * tools, how they are described, and what shape comes back — not the JSON-RPC framing, which
 * is the SDK's job and is covered by driving a real client against the built server.
 */
interface RegisteredTool {
  name: string
  config: {
    title?: string
    description?: string
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }
    inputSchema?: Record<string, unknown>
  }
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>
}

describe('the MCP tool surface', () => {
  let db: typeof import('../server/utils/db')
  let actorModule: typeof import('../server/utils/actor')
  let tools: Map<string, RegisteredTool>

  let boardId = ''
  let laneId = ''
  let otherLaneId = ''
  let ownerId = ''

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.get(name)
    if (!tool) throw new Error(`no tool named ${name}`)
    const result = await tool.handler(args)
    return JSON.parse(result.content[0]!.text)
  }

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-mcp-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.ATTACHMENTS_PATH = join(directory, 'attachments')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    process.env.APP_PASSWORD_HASH = 'scrypt$abc$def'
    process.env.APP_ADMIN_EMAIL = 'owner@example.com'
    process.env.APP_ADMIN_FIRST_NAME = 'Grace'
    process.env.APP_ADMIN_LAST_NAME = 'Hopper'

    db = await import('../server/utils/db')
    actorModule = await import('../server/utils/actor')
    const { registerTools } = await import('../server/mcp/tools')

    const board = db.listBoards()[0]!
    boardId = board.id
    laneId = board.lanes.find(lane => lane.name === 'Backlog')!.id
    otherLaneId = board.lanes.find(lane => lane.name === 'In Progress')!.id
    ownerId = db.listUsers()[0]!.id

    tools = new Map()
    const server = {
      registerTool(name: string, config: RegisteredTool['config'], handler: RegisteredTool['handler']) {
        tools.set(name, { name, config, handler })
      }
    }
    const actor = actorModule.actorFor(db.findUser(ownerId)!, { channel: 'mcp', agentId: 'Claude Desktop', tokenId: 'tok_1' })
    registerTools(server as never, actor)
  })

  describe('the surface itself', () => {
    it('stays small enough for a model to choose from', () => {
      // Selection accuracy falls off well before thirty options. If this grows past the low
      // teens, the answer is a better-shaped tool, not another one.
      expect(tools.size).toBeGreaterThanOrEqual(8)
      expect(tools.size).toBeLessThanOrEqual(14)
    })

    it('describes every tool, at length enough to be useful', () => {
      for (const tool of tools.values()) {
        expect(tool.config.description, tool.name).toBeTruthy()
        expect(tool.config.description!.length, tool.name).toBeGreaterThan(60)
        expect(tool.config.title, tool.name).toBeTruthy()
      }
    })

    it('tells clients which tools only read, so no approval gate lands on a lookup', () => {
      // The spec's default is "assume the worst": a tool without annotations counts as
      // write-capable and destructive, and cautious clients gate it behind an approval.
      const reads = ['whoami', 'list_boards', 'board_overview', 'search_tickets', 'get_ticket', 'list_lanes', 'whats_new']
      for (const tool of tools.values()) {
        expect(tool.config.annotations?.readOnlyHint, tool.name).toBe(reads.includes(tool.name))
      }
      // The URL fetch is the one tool that reaches outside this instance.
      for (const tool of tools.values()) {
        expect(tool.config.annotations?.openWorldHint, tool.name).toBe(tool.name === 'add_attachment')
      }
    })

    it('names tools for the task rather than the endpoint', () => {
      expect([...tools.keys()]).toEqual(expect.arrayContaining([
        'whoami', 'list_boards', 'board_overview', 'search_tickets', 'get_ticket',
        'create_ticket', 'update_ticket', 'move_ticket', 'comment_on_ticket', 'archive_ticket',
        'whats_new', 'add_attachment', 'restore_ticket'
      ]))
      // Nothing named after an operation, and no administration.
      for (const name of tools.keys()) {
        expect(name).not.toContain('.')
        expect(name).not.toMatch(/token|user|service|key/)
      }
    })
  })

  describe('orientation', () => {
    it('says who the token acts for and what it may do', async () => {
      expect(await call('whoami')).toMatchObject({
        principalId: ownerId,
        name: 'Grace Hopper',
        agent: 'Claude Desktop',
        channel: 'mcp'
      })
    })

    it('lists boards with the lane ids every other tool needs, and the workspaces around them', async () => {
      const { boards, workspaces } = await call('list_boards')
      expect(boards[0]).toMatchObject({ id: boardId, name: expect.any(String), yourRole: 'admin' })
      expect(boards[0].lanes.map((lane: { name: string }) => lane.name)).toContain('Backlog')
      expect(workspaces[0]).toMatchObject({ id: boards[0].workspaceId, name: expect.any(String), description: expect.any(String) })
    })

    it('orients on a board in one call, workspace context included', async () => {
      const overview = await call('board_overview', { boardId })
      expect(Object.keys(overview).sort()).toEqual(
        ['categories', 'description', 'id', 'labels', 'lanes', 'members', 'name', 'ticketTypes', 'workspace', 'yourRole']
      )
      expect(overview.workspace).toMatchObject({ id: expect.any(String), name: expect.any(String) })
      // Ids, not just names: a type is chosen by id when a ticket is filed.
      expect(overview.ticketTypes).toEqual(expect.arrayContaining([{ id: expect.any(String), name: 'Email' }]))
    })
  })

  describe('projections', () => {
    let ticketId = ''

    beforeAll(async () => {
      const created = await call('create_ticket', {
        boardId, laneId, title: 'Crash on export', priority: 'high', labels: ['crash'],
        description: 'A long description that a list has no business carrying around with it.'
      })
      ticketId = created.id
    })

    it('files a ticket with a type from the overview, and can take it off again', async () => {
      const overview = await call('board_overview', { boardId })
      const email = overview.ticketTypes.find((type: { name: string }) => type.name === 'Email')
      const created = await call('create_ticket', { boardId, laneId, title: 'Newsletter draft', typeId: email.id })
      expect(created.type).toBe('Email')
      const byType = await call('search_tickets', { boardId, typeId: email.id })
      expect(byType.tickets.map((ticket: { id: string }) => ticket.id)).toEqual([created.id])
      const untyped = await call('search_tickets', { boardId, typeId: 'untyped' })
      expect(untyped.tickets.map((ticket: { id: string }) => ticket.id)).not.toContain(created.id)
      const cleared = await call('update_ticket', { ticketId: created.id, typeId: null })
      expect(cleared.type).toBeNull()
      await call('archive_ticket', { ticketId: created.id })
    })

    it('keeps a searched ticket short', async () => {
      const found = await call('search_tickets', { boardId, text: 'crash' })
      expect(found.total).toBe(1)
      const entry = found.tickets[0]
      expect(Object.keys(entry).sort()).toEqual(
        ['assignee', 'boardId', 'category', 'commentCount', 'dueDate', 'id', 'labels', 'laneId', 'number', 'priority', 'title', 'type']
      )
      // The three fields that make a list expensive are exactly the ones left out.
      expect(entry).not.toHaveProperty('description')
      expect(entry).not.toHaveProperty('attachments')
      expect(entry).not.toHaveProperty('todos')
      expect(JSON.stringify(found)).not.toContain('no business carrying')
    })

    it('returns everything from get_ticket, which is what it is for', async () => {
      const full = await call('get_ticket', { ticketId })
      expect(full.description).toContain('no business carrying')
      expect(full).toHaveProperty('comments')
      expect(full).toHaveProperty('history')
      expect(full).toHaveProperty('todos')
      expect(full).toHaveProperty('attachments')
    })

    it('finds a ticket by the number people refer to it by', async () => {
      const listed = (await call('search_tickets', { boardId, text: 'crash' })).tickets[0]
      const byNumber = await call('get_ticket', { ticketNumber: listed.number })
      expect(byNumber.id).toBe(ticketId)
      // The number is a whole handle, not a hint: the answer is the same one an id gives.
      expect(byNumber).toEqual(await call('get_ticket', { ticketId }))
    })

    it('answers 404 for a number nobody was issued', async () => {
      await expect(call('get_ticket', { ticketNumber: 999_999 })).rejects.toMatchObject({ statusCode: 404 })
    })

    it('refuses to guess when given neither identifier', async () => {
      await expect(call('get_ticket', {})).rejects.toMatchObject({ statusCode: 400 })
    })

    it('honours the search limit and still reports the true total', async () => {
      for (let i = 0; i < 5; i++) await call('create_ticket', { boardId, laneId, title: `Extra ${i}` })
      const page = await call('search_tickets', { boardId, limit: 2 })
      expect(page.tickets).toHaveLength(2)
      expect(page.returned).toBe(2)
      expect(page.total).toBe(6)
    })

    it('filters by lane, priority, label and assignee', async () => {
      expect((await call('search_tickets', { boardId, priority: 'high' })).total).toBe(1)
      expect((await call('search_tickets', { boardId, label: 'CRASH' })).total).toBe(1)
      expect((await call('search_tickets', { boardId, laneId: otherLaneId })).total).toBe(0)
      expect((await call('search_tickets', { boardId, assigneeId: 'unassigned' })).total).toBe(6)
    })

    it('searches across every reachable board when no board is named', async () => {
      const second = db.createBoard('Second search board')
      await call('create_ticket', { boardId, laneId, title: 'Needle here' })
      await call('create_ticket', { boardId: second.id, title: 'Needle there' })
      const found = await call('search_tickets', { text: 'needle' })
      expect(found.total).toBe(2)
      expect(new Set(found.tickets.map((ticket: { boardId: string }) => ticket.boardId)).size).toBe(2)
      // The archive stays one board's view.
      await expect(call('search_tickets', { archived: true })).rejects.toMatchObject({ statusCode: 400 })
    })
  })

  describe('writing', () => {
    it('records the agent beside the person on everything it does', async () => {
      const created = await call('create_ticket', { boardId, laneId, title: 'By an agent' })
      await call('comment_on_ticket', { ticketId: created.id, body: 'Reproduced.' })
      await call('move_ticket', { ticketId: created.id, laneId: otherLaneId })

      const full = await call('get_ticket', { ticketId: created.id })
      for (const entry of full.history) {
        expect(entry.by).toBe('Grace Hopper')
        // Provenance, not attribution: the person still answers for it.
        expect(entry.via).toBe('Claude Desktop')
      }
      expect(full.comments[0]).toMatchObject({ author: 'Grace Hopper', body: 'Reproduced.' })
    })

    it('moves a ticket onto another board of the workspace through the same tool', async () => {
      const other = db.createBoard('Other app')
      const created = await call('create_ticket', { boardId, laneId, title: 'Crossing over' })
      const moved = await call('move_ticket', { ticketId: created.id, boardId: other.id })
      expect(moved.assigneeCleared).toBe(false)
      expect((await call('get_ticket', { ticketId: created.id })).boardId).toBe(other.id)
      db.deleteBoard(other.id)
    })

    it('archives without deleting', async () => {
      const created = await call('create_ticket', { boardId, laneId, title: 'Doomed' })
      const archived = await call('archive_ticket', { ticketId: created.id })
      expect(archived.archivedAt).toBeTruthy()
      // Off the board, but a board admin can still find it.
      expect((await call('search_tickets', { boardId, text: 'Doomed' })).total).toBe(0)
      expect((await call('search_tickets', { boardId, text: 'Doomed', archived: true })).total).toBe(1)
    })

    it('updates only the fields it is given', async () => {
      const created = await call('create_ticket', { boardId, laneId, title: 'Before', priority: 'low', labels: ['keep'] })
      const updated = await call('update_ticket', { ticketId: created.id, title: 'After' })
      expect(updated.title).toBe('After')
      expect(updated.priority).toBe('low')
      expect(updated.labels).toEqual(['keep'])
    })

    it('writes to-dos as a whole list, and omitting the field leaves them alone', async () => {
      const created = await call('create_ticket', {
        boardId, laneId, title: 'With chores', todos: [{ text: 'One' }, { text: 'Two', completed: true }]
      })
      let full = await call('get_ticket', { ticketId: created.id })
      expect(full.todos.map((todo: { text: string; completed: boolean }) => [todo.text, todo.completed]))
        .toEqual([['One', false], ['Two', true]])
      await call('update_ticket', { ticketId: created.id, title: 'Chores renamed' })
      full = await call('get_ticket', { ticketId: created.id })
      expect(full.todos).toHaveLength(2)
      // The list is replaced wholesale: what is not sent back is gone.
      await call('update_ticket', { ticketId: created.id, todos: [{ text: 'Two', completed: true }] })
      full = await call('get_ticket', { ticketId: created.id })
      expect(full.todos.map((todo: { text: string }) => todo.text)).toEqual(['Two'])
    })
  })

  describe('the digest and the undo', () => {
    it('summarises a board since a timestamp', async () => {
      const created = await call('create_ticket', { boardId, laneId, title: 'Digest fodder' })
      await call('comment_on_ticket', { ticketId: created.id, body: 'Noted.' })
      const digest = await call('whats_new', { boardId })
      const kinds = digest.entries
        .filter((entry: { ticket: { id: string } }) => entry.ticket.id === created.id)
        .map((entry: { kind: string }) => entry.kind)
      expect(kinds).toContain('created')
      expect(kinds).toContain('commented')
      expect(digest.entries[0]).toMatchObject({
        ticket: { id: expect.any(String), number: expect.any(Number), title: expect.any(String) },
        by: 'Grace Hopper',
        via: 'Claude Desktop'
      })
      // The future holds nothing yet.
      const later = await call('whats_new', { boardId, since: '2999-01-01T00:00:00.000Z' })
      expect(later.entries).toEqual([])
    })

    it('restores what archive_ticket took off the board', async () => {
      const created = await call('create_ticket', { boardId, laneId, title: 'Back again' })
      await call('archive_ticket', { ticketId: created.id })
      const restored = await call('restore_ticket', { ticketId: created.id })
      expect(restored.laneId).toBe(laneId)
      expect((await call('search_tickets', { boardId, text: 'Back again' })).total).toBe(1)
    })
  })

  describe('attachments by URL', () => {
    // The eight PNG magic bytes and a little noise — enough to pass the signature check.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    let fixture: Server
    let origin = ''

    beforeAll(async () => {
      fixture = createServer((request, response) => {
        if (request.url === '/shot.png' || request.url === '/mystery') {
          response.writeHead(200, { 'content-type': 'image/png' })
          response.end(png)
        } else {
          response.writeHead(404)
          response.end()
        }
      })
      await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
      origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`
    })

    afterAll(() => new Promise<void>(resolve => { fixture.close(() => resolve()) }))

    it('downloads the file and hangs it on the ticket', async () => {
      const created = await call('create_ticket', { boardId, laneId, title: 'With a screenshot' })
      const attachment = await call('add_attachment', { ticketId: created.id, url: `${origin}/shot.png` })
      expect(attachment).toMatchObject({ filename: 'shot.png', mimeType: 'image/png', size: png.length })
      const full = await call('get_ticket', { ticketId: created.id })
      expect(full.attachments).toHaveLength(1)
      expect(full.attachments[0].url).toBe(`/api/v1/attachments/${attachment.id}`)
    })

    it('names an extensionless URL from its content type', async () => {
      const created = await call('create_ticket', { boardId, laneId, title: 'Telegram-style path' })
      const attachment = await call('add_attachment', { ticketId: created.id, url: `${origin}/mystery` })
      expect(attachment.filename).toBe('mystery.png')
    })

    it('reports a failed download in plain words', async () => {
      const created = await call('create_ticket', { boardId, laneId, title: 'No file here' })
      await expect(call('add_attachment', { ticketId: created.id, url: `${origin}/gone.png` }))
        .rejects.toMatchObject({ statusCode: 422, statusMessage: 'The URL answered 404.' })
    })
  })

  /** The guarantee that matters most once an agent holds a credential. */
  describe('a tool cannot exceed the token behind it', () => {
    it('refuses a write when the token is read-only', async () => {
      const { registerTools } = await import('../server/mcp/tools')
      const readOnly = new Map<string, RegisteredTool>()
      const server = {
        registerTool(name: string, config: RegisteredTool['config'], handler: RegisteredTool['handler']) {
          readOnly.set(name, { name, config, handler })
        }
      }
      registerTools(server as never, actorModule.actorFor(db.findUser(ownerId)!, {
        channel: 'mcp', agentId: 'read-only agent', tokenId: 'tok_2', scopes: ['read']
      }))

      // Reading is fine.
      await expect(readOnly.get('list_boards')!.handler({})).resolves.toBeTruthy()
      // Writing is not, even though the principal is the instance owner.
      await expect(readOnly.get('create_ticket')!.handler({ boardId, laneId, title: 'Nope' }))
        .rejects.toMatchObject({ statusCode: 403 })
    })

    it('keeps a board-pinned token off every other board', async () => {
      const { registerTools } = await import('../server/mcp/tools')
      const pinned = new Map<string, RegisteredTool>()
      const server = {
        registerTool(name: string, config: RegisteredTool['config'], handler: RegisteredTool['handler']) {
          pinned.set(name, { name, config, handler })
        }
      }
      const elsewhere = db.createBoard('Somewhere else')
      registerTools(server as never, actorModule.actorFor(db.findUser(ownerId)!, {
        channel: 'mcp', tokenId: 'tok_3', scopes: ['read'], boardScope: boardId
      }))

      await expect(pinned.get('board_overview')!.handler({ boardId })).resolves.toBeTruthy()
      // 404, the same answer a non-member gets: a 403 would confirm the board exists.
      await expect(pinned.get('board_overview')!.handler({ boardId: elsewhere.id }))
        .rejects.toMatchObject({ statusCode: 404 })
    })
  })
})
