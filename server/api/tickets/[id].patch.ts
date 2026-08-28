import { updateTicket } from '~~/server/utils/db'
import { boardMemberIds, requireTicketAccess } from '~~/server/utils/access'
import { importedTicketUpdateSchema, ticketUpdateSchema, validationError } from '~~/server/utils/validation'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || ''
  const { actor, role, ticket } = requireTicketAccess(sessionActor(event), id, 'editor')
  const body = await readBody(event)
  const parsed = (ticket.source === 'manual' ? ticketUpdateSchema : importedTicketUpdateSchema).safeParse(body)
  if (!parsed.success) throw validationError(parsed.error)
  const input = parsed.data

  // Both checks only bite when the value actually moves. A ticket may well already name
  // somebody who has since been removed from the board — or anonymized — and editing its
  // title should not be blocked on that.
  const members = boardMemberIds(ticket.boardId)
  if (input.assigneeId && input.assigneeId !== ticket.assignee?.id && !members.has(input.assigneeId)) {
    throw createError({ statusCode: 422, statusMessage: 'A ticket can only be assigned to a member of this board.' })
  }

  if ('authorId' in input && (input.authorId ?? null) !== (ticket.author?.id ?? null)) {
    // Attribution is a claim about who reported something, so it stays with the board's
    // admins rather than anyone who may edit the ticket.
    if (role !== 'admin') {
      throw createError({ statusCode: 403, statusMessage: 'Only a board admin can change who a ticket is attributed to.' })
    }
    if (input.authorId && !members.has(input.authorId)) {
      throw createError({ statusCode: 422, statusMessage: 'A ticket can only be attributed to a member of this board.' })
    }
  }

  return { ticket: updateTicket(id, input, actor) }
})
