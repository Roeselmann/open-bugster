import { listTickets } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  return { tickets: listTickets(query.archived === 'true') }
})
