import { createError } from 'h3'
import { z } from 'zod'
import { boardMemberIds, boardViewer, requireBoardAccess, requireTicketAccess } from '../utils/access'
import type { Actor } from '../utils/actor'
import {
  archiveTicket, closeRound, reopenRound, createSubticket, createTicket, listActivity, listDueTickets, listBoardActivity, listTickets, listTicketsPage,
  atomically, dependencyRefs, findBoard, findLane, findTicket, listBoards, moveTicket, parentTicketRefsOf, searchSubticketCandidates, personById, restoreTicket, subticketIdsOf, ticketIdByNumber, ticketTimeline, ticketTypeBelongsToBoard, transferTicket, updateTicket, ticketsWaitingOn, waitingTicketIds, waitsOnTransitively
} from '../utils/db'
import { importedTicketUpdateSchema, subticketCreateSchema, ticketCreateSchema, ticketMoveSchema, ticketRoundCloseSchema, ticketShiftSchema, ticketTransferSchema, ticketUpdateSchema } from '../utils/validation'
import { deleteLinkThumbnails } from '../utils/link-preview'
import { cardImageCandidates } from '../../shared/utils/card-images'
import { addDays } from '../../shared/utils/timeline'
import { settleSchedule, touchesSchedule, type ScheduleFields } from '../../shared/utils/schedule'
import type { ShiftMove, ShiftResult, ShiftSkip, TicketDecisionInput } from '../../shared/types/domain'
import { createdId, defineOperation } from './types'
import { orNotFound } from './run'

const ticketId = z.string().trim().min(1).max(64)

export const ticketList = defineOperation({
  name: 'ticket.list',
  summary: 'List the tickets on a board',
  input: z.object({
    boardId: z.string().trim().min(1).max(64),
    archived: z.boolean().default(false),
    /** Omitted returns the whole board, which is what the board view wants. */
    limit: z.number().int().min(1).max(500).optional(),
    cursor: z.number().int().min(0).optional()
  }),
  // Reading a board is one thing; reading what has been taken off it is an administrator's.
  requires: { scope: 'board', role: 'viewer', boardId: input => input.boardId },
  audit: false,
  run: (_ctx, input) => {
    if (input.limit === undefined) return { tickets: listTickets(input.boardId, input.archived) }
    const page = listTicketsPage(input.boardId, { archived: input.archived, limit: input.limit, cursor: input.cursor })
    return { tickets: page.tickets, nextCursor: page.nextCursor }
  }
})

/** Across every board the caller can see: the open tickets with a due date, and how lit each is. */
export const ticketDueList = defineOperation({
  name: 'ticket.listDue',
  summary: 'List the open tickets with a due date across the caller’s boards, with their warning level',
  input: z.object({}),
  requires: { scope: 'authenticated' },
  audit: false,
  run: ctx => ({ tickets: listDueTickets(boardViewer(ctx.account)) })
})

/**
 * The archive rule lives in `requireTicketAccess`, so this cannot be reached for an archived
 * ticket by anyone below board admin — the same answer the board listing gives.
 */
export const ticketGet = defineOperation({
  name: 'ticket.get',
  summary: 'Read one ticket',
  input: z.object({ ticketId }),
  requires: { scope: 'ticket', role: 'viewer', ticketId: input => input.ticketId },
  audit: false,
  run: ctx => ({ ticket: ctx.ticket! })
})

/**
 * The same read, reached by the number a ticket is known by rather than its id.
 *
 * Its own operation rather than a second shape for `ticketGet`, because the two differ in
 * exactly one thing — how the subject is named — and widening the input of the operation
 * three surfaces already depend on would buy nothing but a schema that has to say "one of
 * these, never both".
 *
 * The lookup sits in `requires` so it happens *before* the access check, which therefore
 * lands on the ticket the number actually names. A number nobody can reach and a number that
 * was never issued both answer 404, the same answer `requireTicketAccess` gives for an id.
 */
export const ticketGetByNumber = defineOperation({
  name: 'ticket.getByNumber',
  summary: 'Read one ticket by its number',
  // Coerced because a path parameter arrives as text; MCP and the UI pass a real number.
  input: z.object({ ticketNumber: z.coerce.number().int().positive() }),
  requires: {
    scope: 'ticket',
    role: 'viewer',
    ticketId: input => orNotFound(ticketIdByNumber(input.ticketNumber), 'Ticket')
  },
  audit: false,
  run: ctx => ({ ticket: ctx.ticket! })
})

export const ticketActivity = defineOperation({
  name: 'ticket.activity',
  summary: 'Read a ticket’s history',
  input: z.object({ ticketId }),
  requires: { scope: 'ticket', role: 'viewer', ticketId: input => input.ticketId },
  audit: false,
  run: (_ctx, input) => ({ activity: listActivity(input.ticketId) })
})

/**
 * The same history, board-wide: everything that happened on any of the board's tickets since
 * a timestamp, newest first. What a digest — "what changed while I was away?" — is made of.
 */
export const boardActivity = defineOperation({
  name: 'board.activity',
  summary: 'Read what changed on a board',
  input: z.object({
    boardId: z.string().trim().min(1).max(64),
    since: z.string().trim().max(40).optional().describe('ISO timestamp; omitted means no lower bound.'),
    limit: z.number().int().min(1).max(200).default(50)
  }),
  requires: { scope: 'board', role: 'viewer', boardId: input => input.boardId },
  audit: false,
  run: (_ctx, input) => ({ activity: listBoardActivity(input.boardId, { since: input.since, limit: input.limit }) })
})

export const ticketCreate = defineOperation({
  name: 'ticket.create',
  summary: 'File a new ticket',
  input: ticketCreateSchema,
  requires: { scope: 'board', role: 'editor', boardId: input => input.boardId },
  audit: { targetType: 'ticket', targetId: createdId('ticket'), changes: ['title', 'priority', 'assigneeId', 'laneId', 'typeId'] },
  run: (ctx, input) => {
    const { boardId, ...rest } = input
    if (rest.assigneeId && !boardMemberIds(boardId).has(rest.assigneeId)) {
      throw createError({ statusCode: 422, statusMessage: 'A ticket can only be assigned to a member of this board.' })
    }
    if (rest.typeId && !ticketTypeBelongsToBoard(rest.typeId, boardId)) throw foreignType()
    Object.assign(rest, settled({ schedule: 'none', startDate: null, dueDate: null, liveFrom: null, liveUntil: null, recurrence: null }, rest))
    checkReturnLane(boardId, rest.recurrence)
    checkNewSubtickets(ctx.actor, boardId, null, new Set(), rest.todos)
    keepDecisionsOpenFor(ctx.actor, [], rest.todos)
    if (rest.strictOrder) checkStrictOrder([], rest.todos)
    if (rest.waitsOn?.length) checkWaitsOn(ctx.actor, boardId, null, new Set(), rest.waitsOn)
    // The author answers for the ticket, the actor for the write. Identical from the browser,
    // and different the moment a service identity files on somebody's behalf.
    const ticket = createTicket(boardId, rest, personById(ctx.actor.principalId), ctx.actor)
    if (!ticket) throw createError({ statusCode: 409, statusMessage: 'This board has no lane to create tickets in.' })
    return { ticket }
  }
})

/**
 * The schedule and its dates as they will stand, checked: what the schedule has no room for
 * cleared or refused, the span and the live window running forwards.
 */
function settled(before: ScheduleFields, patch: Partial<ScheduleFields>): ScheduleFields {
  const outcome = settleSchedule(before, patch)
  if (!outcome.ok) throw createError({ statusCode: 422, statusMessage: outcome.message })
  checkSpan(outcome.value.startDate, outcome.value.dueDate)
  checkLiveWindow(outcome.value.liveFrom, outcome.value.liveUntil)
  return outcome.value
}

/** A recurring ticket goes back to a lane of its own board at each new round, or stays put. */
function checkReturnLane(boardId: string, recurrence: { returnLaneId: string | null } | null | undefined) {
  if (!recurrence?.returnLaneId) return
  if (findLane(recurrence.returnLaneId)?.boardId !== boardId) {
    throw createError({ statusCode: 422, statusMessage: 'The return lane has to be a lane of the ticket’s own board.' })
  }
}

/** A start after the due date would draw a bar backwards; either one alone is fine. Both are YYYY-MM-DD, so they compare as text. */
function checkSpan(startDate: string | null, dueDate: string | null) {
  if (startDate && dueDate && startDate > dueDate) {
    throw createError({ statusCode: 422, statusMessage: 'The start date cannot be after the due date.' })
  }
}

/** The live window runs forwards too. It may start before the work is due, and often does: a soft launch. */
function checkLiveWindow(liveFrom: string | null, liveUntil: string | null) {
  if (liveFrom && liveUntil && liveFrom > liveUntil) {
    throw createError({ statusCode: 422, statusMessage: 'The end of the live window cannot be before its start.' })
  }
}

export const ticketUpdate = defineOperation({
  name: 'ticket.update',
  summary: 'Change a ticket’s fields',
  // An imported ticket takes a different shape: its build number is Apple's, and only a board
  // admin may name who really filed it. The narrower schema is picked once the ticket is known.
  input: z.looseObject({ ticketId }),
  requires: { scope: 'ticket', role: 'editor', ticketId: input => input.ticketId },
  // Which fields moved, not their values: `ticket_activity` already records the before and
  // after for everything that has one, and a 10,000-character description does not belong here.
  audit: { targetType: 'ticket', targetId: input => input.ticketId, changes: input => ({ fields: Object.keys(omit(input, 'ticketId')).sort() }) },
  run: async (ctx, input) => {
    const ticket = ctx.ticket!
    const schema = ticket.source === 'manual' ? ticketUpdateSchema : importedTicketUpdateSchema
    const parsed = schema.safeParse(omit(input, 'ticketId'))
    if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Invalid input', data: { issues: z.treeifyError(parsed.error) } })
    const fields = parsed.data

    // Both checks only bite when the value actually moves. A ticket may well already name
    // somebody who has since been removed from the board — or anonymized — and editing its
    // title should not be blocked on that.
    // The dates are checked as they will stand: a new start against the due date already set,
    // a switch to a milestone dropping the start, and so on. Untouched, they are left alone.
    if (touchesSchedule(fields)) Object.assign(fields, settled(ticket, fields))
    if (fields.recurrence && fields.recurrence.returnLaneId !== ticket.recurrence?.returnLaneId) checkReturnLane(ticket.boardId, fields.recurrence)
    const members = boardMemberIds(ticket.boardId)
    if (fields.assigneeId && fields.assigneeId !== ticket.assignee?.id && !members.has(fields.assigneeId)) {
      throw createError({ statusCode: 422, statusMessage: 'A ticket can only be assigned to a member of this board.' })
    }
    if (fields.typeId && fields.typeId !== ticket.type?.id && !ticketTypeBelongsToBoard(fields.typeId, ticket.boardId)) throw foreignType()
    if (fields.todos) keepDecisionsOpenFor(ctx.actor, ticket.todos, fields.todos)
    if (fields.todos && (fields.strictOrder ?? ticket.strictOrder)) checkStrictOrder(ticket.todos, fields.todos)
    if (fields.todos?.some(todo => todo.subticketId)) checkNewSubtickets(ctx.actor, ticket.boardId, ticket.id, subticketIdsOf(ticket.id), fields.todos)
    if (fields.waitsOn?.length) checkWaitsOn(ctx.actor, ticket.boardId, ticket.id, new Set(ticket.waitsOn.map(item => item.id)), fields.waitsOn)
    if (fields.coverAttachmentId && !ticket.attachments.some(file => file.id === fields.coverAttachmentId && file.mimeType.startsWith('image/'))) {
      throw createError({ statusCode: 422, statusMessage: 'The card image has to be one of this ticket’s image attachments.' })
    }
    if (fields.cardImageIds) {
      // Offered means shown: a link only counts with its preview on, as on the card.
      const offered = new Set(cardImageCandidates(ticket).map(image => image.id))
      if (fields.cardImageIds.some(id => !offered.has(id))) {
        throw createError({ statusCode: 422, statusMessage: 'A card image has to be one of this ticket’s image attachments or rendered link previews.' })
      }
    }
    if ('authorId' in fields && (fields.authorId ?? null) !== (ticket.author?.id ?? null)) {
      // Attribution is a claim about who reported something, so it stays with the board's
      // admins rather than anyone who may edit the ticket.
      if (ctx.role !== 'admin') throw createError({ statusCode: 403, statusMessage: 'Only a board admin can change who a ticket is attributed to.' })
      if (fields.authorId && !members.has(fields.authorId)) {
        throw createError({ statusCode: 422, statusMessage: 'A ticket can only be attributed to a member of this board.' })
      }
    }
    const removedThumbnails: string[] = []
    const updated = orNotFound(updateTicket(input.ticketId, fields, ctx.actor, removedThumbnails), 'Ticket')
    await deleteLinkThumbnails(removedThumbnails)
    return { ticket: updated }
  }
})

/**
 * A to-do that is a ticket of its own. It is filed on the board and lane given — this board
 * or another of the workspace — and ticks itself once it reaches a done lane there.
 */
export const ticketSubticketCreate = defineOperation({
  name: 'ticket.createSubticket',
  summary: 'File a new ticket as a to-do of this one, on this board or another of its workspace',
  input: subticketCreateSchema.extend({ ticketId }),
  requires: { scope: 'ticket', role: 'editor', ticketId: input => input.ticketId },
  audit: { targetType: 'ticket', targetId: input => input.ticketId, changes: ['boardId', 'laneId', 'title'] },
  run: (ctx, input) => {
    const parent = ctx.ticket!
    // Filing on the destination asks for an editor there too, and stays a 404 to anyone who cannot see it.
    if (input.boardId !== parent.boardId) requireBoardAccess(ctx.actor, input.boardId, 'editor')
    const target = orNotFound(findBoard(input.boardId), 'Board')
    if (target.workspaceId !== orNotFound(findBoard(parent.boardId), 'Board').workspaceId) {
      throw createError({ statusCode: 422, statusMessage: 'A subticket has to live on a board of the same workspace.' })
    }
    if (parent.todos.length >= 100) throw createError({ statusCode: 422, statusMessage: 'A ticket holds at most 100 to-dos and subtickets.' })
    const result = createSubticket(parent.id, input, personById(ctx.actor.principalId), ctx.actor)
    if (!result) throw createError({ statusCode: 422, statusMessage: 'The lane does not belong to the chosen board.' })
    return result
  }
})

/**
 * What could be linked as a subticket: open tickets on the boards of the parent's workspace
 * that the caller can read, found by title or number. Leaves out the parent and what its
 * list already holds.
 */
export const ticketSubticketCandidates = defineOperation({
  name: 'ticket.subticket.candidates',
  summary: 'Find existing tickets of the workspace that could be linked as subtickets of this one',
  input: z.object({
    ticketId,
    // Coerced because a query string turns "42" into a number on the way in.
    query: z.coerce.string().trim().max(160).default(''),
    limit: z.number().int().min(1).max(50).default(20),
    /** What the pick is for: a subticket, or a ticket this one is to wait on. */
    for: z.enum(['subticket', 'dependency']).default('subticket')
  }),
  requires: { scope: 'ticket', role: 'editor', ticketId: input => input.ticketId },
  audit: false,
  run: (ctx, input) => {
    const parent = ctx.ticket!
    const workspaceId = orNotFound(findBoard(parent.boardId), 'Board').workspaceId
    // The boards the caller reaches through this very credential, not merely as a person.
    const boardIds = listBoards(boardViewer(ctx.account))
      .filter(board => board.workspaceId === workspaceId && readable(ctx.actor, board.id))
      .map(board => board.id)
    // A ticket that already waits on this one, however indirectly, would close a loop.
    const exclude = new Set(input.for === 'dependency'
      ? [parent.id, ...parent.waitsOn.map(item => item.id), ...ticketsWaitingOn(parent.id)]
      : [parent.id, ...subticketIdsOf(parent.id)])
    return { candidates: searchSubticketCandidates(boardIds, input.query, exclude, input.limit) }
  }
})

/**
 * The ticket and its open subtickets as a tree, with each one's span and status: what a
 * timeline draws. A subticket on a board the caller cannot read is listed, as the to-do list
 * already shows it, but not opened up.
 */
export const ticketTimelineGet = defineOperation({
  name: 'ticket.timeline.get',
  summary: 'Read a ticket and its subtickets as a timeline',
  input: z.object({ ticketId }),
  requires: { scope: 'ticket', role: 'viewer', ticketId: input => input.ticketId },
  audit: false,
  run: ctx => ({ timeline: orNotFound(ticketTimeline(ctx.ticket!.id, boardId => readable(ctx.actor, boardId)), 'Ticket') })
})

/**
 * Where a ticket is used: the tickets that hold it as a subticket, the way up its hierarchy.
 * A parent on a board the caller cannot read is left out, not even its number.
 */
export const ticketParentsList = defineOperation({
  name: 'ticket.parents.list',
  summary: 'List the tickets that hold this ticket as a subticket',
  input: z.object({ ticketId }),
  requires: { scope: 'ticket', role: 'viewer', ticketId: input => input.ticketId },
  audit: false,
  run: ctx => ({ parents: parentTicketRefsOf(ctx.ticket!.id).filter(parent => readable(ctx.actor, parent.boardId)) })
})

/**
 * Who waits on a ticket: the other side of `waitsOn`. A ticket on a board the caller cannot
 * read is left out, as with the parents.
 */
export const ticketDependentsList = defineOperation({
  name: 'ticket.dependents.list',
  summary: 'List the tickets that wait on this ticket',
  input: z.object({ ticketId }),
  requires: { scope: 'ticket', role: 'viewer', ticketId: input => input.ticketId },
  audit: false,
  run: ctx => ({ dependents: dependencyRefs('waitedOnBy', ctx.ticket!.id).filter(item => readable(ctx.actor, item.boardId)) })
})

/**
 * Moves a ticket's start and due date by whole days, and those of everything waiting on it,
 * directly or through others, by the same days. Finished work stays where it is, and so does a
 * ticket the caller may not edit; either stops the push there. A dry run reports the same
 * without writing. Live windows stay put: a run that follows the go-live is moved by hand.
 */
export const ticketShift = defineOperation({
  name: 'ticket.shift',
  summary: 'Move a ticket’s dates by days, and everything waiting on it',
  input: ticketShiftSchema.extend({ ticketId }),
  requires: { scope: 'ticket', role: 'editor', ticketId: input => input.ticketId },
  audit: { targetType: 'ticket', targetId: input => input.ticketId, changes: input => ({ days: input.days, dryRun: input.dryRun }) },
  run: (ctx, input): ShiftResult => {
    const root = ctx.ticket!
    if (!root.startDate && !root.dueDate) throw createError({ statusCode: 422, statusMessage: 'The ticket has no start or due date to shift.' })
    const moves: ShiftMove[] = []
    const skipped: ShiftSkip[] = []
    const seen = new Set<string>([root.id])
    const queue = [root.id]
    while (queue.length) {
      const id = queue.shift()!
      const ticket = findTicket(id)
      if (!ticket) continue
      if (id !== root.id) {
        if (ticket.archivedAt) continue
        const lane = findLane(ticket.laneId)
        let editable = true
        try {
          requireTicketAccess(ctx.actor, id, 'editor')
        } catch {
          editable = false
        }
        if (!editable) {
          skipped.push({ ticketId: id, ticketNumber: ticket.ticketNumber, title: readable(ctx.actor, ticket.boardId) ? ticket.title : null, reason: 'no_access' })
          continue
        }
        if (lane?.isDone || lane?.isLive) {
          skipped.push({ ticketId: id, ticketNumber: ticket.ticketNumber, title: ticket.title, reason: 'finished' })
          continue
        }
      }
      if (ticket.startDate || ticket.dueDate) {
        const shift = (date: string | null) => (date ? addDays(date, input.days) : null)
        moves.push({
          ticketId: id, ticketNumber: ticket.ticketNumber, title: ticket.title, boardName: findBoard(ticket.boardId)?.name ?? '',
          startDate: { from: ticket.startDate, to: shift(ticket.startDate) },
          dueDate: { from: ticket.dueDate, to: shift(ticket.dueDate) }
        })
      }
      for (const next of waitingTicketIds(id)) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    // All or nothing: half a chain moved is a plan nobody made.
    if (!input.dryRun) atomically(() => moves.forEach(move => updateTicket(move.ticketId, { startDate: move.startDate.to, dueDate: move.dueDate.to }, ctx.actor)))
    return { days: input.days, applied: !input.dryRun, moves, skipped }
  }
})

function readable(actor: Actor, boardId: string) {
  try {
    requireBoardAccess(actor, boardId, 'viewer')
    return true
  } catch {
    return false
  }
}

/**
 * Ends the round of a recurring ticket that is on now, by hand — done, or skipped on purpose —
 * and starts the next: to-dos reset, the card back in its return lane, the due date on to the
 * next round after today. The calendar does the same by itself once the next round is due.
 */
export const ticketRoundClose = defineOperation({
  name: 'ticket.round.close',
  summary: 'Close the current round of a recurring ticket and start the next',
  input: ticketRoundCloseSchema.extend({ ticketId }),
  requires: { scope: 'ticket', role: 'editor', ticketId: input => input.ticketId },
  audit: { targetType: 'ticket', targetId: input => input.ticketId, changes: ['outcome'] },
  run: (ctx, input) => {
    const ticket = ctx.ticket!
    if (ticket.schedule !== 'recurring') throw createError({ statusCode: 422, statusMessage: 'Only a recurring ticket has rounds to close.' })
    if (ticket.archivedAt) throw createError({ statusCode: 422, statusMessage: 'An archived ticket has no round on.' })
    if (!ticket.nextRound && ticket.rounds[0]?.date === ticket.dueDate) {
      throw createError({ statusCode: 409, statusMessage: 'This series is over: its last round has closed.' })
    }
    const signal = orNotFound(closeRound(ticket.id, input.outcome, ctx.actor), 'Ticket')
    return { ticket: orNotFound(findTicket(ticket.id), 'Ticket'), round: { date: signal.date, outcome: signal.outcome, next: signal.next } }
  }
})

export const ticketRoundReopen = defineOperation({
  name: 'ticket.round.reopen',
  summary: 'Open the last closed round of a recurring ticket again',
  input: z.object({ ticketId }),
  requires: { scope: 'ticket', role: 'editor', ticketId: input => input.ticketId },
  audit: { targetType: 'ticket', targetId: input => input.ticketId, changes: [] },
  run: (ctx) => {
    const ticket = ctx.ticket!
    if (ticket.schedule !== 'recurring') throw createError({ statusCode: 422, statusMessage: 'Only a recurring ticket has rounds to reopen.' })
    const round = reopenRound(ticket.id, ctx.actor)
    if (!round) throw createError({ statusCode: 409, statusMessage: 'No round to reopen: only the last one can, and only until the next round is due.' })
    return { ticket: orNotFound(findTicket(ticket.id), 'Ticket'), round }
  }
})

export const ticketMove = defineOperation({
  name: 'ticket.move',
  summary: 'Move a ticket to a lane and position',
  input: ticketMoveSchema.extend({ ticketId }),
  requires: { scope: 'ticket', role: 'editor', ticketId: input => input.ticketId },
  audit: { targetType: 'ticket', targetId: input => input.ticketId, changes: ['laneId', 'index'] },
  run: (ctx, input) => ({ ticket: orNotFound(moveTicket(input.ticketId, input.laneId, input.index, ctx.actor), 'Ticket') })
})

export const ticketTransfer = defineOperation({
  name: 'ticket.transfer',
  summary: 'Move a ticket onto another board of the same workspace',
  input: ticketTransferSchema.extend({ ticketId }),
  requires: { scope: 'ticket', role: 'editor', ticketId: input => input.ticketId },
  audit: { targetType: 'ticket', targetId: input => input.ticketId, changes: ['boardId', 'laneId'] },
  run: (ctx, input) => {
    // Editing rights on the source come from the requirement; the destination asks for the
    // same, and stays a 404 to anyone who cannot see it — as `board.move` does for workspaces.
    requireBoardAccess(ctx.actor, input.boardId, 'editor')
    if (ctx.ticket!.boardId === input.boardId) {
      throw createError({ statusCode: 409, statusMessage: 'The ticket is already on this board.' })
    }
    const target = orNotFound(findBoard(input.boardId), 'Board')
    if (target.workspaceId !== orNotFound(findBoard(ctx.ticket!.boardId), 'Board').workspaceId) {
      throw createError({ statusCode: 422, statusMessage: 'Tickets can only move between boards of the same workspace.' })
    }
    const result = transferTicket(input.ticketId, input.boardId, input.laneId ?? null, ctx.actor)
    if (!result) throw createError({ statusCode: 422, statusMessage: 'The lane does not belong to the destination board.' })
    return result
  }
})

export const ticketArchive = defineOperation({
  name: 'ticket.archive',
  summary: 'Take a ticket off the board',
  input: z.object({ ticketId }),
  requires: { scope: 'ticket', role: 'editor', ticketId: input => input.ticketId },
  audit: { targetType: 'ticket', targetId: input => input.ticketId },
  run: (ctx, input) => ({ ticket: orNotFound(archiveTicket(input.ticketId, ctx.actor), 'Ticket') })
})

/** Restoring reaches into the archive, which belongs to the board's administrators. */
export const ticketRestore = defineOperation({
  name: 'ticket.restore',
  summary: 'Put an archived ticket back on the board',
  input: z.object({ ticketId }),
  requires: { scope: 'ticket', role: 'admin', ticketId: input => input.ticketId },
  audit: { targetType: 'ticket', targetId: input => input.ticketId },
  run: (ctx, input) => ({ ticket: orNotFound(restoreTicket(input.ticketId, ctx.actor), 'Ticket') })
})

/** Types are a workspace's vocabulary; a ticket only speaks the one its board is in. */
function foreignType() {
  return createError({ statusCode: 422, statusMessage: 'A ticket type must belong to this board’s workspace.' })
}

/**
 * A to-do naming a ticket the list does not hold yet links that ticket as a subticket. It has
 * to be one the caller can read — anything else is the same 404 a stranger gets — on a board
 * of the same workspace, and neither the ticket itself nor one that already lists it.
 */
/**
 * A strict list is worked top to bottom: a step ticked (or a decision decided) now has to come
 * after steps that are all done. Only what changes is checked — a step undone again, or a list
 * switched to strict with gaps already in it, is left alone. A subticket ticks itself in its
 * own lane, so it is never refused here, but an open one holds back the steps below it.
 */
function checkStrictOrder(existing: Array<{ text: string; completed: boolean; subticketId?: string | null }>, todos: Array<{ text: string; completed: boolean; subticketId?: string | null }>) {
  const doneBefore = new Map<string, number>()
  for (const todo of existing) if (todo.completed && !todo.subticketId) doneBefore.set(todo.text, (doneBefore.get(todo.text) ?? 0) + 1)
  const subticketsDone = new Map(existing.filter(todo => todo.subticketId).map(todo => [todo.subticketId!, todo.completed]))
  let open: string | null = null
  for (const todo of todos) {
    if (todo.subticketId) {
      if (!open && !(subticketsDone.get(todo.subticketId) ?? todo.completed)) open = todo.text
      continue
    }
    const text = todo.text.trim()
    const wasDone = (doneBefore.get(text) ?? 0) > 0
    if (todo.completed && wasDone) doneBefore.set(text, doneBefore.get(text)! - 1)
    if (todo.completed && !wasDone && open) {
      throw createError({ statusCode: 422, statusMessage: `This ticket's to-dos go in strict order: “${open}” comes first.` })
    }
    if (!todo.completed && !open) open = text
  }
}

/**
 * Decisions are made by people. An agent may ask one — file it, reword it, move it — but the
 * result stays what it was: a decision it keeps carries its earlier result over, matched by
 * its question, and one it adds starts open.
 */
function keepDecisionsOpenFor(actor: Actor, existing: Array<{ text: string; completed: boolean; decision?: TicketDecisionInput | null }>, todos: Array<{ text: string; completed: boolean; decision?: TicketDecisionInput | null }>) {
  if (actor.channel !== 'mcp') return
  const earlier = new Map<string, Array<{ completed: boolean; decision: TicketDecisionInput }>>()
  for (const todo of existing) if (todo.decision) earlier.set(todo.text, [...(earlier.get(todo.text) ?? []), { completed: todo.completed, decision: todo.decision }])
  for (const todo of todos) {
    if (!todo.decision) continue
    const previous = earlier.get(todo.text.trim())?.shift()
    const options = todo.decision.options.map(option => option.trim())
    // The picks name options by place, so they only carry over while those options stand.
    const same = previous && previous.decision.options.every((option, index) => options[index] === option)
    todo.completed = Boolean(same && previous.completed)
    todo.decision.chosen = same ? previous.decision.chosen.filter(index => index < options.length) : []
    todo.decision.other = same && todo.decision.allowOther ? previous.decision.other : null
  }
}

function checkNewSubtickets(actor: Actor, boardId: string, parentId: string | null, held: Set<string>, todos: Array<{ subticketId?: string | null }>) {
  const workspaceId = orNotFound(findBoard(boardId), 'Board').workspaceId
  for (const todo of todos) {
    const id = todo.subticketId
    if (!id || held.has(id)) continue
    if (id === parentId) throw createError({ statusCode: 422, statusMessage: 'A ticket cannot be its own subticket.' })
    const { ticket } = requireTicketAccess(actor, id, 'viewer')
    if (ticket.archivedAt) throw createError({ statusCode: 422, statusMessage: 'An archived ticket cannot become a subticket.' })
    if (orNotFound(findBoard(ticket.boardId), 'Board').workspaceId !== workspaceId) {
      throw createError({ statusCode: 422, statusMessage: 'A subticket has to live on a board of the same workspace.' })
    }
    if (parentId && subticketIdsOf(id).has(parentId)) {
      throw createError({ statusCode: 422, statusMessage: `#${ticket.ticketNumber} already lists this ticket as its subticket.` })
    }
  }
}

/**
 * What a ticket may newly wait on: a ticket the caller can read, open, of the same workspace,
 * and not one that already waits on this ticket, directly or through others. What it waits on
 * already stays, whatever has happened to it since.
 */
function checkWaitsOn(actor: Actor, boardId: string, waitingId: string | null, held: Set<string>, ids: string[]) {
  const workspaceId = orNotFound(findBoard(boardId), 'Board').workspaceId
  for (const id of new Set(ids)) {
    if (held.has(id)) continue
    if (id === waitingId) throw createError({ statusCode: 422, statusMessage: 'A ticket cannot wait on itself.' })
    const { ticket } = requireTicketAccess(actor, id, 'viewer')
    if (ticket.archivedAt) throw createError({ statusCode: 422, statusMessage: 'A ticket cannot wait on an archived ticket.' })
    if (orNotFound(findBoard(ticket.boardId), 'Board').workspaceId !== workspaceId) {
      throw createError({ statusCode: 422, statusMessage: 'A ticket can only wait on a ticket of the same workspace.' })
    }
    if (waitingId && waitsOnTransitively(id, waitingId)) {
      throw createError({ statusCode: 422, statusMessage: `#${ticket.ticketNumber} already waits on this ticket; the other way round would be a loop.` })
    }
  }
}

function omit<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = value
  return rest
}
