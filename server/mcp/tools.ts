import { createError } from 'h3'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { run, type AnyOperation } from '~~/server/operations'
import * as ops from '~~/server/operations'
import type { Actor } from '~~/server/utils/actor'
import { resolveAttachmentFile } from '~~/server/utils/attachment-file'
import { DEFAULT_PREVIEW_DIMENSION, imagePreview } from '~~/server/utils/image-preview'
import { isServiceIdentity, parentTicketIdsOf, principalDescription } from '~~/server/utils/db'
import { todoLight } from '~~/shared/utils/todo-progress'
import { boardToday } from '~~/shared/utils/due-date'
import { timelineBounds, timelineWarnings } from '~~/shared/utils/timeline'
import { describeRecurrence } from '~~/shared/utils/recurrence'
import type { BoardSummary, DependencyRef, LaneSummary, ShiftResult, TimelineNode, Ticket, TicketTodo, TicketActivityEntry, TicketComment, TicketTypeSummary, WorkspaceSummary } from '~~/shared/types/domain'

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

const SCHEDULE_FIELD = 'How the ticket sits in time. "milestone": an event on one day — a meeting, a go-live — given as dueDate, with no start and no live window. "lifecycle": work from startDate to dueDate, then optionally a live window; a dueDate alone is a plain deadline. "recurring": the same card comes round again, like a calendar series — give its rule as recurrence; dueDate is then the round that is on now. "none": no dates. Sending dates without it to an undated ticket makes it a lifecycle.'

const RECURRENCE_INPUT = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(99).optional().describe('Every so many of frequency; defaults to 1. 2 weekly is every other week, 3 monthly is quarterly.'),
  anchor: z.string().describe('YYYY-MM-DD: the day of the first round. Weekly rounds keep its weekday, monthly ones its day of the month.'),
  until: z.string().nullable().optional().describe('YYYY-MM-DD: the last day a round may fall on; omit for a series without end.'),
  resetTodos: z.boolean().optional().describe('Untick the plain to-dos and reopen the decisions at each new round. Defaults to true.'),
  returnLaneId: z.string().nullable().optional().describe('A lane of this board the card goes back to at each new round, e.g. "Weekly", so it can sit in a done lane until then. Omit to leave it where it is.')
}).describe('The rule of a recurring ticket, whole; it makes the ticket recurring. dueDate becomes the first round from today on unless given. On the day the next round is due the server closes the current one — done if the card is in a done or live lane or every to-do is ticked, otherwise missed (a warning) — and starts the next.')

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
    type: ticket.type?.name ?? null,
    schedule: ticket.schedule,
    startDate: ticket.startDate,
    dueDate: ticket.dueDate,
    liveFrom: ticket.liveFrom,
    liveUntil: ticket.liveUntil,
    // Only for a recurring ticket: how it repeats, when the next round is, how the last one went.
    ...(ticket.recurrence ? { repeats: describeRecurrence(ticket.recurrence), nextRound: ticket.nextRound, lastRound: ticket.rounds[0] ? { date: ticket.rounds[0].date, outcome: ticket.rounds[0].outcome } : null } : {}),
    commentCount: ticket.commentCount,
    progress: progressOf(ticket.todos),
    // Numbers only here; get_ticket spells them out.
    waitsOn: ticket.waitsOn.map(item => item.ticketNumber)
  }
}

/** A dependency as an agent reads it: which ticket, where it stands, and its dates. */
function dependencyOf(item: DependencyRef) {
  return { id: item.id, number: item.ticketNumber, title: item.title, board: item.boardName, lane: item.laneName, done: item.done, startDate: item.startDate, dueDate: item.dueDate, ...(item.strictOrderOf !== null ? { strictOrderOf: item.strictOrderOf } : {}) }
}

/**
 * A timeline as an agent reads it: the tree with each ticket's place and dates, nothing more.
 * `readable` shows up only where it is false, the rare case worth pointing out.
 */
function timelineOf(node: TimelineNode): Record<string, unknown> {
  return {
    id: node.id,
    number: node.ticketNumber,
    title: node.title,
    type: node.type?.name ?? null,
    board: node.boardName,
    lane: node.laneName,
    done: node.done,
    schedule: node.schedule,
    startDate: node.startDate,
    dueDate: node.dueDate,
    ...(node.liveFrom || node.liveUntil ? { live: node.live, liveFrom: node.liveFrom, liveUntil: node.liveUntil } : {}),
    ...(node.recurrence ? { repeats: describeRecurrence(node.recurrence), rounds: node.rounds.slice(0, 6) } : {}),
    ...(node.waitsOn.length ? { waitsOn: node.waitsOn.map(item => item.ticketNumber) } : {}),
    ...(node.readable ? {} : { readable: false }),
    ...(node.children.length ? { subtickets: node.children.map(timelineOf) } : {})
  }
}

/**
 * How far a ticket's to-do list has come, subtickets included, without the list itself:
 * enough to scan a board for what is blocked. `light` is the traffic light the UI shows —
 * green when all is done, orange from half, red below. Null for a ticket without to-dos.
 */
/**
 * A decision as an agent asks it: the question is the to-do's text. Whether and how it is
 * decided is left to people; the server keeps an earlier result over a rewrite of the list.
 */
const STRICT_ORDER_FIELD = 'Work the to-dos top to bottom: a to-do or decision can only be completed once everything above it is done (an update ticking one too early is refused), '
  + 'and each subticket waits on the subticket before it — shown in waitsOn with strictOrderOf, counted by the timeline and by shift. False: any order.'

const DECISION_INPUT = z.object({
  options: z.array(z.string().min(1).max(200)).min(1).max(20).describe('The answers to pick from, in order.'),
  multiple: z.boolean().default(false).describe('Several answers may be picked; otherwise one.'),
  allowOther: z.boolean().default(false).describe('Offer a field for an answer of one\'s own.')
}).optional().describe('Makes the to-do a decision — a question with answers for people to pick, e.g. which logo to use. Its text is the question.')
  .transform(value => value && { ...value, chosen: [] as number[], other: null })

/** Whether a decision is decided is the server's to carry over, never the agent's to say. */
function openDecision<T extends { completed: boolean; decision?: unknown }>(todo: T): T {
  return todo.decision ? { ...todo, completed: false } : todo
}

function decisionAnswerOf(decision: NonNullable<TicketTodo['decision']>) {
  return [...decision.chosen.map(index => decision.options[index]).filter(Boolean), ...(decision.other ? [decision.other] : [])]
}

function progressOf(todos: TicketTodo[]) {
  const light = todoLight(todos)
  if (!light) return null
  const subtickets = todos.filter(todo => todo.subticket)
  return {
    done: todos.filter(todo => todo.completed).length,
    total: todos.length,
    light,
    openSubtickets: subtickets.filter(todo => !todo.completed).length,
    subtickets: subtickets.length
  }
}

/** A lane as every tool shows it; `isDone` or `isLive` is what ticks a subticket off once it lands there. */
function laneOf(lane: LaneSummary) {
  return { id: lane.id, name: lane.name, ticketCount: lane.ticketCount, isImport: lane.isImport, isDone: lane.isDone, isLive: lane.isLive }
}

function nameOf(person: { firstName: string; lastName: string } | null): string | null {
  if (!person) return null
  return `${person.firstName} ${person.lastName}`.trim() || null
}

/** An activity payload with its person-valued ids swapped for names a model can repeat. */
function activityDetail(entry: TicketActivityEntry): Record<string, string | null> {
  const detail: Record<string, string | null> = { ...entry.payload }
  for (const [key, person] of Object.entries(entry.payloadPeople)) detail[key] = nameOf(person)
  return detail
}

/** Every tool answers with JSON text, which is what a model reads best. */
function reply(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
}

/**
 * A cautious client gates on these hints, and the spec's default is "assume the worst" — a
 * tool without them counts as write-capable and destructive, so a read like whats_new would
 * sit behind the same approval as a delete. Declared on every tool for that reason.
 */
const readsOnly = { readOnlyHint: true, openWorldHint: false }
const LINK_INPUT = z.object({
  url: z.string().describe('http(s) only.'),
  display: z.enum(['preview', 'text']).optional().describe('"text" (the default) shows only the address; "preview" a card with a rendered thumbnail of the page.')
})

const MARKDOWN_FIELD = 'Markdown. Headings, lists, links and fenced code blocks render; raw HTML is shown as text, not interpreted.'

export interface ToolOptions {
  /** This instance as the caller reached it, for the addresses a tool hands back. */
  origin?: string
}

export function registerTools(server: McpServer, actor: Actor, options: ToolOptions = {}) {
  // `AnyOperation` for the same reason the registry uses it: `ZodType` is invariant, so a
  // parameter typed `Operation<unknown>` rejects every concrete operation.
  const call = <T>(operation: AnyOperation, input: unknown) => run(operation, actor, input) as Promise<T>

  /**
   * The parents of a subticket this token may read. Each goes through the same read as
   * get_ticket, so a parent on a board out of reach is simply not there — not even its number.
   */
  const readableParents = async (ticketId: string) => {
    const parents = await Promise.all(parentTicketIdsOf(ticketId).map(id =>
      call<{ ticket: Ticket }>(ops.ticketGet, { ticketId: id }).then(result => result.ticket, () => null)))
    return parents
      .filter((parent): parent is Ticket => Boolean(parent))
      .map(parent => ({ id: parent.id, number: parent.ticketNumber, title: parent.title, boardId: parent.boardId, laneId: parent.laneId, progress: progressOf(parent.todos) }))
  }

  server.registerTool('whoami', {
    title: 'Who am I',
    description:
      'The principal this token acts for, the agent label it carries, and what its scopes permit. '
      + 'kind says whether that principal is a person you act for or an agent with an identity of '
      + 'its own — in which case it is you, and the tickets assigned to principalId are your work. '
      + 'Worth calling first when a write is unexpectedly refused: a token is a ceiling on what its '
      + 'principal can do, so being denied usually means the scopes are narrower than the person.',
    annotations: readsOnly,
    inputSchema: {}
  }, async () => {
    const isAgent = isServiceIdentity(actor.principal)
    return reply({
      principalId: actor.principalId,
      name: nameOf(actor.principal),
      kind: isAgent ? 'agent' : 'person',
      ...(isAgent
        ? {
            description: principalDescription(actor.principalId) || null,
            note: 'You are a user of your own. Tickets assigned to you and comments you write carry your name. '
              + 'Find your work with search_tickets and assigneeId set to principalId; assign a ticket to yourself '
              + 'with update_ticket and the same id.'
          }
        : {}),
      agent: actor.agentId,
      channel: actor.channel,
      scopes: actor.scopes ?? 'unrestricted',
      boardScope: actor.boardScope ?? 'all boards this principal can reach'
    })
  })

  server.registerTool('list_boards', {
    title: 'List boards',
    description: 'Every board this token can see, with its lanes and how many tickets are on it, plus the workspaces the boards are grouped into. Start here — every other tool needs a board or a ticket id.',
    annotations: readsOnly,
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
        lanes: board.lanes.map(laneOf)
      }))
    })
  })

  server.registerTool('board_overview', {
    title: 'Board overview',
    description:
      'One call to orient on a board: its lanes with counts, who is on it, its labels and '
      + 'categories, and the ticket types of its workspace. Use this before creating or moving '
      + 'anything, so lane and label names and type ids are the ones that actually exist.',
    annotations: readsOnly,
    inputSchema: { boardId: z.string().describe('From list_boards.') }
  }, async ({ boardId }) => {
    const [{ board }, { labels }, { categories }, { types }, { workspaces }] = await Promise.all([
      call<{ board: BoardSummary }>(ops.boardGet, { boardId }),
      call<{ labels: Array<{ name: string; ticketCount: number }> }>(ops.labelList, { boardId }),
      call<{ categories: Array<{ name: string; color: string; ticketCount: number }> }>(ops.categoryList, { boardId }),
      call<{ types: TicketTypeSummary[] }>(ops.ticketTypeList, { boardId }),
      call<{ workspaces: WorkspaceSummary[] }>(ops.workspaceList, {})
    ])
    const home = workspaces.find(workspace => workspace.id === board.workspaceId)
    return reply({
      id: board.id,
      workspace: { id: board.workspaceId, name: home?.name ?? null, description: home?.description ?? null },
      name: board.name,
      description: board.description,
      yourRole: board.role,
      lanes: board.lanes.map(laneOf),
      members: board.members.map(member => ({ id: member.userId, name: `${member.firstName} ${member.lastName}`.trim(), role: member.role, ...(member.isService ? { isAgent: true } : {}) })),
      labels: labels.map(label => label.name),
      categories: categories.map(category => category.name),
      ticketTypes: types.map(type => ({ id: type.id, name: type.name }))
    })
  })

  server.registerTool('search_tickets', {
    title: 'Search tickets',
    description:
      'Find tickets on one board — or across every board this token can reach when boardId is '
      + 'omitted. Text matches the title and description. Every filter is optional and they '
      + 'combine. Returns a short form of each ticket — call get_ticket for the whole one. '
      + 'Each carries `progress` (to-dos and subtickets done of total, and a green/orange/red light) or null without to-dos. '
      + 'Search before creating, so an existing report gets a comment instead of a duplicate.',
    annotations: readsOnly,
    inputSchema: {
      boardId: z.string().optional().describe('Omit to search every board this token can reach.'),
      text: z.string().optional().describe('Matched case-insensitively against title and description.'),
      laneId: z.string().optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      label: z.string().optional(),
      assigneeId: z.string().optional().describe('Use "unassigned" for tickets nobody holds.'),
      typeId: z.string().optional().describe('A ticket type id from board_overview.ticketTypes, or "untyped" for tickets without one.'),
      archived: z.boolean().optional().describe('Archived tickets are visible to board admins only, and only with a boardId.'),
      limit: z.number().int().min(1).max(100).optional().describe('Defaults to 25.')
    }
  }, async (input) => {
    // The archive stays board-scoped: it is an administrator's view of one board, not a
    // haystack to sweep across the instance.
    if (!input.boardId && input.archived) {
      throw createError({ statusCode: 400, statusMessage: 'Searching the archive needs a boardId.' })
    }
    const boardIds = input.boardId
      ? [input.boardId]
      : (await call<{ boards: BoardSummary[] }>(ops.boardList, {})).boards.map(board => board.id)
    const perBoard = await Promise.all(boardIds.map(boardId =>
      call<{ tickets: Ticket[] }>(ops.ticketList, { boardId, archived: input.archived ?? false }).then(result => result.tickets)
    ))
    const text = input.text?.toLowerCase()
    const matched = perBoard.flat().filter((ticket) => {
      if (text && !`${ticket.title} ${ticket.description}`.toLowerCase().includes(text)) return false
      if (input.laneId && ticket.laneId !== input.laneId) return false
      if (input.priority && ticket.priority !== input.priority) return false
      if (input.label && !ticket.labels.some(label => label.name.toLowerCase() === input.label!.toLowerCase())) return false
      if (input.assigneeId === 'unassigned' && ticket.assignee) return false
      if (input.assigneeId && input.assigneeId !== 'unassigned' && ticket.assignee?.id !== input.assigneeId) return false
      if (input.typeId === 'untyped' && ticket.type) return false
      if (input.typeId && input.typeId !== 'untyped' && ticket.type?.id !== input.typeId) return false
      return true
    })
    const limit = input.limit ?? 25
    return reply({
      total: matched.length,
      returned: Math.min(limit, matched.length),
      tickets: matched.slice(0, limit).map(ticket => ({ ...slim(ticket), boardId: ticket.boardId }))
    })
  })

  server.registerTool('get_ticket', {
    title: 'Get a ticket',
    description:
      'One ticket in full, with its description, to-do list, attachments, comment thread and '
      + 'history. Takes either an id or the number the ticket is known by, so someone asking '
      + 'about "ticket 42" costs one call and no board. The only tool that returns everything, '
      + 'so prefer search_tickets when scanning. '
      + 'A to-do with a subticketId is a subticket: a ticket of its own, maybe on another board of '
      + 'the workspace, whose `completed` follows its lane — it is done once it sits in a lane with '
      + 'isDone. A to-do with a `decision` is a question to settle: `text` is the question, `decision.options` '
      + 'the answers, `completed` whether it is decided, and then `decision.answer` what was decided, by whom and when. '
      + 'Decisions are made by people in Bugster; you can ask one and read it, not answer it. '
      + '`parents` lists the tickets that hold this one as a subticket; `progress` sums up the list. '
      + 'A recurring ticket carries `repeats`, `nextRound`, its `recurrence` rule and its last `rounds`, each done, missed or skipped with the to-dos it left open. '
      + 'With timeline: true it adds `timeline`, the plan below the ticket: every subticket down through '
      + 'theirs, with board, lane, start and due date, plus `warnings` for open tickets past their due '
      + 'date and subtickets that start before or end after this ticket\'s own window. Use it when the question '
      + 'is how a campaign or any other bundle of work stands, rather than reading each subticket. '
      + '`waitsOn` lists the tickets this one waits on (finish-to-start: it starts once they end) and '
      + '`waitedOnBy` the ones waiting on it; the warnings include tickets that start before what they '
      + 'wait on ends, and ones waiting on something late.',
    annotations: readsOnly,
    inputSchema: {
      ticketId: z.string().optional().describe('From search_tickets. Give this or ticketNumber.'),
      ticketNumber: z.number().int().positive().optional()
        .describe('The number a ticket is referred to by — the `number` field of a search result. Unique across the instance, so it names a ticket on its own.'),
      timeline: z.boolean().optional()
        .describe('Also return the whole subticket tree with dates and the warnings on it. A subticket on a board this token cannot read appears with readable: false and without its own subtickets.')
    }
  }, async ({ ticketId, ticketNumber, timeline: withTimeline }) => {
    if (!ticketId && ticketNumber === undefined) {
      throw createError({ statusCode: 400, statusMessage: 'Give either ticketId or ticketNumber.' })
    }
    // Resolved first rather than alongside, because the comment thread and the history are
    // asked for by id and a number does not become one until the ticket has been read. Three
    // local reads instead of one round trip; the ordering costs nothing worth measuring.
    const { ticket } = ticketId
      ? await call<{ ticket: Ticket }>(ops.ticketGet, { ticketId })
      : await call<{ ticket: Ticket }>(ops.ticketGetByNumber, { ticketNumber })
    const [{ comments }, { activity }, parents, { dependents }] = await Promise.all([
      call<{ comments: TicketComment[] }>(ops.commentList, { ticketId: ticket.id }),
      call<{ activity: TicketActivityEntry[] }>(ops.ticketActivity, { ticketId: ticket.id }),
      readableParents(ticket.id),
      call<{ dependents: DependencyRef[] }>(ops.ticketDependentsList, { ticketId: ticket.id })
    ])
    const plan = withTimeline ? (await call<{ timeline: TimelineNode }>(ops.ticketTimelineGet, { ticketId: ticket.id })).timeline : null
    return reply({
      ...slim(ticket),
      boardId: ticket.boardId,
      description: ticket.description,
      source: ticket.source,
      buildNumber: ticket.buildNumber,
      // What the page said about itself, when somebody has opened the ticket and it was read.
      links: ticket.links.map(link => ({ id: link.id, url: link.url, display: link.display, title: link.preview.title, description: link.preview.description, hasPreviewImage: Boolean(link.preview.imageUrl) })),
      // What the card shows, attachments and link previews alike; null while nobody picked.
      cardImageIds: ticket.cardImageIds,
      author: nameOf(ticket.author),
      createdAt: ticket.createdAt,
      archivedAt: ticket.archivedAt,
      // A subticket is a ticket of its own; it counts as done once it reaches a done lane.
      todos: ticket.todos.map(todo => todo.subticket
        ? {
            text: todo.text,
            completed: todo.completed,
            subticketId: todo.subticket.id,
            subticket: {
              number: todo.subticket.ticketNumber,
              boardId: todo.subticket.boardId,
              board: todo.subticket.boardName,
              laneId: todo.subticket.laneId,
              lane: todo.subticket.laneName,
              archived: todo.subticket.archived
            }
          }
        : todo.decision
          ? {
              text: todo.text,
              completed: todo.completed,
              decision: {
                multiple: todo.decision.multiple,
                options: todo.decision.options,
                allowOther: todo.decision.allowOther,
                ...(todo.completed ? { answer: decisionAnswerOf(todo.decision), decidedBy: nameOf(todo.decision.decidedBy), decidedAt: todo.decision.decidedAt } : {})
              }
            }
          : { text: todo.text, completed: todo.completed }),
      strictOrder: ticket.strictOrder,
      progress: progressOf(ticket.todos),
      ...(ticket.recurrence
        ? {
            recurrence: ticket.recurrence,
            rounds: ticket.rounds.map(round => ({ date: round.date, outcome: round.outcome, todos: `${round.todosDone}/${round.todosTotal}`, ...(round.openTodos.length ? { openTodos: round.openTodos } : {}), closedBy: nameOf(round.closedBy) }))
          }
        : {}),
      // The other way round: the tickets whose to-do lists hold this one, as far as this token
      // can read them. Moving this ticket into a done lane ticks it off on each of them.
      parents,
      // Finish-to-start, both ways: what this one waits on, and what waits on it.
      waitsOn: ticket.waitsOn.map(dependencyOf),
      waitedOnBy: dependents.map(dependencyOf),
      // The v1 path, not the `url` on the record: that one is the UI's own API and takes a
      // session cookie, so the token this tool holds could see an attachment listed and
      // fetch none of them. This one answers to the same bearer token.
      attachments: ticket.attachments.map(file => ({
        // What get_attachment takes, so an image can be looked at without parsing the url.
        id: file.id,
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
      })),
      ...(plan ? { timeline: { covers: timelineBounds(plan), warnings: timelineWarnings(plan, boardToday()).map(warning => warning.message), subtickets: plan.children.map(timelineOf) } } : {})
    })
  })

  server.registerTool('get_attachment', {
    title: 'View an attachment',
    description:
      'Look at a ticket attachment — above all the screenshots TestFlight feedback arrives with, '
      + 'which the url in get_ticket cannot show you. An image comes back as an image you can see, '
      + 'scaled down to maxDimension and re-encoded as JPEG. Any other file (PDF, log, Office '
      + 'document) returns only its filename, type and size. Takes the id from get_ticket attachments.',
    annotations: readsOnly,
    inputSchema: {
      attachmentId: z.string().describe('The `id` of an entry in get_ticket\'s `attachments`.'),
      maxDimension: z.number().int().min(200).max(4000).optional()
        .describe(`Longest side of the returned image in pixels. Defaults to ${DEFAULT_PREVIEW_DIMENSION}; a smaller image costs less context.`)
    }
  }, async ({ attachmentId, maxDimension }) => {
    type AttachmentRow = { id: string; filename: string; mime_type: string; size: number; relative_path: string }
    let attachment: AttachmentRow
    try {
      ({ attachment } = await call<{ attachment: AttachmentRow }>(ops.attachmentGet, { attachmentId }))
    } catch (error) {
      // A file on a board this token cannot see answers exactly like one that does not exist:
      // "Board not found" would confirm the id is real.
      if ((error as { statusCode?: number }).statusCode === 404) throw createError({ statusCode: 404, statusMessage: 'Attachment not found.' })
      throw error
    }
    const details = { id: attachment.id, filename: attachment.filename, mimeType: attachment.mime_type, size: attachment.size }
    if (!attachment.mime_type.startsWith('image/')) return reply({ ...details, note: 'Not an image, so only its details are returned.' })
    const preview = await imagePreview(await resolveAttachmentFile(attachment.relative_path), maxDimension)
    if (!preview) return reply({ ...details, note: 'This image format cannot be converted for viewing, so only its details are returned.' })
    return {
      content: [
        { type: 'image' as const, data: preview.toString('base64'), mimeType: 'image/jpeg' },
        { type: 'text' as const, text: JSON.stringify(details, null, 2) }
      ]
    }
  })

  server.registerTool('create_ticket', {
    title: 'Create a ticket',
    description:
      'File a new ticket. Search first — a duplicate is worse than a comment on the existing one. '
      + 'Labels are created on demand; a lane must already exist, so take its id from board_overview. '
      + 'The ticket is attributed to the principal this token acts for. The description is Markdown.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      boardId: z.string(),
      title: z.string().max(160),
      description: z.string().max(10000).optional().describe(MARKDOWN_FIELD),
      laneId: z.string().optional().describe('Defaults to the board’s first non-import lane.'),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      assigneeId: z.string().optional().describe('Must be a member of this board.'),
      schedule: z.enum(['none', 'milestone', 'lifecycle', 'recurring']).optional().describe(SCHEDULE_FIELD),
      recurrence: RECURRENCE_INPUT.optional(),
      startDate: z.string().optional().describe('YYYY-MM-DD: the day work starts. With dueDate it spans the ticket on a timeline; never after dueDate. Not for a milestone.'),
      dueDate: z.string().optional().describe('YYYY-MM-DD: the day the work has to be done — for a campaign its go-live, not the end of its run.'),
      liveFrom: z.string().optional().describe('YYYY-MM-DD: the first day it is out in the world, e.g. a campaign\'s start in market.'),
      liveUntil: z.string().optional().describe('YYYY-MM-DD: the last day it is out, e.g. the end of a campaign or an approval\'s expiry. Warns while the ticket sits in a lane with isLive.'),
      links: z.array(LINK_INPUT).max(50).optional().describe('Web addresses the ticket refers to, in order.'),
      labels: z.array(z.string()).max(12).optional(),
      categoryName: z.string().optional(),
      typeId: z.string().optional().describe('A ticket type id from board_overview.ticketTypes. Omit for an untyped ticket.'),
      todos: z.array(z.object({ text: z.string().min(1).max(500), completed: z.boolean().default(false), decision: DECISION_INPUT }).transform(openDecision)).max(100).optional()
        .describe('The ticket’s initial to-do list, in order. An item with decision is a question for people to decide.'),
      strictOrder: z.boolean().optional().describe(STRICT_ORDER_FIELD),
      placement: z.enum(['top', 'bottom']).optional()
        .describe('Where the ticket lands in its lane. Defaults to the bottom; "top" pushes the lane’s other tickets down one.'),
      parentTicketId: z.string().optional()
        .describe('File the ticket as a subticket of this one: it is added to the end of the parent’s to-do list and ticks itself there once it reaches a done lane of its own board. boardId may then be the parent’s board or another board of the same workspace.')
    }
  }, async ({ parentTicketId, ...input }) => {
    if (!parentTicketId) {
      const { ticket } = await call<{ ticket: Ticket }>(ops.ticketCreate, input)
      return reply(slim(ticket))
    }
    const { boardId, laneId, title, description, placement: _placement, ...fields } = input
    const created = await call<{ ticket: Ticket; subticket: Ticket }>(ops.ticketSubticketCreate, { ticketId: parentTicketId, boardId, laneId, title, description })
    // Everything beyond what a subticket is filed with is set on it right after, in one write.
    const rest = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
    const subticket = Object.keys(rest).length
      ? (await call<{ ticket: Ticket }>(ops.ticketUpdate, { ticketId: created.subticket.id, ...rest })).ticket
      : created.subticket
    return reply({ ...slim(subticket), parentTicketId })
  })

  server.registerTool('update_ticket', {
    title: 'Update a ticket',
    description: 'Change fields on an existing ticket. Only the fields given are touched; everything omitted is left alone. The description is Markdown.',
    // Destructive in the hint's sense: what a field held before is overwritten, not appended to.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      ticketId: z.string(),
      title: z.string().max(160).optional(),
      description: z.string().max(10000).optional().describe(MARKDOWN_FIELD),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      assigneeId: z.string().nullable().optional(),
      schedule: z.enum(['none', 'milestone', 'lifecycle', 'recurring']).optional().describe(`${SCHEDULE_FIELD} Switching clears what the new one has no room for: none every date, milestone and recurring the start and the live window (the due date stays as its day), and every schedule but recurring the rule.`),
      recurrence: RECURRENCE_INPUT.nullable().optional().describe('Replaces the rule of a recurring ticket, whole; null stops the series and leaves the current round as a milestone. A rule that moves the rounds to other days puts dueDate on the first of them from today on; dueDate given alone moves only the current round.'),
      closeRound: z.enum(['done', 'skipped']).optional()
        .describe('For a recurring ticket: end the round that is on now — done, or skipped on purpose — and start the next one right away (to-dos reset, back to the return lane, dueDate the next round after today). Applied after the other fields. Leave it to the calendar when the work is simply finished on time: moving the card to a done lane is enough.'),
      reopenRound: z.literal(true).optional()
        .describe('For a recurring ticket: undo the last closed round, whether a person or the calendar closed it — dueDate, to-dos, decisions and lane go back to how they stood. Only the last round, and only until the next one is due. Not with other fields.'),
      startDate: z.string().nullable().optional().describe('YYYY-MM-DD; null removes it. Never after dueDate; not for a milestone.'),
      dueDate: z.string().nullable().optional().describe('YYYY-MM-DD; null removes it. The deadline of the work, not the end of a run.'),
      liveFrom: z.string().nullable().optional().describe('YYYY-MM-DD; null removes it. First day out in the world.'),
      liveUntil: z.string().nullable().optional().describe('YYYY-MM-DD; null removes it. Last day out; never before liveFrom.'),
      links: z.array(LINK_INPUT).max(50).optional()
        .describe('Replaces the whole link list — read the ticket first and send every link back, kept and new alike. Omit the field to leave the list alone.'),
      cardImageIds: z.array(z.string()).max(100).nullable().optional()
        .describe('The pictures the card shows: ids of image attachments and of links shown as a preview with hasPreviewImage (from get_ticket). Replaces the whole pick; [] shows none, null goes back to the default — the oldest image attachment, else the first link preview.'),
      coverAttachmentId: z.string().nullable().optional().describe('Older form of cardImageIds for a single image attachment; prefer cardImageIds.'),
      labels: z.array(z.string()).max(12).optional(),
      categoryName: z.string().nullable().optional(),
      typeId: z.string().nullable().optional().describe('A ticket type id from board_overview.ticketTypes; null removes the type.'),
      todos: z.array(z.object({
        text: z.string().min(1).max(500),
        completed: z.boolean().default(false),
        subticketId: z.string().optional().describe('Send back the subticketId get_ticket showed to keep that subticket in the list. The id of another open ticket of the workspace (from search_tickets) links it as a new subticket. Its text and completion follow the subticket itself.'),
        decision: DECISION_INPUT
      }).transform(openDecision)).max(100).optional()
        .describe('Replaces the whole to-do list — read the ticket first and send every item back, changed and unchanged alike, subtickets with their subticketId, decisions with their decision (question as text, same options) so they keep their result. A subticket left out is unlinked; the ticket itself stays. To file a brand-new subticket use create_ticket with parentTicketId. Omit the field to leave the list alone.'),
      strictOrder: z.boolean().optional().describe(STRICT_ORDER_FIELD),
      waitsOn: z.array(z.string()).max(50).optional()
        .describe('Ids of the tickets this one waits on, finish-to-start: it starts once they end. Replaces the whole list — send back the ids get_ticket showed under waitsOn to keep them; [] removes all. Same workspace only, and never a loop.'),
      shift: z.object({
        days: z.number().int().describe('Whole days; negative moves earlier.'),
        dryRun: z.boolean().default(false).describe('Only report what would move. Do this first and show the person.')
      }).optional()
        .describe('Moves this ticket\'s start and due date by days, and with them every ticket waiting on it, directly or through others. Finished work and tickets you may not edit stay put and stop the push; live windows never move. Applied after the other fields; a dry run has to come on its own.')
    }
  }, async ({ shift, closeRound, reopenRound, ...input }) => {
    const fields = Object.keys(input).filter(key => key !== 'ticketId' && input[key as keyof typeof input] !== undefined)
    if (reopenRound) {
      if (fields.length || shift || closeRound) throw new Error('Reopen the round on its own, without other changes.')
      const reopened = await call<{ ticket: Ticket; round: { date: string; outcome: string } }>(ops.ticketRoundReopen, { ticketId: input.ticketId })
      return reply({ ...slim(reopened.ticket), reopenedRound: reopened.round })
    }
    if (shift?.dryRun && fields.length) throw new Error('Send a dry run on its own, without other changes.')
    if (shift && closeRound) throw new Error('Shift the dates or close the round, not both at once.')
    const updated = fields.length || (!shift && !closeRound) ? (await call<{ ticket: Ticket }>(ops.ticketUpdate, input)).ticket : null
    if (closeRound) {
      const closed = await call<{ ticket: Ticket; round: { date: string; outcome: string; next: string | null } }>(ops.ticketRoundClose, { ticketId: input.ticketId, outcome: closeRound })
      return reply({ ...slim(closed.ticket), closedRound: closed.round })
    }
    if (!shift) return reply(slim(updated!))
    const result = await call<ShiftResult>(ops.ticketShift, { ticketId: input.ticketId, days: shift.days, dryRun: shift.dryRun })
    return reply({
      applied: result.applied,
      days: result.days,
      moves: result.moves.map(move => ({ number: move.ticketNumber, title: move.title, board: move.boardName, startDate: move.startDate, dueDate: move.dueDate })),
      skipped: result.skipped.map(item => ({ number: item.ticketNumber, title: item.title, reason: item.reason }))
    })
  })

  server.registerTool('move_ticket', {
    title: 'Move a ticket',
    description: 'Move a ticket to a lane, and optionally to a position within it. A lane with isDone finishes the ticket: as a subticket it is then ticked off on every parent. A lane with isLive does the same for a ticket that is finished and now running — a campaign in market — whose live window then warns instead of its due date. With a boardId the ticket moves onto that other board of the same workspace instead, into laneId there (its default lane when omitted); labels and category come along by name, an assignee who is no member over there is dropped. Ids come from list_boards and board_overview.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      ticketId: z.string(),
      laneId: z.string().optional().describe('The destination lane. Required unless boardId is given.'),
      boardId: z.string().optional().describe('Another board of the workspace to move the ticket onto.'),
      index: z.number().int().min(0).optional().describe('Position in the lane; 0 is the top. Defaults to the top. Ignored with boardId, where the ticket lands at the bottom.')
    }
  }, async ({ ticketId, laneId, boardId, index }) => {
    if (boardId) {
      const { ticket, assigneeCleared } = await call<{ ticket: Ticket; assigneeCleared: boolean }>(ops.ticketTransfer, { ticketId, boardId, laneId })
      return reply({ ...slim(ticket), assigneeCleared })
    }
    if (!laneId) throw new Error('Either laneId or boardId is needed.')
    const { ticket } = await call<{ ticket: Ticket }>(ops.ticketMove, { ticketId, laneId, index: index ?? 0 })
    return reply(slim(ticket))
  })

  server.registerTool('comment_on_ticket', {
    title: 'Comment on a ticket',
    description: 'Add a comment to a ticket’s thread. Prefer this to editing the description when adding a finding, so the ticket keeps its history. The body is Markdown.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { ticketId: z.string(), body: z.string().min(1).max(10000).describe(MARKDOWN_FIELD) }
  }, async ({ ticketId, body }) => {
    const { comment } = await call<{ comment: TicketComment }>(ops.commentAdd, { ticketId, body })
    return reply({ id: comment.id, createdAt: comment.createdAt })
  })

  server.registerTool('archive_ticket', {
    title: 'Archive a ticket',
    description: 'Take a ticket off the board. Nothing is deleted — a board admin can restore it — but it stops being visible to everyone else.',
    // Not destructive by its own account: nothing is lost, and restore_ticket is the way back.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { ticketId: z.string() }
  }, async ({ ticketId }) => {
    const { ticket } = await call<{ ticket: Ticket }>(ops.ticketArchive, { ticketId })
    return reply({ id: ticket.id, archivedAt: ticket.archivedAt })
  })

  server.registerTool('list_lanes', {
    title: 'List lanes',
    description: 'The lanes of a board with their ids and ticket counts. board_overview returns these too; this is the cheaper call when that is all you need.',
    annotations: readsOnly,
    inputSchema: { boardId: z.string() }
  }, async ({ boardId }) => {
    const { lanes } = await call<{ lanes: LaneSummary[] }>(ops.laneList, { boardId })
    return reply(lanes.map(laneOf))
  })

  server.registerTool('whats_new', {
    title: 'What changed on a board',
    description:
      'The board’s recent history in one call, newest first: tickets created, imported, moved, '
      + 'commented on, (un)assigned, reprioritised, archived and restored — and, from the server '
      + 'itself (`by` null), a live window opening (went_live), nearing its end (live_ending) or '
      + 'running out while the ticket is still live (live_ended), each with its `date`, and a recurring '
      + 'ticket\'s round closing as it starts the next: new_round (done or skipped) or round_missed '
      + '(the next round came while it was still open — worth a look), each with the `date` of the round and `next`. Give `since` to pick '
      + 'up where you left off; it defaults to the last seven days. Edits to a ticket’s title, '
      + 'description or labels leave no trace here — this reads the same history get_ticket shows.',
    annotations: readsOnly,
    inputSchema: {
      boardId: z.string().describe('From list_boards.'),
      since: z.string().optional().describe('ISO timestamp; defaults to seven days ago.'),
      limit: z.number().int().min(1).max(200).optional().describe('Defaults to 50.')
    }
  }, async ({ boardId, since, limit }) => {
    const from = since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { activity } = await call<{ activity: Array<TicketActivityEntry & { ticketNumber: number; ticketTitle: string }> }>(
      ops.boardActivity, { boardId, since: from, limit: limit ?? 50 }
    )
    return reply({
      since: from,
      entries: activity.map(entry => ({
        ticket: { id: entry.ticketId, number: entry.ticketNumber, title: entry.ticketTitle },
        kind: entry.kind,
        by: nameOf(entry.actor),
        via: entry.agentId,
        at: entry.createdAt,
        detail: activityDetail(entry)
      }))
    })
  })

  server.registerTool('add_attachment', {
    title: 'Add an attachment',
    description:
      'Attach a file to a ticket by URL: the server downloads it itself, so pass a link — a '
      + 'Telegram file URL, a CI artifact, a log on a paste service — rather than pushing bytes '
      + 'through context. Up to 25 MB; images, PDF, text and Office types. The filename decides '
      + 'the allowed type — give one when the URL does not already end in it.',
    // The one tool that reaches outside this instance: it fetches the caller's URL.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      ticketId: z.string(),
      url: z.string().describe('The http(s) URL to download. Fetched once, without following redirects.'),
      filename: z.string().max(180).optional().describe('Overrides the name taken from the URL, extension included.')
    }
  }, async ({ ticketId, url, filename }) => {
    const { attachment } = await call<{ attachment: { id: string; filename: string; mimeType: string; size: number; url: string } }>(
      ops.attachmentAddFromUrl, { ticketId, url, filename }
    )
    return reply(attachment)
  })

  server.registerTool('create_upload_url', {
    title: 'Get an upload address',
    description:
      'For a file on your own disk — one somebody handed you in a chat, a log you wrote. Returns '
      + 'a one-time address and the curl command that sends the file there, so it travels '
      + 'straight from your machine to the ticket and never through your context. Run the '
      + 'command in your shell within 10 minutes; the address takes one file and is then spent. '
      + 'A file already online goes through add_attachment instead. Same limits: up to 25 MB, '
      + 'images, PDF, text and Office types, the extension deciding the type.',
    // Writes nothing to the ticket by itself, but hands out the means to — so a write.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      ticketId: z.string(),
      filename: z.string().max(180).optional().describe('Overrides the name of the file you send, extension included.')
    }
  }, async ({ ticketId, filename }) => {
    const { upload } = await call<{ upload: { path: string; field: string; expiresAt: string } }>(
      ops.attachmentUploadUrl, { ticketId, filename }
    )
    const url = options.origin ? new URL(upload.path, options.origin).toString() : upload.path
    return reply({
      url,
      expiresAt: upload.expiresAt,
      // What to run, with the path to fill in. The answer is the attachment, as add_attachment returns it.
      command: `curl -sS -F '${upload.field}=@<path to the file>' '${url}'`
    })
  })

  server.registerTool('restore_ticket', {
    title: 'Restore a ticket',
    description:
      'Put an archived ticket back on the board — the undo of archive_ticket. Restoring reaches '
      + 'into the archive, so it takes a board administrator. The ticket returns to the lane it '
      + 'was archived from, or to the board’s default lane when that one is gone.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { ticketId: z.string() }
  }, async ({ ticketId }) => {
    const { ticket } = await call<{ ticket: Ticket }>(ops.ticketRestore, { ticketId })
    return reply({ id: ticket.id, laneId: ticket.laneId })
  })
}
