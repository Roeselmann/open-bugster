import { run, ticketList } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  return run(ticketList, sessionActor(event), { boardId: String(query.boardId || ''), archived: query.archived === 'true' })
})
