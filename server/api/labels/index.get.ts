import { listLabels } from '~~/server/utils/db'
import { requireBoardAccess } from '~~/server/utils/access'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const boardId = String(getQuery(event).boardId || '')
  requireBoardAccess(sessionActor(event), boardId)
  return { labels: listLabels(boardId) }
})
