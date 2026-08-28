import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
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
  config: { title?: string; description?: string; inputSchema?: Record<string, unknown> }
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

    it('names tools for the task rather than the endpoint', () => {
      expect([...tools.keys()]).toEqual(expect.arrayContaining([
        'whoami', 'list_boards', 'board_overview', 'search_tickets', 'get_ticket',
        'create_ticket', 'update_ticket', 'move_ticket', 'comment_on_ticket', 'archive_ticket'
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

    it('lists boards with the lane ids every other tool needs', async () => {
      const boards = await call('list_boards')
      expect(boards[0]).toMatchObject({ id: boardId, name: expect.any(String), yourRole: 'admin' })
      expect(boards[0].lanes.map((lane: { name: string }) => lane.name)).toContain('Backlog')
    })

    it('orients on a board in one call', async () => {
      const overview = await call('board_overview', { boardId })
      expect(Object.keys(overview).sort()).toEqual(
        ['categories', 'description', 'id', 'labels', 'lanes', 'members', 'name', 'yourRole']
      )
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

    it('keeps a searched ticket short', async () => {
      const found = await call('search_tickets', { boardId, text: 'crash' })
      expect(found.total).toBe(1)
      const entry = found.tickets[0]
      expect(Object.keys(entry).sort()).toEqual(
        ['assignee', 'category', 'commentCount', 'dueDate', 'id', 'labels', 'laneId', 'number', 'priority', 'title']
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
