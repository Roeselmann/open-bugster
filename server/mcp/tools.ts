import { createError } from 'h3'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { run, type AnyOperation } from '~~/server/operations'
import * as ops from '~~/server/operations'
import type { Actor } from '~~/server/utils/actor'
import { resolveAttachmentFile } from '~~/server/utils/attachment-file'
import { DEFAULT_PREVIEW_DIMENSION, imagePreview } from '~~/server/utils/image-preview'
import { boardTodayOf, findTicketType, isServiceIdentity, parentTicketIdsOf, principalDescription } from '~~/server/utils/db'
import { todoLight } from '~~/shared/utils/todo-progress'
import { dependencyWarnings, timelineBounds, timelineWarnings } from '~~/shared/utils/timeline'
import { describeRecurrence } from '~~/shared/utils/recurrence'
import { categoryColors, ticketTypeColors } from '~~/shared/types/domain'
import type { BoardMember, BoardSummary, CategorySummary, DependencyRef, LabelSummary, LaneSummary, ShiftResult, TimelineNode, Ticket, TicketTodo, TicketActivityEntry, TicketComment, TicketType, TicketTypeSummary, WorkspaceSummary } from '~~/shared/types/domain'

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
 *
 * The structure tools — boards, lanes, members, labels, categories, ticket types — are a
 * second, smaller group that only an agent organising its own boards needs. They are kept
 * just as task-shaped (one `save_lane` for create, update and position; one `edit_label` for
 * rename and delete) so the group adds a dozen names rather than thirty, and each one is
 * refused by the server unless the token carries the `admin` scope and the principal is an
 * administrator of the board or workspace in question.
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

const DUE_TIME_FIELD = 'HH:MM, 24-hour, in the workspace\'s time zone (timeZone in list_boards): when a milestone or each round of a recurring ticket happens, e.g. a meeting at 10:00. Not for a lifecycle, whose dueDate is a deadline. Omit for a whole day.'
const LIVE_TIME_FIELD = 'HH:MM, 24-hour, in the workspace\'s time zone: the time on that day of the live window, e.g. a go-live at 09:00. Shown only; warnings still go by the day. Omit for a whole day.'

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
    // Times of day only where there is one: most days are whole days.
    ...timesOf(ticket),
    // Only for a recurring ticket: how it repeats, when the next round is, how the last one went.
    ...(ticket.recurrence ? { repeats: describeRecurrence(ticket.recurrence), nextRound: ticket.nextRound, lastRound: ticket.rounds[0] ? { date: ticket.rounds[0].date, outcome: ticket.rounds[0].outcome } : null } : {}),
    commentCount: ticket.commentCount,
    progress: progressOf(ticket.todos),
    // Numbers only here; get_ticket spells them out.
    waitsOn: ticket.waitsOn.map(item => item.ticketNumber)
  }
}

/** The times of day a ticket or timeline node has, HH:MM in its workspace's time zone; nothing for whole days. */
function timesOf(item: { dueTime: string | null; liveFromTime: string | null; liveUntilTime: string | null }) {
  return {
    ...(item.dueTime ? { dueTime: item.dueTime } : {}),
    ...(item.liveFromTime ? { liveFromTime: item.liveFromTime } : {}),
    ...(item.liveUntilTime ? { liveUntilTime: item.liveUntilTime } : {})
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
    ...timesOf(node),
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

/**
 * A board member as every tool shows one. No address: an agent assigns by id. `through` is
 * there only for an agent on the roster by a grant rather than a membership — the one member
 * remove_board_member cannot take off, which is worth knowing before trying.
 */
function memberOf(member: BoardMember) {
  return {
    id: member.userId, name: `${member.firstName} ${member.lastName}`.trim(), role: member.role, mayAutomate: member.mayAutomate,
    ...(member.isService ? { isAgent: true } : {}),
    ...(member.via !== 'board' ? { through: member.via === 'instance' ? 'grant for every board' : 'workspace grant' } : {})
  }
}

function categoryOf(category: Pick<CategorySummary, 'name' | 'color'>) {
  return { name: category.name, color: category.color }
}

function ticketTypeOf(type: Pick<TicketType, 'id' | 'name' | 'color'>) {
  return { id: type.id, name: type.name, color: type.color }
}

/** Whether a lane's tickets count as finished — what ticks a subticket and closes a round as done. */
const finishes = (lane: { isDone: boolean; isLive: boolean }) => lane.isDone || lane.isLive

const STRUCTURE_NOTE = 'Needs a token with the admin scope, and the principal has to be an administrator of this board — whoami says whether the token allows it.'
const WORKSPACE_NOTE = 'Needs a token with the admin scope that is not pinned to one board, and the principal has to be an administrator of the workspace — whoami says whether the token allows it.'

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

/** One entry of `board.structure.list`, as that operation returns it. */
interface StructureEntry {
  operation: string
  at: string
  principal: { firstName: string; lastName: string } | null
  agentId: string | null
  targetName: string | null
  changes: Record<string, unknown>
}

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

  /** board_overview's answer, which create_board gives back too. */
  const overviewOf = async (boardId: string) => {
    const [{ board }, { labels }, { categories }, { types }, { workspaces }] = await Promise.all([
      call<{ board: BoardSummary }>(ops.boardGet, { boardId }),
      call<{ labels: LabelSummary[] }>(ops.labelList, { boardId }),
      call<{ categories: CategorySummary[] }>(ops.categoryList, { boardId }),
      call<{ types: TicketTypeSummary[] }>(ops.ticketTypeList, { boardId }),
      call<{ workspaces: WorkspaceSummary[] }>(ops.workspaceList, {})
    ])
    const home = workspaces.find(workspace => workspace.id === board.workspaceId)
    return {
      id: board.id,
      workspace: { id: board.workspaceId, name: home?.name ?? null, description: home?.description ?? null, timeZone: home?.timeZone ?? null },
      name: board.name,
      description: board.description,
      yourRole: board.role,
      lanes: board.lanes.map(laneOf),
      members: board.members.map(memberOf),
      labels: labels.map(label => label.name),
      // With the colour, which is what edit_category sets; a ticket still names one by name.
      categories: categories.map(categoryOf),
      ticketTypes: types.map(type => ({ id: type.id, name: type.name }))
    }
  }

  /**
   * What to tell an agent that has just finished a ticket still waiting on open work. Moving
   * it is allowed — only a strict to-do list refuses — so the reply is where it learns of it,
   * rather than from a timeline it may never read.
   */
  const finishedEarly = async (ticket: Ticket, lanes?: LaneSummary[]): Promise<string[]> => {
    if (!ticket.waitsOn.some(blocker => !blocker.done && !blocker.archived)) return []
    const known = lanes ?? (await call<{ lanes: LaneSummary[] }>(ops.laneList, { boardId: ticket.boardId })).lanes
    const lane = known.find(candidate => candidate.id === ticket.laneId)
    if (!lane || !(lane.isDone || lane.isLive)) return []
    return dependencyWarnings({ id: ticket.id, ticketNumber: ticket.ticketNumber, startDate: ticket.startDate, dueDate: ticket.dueDate, done: true, waitsOn: ticket.waitsOn }, boardTodayOf(ticket.boardId))
      .map(warning => warning.message)
  }

  server.registerTool('whoami', {
    title: 'Who am I',
    description:
      'The principal this token acts for, the agent label it carries, and what its scopes permit. '
      + 'kind says whether that principal is a person you act for or an agent with an identity of '
      + 'its own — in which case it is you, and the tickets assigned to principalId are your work. '
      + 'Worth calling first when a write is unexpectedly refused: a token is a ceiling on what its '
      + 'principal can do, so being denied usually means the scopes are narrower than the person. '
      + 'canChangeStructure says whether the token itself permits the structure tools (create_board, '
      + 'save_lane, set_board_member, edit_label, edit_category, edit_ticket_type and the like): true '
      + 'with the admin scope or an unrestricted token. The principal still needs the admin role on '
      + 'the board or workspace in question — list_boards shows yourRole on both.',
    annotations: readsOnly,
    inputSchema: {}
  }, async () => {
    const isAgent = isServiceIdentity(actor.principal)
    const canChangeStructure = !actor.scopes || actor.scopes.includes('admin')
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
      boardScope: actor.boardScope ?? 'all boards this principal can reach',
      // The token's half of the question only; the role is the other half, and differs per board.
      canChangeStructure,
      structure: canChangeStructure
        ? `This token permits changing structure. Each change still needs yourRole "admin" on that board (or on that workspace, for create_board and edit_ticket_type)${actor.boardScope ? '; being pinned to one board, it cannot create boards or edit ticket types' : ''}.`
        : 'This token cannot change structure: that takes the admin scope. Tickets, comments and moves are unaffected.'
    })
  })

  server.registerTool('list_boards', {
    title: 'List boards',
    description: 'Every board this token can see, with its lanes and how many tickets are on it, plus the workspaces the boards are grouped into. Start here — every other tool needs a board or a ticket id. yourRole on a workspace is "admin" where you may create boards and edit ticket types (null where you only see it through one of its boards); on a board, "admin" is where the structure tools work.',
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
      workspaces: workspaces.map(workspace => ({ id: workspace.id, name: workspace.name, description: workspace.description, timeZone: workspace.timeZone, yourRole: workspace.role })),
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
  }, async ({ boardId }) => reply(await overviewOf(boardId)))

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
      ...(plan ? { timeline: { covers: timelineBounds(plan), warnings: timelineWarnings(plan, boardTodayOf(ticket.boardId)).map(warning => warning.message), subtickets: plan.children.map(timelineOf) } } : {})
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
      dueTime: z.string().optional().describe(DUE_TIME_FIELD),
      liveFromTime: z.string().optional().describe(LIVE_TIME_FIELD),
      liveUntilTime: z.string().optional().describe(LIVE_TIME_FIELD),
      links: z.array(LINK_INPUT).max(50).optional().describe('Web addresses the ticket refers to, in order.'),
      labels: z.array(z.string()).max(12).optional(),
      categoryName: z.string().optional(),
      typeId: z.string().optional().describe('A ticket type id from board_overview.ticketTypes. Omit for an untyped ticket.'),
      todos: z.array(z.object({ text: z.string().min(1).max(500), completed: z.boolean().default(false), decision: DECISION_INPUT }).transform(openDecision)).max(100).optional()
        .describe('The ticket’s initial to-do list, in order. An item with decision is a question for people to decide.'),
      strictOrder: z.boolean().optional().describe(STRICT_ORDER_FIELD),
      // Filing a plan is mostly filing tickets that wait on each other; without this every
      // dependency cost a second call to update_ticket.
      waitsOn: z.array(z.string()).max(50).optional()
        .describe('Ids of the tickets this one waits on, finish-to-start: it starts once they end. Same workspace only.'),
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
      dueTime: z.string().nullable().optional().describe(`${DUE_TIME_FIELD} null makes it a whole day again.`),
      liveFromTime: z.string().nullable().optional().describe(`${LIVE_TIME_FIELD} null makes it a whole day again.`),
      liveUntilTime: z.string().nullable().optional().describe(`${LIVE_TIME_FIELD} null makes it a whole day again.`),
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
    description: 'Move a ticket to a lane, and optionally to a position within it. A lane with isDone finishes the ticket: as a subticket it is then ticked off on every parent. A lane with isLive does the same for a ticket that is finished and now running — a campaign in market — whose live window then warns instead of its due date. With a boardId the ticket moves onto that other board of the same workspace instead, into laneId there (its default lane when omitted); labels and category come along by name, an assignee who is no member over there is dropped. Ids come from list_boards and board_overview. Finishing a subticket of a strict to-do list while something above it in that list is open is refused. Finishing a ticket that waits on open work by a dependency set by hand is allowed, and the reply then carries `warnings`.',
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
      const warnings = await finishedEarly(ticket)
      return reply({ ...slim(ticket), assigneeCleared, ...(warnings.length ? { warnings } : {}) })
    }
    if (!laneId) throw new Error('Either laneId or boardId is needed.')
    const { ticket } = await call<{ ticket: Ticket }>(ops.ticketMove, { ticketId, laneId, index: index ?? 0 })
    const warnings = await finishedEarly(ticket)
    return reply({ ...slim(ticket), ...(warnings.length ? { warnings } : {}) })
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
      + 'description or labels leave no trace in `entries`, which read the same history get_ticket shows. '
      + '`structure` lists, newest first, what was done to the board itself: renamed or re-described, lanes added, '
      + 'changed, reordered or deleted, members added, re-roled or removed, categories and labels created, '
      + 'renamed or deleted — each with `operation`, `by`, `via`, `at` and a `detail` of what the change recorded, '
      + 'plus the target\'s current name. It reaches back as far as the audit log is kept (a year by default) '
      + 'and shows only changes that went through.',
    annotations: readsOnly,
    inputSchema: {
      boardId: z.string().describe('From list_boards.'),
      since: z.string().optional().describe('ISO timestamp; defaults to seven days ago.'),
      limit: z.number().int().min(1).max(200).optional().describe('Defaults to 50.')
    }
  }, async ({ boardId, since, limit }) => {
    const from = since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const [{ activity }, { entries: structure }] = await Promise.all([
      call<{ activity: Array<TicketActivityEntry & { ticketNumber: number; ticketTitle: string }> }>(
        ops.boardActivity, { boardId, since: from, limit: limit ?? 50 }
      ),
      call<{ entries: StructureEntry[] }>(ops.boardStructureList, { boardId, since: from, limit: limit ?? 50 })
    ])
    return reply({
      since: from,
      entries: activity.map(entry => ({
        ticket: { id: entry.ticketId, number: entry.ticketNumber, title: entry.ticketTitle },
        kind: entry.kind,
        by: nameOf(entry.actor),
        via: entry.agentId,
        at: entry.createdAt,
        detail: activityDetail(entry)
      })),
      structure: structure.map(entry => ({
        operation: entry.operation,
        by: nameOf(entry.principal),
        via: entry.agentId,
        at: entry.at,
        detail: { ...entry.changes, ...(entry.targetName ? { target: entry.targetName } : {}) }
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

  /* ── structure ──────────────────────────────────────────────────────────── */

  server.registerTool('create_board', {
    title: 'Create a board',
    description:
      'Open a new board in a workspace; you become its administrator. Without lanes it gets the '
      + 'default Import, Backlog, In Progress and Done. With lanes it gets exactly those, left to '
      + 'right; an import lane is added by the first TestFlight or Jira import, should the board ever '
      + 'get one. New tickets land in the first lane that is not the import lane unless they name one. '
      + `${WORKSPACE_NOTE} Replies with the board as board_overview shows it.`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      name: z.string().max(40),
      workspaceId: z.string().optional().describe('From list_boards, one where your yourRole is "admin". Omit for the default workspace.'),
      description: z.string().max(200).optional().describe('Shown under the board title.'),
      lanes: z.array(z.object({
        name: z.string().max(30),
        isDone: z.boolean().optional().describe('Holds finished work: a subticket here counts as done, due dates stop warning.'),
        isLive: z.boolean().optional().describe('Holds finished work that is running, a campaign in market: counts as done too, and the live window warns instead. Wins over isDone.')
      })).min(1).max(30).optional().describe('The lanes, left to right. Omit for the default four.')
    }
  }, async (input) => {
    const { board } = await call<{ board: BoardSummary }>(ops.boardCreate, input)
    return reply(await overviewOf(board.id))
  })

  server.registerTool('update_board', {
    title: 'Rename or describe a board',
    description: `Change a board's name or the description shown under its title; what is omitted stays. ${STRUCTURE_NOTE}`,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      boardId: z.string(),
      name: z.string().max(40).optional(),
      description: z.string().max(200).optional().describe('An empty string clears it.')
    }
  }, async ({ boardId, name, description }) => {
    // Only these two: the operation also takes the sync settings, which stay with the UI.
    if (name === undefined && description === undefined) throw createError({ statusCode: 400, statusMessage: 'Give a name, a description, or both.' })
    const { board } = await call<{ board: BoardSummary }>(ops.boardUpdate, { boardId, name, description })
    return reply({ id: board.id, name: board.name, description: board.description })
  })

  server.registerTool('delete_board', {
    title: 'Delete an empty board',
    description:
      'Delete a board that holds no tickets at all — archived ones count, since deleting the board '
      + 'would delete them for good. A board with tickets is refused: move them to another board of '
      + 'the workspace with move_ticket first (restore archived ones to move them). Its lanes, '
      + `labels, categories and memberships go with it. The last board of the instance stays. ${STRUCTURE_NOTE}`,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { boardId: z.string() }
  }, async ({ boardId }) => {
    // Always set, and checked by the operation inside the deleting transaction — the count is
    // not this tool's to make, so nothing filed in the meantime can be swept away.
    await call(ops.boardDelete, { boardId, onlyIfEmpty: true })
    return reply({ deleted: boardId })
  })

  server.registerTool('save_lane', {
    title: 'Add or change a lane',
    description:
      'Without laneId, adds a lane (name required) at the right end, or at index. With laneId, '
      + 'changes what is given: name, isDone, isLive, and index — its place, 0 being the leftmost. '
      + 'isDone marks a lane of finished work; isLive one of finished work that is running, like a '
      + 'campaign in market. Both make a ticket there count as finished: a subticket is ticked off on '
      + 'its parents, and a recurring ticket closes its round as done. They exclude each other: '
      + 'switching isLive on switches isDone off, and isDone on switches isLive off. The import lane is '
      + 'neither. Replies with the board\'s lanes, and a note when the change turns a lane\'s tickets '
      + `finished or open again. ${STRUCTURE_NOTE}`,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      boardId: z.string(),
      laneId: z.string().optional().describe('From board_overview. Omit to add a lane.'),
      name: z.string().max(30).optional(),
      isDone: z.boolean().optional(),
      isLive: z.boolean().optional(),
      index: z.number().int().min(0).max(29).optional().describe('Where the lane sits, 0 being the leftmost; past the end puts it last.')
    }
  }, async ({ boardId, laneId, name, isDone, isLive, index }) => {
    const before = (await call<{ lanes: LaneSummary[] }>(ops.laneList, { boardId })).lanes
    let targetId: string
    let lanes: LaneSummary[]
    if (!laneId) {
      if (!name) throw createError({ statusCode: 400, statusMessage: 'A new lane needs a name. To change a lane, give its laneId.' })
      const created = await call<{ lane: { id: string }; lanes: LaneSummary[] }>(ops.laneCreate, { boardId, name, isDone, isLive })
      targetId = created.lane.id
      lanes = created.lanes
    } else {
      if (!before.some(lane => lane.id === laneId)) throw createError({ statusCode: 404, statusMessage: 'Lane not found on this board.' })
      targetId = laneId
      const edits = name !== undefined || isDone !== undefined || isLive !== undefined
      if (!edits && index === undefined) throw createError({ statusCode: 400, statusMessage: 'Nothing to change: give a name, isDone, isLive or index.' })
      lanes = edits ? (await call<{ lanes: LaneSummary[] }>(ops.laneUpdate, { boardId, laneId, name, isDone, isLive })).lanes : before
    }
    if (index !== undefined) {
      const order = lanes.map(lane => lane.id).filter(id => id !== targetId)
      order.splice(Math.min(index, order.length), 0, targetId)
      if (order.join() !== lanes.map(lane => lane.id).join()) {
        lanes = (await call<{ lanes: LaneSummary[] }>(ops.laneReorder, { boardId, laneIds: order })).lanes
      }
    }
    const previous = before.find(lane => lane.id === targetId)
    const now = lanes.find(lane => lane.id === targetId)!
    const notes: string[] = []
    // What a flag means to the tickets already there is the part an agent would not guess.
    if (previous && previous.ticketCount && finishes(previous) !== finishes(now)) {
      const count = `${previous.ticketCount} ticket${previous.ticketCount === 1 ? '' : 's'} in this lane`
      notes.push(finishes(now)
        ? `${count} now count as finished: as subtickets they are ticked off on their parents, their due dates stop warning, and a recurring one here closes its round as done.`
        : `${count} count as open again: as subtickets they are unticked on their parents, their due dates warn again, and a recurring one left here closes its round as missed unless all its to-dos are ticked.`)
    }
    if (isDone && isLive) notes.push('isDone and isLive exclude each other; isLive won, so isDone is off.')
    if (now.isImport && (isDone || isLive)) notes.push('The import lane is neither done nor live; those flags were left off.')
    return reply({ laneId: targetId, lanes: lanes.map(laneOf), ...(notes.length ? { note: notes.join(' ') } : {}) })
  })

  server.registerTool('delete_lane', {
    title: 'Delete a lane',
    description:
      'Remove a lane. An empty one goes directly. One holding tickets needs exactly one of '
      + 'moveTicketsTo — another lane of the same board, where they land at the end — or '
      + 'archiveTickets: true, which archives them (a board admin can restore them). Archived tickets '
      + 'of the lane move to the board\'s first lane either way, so restoring one has somewhere to go. '
      + `The import lane and a board's last lane cannot be deleted. ${STRUCTURE_NOTE}`,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      boardId: z.string(),
      laneId: z.string(),
      moveTicketsTo: z.string().optional().describe('A lane id of the same board.'),
      archiveTickets: z.boolean().optional()
    }
  }, async ({ boardId, laneId, moveTicketsTo, archiveTickets }) => {
    if (moveTicketsTo && archiveTickets) throw createError({ statusCode: 400, statusMessage: 'Give moveTicketsTo or archiveTickets, not both.' })
    const { lanes } = await call<{ lanes: LaneSummary[] }>(ops.laneList, { boardId })
    const lane = lanes.find(item => item.id === laneId)
    if (!lane) throw createError({ statusCode: 404, statusMessage: 'Lane not found on this board.' })
    if (moveTicketsTo && !lanes.some(item => item.id === moveTicketsTo && item.id !== laneId)) {
      throw createError({ statusCode: 422, statusMessage: 'moveTicketsTo has to be another lane of this board.' })
    }
    if (lane.ticketCount && !moveTicketsTo && !archiveTickets) {
      throw createError({
        statusCode: 409,
        statusMessage: `This lane holds ${lane.ticketCount} ticket${lane.ticketCount === 1 ? '' : 's'}. Delete it with moveTicketsTo set to another lane of the board to keep them there, or with archiveTickets: true to archive them.`
      })
    }
    // `empty` rather than `archive` for a lane that looked empty: the operation re-counts inside
    // its transaction, so a ticket filed since the read above is refused, not archived.
    const mode = moveTicketsTo ? { mode: 'move', targetLaneId: moveTicketsTo } : archiveTickets ? { mode: 'archive' } : { mode: 'empty' }
    const result = await call<{ lanes: LaneSummary[] }>(ops.laneDelete, { boardId, laneId, ...mode })
    return reply({
      deleted: laneId,
      ...(lane.ticketCount ? { [moveTicketsTo ? 'ticketsMoved' : 'ticketsArchived']: lane.ticketCount } : {}),
      lanes: result.lanes.map(laneOf)
    })
  })

  server.registerTool('member_candidates', {
    title: 'Who can join a board',
    description: 'The people and agents who are not on this board yet — the userIds set_board_member takes. Unless the principal administers the instance, '
      + 'the list holds only those it shares a workspace with: nobody is shown the accounts of other workspaces. To add somebody from outside, give their whole '
      + `e-mail address as email; the account it belongs to, if any, joins the list. ${STRUCTURE_NOTE}`,
    annotations: readsOnly,
    inputSchema: {
      boardId: z.string(),
      email: z.string().max(254).optional().describe('The whole address of one account to look up, exactly; no partial matches.')
    }
  }, async ({ boardId, email }) => {
    const { candidates } = await call<{ candidates: Array<{ id: string; firstName: string; lastName: string; isService: boolean }> }>(ops.memberCandidates, { boardId, email })
    // Names only, as board_overview shows its members: an agent adds somebody by id.
    return reply(candidates.map(person => ({ id: person.id, name: `${person.firstName} ${person.lastName}`.trim(), ...(person.isService ? { isAgent: true } : {}) })))
  })

  server.registerTool('set_board_member', {
    title: 'Add a member or change their role',
    description:
      'Add somebody to a board, or change the role they hold there: viewer reads, editor works '
      + 'tickets, admin also changes the board itself. mayAutomate is whether that account may work '
      + 'the board through the API or an agent rather than only in the browser; omitted, an existing '
      + 'member keeps theirs and a new one starts without. Admins and agents always may, whatever it '
      + 'says. Demoting the last administrator is refused. userId comes from member_candidates or '
      + `board_overview. Replies with the members as board_overview shows them. ${STRUCTURE_NOTE}`,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      boardId: z.string(),
      userId: z.string(),
      role: z.enum(['viewer', 'editor', 'admin']),
      mayAutomate: z.boolean().optional()
    }
  }, async (input) => {
    const { board } = await call<{ board: BoardSummary | null }>(ops.memberSet, input)
    const members = board?.members ?? (await call<{ members: BoardMember[] }>(ops.memberList, { boardId: input.boardId })).members
    return reply({ members: members.map(memberOf) })
  })

  server.registerTool('remove_board_member', {
    title: 'Remove a member',
    description:
      'Take somebody off a board. Tickets assigned to them keep that assignee until somebody '
      + 'changes it; their comments and history stay. The last administrator cannot be removed, and '
      + 'an agent listed with `through` is on the board by a grant, not a membership, and is refused '
      + `here: an instance administrator changes the grant. Replies with the members left. ${STRUCTURE_NOTE}`,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { boardId: z.string(), userId: z.string() }
  }, async (input) => {
    const { board } = await call<{ board: BoardSummary | null }>(ops.memberRemove, input)
    const members = board?.members ?? (await call<{ members: BoardMember[] }>(ops.memberList, { boardId: input.boardId })).members
    return reply({ members: members.map(memberOf) })
  })

  server.registerTool('edit_label', {
    title: 'Rename or delete a label',
    description:
      'Labels belong to a board and come into being when a ticket names one. rename gives one a new '
      + 'name on every ticket; onto a name another label already has, the two merge and each ticket '
      + 'keeps the one label. delete takes it off every ticket. Names match case-insensitively; a new '
      + 'name is 1–30 characters. Replies with the board\'s labels and how many tickets carried the '
      + `label. ${STRUCTURE_NOTE}`,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      boardId: z.string(),
      name: z.string().max(30).describe('The label as board_overview lists it.'),
      action: z.enum(['rename', 'delete']),
      newName: z.string().max(30).optional().describe('For rename.')
    }
  }, async ({ boardId, name, action, newName }) => {
    if (action === 'rename' && !newName) throw createError({ statusCode: 400, statusMessage: 'A rename needs newName.' })
    const result = action === 'rename'
      ? await call<{ labels: LabelSummary[]; ticketsTouched: number; merged: boolean }>(ops.labelRename, { boardId, name, newName })
      : await call<{ labels: LabelSummary[]; ticketsTouched: number }>(ops.labelDelete, { boardId, name })
    return reply({
      labels: result.labels.map(label => label.name),
      ticketsTouched: result.ticketsTouched,
      ...('merged' in result && result.merged ? { merged: true } : {})
    })
  })

  server.registerTool('edit_category', {
    title: 'Create, change or delete a category',
    description:
      'A board\'s categories, each ticket having at most one. create adds one (a ticket naming an '
      + 'unknown category also adds it, in neutral); update renames it with newName or recolours it; '
      + 'delete removes it, and its tickets are left without a category. Addressed by name, as '
      + `board_overview lists them. Colours: ${categoryColors.join(', ')}. ${STRUCTURE_NOTE}`,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      boardId: z.string(),
      action: z.enum(['create', 'update', 'delete']),
      name: z.string().max(30),
      newName: z.string().max(30).optional().describe('For update.'),
      color: z.enum(categoryColors).optional().describe('For create (defaults to neutral) and update.')
    }
  }, async ({ boardId, action, name, newName, color }) => {
    let uncategorised: number | null = null
    if (action === 'create') {
      await call(ops.categoryCreate, { boardId, name, color })
    } else {
      const { categories } = await call<{ categories: CategorySummary[] }>(ops.categoryList, { boardId })
      const found = categories.find(category => category.name.toLocaleLowerCase('en') === name.trim().toLocaleLowerCase('en'))
      if (!found) throw createError({ statusCode: 404, statusMessage: `This board has no category named “${name.trim()}”. board_overview lists the ones it has.` })
      if (action === 'update') {
        if (!newName && !color) throw createError({ statusCode: 400, statusMessage: 'An update needs newName, color, or both.' })
        await call(ops.categoryUpdate, { categoryId: found.id, name: newName, color })
      } else {
        await call(ops.categoryDelete, { categoryId: found.id })
        uncategorised = found.ticketCount
      }
    }
    const { categories } = await call<{ categories: CategorySummary[] }>(ops.categoryList, { boardId })
    return reply({ categories: categories.map(categoryOf), ...(uncategorised !== null ? { ticketsUncategorised: uncategorised } : {}) })
  })

  server.registerTool('edit_ticket_type', {
    title: 'Create, change or delete a ticket type',
    description:
      'Ticket types — Email, Bug, Campaign — belong to a workspace and are shared by its boards. '
      + 'create needs a name and the workspace, given as workspaceId or as one of its boards; update '
      + 'renames or recolours the type with typeId; delete removes it, and its tickets become untyped. '
      + `Colours: ${ticketTypeColors.join(', ')} — the colour doubles as the card background, none leaves the card as it is. `
      + 'A new type gets the Ticket icon; picking another icon is left to the workspace settings in the UI. '
      + `Replies with the workspace's types. ${WORKSPACE_NOTE}`,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      action: z.enum(['create', 'update', 'delete']),
      boardId: z.string().optional().describe('For create: the type goes to this board\'s workspace.'),
      workspaceId: z.string().optional().describe('For create, instead of boardId.'),
      typeId: z.string().optional().describe('For update and delete: from board_overview.ticketTypes.'),
      name: z.string().max(30).optional().describe('Required for create.'),
      color: z.enum(ticketTypeColors).optional().describe('For create (defaults to neutral) and update.')
    }
  }, async ({ action, boardId, workspaceId, typeId, name, color }) => {
    let untyped: number | null = null
    let home: string
    if (action === 'create') {
      if (!name) throw createError({ statusCode: 400, statusMessage: 'A new type needs a name.' })
      const target = workspaceId ?? (boardId ? (await call<{ board: BoardSummary }>(ops.boardGet, { boardId })).board.workspaceId : null)
      if (!target) throw createError({ statusCode: 400, statusMessage: 'Name the workspace, with workspaceId or one of its boards as boardId.' })
      home = (await call<{ type: TicketType }>(ops.ticketTypeCreate, { workspaceId: target, name, color })).type.workspaceId
    } else {
      if (!typeId) throw createError({ statusCode: 400, statusMessage: `To ${action} a type, give its typeId.` })
      if (action === 'update') {
        if (!name && !color) throw createError({ statusCode: 400, statusMessage: 'An update needs a name, a color, or both.' })
        home = (await call<{ type: TicketType }>(ops.ticketTypeUpdate, { typeId, name, color })).type.workspaceId
      } else {
        // Read before the delete only to say how many tickets lose the type; the delete itself
        // is where access is decided, and an unknown id is its 404 to give.
        const known = findTicketType(typeId)
        const before = known ? (await call<{ types: TicketTypeSummary[] }>(ops.ticketTypeList, { workspaceId: known.workspaceId }).catch(() => ({ types: [] as TicketTypeSummary[] }))).types : []
        await call(ops.ticketTypeDelete, { typeId })
        home = known!.workspaceId
        untyped = before.find(type => type.id === typeId)?.ticketCount ?? 0
      }
    }
    const { types } = await call<{ types: TicketTypeSummary[] }>(ops.ticketTypeList, { workspaceId: home })
    return reply({ workspaceId: home, types: types.map(ticketTypeOf), ...(untyped !== null ? { ticketsUntyped: untyped } : {}) })
  })

  server.registerTool('move_tickets', {
    title: 'Move several tickets',
    description:
      'Move up to 50 tickets of one board into a lane, so they sit together in the order given, the '
      + 'first at index (0 is the top, the default) counted among the lane\'s other tickets. Tickets '
      + 'already in the lane are reordered the same way. Each move is its own change, recorded and '
      + 'announced like move_ticket; a lane with isDone or isLive finishes them as it does there. If one '
      + 'fails the rest are not attempted, and the reply says what moved and why the one stopped — a strict to-do list refuses a subticket finished out of turn, so give those in list order. `warnings` names tickets finished while something they wait on is open. '
      + 'Moving onto another board stays with move_ticket and boardId. Needs editor, like move_ticket.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      laneId: z.string().describe('The destination lane, from board_overview.'),
      ticketIds: z.array(z.string()).min(1).max(50).describe('In the order they should end up in.'),
      index: z.number().int().min(0).max(10000).optional().describe('Where the first one lands among the lane\'s other tickets; past the end puts them last.')
    }
  }, async ({ laneId, ticketIds, index }) => {
    if (new Set(ticketIds).size !== ticketIds.length) throw createError({ statusCode: 400, statusMessage: 'Name each ticket once.' })
    // Everything is checked before anything moves, so a bad id or a stray board costs nothing.
    const tickets = await Promise.all(ticketIds.map(ticketId => call<{ ticket: Ticket }>(ops.ticketGet, { ticketId }).then(result => result.ticket)))
    const boardId = tickets[0]!.boardId
    if (tickets.some(ticket => ticket.boardId !== boardId)) {
      throw createError({ statusCode: 422, statusMessage: 'All tickets have to be on one board, the lane\'s. Move tickets between boards with move_ticket and boardId.' })
    }
    const archived = tickets.find(ticket => ticket.archivedAt)
    if (archived) throw createError({ statusCode: 409, statusMessage: `Ticket ${archived.ticketNumber} is archived; restore it first.` })
    const { lanes } = await call<{ lanes: LaneSummary[] }>(ops.laneList, { boardId })
    if (!lanes.some(lane => lane.id === laneId)) {
      throw createError({ statusCode: 422, statusMessage: 'This lane is not on the board these tickets are on. Move tickets between boards with move_ticket and boardId.' })
    }

    // The lane as it will be, kept in step with each move. A ticket's index is counted with it
    // taken out of the lane, so each one is placed right after the one before it — which stays
    // right however many of the others started above the insertion point, in this lane or not.
    const { tickets: onBoard } = await call<{ tickets: Ticket[] }>(ops.ticketList, { boardId })
    const moving = new Set(ticketIds)
    let lane = onBoard.filter(ticket => ticket.laneId === laneId).map(ticket => ticket.id)
    const others = lane.filter(id => !moving.has(id))
    const anchor = Math.min(index ?? 0, others.length) > 0 ? others[Math.min(index ?? 0, others.length) - 1]! : null

    const moved: Ticket[] = []
    for (const [i, ticketId] of ticketIds.entries()) {
      const rest = lane.filter(id => id !== ticketId)
      const after = i === 0 ? anchor : ticketIds[i - 1]!
      const position = after ? rest.indexOf(after) + 1 : 0
      try {
        moved.push((await call<{ ticket: Ticket }>(ops.ticketMove, { ticketId, laneId, index: position })).ticket)
      } catch (error) {
        const failed = tickets[i]!
        return reply({
          laneId,
          moved: moved.map(ticket => ({ id: ticket.id, number: ticket.ticketNumber, title: ticket.title })),
          failed: { id: failed.id, number: failed.ticketNumber, error: (error as { statusMessage?: string; message?: string }).statusMessage || (error as Error).message },
          notAttempted: tickets.slice(i + 1).map(ticket => ({ id: ticket.id, number: ticket.ticketNumber }))
        })
      }
      rest.splice(position, 0, ticketId)
      lane = rest
    }
    const warnings = (await Promise.all(moved.map(ticket => finishedEarly(ticket, lanes)))).flat()
    return reply({ laneId, moved: moved.map(ticket => ({ id: ticket.id, number: ticket.ticketNumber, title: ticket.title })), ...(warnings.length ? { warnings } : {}) })
  })
}
