import { findBoardSummary, setBoardMember } from '~~/server/utils/db'
import { boardViewer, requireBoardAccess } from '~~/server/utils/access'
import { boardMemberSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const boardId = getRouterParam(event, 'id') || ''
  const userId = getRouterParam(event, 'userId') || ''
  const { account } = requireBoardAccess(event, boardId, 'admin')
  const parsed = boardMemberSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const member = setBoardMember(boardId, userId, parsed.data.role)
  if (!member) throw createError({ statusCode: 404, statusMessage: 'This account does not exist.' })
  return { member, board: findBoardSummary(boardId, boardViewer(account)) }
})
