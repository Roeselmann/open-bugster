import { listTickets } from '~~/server/utils/db'
import { requireBoardAccess } from '~~/server/utils/access'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  const boardId = String(query.boardId || '')
  requireBoardAccess(event, boardId)
  return { tickets: listTickets(boardId, query.archived === 'true') }
})
