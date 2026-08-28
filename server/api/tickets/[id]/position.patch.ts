import { moveTicket } from '~~/server/utils/db'
import { requireTicketAccess } from '~~/server/utils/access'
import { ticketMoveSchema, validationError } from '~~/server/utils/validation'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || ''
  const { actor } = requireTicketAccess(sessionActor(event), id, 'editor')
  const parsed = ticketMoveSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const ticket = moveTicket(id, parsed.data.laneId, parsed.data.index, actor)
  if (!ticket) throw createError({ statusCode: 404, statusMessage: 'Ticket or lane not found.' })
  return { ticket }
})
