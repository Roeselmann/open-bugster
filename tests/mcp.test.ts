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
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }>
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
    return JSON.parse(result.content[0]!.text!)
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
      // Selection accuracy falls off well before thirty options. Sixteen ticket tools plus the
      // twelve structure tools is the ceiling; past it, the answer is a better-shaped tool, not
      // another one.
      expect(tools.size).toBeGreaterThanOrEqual(8)
      expect(tools.size).toBeLessThanOrEqual(28)
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
      const reads = ['whoami', 'list_boards', 'board_overview', 'search_tickets', 'get_ticket', 'get_attachment', 'list_lanes', 'whats_new', 'member_candidates']
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
        'whats_new', 'add_attachment', 'get_attachment', 'restore_ticket'
      ]))
      // The structure tools, a dozen of them on purpose.
      expect([...tools.keys()]).toEqual(expect.arrayContaining([
        'create_board', 'update_board', 'delete_board', 'save_lane', 'delete_lane', 'member_candidates',
        'set_board_member', 'remove_board_member', 'edit_label', 'edit_category', 'edit_ticket_type', 'move_tickets'
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

    it('tells an agent with an identity of its own that the principal is itself', async () => {
      const agent = db.createServiceIdentity('Hermes', 'Triages bug reports')
      db.setBoardMember(boardId, agent.id, 'editor')
      const own = new Map<string, RegisteredTool>()
      const server = { registerTool: (name: string, config: RegisteredTool['config'], handler: RegisteredTool['handler']) => own.set(name, { name, config, handler }) }
      const { registerTools } = await import('../server/mcp/tools')
      registerTools(server as never, actorModule.actorFor(db.findPrincipal(agent.id)!, { channel: 'mcp', agentId: 'Telegram', tokenId: 'tok_agent' }))
      const result = await own.get('whoami')!.handler({})
      expect(JSON.parse(result.content[0]!.text!)).toMatchObject({
        principalId: agent.id, name: 'Hermes', kind: 'agent', description: 'Triages bug reports', note: expect.stringContaining('assigneeId')
      })
      // And people browsing the board can tell it apart from a colleague.
      const { members } = await call('board_overview', { boardId })
      expect(members.find((member: { id: string }) => member.id === agent.id)).toMatchObject({ isAgent: true })
      expect(await call('whoami')).toMatchObject({ kind: 'person' })
      db.deleteUser(agent.id)
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
        ['assignee', 'boardId', 'category', 'commentCount', 'dueDate', 'id', 'labels', 'laneId', 'liveFrom', 'liveUntil', 'number', 'priority', 'progress', 'schedule', 'startDate', 'title', 'type', 'waitsOn']
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

    it('links what a ticket waits on and shifts the chain, a dry run first', async () => {
      const brief = await call('create_ticket', { boardId, laneId, title: 'Chain brief', startDate: '2026-06-01', dueDate: '2026-06-03' })
      const mail = await call('create_ticket', { boardId, laneId, title: 'Chain mail', dueDate: '2026-06-10' })
      const linked = await call('update_ticket', { ticketId: mail.id, waitsOn: [brief.id] })
      expect(linked.waitsOn).toEqual([brief.number])
      const full = await call('get_ticket', { ticketId: brief.id })
      expect(full.waitedOnBy.map((item: { number: number }) => item.number)).toEqual([mail.number])

      // A dry run comes on its own and writes nothing.
      await expect(call('update_ticket', { ticketId: brief.id, title: 'Renamed', shift: { days: 2, dryRun: true } })).rejects.toThrow()
      const preview = await call('update_ticket', { ticketId: brief.id, shift: { days: 2, dryRun: true } })
      expect(preview.applied).toBe(false)
      expect(preview.moves.map((move: { number: number; dueDate: { to: string } }) => [move.number, move.dueDate.to])).toEqual([[brief.number, '2026-06-05'], [mail.number, '2026-06-12']])
      expect((await call('get_ticket', { ticketId: mail.id })).dueDate).toBe('2026-06-10')
      const applied = await call('update_ticket', { ticketId: brief.id, shift: { days: 2 } })
      expect(applied.applied).toBe(true)
      expect((await call('get_ticket', { ticketId: mail.id })).dueDate).toBe('2026-06-12')
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

    it('files a subticket through create_ticket and keeps it when the list is sent back', async () => {
      const parent = await call('create_ticket', { boardId, laneId, title: 'Launch', todos: [{ text: 'Plan' }] })
      const sub = await call('create_ticket', { boardId, title: 'Press kit', priority: 'high', parentTicketId: parent.id })
      expect(sub).toMatchObject({ title: 'Press kit', priority: 'high', parentTicketId: parent.id })
      let full = await call('get_ticket', { ticketId: parent.id })
      expect(full.todos).toEqual([
        { text: 'Plan', completed: false },
        { text: 'Press kit', completed: false, subticketId: sub.id, subticket: { number: sub.number, boardId, board: expect.any(String), laneId: sub.laneId, lane: expect.any(String), archived: false } }
      ])
      await call('update_ticket', { ticketId: parent.id, todos: full.todos.map(({ subticket: _ref, ...todo }: Record<string, unknown>) => todo).reverse() })
      full = await call('get_ticket', { ticketId: parent.id })
      expect(full.todos.map((todo: { text: string; subticketId?: string }) => [todo.text, todo.subticketId ?? null])).toEqual([['Press kit', sub.id], ['Plan', null]])
    })

    it('lets an agent trace a subticket both ways and see where it gets done', async () => {
      // The lanes say which one finishes a ticket, so an agent need not guess from a name.
      const overview = await call('board_overview', { boardId })
      const doneLane = overview.lanes.find((lane: { isDone: boolean }) => lane.isDone)
      expect(doneLane).toMatchObject({ name: 'Done', isDone: true })
      expect(overview.lanes.filter((lane: { isDone: boolean }) => lane.isDone)).toHaveLength(1)
      expect((await call('list_lanes', { boardId })).find((lane: { id: string }) => lane.id === doneLane.id).isDone).toBe(true)

      const parent = await call('create_ticket', { boardId, laneId, title: 'Release', todos: [{ text: 'Notes', completed: true }] })
      const sub = await call('create_ticket', { boardId, title: 'Store listing', parentTicketId: parent.id })
      // Down: the list says how far it has come; a search says the same in short.
      let full = await call('get_ticket', { ticketId: parent.id })
      expect(full.progress).toEqual({ done: 1, total: 2, light: 'orange', openSubtickets: 1, subtickets: 1 })
      expect(full.parents).toEqual([])
      const found = await call('search_tickets', { boardId, text: 'Release' })
      expect(found.tickets.find((ticket: { id: string }) => ticket.id === parent.id).progress).toMatchObject({ light: 'orange' })
      expect(found.tickets.find((ticket: { id: string }) => ticket.id === parent.id)).not.toHaveProperty('todos')

      // Up: the subticket names the ticket waiting on it.
      const child = await call('get_ticket', { ticketId: sub.id })
      expect(child.parents).toEqual([{ id: parent.id, number: parent.number, title: 'Release', boardId, laneId, progress: expect.objectContaining({ openSubtickets: 1 }) }])
      expect(child.progress).toBeNull()

      // Moving it into the done lane ticks it off on the parent, which the light shows.
      await call('move_ticket', { ticketId: sub.id, laneId: doneLane.id })
      full = await call('get_ticket', { ticketId: parent.id })
      expect(full.todos[1]).toMatchObject({ completed: true, subticket: { laneId: doneLane.id } })
      expect(full.progress).toEqual({ done: 2, total: 2, light: 'green', openSubtickets: 0, subtickets: 1 })
    })

    it('names only the parents the token can read', async () => {
      const { registerTools } = await import('../server/mcp/tools')
      const hidden = db.createBoard('Hidden parent board')
      const hiddenLane = db.findBoardSummary(hidden.id)!.lanes.find(lane => !lane.isImport)!
      const parent = db.createTicket(hidden.id, { title: 'Secret plan', laneId: hiddenLane.id })!
      const sub = await call('create_ticket', { boardId, laneId, title: 'Visible part' })
      db.updateTicket(parent.id, { todos: [{ text: 'Visible part', completed: false, subticketId: sub.id }] })
      expect((await call('get_ticket', { ticketId: sub.id })).parents.map((item: { id: string }) => item.id)).toEqual([parent.id])

      const pinned = new Map<string, RegisteredTool>()
      const server = { registerTool(name: string, config: RegisteredTool['config'], handler: RegisteredTool['handler']) { pinned.set(name, { name, config, handler }) } }
      registerTools(server as never, actorModule.actorFor(db.findUser(ownerId)!, { channel: 'mcp', tokenId: 'tok_5', scopes: ['read'], boardScope: boardId }))
      const result = await pinned.get('get_ticket')!.handler({ ticketId: sub.id }) as { content: Array<{ text: string }> }
      const seen = JSON.parse(result.content[0]!.text)
      expect(seen.parents).toEqual([])
      expect(JSON.stringify(seen)).not.toContain('Secret plan')
      db.deleteBoard(hidden.id)
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
      expect(full.attachments[0].id).toBe(attachment.id)
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

  describe('viewing attachments', () => {
    let fixture: Server
    let origin = ''
    let screenshot: Buffer

    beforeAll(async () => {
      const sharp = (await import('sharp')).default
      // Shaped like a TestFlight screenshot: tall, and larger than the default preview.
      screenshot = await sharp({ create: { width: 1200, height: 2600, channels: 4, background: { r: 30, g: 120, b: 200, alpha: 0.5 } } }).png().toBuffer()
      fixture = createServer((request, response) => {
        if (request.url === '/screenshot.png') {
          response.writeHead(200, { 'content-type': 'image/png' })
          response.end(screenshot)
        } else if (request.url === '/report.pdf') {
          response.writeHead(200, { 'content-type': 'application/pdf' })
          response.end(Buffer.from('%PDF-1.4\n%fixture\n'))
        } else {
          response.writeHead(404)
          response.end()
        }
      })
      await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
      origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`
    })

    afterAll(() => new Promise<void>(resolve => { fixture.close(() => resolve()) }))

    it('shows an image scaled down and re-encoded as JPEG', async () => {
      const sharp = (await import('sharp')).default
      const created = await call('create_ticket', { boardId, laneId, title: 'Feedback with a screenshot' })
      const attachment = await call('add_attachment', { ticketId: created.id, url: `${origin}/screenshot.png` })

      const result = await tools.get('get_attachment')!.handler({ attachmentId: attachment.id })
      const [image, text] = result.content
      expect(image).toMatchObject({ type: 'image', mimeType: 'image/jpeg' })
      const meta = await sharp(Buffer.from(image!.data!, 'base64')).metadata()
      expect(meta).toMatchObject({ format: 'jpeg', height: 1500 })
      expect(meta.width).toBeLessThan(1200)
      expect(JSON.parse(text!.text!)).toMatchObject({ id: attachment.id, filename: 'screenshot.png', mimeType: 'image/png' })

      const small = await tools.get('get_attachment')!.handler({ attachmentId: attachment.id, maxDimension: 400 })
      expect((await sharp(Buffer.from(small.content[0]!.data!, 'base64')).metadata()).height).toBe(400)
    })

    it('returns only the details of a file that is not an image', async () => {
      const created = await call('create_ticket', { boardId, laneId, title: 'Feedback with a report' })
      const attachment = await call('add_attachment', { ticketId: created.id, url: `${origin}/report.pdf` })
      const result = await tools.get('get_attachment')!.handler({ attachmentId: attachment.id })
      expect(result.content).toHaveLength(1)
      expect(JSON.parse(result.content[0]!.text!)).toMatchObject({ id: attachment.id, filename: 'report.pdf', mimeType: 'application/pdf' })
    })

    it('answers an unknown id and a file out of reach alike', async () => {
      await expect(call('get_attachment', { attachmentId: 'no-such-attachment' }))
        .rejects.toMatchObject({ statusCode: 404, statusMessage: 'Attachment not found.' })

      const created = await call('create_ticket', { boardId, laneId, title: 'On the main board' })
      const attachment = await call('add_attachment', { ticketId: created.id, url: `${origin}/screenshot.png` })
      const { registerTools } = await import('../server/mcp/tools')
      const pinned = new Map<string, RegisteredTool>()
      const server = {
        registerTool(name: string, config: RegisteredTool['config'], handler: RegisteredTool['handler']) {
          pinned.set(name, { name, config, handler })
        }
      }
      const elsewhere = db.createBoard('Out of reach')
      registerTools(server as never, actorModule.actorFor(db.findUser(ownerId)!, {
        channel: 'mcp', tokenId: 'tok_4', scopes: ['read'], boardScope: elsewhere.id
      }))
      await expect(pinned.get('get_attachment')!.handler({ attachmentId: attachment.id }))
        .rejects.toMatchObject({ statusCode: 404, statusMessage: 'Attachment not found.' })
    })
  })

  describe('structure', () => {
    /** The tools as another principal, through another token, sees them. */
    const toolsAs = async (principalId: string, options: { scopes?: Array<'read' | 'write' | 'admin'>; agentId?: string } = {}) => {
      const { registerTools } = await import('../server/mcp/tools')
      const own = new Map<string, RegisteredTool>()
      const server = { registerTool: (name: string, config: RegisteredTool['config'], handler: RegisteredTool['handler']) => own.set(name, { name, config, handler }) }
      registerTools(server as never, actorModule.actorFor(db.findPrincipal(principalId)!, { channel: 'mcp', agentId: options.agentId ?? 'Structure agent', tokenId: `tok_${principalId}`, scopes: options.scopes }))
      return async (name: string, args: Record<string, unknown> = {}) => JSON.parse((await own.get(name)!.handler(args)).content[0]!.text!)
    }
    const lanesOf = (reply: { lanes: Array<{ name: string; isDone: boolean; isLive: boolean; isImport: boolean }> }) =>
      reply.lanes.map(lane => [lane.name, lane.isDone, lane.isLive, lane.isImport])

    it('opens a board with exactly the lanes asked for, makes its creator admin, and lists it for them', async () => {
      // A workspace admin who is no instance admin, over MCP: the board has to show up in
      // list_boards for them, which the integration permission decides on that channel.
      const ada = db.createUser({ email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace', role: 'member' })
      const workspaceId = db.listBoards()[0]!.workspaceId
      db.setWorkspaceMember(workspaceId, ada.id, 'admin')
      const as = await toolsAs(ada.id, { scopes: ['read', 'write', 'admin'] })

      const created = await as('create_board', {
        name: 'Agent board', workspaceId, description: 'Where the agent plans',
        lanes: [{ name: 'Todo' }, { name: 'Doing' }, { name: 'Shipped', isDone: true }, { name: 'Running', isDone: true, isLive: true }]
      })
      expect(Object.keys(created).sort()).toEqual(['categories', 'description', 'id', 'labels', 'lanes', 'members', 'name', 'ticketTypes', 'workspace', 'yourRole'])
      expect(created).toMatchObject({ name: 'Agent board', description: 'Where the agent plans', yourRole: 'admin', workspace: { id: workspaceId } })
      // Exactly these, in this order, no import lane — and live wins over done.
      expect(lanesOf(created)).toEqual([['Todo', false, false, false], ['Doing', false, false, false], ['Shipped', true, false, false], ['Running', false, true, false]])
      expect(created.members).toEqual([expect.objectContaining({ id: ada.id, role: 'admin', mayAutomate: true })])

      const { boards, workspaces } = await as('list_boards')
      expect(boards.map((board: { id: string }) => board.id)).toContain(created.id)
      expect(workspaces.find((workspace: { id: string }) => workspace.id === workspaceId).yourRole).toBe('admin')
      // New tickets land in the first lane when none is named.
      const ticket = await as('create_ticket', { boardId: created.id, title: 'First' })
      expect(ticket.laneId).toBe(created.lanes[0].id)
    })

    it('opens a board with the default lanes when none are given', async () => {
      const created = await call('create_board', { name: 'Plain board' })
      expect(created.lanes.map((lane: { name: string }) => lane.name)).toEqual(['Import', 'Backlog', 'In Progress', 'Done'])
      expect(created.lanes[0].isImport).toBe(true)
      await call('delete_board', { boardId: created.id })
    })

    it('says whether the token can change structure, and refuses a write-scope token', async () => {
      expect(await call('whoami')).toMatchObject({ canChangeStructure: true })
      const writer = await toolsAs(ownerId, { scopes: ['read', 'write'] })
      expect(await writer('whoami')).toMatchObject({ canChangeStructure: false, structure: expect.stringContaining('admin scope') })
      // The owner is admin of everything; the token is the ceiling.
      await expect(writer('create_board', { name: 'Nope' })).rejects.toMatchObject({ statusCode: 403 })
      await expect(writer('save_lane', { boardId, name: 'Nope' })).rejects.toMatchObject({ statusCode: 403 })
      await expect(writer('edit_label', { boardId, name: 'crash', action: 'delete' })).rejects.toMatchObject({ statusCode: 403 })
      await expect(writer('edit_category', { boardId, action: 'create', name: 'Nope' })).rejects.toMatchObject({ statusCode: 403 })
      await expect(writer('edit_ticket_type', { action: 'create', boardId, name: 'Nope' })).rejects.toMatchObject({ statusCode: 403 })
      await expect(writer('set_board_member', { boardId, userId: ownerId, role: 'viewer' })).rejects.toMatchObject({ statusCode: 403 })
      // Moving tickets is not structure: a writer may.
      const ticket = await writer('create_ticket', { boardId, laneId, title: 'Writer ticket' })
      await expect(writer('move_tickets', { laneId: otherLaneId, ticketIds: [ticket.id] })).resolves.toMatchObject({ moved: [{ id: ticket.id }] })
    })

    it('renames a board and its description, and nothing else', async () => {
      const board = await call('create_board', { name: 'Old name' })
      expect(await call('update_board', { boardId: board.id, name: 'New name', description: 'Now described' }))
        .toEqual({ id: board.id, name: 'New name', description: 'Now described' })
      await expect(call('update_board', { boardId: board.id })).rejects.toMatchObject({ statusCode: 400 })
      await call('delete_board', { boardId: board.id })
    })

    it('deletes only an empty board, archived tickets included', async () => {
      const board = await call('create_board', { name: 'Short-lived', lanes: [{ name: 'Only' }] })
      const ticket = await call('create_ticket', { boardId: board.id, title: 'Still here' })
      await call('archive_ticket', { ticketId: ticket.id })
      await expect(call('delete_board', { boardId: board.id })).rejects.toMatchObject({ statusCode: 409, statusMessage: expect.stringContaining('1 ticket, 1 of them archived') })
      expect(db.findBoard(board.id)).not.toBeNull()

      await call('restore_ticket', { ticketId: ticket.id })
      await call('move_ticket', { ticketId: ticket.id, boardId })
      expect(await call('delete_board', { boardId: board.id })).toEqual({ deleted: board.id })
      expect((await call('list_boards')).boards.map((item: { id: string }) => item.id)).not.toContain(board.id)
    })

    it('keeps a REST delete without the flag as it was', async () => {
      const { run, boardDelete } = await import('../server/operations')
      const board = db.createBoard('Full board')
      const lane = db.findBoardSummary(board.id)!.lanes.find(item => !item.isImport)!
      db.createTicket(board.id, { title: 'Goes with it', laneId: lane.id })
      await run(boardDelete, actorModule.actorFor(db.findUser(ownerId)!, { channel: 'api' }), { boardId: board.id })
      expect(db.findBoard(board.id)).toBeNull()
    })

    it('adds, places and flags lanes, and says what a flag does to the tickets there', async () => {
      const board = await call('create_board', { name: 'Lane board', lanes: [{ name: 'A' }, { name: 'B' }] })
      const added = await call('save_lane', { boardId: board.id, name: 'Front', index: 0 })
      expect(added.lanes.map((lane: { name: string }) => lane.name)).toEqual(['Front', 'A', 'B'])
      expect(added.lanes[0].id).toBe(added.laneId)
      expect(added).not.toHaveProperty('note')
      await expect(call('save_lane', { boardId: board.id })).rejects.toMatchObject({ statusCode: 400 })

      const laneB = added.lanes[2].id
      await call('create_ticket', { boardId: board.id, laneId: laneB, title: 'In B' })
      await call('create_ticket', { boardId: board.id, laneId: laneB, title: 'Also in B' })
      const done = await call('save_lane', { boardId: board.id, laneId: laneB, isDone: true })
      expect(done.note).toContain('2 tickets in this lane now count as finished')
      // Live switches done off, and the tickets stay finished — so no note this time.
      const live = await call('save_lane', { boardId: board.id, laneId: laneB, isLive: true, name: 'Live', index: 0 })
      expect(live.lanes[0]).toMatchObject({ id: laneB, name: 'Live', isDone: false, isLive: true })
      expect(live).not.toHaveProperty('note')
      const open = await call('save_lane', { boardId: board.id, laneId: laneB, isLive: false })
      expect(open.note).toContain('count as open again')
    })

    it('deletes an empty lane directly and wants a decision for a full one', async () => {
      const board = await call('create_board', { name: 'Delete lanes', lanes: [{ name: 'Keep' }, { name: 'Full' }, { name: 'Empty' }] })
      const [keep, full, empty] = board.lanes
      await call('create_ticket', { boardId: board.id, laneId: full.id, title: 'One' })
      await call('create_ticket', { boardId: board.id, laneId: full.id, title: 'Two' })

      await expect(call('delete_lane', { boardId: board.id, laneId: full.id }))
        .rejects.toMatchObject({ statusCode: 409, statusMessage: expect.stringMatching(/2 tickets.*moveTicketsTo.*archiveTickets/) })
      await expect(call('delete_lane', { boardId: board.id, laneId: full.id, moveTicketsTo: full.id })).rejects.toMatchObject({ statusCode: 422 })
      expect((await call('delete_lane', { boardId: board.id, laneId: empty.id })).lanes.map((lane: { name: string }) => lane.name)).toEqual(['Keep', 'Full'])
      const moved = await call('delete_lane', { boardId: board.id, laneId: full.id, moveTicketsTo: keep.id })
      expect(moved).toMatchObject({ deleted: full.id, ticketsMoved: 2 })
      expect(moved.lanes).toEqual([expect.objectContaining({ id: keep.id, ticketCount: 2 })])
      // The rules of the lane delete itself come through in their own words.
      await expect(call('delete_lane', { boardId: board.id, laneId: keep.id, archiveTickets: true }))
        .rejects.toMatchObject({ statusCode: 409, statusMessage: 'A board needs at least one lane.' })
    })

    it('refuses an empty-only lane delete server-side once a ticket has arrived', async () => {
      const { run, laneDelete } = await import('../server/operations')
      const board = await call('create_board', { name: 'Race board', lanes: [{ name: 'Keep' }, { name: 'Busy' }] })
      await call('create_ticket', { boardId: board.id, laneId: board.lanes[1].id, title: 'Arrived meanwhile' })
      await expect(run(laneDelete, actorModule.actorFor(db.findUser(ownerId)!, { channel: 'mcp' }), { boardId: board.id, laneId: board.lanes[1].id, mode: 'empty' }))
        .rejects.toMatchObject({ statusCode: 409 })
      expect(db.findLane(board.lanes[1].id)).not.toBeNull()
    })

    it('adds, re-roles and removes members, and keeps the last administrator', async () => {
      const board = await call('create_board', { name: 'People board' })
      const bob = db.createUser({ email: 'bob@example.com', firstName: 'Bob', lastName: 'Builder', role: 'member' })
      const candidates = await call('member_candidates', { boardId: board.id })
      expect(candidates).toEqual(expect.arrayContaining([{ id: bob.id, name: 'Bob Builder' }]))
      expect(JSON.stringify(candidates)).not.toContain('@')

      const added = await call('set_board_member', { boardId: board.id, userId: bob.id, role: 'editor', mayAutomate: true })
      expect(added.members).toEqual(expect.arrayContaining([{ id: bob.id, name: 'Bob Builder', role: 'editor', mayAutomate: true }]))
      // Bob is now the only board admin once promoted and the creator steps down.
      await call('set_board_member', { boardId: board.id, userId: bob.id, role: 'admin' })
      await call('remove_board_member', { boardId: board.id, userId: ownerId })
      await expect(call('set_board_member', { boardId: board.id, userId: bob.id, role: 'viewer' }))
        .rejects.toMatchObject({ statusCode: 409, statusMessage: 'A board needs at least one administrator.' })
      await expect(call('remove_board_member', { boardId: board.id, userId: bob.id }))
        .rejects.toMatchObject({ statusCode: 409, statusMessage: 'A board needs at least one administrator.' })

      await call('set_board_member', { boardId: board.id, userId: ownerId, role: 'admin' })
      const left = await call('remove_board_member', { boardId: board.id, userId: bob.id })
      expect(left.members.map((member: { id: string }) => member.id)).toEqual([ownerId])
    })

    it('renames a label onto an existing one by merging, without duplicates', async () => {
      const board = await call('create_board', { name: 'Label board', lanes: [{ name: 'Only' }] })
      const both = await call('create_ticket', { boardId: board.id, title: 'Both', labels: ['alpha', 'beta'] })
      const alphaOnly = await call('create_ticket', { boardId: board.id, title: 'Alpha only', labels: ['alpha'] })
      const renamed = await call('edit_label', { boardId: board.id, name: 'ALPHA', action: 'rename', newName: 'Beta' })
      expect(renamed).toEqual({ labels: ['beta'], ticketsTouched: 2, merged: true })
      expect((await call('get_ticket', { ticketId: both.id })).labels).toEqual(['beta'])
      expect((await call('get_ticket', { ticketId: alphaOnly.id })).labels).toEqual(['beta'])
      expect(db.listLabels(board.id)).toEqual([expect.objectContaining({ name: 'beta', ticketCount: 2 })])

      // A plain rename keeps the row; a case-only one too.
      expect(await call('edit_label', { boardId: board.id, name: 'beta', action: 'rename', newName: 'Beta' })).toEqual({ labels: ['Beta'], ticketsTouched: 2 })
      expect(await call('edit_label', { boardId: board.id, name: 'beta', action: 'delete' })).toEqual({ labels: [], ticketsTouched: 2 })
      expect((await call('get_ticket', { ticketId: both.id })).labels).toEqual([])
      await expect(call('edit_label', { boardId: board.id, name: 'gone', action: 'delete' })).rejects.toMatchObject({ statusCode: 404 })
    })

    it('creates, recolours and deletes categories by name, and the overview shows their colour', async () => {
      const board = await call('create_board', { name: 'Category board', lanes: [{ name: 'Only' }] })
      expect(await call('edit_category', { boardId: board.id, action: 'create', name: 'Marketing', color: 'rose' }))
        .toEqual({ categories: [{ name: 'Marketing', color: 'rose' }] })
      await expect(call('edit_category', { boardId: board.id, action: 'create', name: 'marketing' })).rejects.toMatchObject({ statusCode: 409 })
      const ticket = await call('create_ticket', { boardId: board.id, title: 'Campaign', categoryName: 'Marketing' })
      expect(await call('edit_category', { boardId: board.id, action: 'update', name: 'marketing', newName: 'Brand', color: 'teal' }))
        .toEqual({ categories: [{ name: 'Brand', color: 'teal' }] })
      expect((await call('board_overview', { boardId: board.id })).categories).toEqual([{ name: 'Brand', color: 'teal' }])
      expect((await call('get_ticket', { ticketId: ticket.id })).category).toBe('Brand')
      expect(await call('edit_category', { boardId: board.id, action: 'delete', name: 'Brand' })).toEqual({ categories: [], ticketsUncategorised: 1 })
      expect((await call('get_ticket', { ticketId: ticket.id })).category).toBeNull()
      await expect(call('edit_category', { boardId: board.id, action: 'delete', name: 'Brand' })).rejects.toMatchObject({ statusCode: 404 })
    })

    it('creates, changes and deletes a ticket type of the workspace', async () => {
      const created = await call('edit_ticket_type', { action: 'create', boardId, name: 'Podcast', color: 'violet' })
      const podcast = created.types.find((type: { name: string }) => type.name === 'Podcast')
      expect(podcast).toMatchObject({ color: 'violet' })
      const ticket = await call('create_ticket', { boardId, laneId, title: 'Episode 1', typeId: podcast.id })
      const updated = await call('edit_ticket_type', { action: 'update', typeId: podcast.id, name: 'Show', color: 'none' })
      expect(updated.types.find((type: { id: string }) => type.id === podcast.id)).toMatchObject({ name: 'Show', color: 'none' })
      const deleted = await call('edit_ticket_type', { action: 'delete', typeId: podcast.id })
      expect(deleted.ticketsUntyped).toBe(1)
      expect(deleted.types.map((type: { id: string }) => type.id)).not.toContain(podcast.id)
      expect((await call('get_ticket', { ticketId: ticket.id })).type).toBeNull()
    })

    it('moves tickets into a lane in the order given, counting right when some started above', async () => {
      const board = await call('create_board', { name: 'Move board', lanes: [{ name: 'Target' }, { name: 'Elsewhere' }] })
      const [target, elsewhere] = board.lanes
      const make = async (title: string, lane: string) => (await call('create_ticket', { boardId: board.id, laneId: lane, title })).id as string
      const t1 = await make('t1', target.id)
      const t2 = await make('t2', target.id)
      const t3 = await make('t3', target.id)
      const t4 = await make('t4', target.id)
      const x = await make('x', elsewhere.id)
      const order = async () => (await call('search_tickets', { boardId: board.id, laneId: target.id, limit: 100 })).tickets.map((ticket: { title: string }) => ticket.title)

      // t1 sits above the insertion point and t3 below it; x comes from another lane.
      const moved = await call('move_tickets', { laneId: target.id, ticketIds: [t3, x, t1], index: 1 })
      expect(moved.moved.map((ticket: { title: string }) => ticket.title)).toEqual(['t3', 'x', 't1'])
      expect(await order()).toEqual(['t2', 't3', 'x', 't1', 't4'])

      // To the top by default, and past the end puts them last.
      await call('move_tickets', { laneId: target.id, ticketIds: [t4, t2] })
      expect(await order()).toEqual(['t4', 't2', 't3', 'x', 't1'])
      await call('move_tickets', { laneId: target.id, ticketIds: [t4], index: 99 })
      expect(await order()).toEqual(['t2', 't3', 'x', 't1', 't4'])

      // Every move is its own entry in the ticket's history.
      expect((await call('get_ticket', { ticketId: x })).history.map((entry: { kind: string }) => entry.kind)).toContain('moved')
      // One board only; cross-board moves are move_ticket's.
      const stray = await call('create_ticket', { boardId, laneId, title: 'Other board' })
      await expect(call('move_tickets', { laneId: target.id, ticketIds: [t1, stray.id] })).rejects.toMatchObject({ statusCode: 422 })
      await expect(call('move_tickets', { laneId, ticketIds: [t1] })).rejects.toMatchObject({ statusCode: 422 })
      await expect(call('move_tickets', { laneId: target.id, ticketIds: [t1, t1] })).rejects.toMatchObject({ statusCode: 400 })
    })

    it('shows a viewer what was done to the board, and never a refused attempt', async () => {
      const board = await call('create_board', { name: 'Watched board', lanes: [{ name: 'Todo' }, { name: 'Done', isDone: true }] })
      await call('save_lane', { boardId: board.id, laneId: board.lanes[0].id, name: 'Backlog' })
      await call('edit_category', { boardId: board.id, action: 'create', name: 'Ops', color: 'amber' })
      const vera = db.createUser({ email: 'vera@example.com', firstName: 'Vera', lastName: 'Viewer', role: 'member' })
      await call('set_board_member', { boardId: board.id, userId: vera.id, role: 'viewer', mayAutomate: true })

      const asVera = await toolsAs(vera.id, { scopes: ['read', 'write', 'admin'] })
      // Refused: a viewer is no board admin, whatever the token says.
      await expect(asVera('save_lane', { boardId: board.id, name: 'Sneaky' })).rejects.toMatchObject({ statusCode: 403 })
      // Refused inside the operation, which is logged against the board: still not shown.
      await expect(call('edit_category', { boardId: board.id, action: 'create', name: 'ops' })).rejects.toMatchObject({ statusCode: 409 })

      // A move refused part-way answers with what happened rather than throwing it all away.
      const one = await call('create_ticket', { boardId: board.id, title: 'One' })
      const two = await call('create_ticket', { boardId: board.id, title: 'Two' })
      const partial = await asVera('move_tickets', { laneId: board.lanes[1].id, ticketIds: [one.id, two.id] })
      expect(partial).toMatchObject({ moved: [], failed: { id: one.id, error: 'You do not have permission to do this.' }, notAttempted: [{ id: two.id }] })

      const { structure } = await asVera('whats_new', { boardId: board.id })
      expect(structure.map((entry: { operation: string }) => entry.operation)).toEqual(['member.set', 'category.create', 'lane.update', 'board.create'])
      expect(structure.find((entry: { operation: string }) => entry.operation === 'lane.update')).toMatchObject({
        by: 'Grace Hopper', via: 'Claude Desktop', detail: { name: 'Backlog', target: 'Backlog' }
      })
      expect(structure.find((entry: { operation: string }) => entry.operation === 'board.create')).toMatchObject({
        detail: { name: 'Watched board', lanes: ['Todo', 'Done'], target: 'Watched board' }
      })
      expect(structure.find((entry: { operation: string }) => entry.operation === 'member.set').detail).toMatchObject({ role: 'viewer', target: 'Vera Viewer' })
      // Nothing of the log beyond what the operations allowlisted.
      const text = JSON.stringify(structure)
      expect(text).not.toContain('Sneaky')
      expect(text).not.toContain('denied')
      expect(text).not.toContain('@')
      for (const entry of structure) expect(Object.keys(entry).sort()).toEqual(['at', 'by', 'detail', 'operation', 'via'])
      // The full log stays with administrators.
      const { run, auditList } = await import('../server/operations')
      await expect(run(auditList, actorModule.actorFor(db.findUser(vera.id)!, { channel: 'mcp' }), { boardId: board.id })).rejects.toMatchObject({ statusCode: 403 })
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
