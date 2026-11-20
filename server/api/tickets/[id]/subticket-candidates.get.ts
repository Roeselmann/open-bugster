import { run, ticketSubticketCandidates } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  return run(ticketSubticketCandidates, sessionActor(event), { ticketId: getRouterParam(event, 'id') || '', query: String(query.query ?? ''), for: query.for === 'dependency' ? 'dependency' : 'subticket' })
})
