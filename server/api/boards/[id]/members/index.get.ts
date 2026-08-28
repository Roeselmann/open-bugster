import { boardMembers } from '~~/server/utils/db'
import { requireBoardAccess } from '~~/server/utils/access'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') || ''
  requireBoardAccess(sessionActor(event), id)
  return { members: boardMembers(id) }
})
