import { createError } from 'h3'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { run, type AnyOperation } from '~~/server/operations'
import * as ops from '~~/server/operations'
import type { Actor } from '~~/server/utils/actor'
import type { BoardSummary, LaneSummary, Ticket, TicketActivityEntry, TicketComment, WorkspaceSummary } from '~~/shared/types/domain'

/**
 * The agent-facing surface.
 *
 * Deliberately not one tool per REST endpoint. Tool-selection accuracy falls off well before
 * thirty options, and a model that has to compose four calls to answer "what is on the board"
 * spends its context on plumbing. These are task-shaped instead, and every list returns a slim
 * projection — a full `Ticket` carries its description, todos, attachments and TestFlight blob,
 * and fifty of them is most of a context window for information nobody asked for.
 *
 * `get_ticket` is the one tool that returns everything, which is the point of it.
 */

/** What a ticket looks like in a list: enough to choose one, and no more. */
function slim(ticket: Ticket) {
  return {
    id: ticket.id,
    number: ticket.ticketNumber,
    title: ticket.title,
    laneId: ticket.laneId,
    priority: ticket.priority,
    assignee: nameOf(ticket.assignee),
    labels: ticket.labels.map(label => label.name),
    category: ticket.category?.name ?? null,
    dueDate: ticket.dueDate,
    commentCount: ticket.commentCount
  }
}

function nameOf(person: { firstName: string; lastName: string } | null): string | null {
  if (!person) return null
  return `${person.firstName} ${person.lastName}`.trim() || null
}

/** Every tool answers with JSON text, which is what a model reads best. */
function reply(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
}

export function registerTools(server: McpServer, actor: Actor) {
  // `AnyOperation` for the same reason the registry uses it: `ZodType` is invariant, so a
  // parameter typed `Operation<unknown>` rejects every concrete operation.
  const call = <T>(operation: AnyOperation, input: unknown) => run(operation, actor, input) as Promise<T>

  server.registerTool('whoami', {
    title: 'Who am I',
    description:
      'The principal this token acts for, the agent label it carries, and what its scopes permit. '
      + 'Worth calling first when a write is unexpectedly refused: a token is a ceiling on what its '
      + 'principal can do, so being denied usually means the scopes are narrower than the person.',
    inputSchema: {}
  }, async () => reply({
    principalId: actor.principalId,
    name: nameOf(actor.principal),
    agent: actor.agentId,
    channel: actor.channel,
    scopes: actor.scopes ?? 'unrestricted',
    boardScope: actor.boardScope ?? 'all boards this principal can reach'
  }))

  server.registerTool('list_boards', {
    title: 'List boards',
    description: 'Every board this token can see, with its lanes and how many tickets are on it, plus the workspaces the boards are grouped into. Start here — every other tool needs a board or a ticket id.',
    inputSchema: {}
  }, async () => {
    const [{ boards }, { workspaces }] = await Promise.all([
      call<{ boards: BoardSummary[] }>(ops.boardList, {}),
      call<{ workspaces: WorkspaceSummary[] }>(ops.workspaceList, {})
    ])
    return reply({
      // Name and description up front rather than a bare workspaceId on each board: what a
      // workspace is for is exactly the context an agent lacks when it picks a board.
      workspaces: workspaces.map(workspace => ({ id: workspace.id, name: workspace.name, description: workspace.description })),
      boards: boards.map(board => ({
        id: board.id,
        workspaceId: board.workspaceId,
        name: board.name,
        description: board.description,
        yourRole: board.role,
        ticketCount: board.ticketCount,
        lanes: board.lanes.map(lane => ({ id: lane.id, name: lane.name, ticketCount: lane.ticketCount, isImport: lane.isImport }))
      }))
    })
  })

  server.registerTool('board_overview', {
    title: 'Board overview',
    description:
      'One call to orient on a board: its lanes with counts, who is on it, and its labels and '
      + 'categories. Use this before creating or moving anything, so lane and label names are the '
      + 'ones that actually exist.',
    inputSchema: { boardId: z.string().describe('From list_boards.') }
  }, async ({ boardId }) => {
    const [{ board }, { labels }, { categories }, { workspaces }] = await Promise.all([
      call<{ board: BoardSummary }>(ops.boardGet, { boardId }),
      call<{ labels: Array<{ name: string; ticketCount: number }> }>(ops.labelList, { boardId }),
      call<{ categories: Array<{ name: string; color: string; ticketCount: number }> }>(ops.categoryList, { boardId }),
      call<{ workspaces: WorkspaceSummary[] }>(ops.workspaceList, {})
    ])
    const home = workspaces.find(workspace => workspace.id === board.workspaceId)
    return reply({
      id: board.id,
      workspace: { id: board.workspaceId, name: home?.name ?? null, description: home?.description ?? null },
      name: board.name,
      description: board.description,
      yourRole: board.role,
      lanes: board.lanes.map(lane => ({ id: lane.id, name: lane.name, ticketCount: lane.ticketCount, isImport: lane.isImport })),
      members: board.members.map(member => ({ id: member.userId, name: `${member.firstName} ${member.lastName}`.trim(), role: member.role })),
      labels: labels.map(label => label.name),
      categories: categories.map(category => category.name)
    })
  })

  server.registerTool('search_tickets', {
    title: 'Search tickets',
    description:
      'Find tickets on a board. Text matches the title and description. Every filter is optional '
      + 'and they combine. Returns a short form of each ticket — call get_ticket for the whole one. '
      + 'Search before creating, so an existing report gets a comment instead of a duplicate.',
    inputSchema: {
      boardId: z.string(),
      text: z.string().optional().describe('Matched case-insensitively against title and description.'),
      laneId: z.string().optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      label: z.string().optional(),
      assigneeId: z.string().optional().describe('Use "unassigned" for tickets nobody holds.'),
      archived: z.boolean().optional().describe('Archived tickets are visible to board admins only.'),
      limit: z.number().int().min(1).max(100).optional().describe('Defaults to 25.')
    }
  }, async (input) => {
    const { tickets } = await call<{ tickets: Ticket[] }>(ops.ticketList, { boardId: input.boardId, archived: input.archived ?? false })
    const text = input.text?.toLowerCase()
    const matched = tickets.filter((ticket) => {
      if (text && !`${ticket.title} ${ticket.description}`.toLowerCase().includes(text)) return false
      if (input.laneId && ticket.laneId !== input.laneId) return false
      if (input.priority && ticket.priority !== input.priority) return false
      if (input.label && !ticket.labels.some(label => label.name.toLowerCase() === input.label!.toLowerCase())) return false
      if (input.assigneeId === 'unassigned' && ticket.assignee) return false
      if (input.assigneeId && input.assigneeId !== 'unassigned' && ticket.assignee?.id !== input.assigneeId) return false
      return true
    })
    const limit = input.limit ?? 25
    return reply({
      total: matched.length,
      returned: Math.min(limit, matched.length),
      tickets: matched.slice(0, limit).map(slim)
    })
  })

  server.registerTool('get_ticket', {
    title: 'Get a ticket',
    description:
      'One ticket in full, with its description, to-do list, attachments, comment thread and '
      + 'history. Takes either an id or the number the ticket is known by, so someone asking '
      + 'about "ticket 42" costs one call and no board. The only tool that returns everything, '
      + 'so prefer search_tickets when scanning.',
    inputSchema: {
      ticketId: z.string().optional().describe('From search_tickets. Give this or ticketNumber.'),
      ticketNumber: z.number().int().positive().optional()
        .describe('The number a ticket is referred to by — the `number` field of a search result. Unique across the instance, so it names a ticket on its own.')
    }
  }, async ({ ticketId, ticketNumber }) => {
    if (!ticketId && ticketNumber === undefined) {
      throw createError({ statusCode: 400, statusMessage: 'Give either ticketId or ticketNumber.' })
    }
    // Resolved first rather than alongside, because the comment thread and the history are
    // asked for by id and a number does not become one until the ticket has been read. Three
    // local reads instead of one round trip; the ordering costs nothing worth measuring.
    const { ticket } = ticketId
      ? await call<{ ticket: Ticket }>(ops.ticketGet, { ticketId })
      : await call<{ ticket: Ticket }>(ops.ticketGetByNumber, { ticketNumber })
    const [{ comments }, { activity }] = await Promise.all([
      call<{ comments: TicketComment[] }>(ops.commentList, { ticketId: ticket.id }),
      call<{ activity: TicketActivityEntry[] }>(ops.ticketActivity, { ticketId: ticket.id })
    ])
    return reply({
      ...slim(ticket),
      boardId: ticket.boardId,
      description: ticket.description,
      source: ticket.source,
      buildNumber: ticket.buildNumber,
      author: nameOf(ticket.author),
      createdAt: ticket.createdAt,
      archivedAt: ticket.archivedAt,
      todos: ticket.todos.map(todo => ({ text: todo.text, completed: todo.completed })),
      // The v1 path, not the `url` on the record: that one is the UI's own API and takes a
      // session cookie, so the token this tool holds could see an attachment listed and
      // fetch none of them. This one answers to the same bearer token.
      attachments: ticket.attachments.map(file => ({
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.size,
        url: `/api/v1/attachments/${file.id}`
      })),
      feedback: ticket.feedback,
      comments: comments.map(comment => ({ id: comment.id, author: nameOf(comment.author), body: comment.body, createdAt: comment.createdAt })),
      history: activity.map(entry => ({
        kind: entry.kind,
        by: nameOf(entry.actor),
        // The provenance the audit layer records, so a model can see what an agent did before.
        via: entry.agentId,
        at: entry.createdAt
      }))
    })
  })

  server.registerTool('create_ticket', {
    title: 'Create a ticket',
    description:
      'File a new ticket. Search first — a duplicate is worse than a comment on the existing one. '
      + 'Labels are created on demand; a lane must already exist, so take its id from board_overview. '
      + 'The ticket is attributed to the principal this token acts for.',
    inputSchema: {
      boardId: z.string(),
      title: z.string().max(160),
      description: z.string().max(10000).optional(),
      laneId: z.string().optional().describe('Defaults to the board’s first non-import lane.'),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      assigneeId: z.string().optional().describe('Must be a member of this board.'),
      dueDate: z.string().optional().describe('YYYY-MM-DD.'),
      labels: z.array(z.string()).max(12).optional(),
      categoryName: z.string().optional()
    }
  }, async (input) => {
    const { ticket } = await call<{ ticket: Ticket }>(ops.ticketCreate, input)
    return reply(slim(ticket))
  })

  server.registerTool('update_ticket', {
    title: 'Update a ticket',
    description: 'Change fields on an existing ticket. Only the fields given are touched; everything omitted is left alone.',
    inputSchema: {
      ticketId: z.string(),
      title: z.string().max(160).optional(),
      description: z.string().max(10000).optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      assigneeId: z.string().nullable().optional(),
      dueDate: z.string().nullable().optional(),
      labels: z.array(z.string()).max(12).optional(),
      categoryName: z.string().nullable().optional()
    }
  }, async (input) => {
    const { ticket } = await call<{ ticket: Ticket }>(ops.ticketUpdate, input)
    return reply(slim(ticket))
  })

  server.registerTool('move_ticket', {
    title: 'Move a ticket',
    description: 'Move a ticket to a lane, and optionally to a position within it. Lane ids come from board_overview.',
    inputSchema: {
      ticketId: z.string(),
      laneId: z.string(),
      index: z.number().int().min(0).optional().describe('Position in the lane; 0 is the top. Defaults to the top.')
    }
  }, async ({ ticketId, laneId, index }) => {
    const { ticket } = await call<{ ticket: Ticket }>(ops.ticketMove, { ticketId, laneId, index: index ?? 0 })
    return reply(slim(ticket))
  })

  server.registerTool('comment_on_ticket', {
    title: 'Comment on a ticket',
    description: 'Add a comment to a ticket’s thread. Prefer this to editing the description when adding a finding, so the ticket keeps its history.',
    inputSchema: { ticketId: z.string(), body: z.string().min(1).max(10000) }
  }, async ({ ticketId, body }) => {
    const { comment } = await call<{ comment: TicketComment }>(ops.commentAdd, { ticketId, body })
    return reply({ id: comment.id, createdAt: comment.createdAt })
  })

  server.registerTool('archive_ticket', {
    title: 'Archive a ticket',
    description: 'Take a ticket off the board. Nothing is deleted — a board admin can restore it — but it stops being visible to everyone else.',
    inputSchema: { ticketId: z.string() }
  }, async ({ ticketId }) => {
    const { ticket } = await call<{ ticket: Ticket }>(ops.ticketArchive, { ticketId })
    return reply({ id: ticket.id, archivedAt: ticket.archivedAt })
  })

  server.registerTool('list_lanes', {
    title: 'List lanes',
    description: 'The lanes of a board with their ids and ticket counts. board_overview returns these too; this is the cheaper call when that is all you need.',
    inputSchema: { boardId: z.string() }
  }, async ({ boardId }) => {
    const { lanes } = await call<{ lanes: LaneSummary[] }>(ops.laneList, { boardId })
    return reply(lanes.map(lane => ({ id: lane.id, name: lane.name, ticketCount: lane.ticketCount, isImport: lane.isImport })))
  })
}
