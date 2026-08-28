import { listLabels } from '~~/server/utils/db'
import { requireBoardAccess } from '~~/server/utils/access'

export default defineEventHandler((event) => {
  const boardId = String(getQuery(event).boardId || '')
  requireBoardAccess(event, boardId)
  return { labels: listLabels(boardId) }
})
