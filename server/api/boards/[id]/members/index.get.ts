import { boardMembers } from '~~/server/utils/db'
import { requireBoardAccess } from '~~/server/utils/access'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') || ''
  requireBoardAccess(event, id)
  return { members: boardMembers(id) }
})
