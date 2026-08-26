import { findTicket, updateTicket } from '~~/server/utils/db'
import { importedTicketUpdateSchema, ticketUpdateSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || ''
  const ticket = findTicket(id)
  if (!ticket) throw createError({ statusCode: 404, statusMessage: 'Ticket not found.' })
  const body = await readBody(event)
  const parsed = (ticket.source === 'manual' ? ticketUpdateSchema : importedTicketUpdateSchema).safeParse(body)
  if (!parsed.success) throw validationError(parsed.error)
  return { ticket: updateTicket(id, parsed.data) }
})
