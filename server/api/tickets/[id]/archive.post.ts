import { archiveTicket } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const ticket = archiveTicket(getRouterParam(event, 'id') || '')
  if (!ticket) throw createError({ statusCode: 404, statusMessage: 'Ticket not found.' })
  return { ticket }
})
