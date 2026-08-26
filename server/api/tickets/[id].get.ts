import { findTicket } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const ticket = findTicket(getRouterParam(event, 'id') || '')
  if (!ticket) throw createError({ statusCode: 404, statusMessage: 'Ticket not found.' })
  return { ticket }
})
