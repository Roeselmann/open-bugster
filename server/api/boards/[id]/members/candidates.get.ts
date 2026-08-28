import { boardMembers, listUsers } from '~~/server/utils/db'
import { requireBoardAccess } from '~~/server/utils/access'

/** The accounts a board administrator can still add. Scoped to that board, not the instance. */
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') || ''
  requireBoardAccess(event, id, 'admin')
  const existing = new Set(boardMembers(id).map(member => member.userId))
  return {
    candidates: listUsers()
      .filter(user => !existing.has(user.id))
      .map(user => ({ id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, status: user.status }))
  }
})
