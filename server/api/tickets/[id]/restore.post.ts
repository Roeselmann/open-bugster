import { restoreTicket } from '~~/server/utils/db'
import { requireTicketAccess } from '~~/server/utils/access'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') || ''
  // Archiving is still an editor's call, but what happens to a ticket afterwards is not:
  // only a board administrator sees the archive, so only they can bring one back.
  const { actor } = requireTicketAccess(sessionActor(event), id, 'admin')
  const ticket = restoreTicket(id, actor)
  if (!ticket) throw createError({ statusCode: 404, statusMessage: 'Ticket not found.' })
  return { ticket }
})
