import { updateTicket } from '~~/server/utils/db'
import { boardMemberEmails, requireTicketAccess } from '~~/server/utils/access'
import { importedTicketUpdateSchema, ticketUpdateSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || ''
  const { account, ticket } = requireTicketAccess(event, id, 'editor')
  const body = await readBody(event)
  const parsed = (ticket.source === 'manual' ? ticketUpdateSchema : importedTicketUpdateSchema).safeParse(body)
  if (!parsed.success) throw validationError(parsed.error)
  if (parsed.data.assigneeEmail && !boardMemberEmails(ticket.boardId).has(parsed.data.assigneeEmail)) {
    throw createError({ statusCode: 422, statusMessage: 'A ticket can only be assigned to a member of this board.' })
  }
  return { ticket: updateTicket(id, parsed.data, account.email) }
})
