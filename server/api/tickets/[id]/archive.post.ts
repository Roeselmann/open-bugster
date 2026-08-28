import { archiveTicket } from '~~/server/utils/db'
import { requireTicketAccess } from '~~/server/utils/access'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') || ''
  const { account } = requireTicketAccess(event, id, 'editor')
  const ticket = archiveTicket(id, account.id)
  if (!ticket) throw createError({ statusCode: 404, statusMessage: 'Ticket not found.' })
  return { ticket }
})
