import { moveTicket } from '~~/server/utils/db'
import { ticketMoveSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const parsed = ticketMoveSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const ticket = moveTicket(getRouterParam(event, 'id') || '', parsed.data.laneId, parsed.data.index)
  if (!ticket) throw createError({ statusCode: 404, statusMessage: 'Ticket or lane not found.' })
  return { ticket }
})
