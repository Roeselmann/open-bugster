import { boardMembers, listUsers } from '~~/server/utils/db'
import { requireBoardAccess } from '~~/server/utils/access'
import { sessionActor } from '~~/server/utils/actor'

/** The accounts a board administrator can still add. Scoped to that board, not the instance. */
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') || ''
  requireBoardAccess(sessionActor(event), id, 'admin')
  const existing = new Set(boardMembers(id).map(member => member.userId))
  return {
    candidates: listUsers()
      // An anonymized account is a tombstone: it keeps its history and is offered to nobody.
      .filter(user => !existing.has(user.id) && !user.anonymizedAt)
      .map(user => ({ id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, status: user.status }))
  }
})
