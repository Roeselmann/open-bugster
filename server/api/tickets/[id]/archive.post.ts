import { archiveTicket } from '~~/server/utils/db'
import { requireTicketAccess } from '~~/server/utils/access'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') || ''
  const { actor } = requireTicketAccess(sessionActor(event), id, 'editor')
  const ticket = archiveTicket(id, actor)
  if (!ticket) throw createError({ statusCode: 404, statusMessage: 'Ticket not found.' })
  return { ticket }
})
