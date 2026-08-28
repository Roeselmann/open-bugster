import { boardRoleFor, countBoardAdmins, findBoardSummary, removeBoardMember } from '~~/server/utils/db'
import { boardViewer, requireBoardAccess } from '~~/server/utils/access'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const boardId = getRouterParam(event, 'id') || ''
  const userId = getRouterParam(event, 'userId') || ''
  const { account } = requireBoardAccess(sessionActor(event), boardId, 'admin')
  // Leaving a board without an admin would make its settings unreachable for everyone
  // except instance administrators.
  if (boardRoleFor(boardId, userId) === 'admin' && countBoardAdmins(boardId) <= 1) {
    throw createError({ statusCode: 409, statusMessage: 'A board needs at least one administrator.' })
  }
  if (!removeBoardMember(boardId, userId)) throw createError({ statusCode: 404, statusMessage: 'This account is not a member of the board.' })
  return { board: findBoardSummary(boardId, boardViewer(account)) }
})
