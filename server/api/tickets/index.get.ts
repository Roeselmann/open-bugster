import { listTickets } from '~~/server/utils/db'
import { requireBoardAccess } from '~~/server/utils/access'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  const boardId = String(query.boardId || '')
  const archived = query.archived === 'true'
  // Reading the board is one thing; reading what has been taken off it is an administrator's.
  requireBoardAccess(sessionActor(event), boardId, archived ? 'admin' : 'viewer')
  return { tickets: listTickets(boardId, archived) }
})
