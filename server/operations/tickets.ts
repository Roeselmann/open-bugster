import { createError } from 'h3'
import { z } from 'zod'
import { boardMemberIds } from '../utils/access'
import {
  archiveTicket, createTicket, listActivity, listTickets, moveTicket,
  personById, restoreTicket, updateTicket
} from '../utils/db'
import { importedTicketUpdateSchema, ticketCreateSchema, ticketMoveSchema, ticketUpdateSchema } from '../utils/validation'
import { createdId, defineOperation } from './types'
import { orNotFound } from './run'

const ticketId = z.string().trim().min(1).max(64)

export const ticketList = defineOperation({
  name: 'ticket.list',
  summary: 'List the tickets on a board',
  input: z.object({
    boardId: z.string().trim().min(1).max(64),
    archived: z.boolean().default(false)
  }),
  // Reading a board is one thing; reading what has been taken off it is an administrator's.
  requires: { scope: 'board', role: 'viewer', boardId: input => input.boardId },
  audit: false,
  run: (_ctx, input) => ({ tickets: listTickets(input.boardId, input.archived) })
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

export const ticketActivity = defineOperation({
  name: 'ticket.activity',
  summary: 'Read a ticket’s history',
  input: z.object({ ticketId }),
  requires: { scope: 'ticket', role: 'viewer', ticketId: input => input.ticketId },
  audit: false,
  run: (_ctx, input) => ({ activity: listActivity(input.ticketId) })
})

export const ticketCreate = defineOperation({
  name: 'ticket.create',
  summary: 'File a new ticket',
  input: ticketCreateSchema,
  requires: { scope: 'board', role: 'editor', boardId: input => input.boardId },
  audit: { targetType: 'ticket', targetId: createdId('ticket'), changes: ['title', 'priority', 'assigneeId', 'laneId'] },
  run: (ctx, input) => {
    const { boardId, ...rest } = input
    if (rest.assigneeId && !boardMemberIds(boardId).has(rest.assigneeId)) {
      throw createError({ statusCode: 422, statusMessage: 'A ticket can only be assigned to a member of this board.' })
    }
    // The author answers for the ticket, the actor for the write. Identical from the browser,
    // and different the moment a service identity files on somebody's behalf.
    const ticket = createTicket(boardId, rest, personById(ctx.actor.principalId), ctx.actor)
    if (!ticket) throw createError({ statusCode: 409, statusMessage: 'This board has no lane to create tickets in.' })
    return { ticket }
  }
})

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
  run: (ctx, input) => {
    const ticket = ctx.ticket!
    const schema = ticket.source === 'manual' ? ticketUpdateSchema : importedTicketUpdateSchema
    const parsed = schema.safeParse(omit(input, 'ticketId'))
    if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Invalid input', data: { issues: z.treeifyError(parsed.error) } })
    const fields = parsed.data

    // Both checks only bite when the value actually moves. A ticket may well already name
    // somebody who has since been removed from the board — or anonymized — and editing its
    // title should not be blocked on that.
    const members = boardMemberIds(ticket.boardId)
    if (fields.assigneeId && fields.assigneeId !== ticket.assignee?.id && !members.has(fields.assigneeId)) {
      throw createError({ statusCode: 422, statusMessage: 'A ticket can only be assigned to a member of this board.' })
    }
    if ('authorId' in fields && (fields.authorId ?? null) !== (ticket.author?.id ?? null)) {
      // Attribution is a claim about who reported something, so it stays with the board's
      // admins rather than anyone who may edit the ticket.
      if (ctx.role !== 'admin') throw createError({ statusCode: 403, statusMessage: 'Only a board admin can change who a ticket is attributed to.' })
      if (fields.authorId && !members.has(fields.authorId)) {
        throw createError({ statusCode: 422, statusMessage: 'A ticket can only be attributed to a member of this board.' })
      }
    }
    return { ticket: orNotFound(updateTicket(input.ticketId, fields, ctx.actor), 'Ticket') }
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

function omit<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = value
  return rest
}
