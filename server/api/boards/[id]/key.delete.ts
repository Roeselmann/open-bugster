import { clearBoardPrivateKey } from '~~/server/utils/db'
import { boardViewer, requireBoardAccess } from '~~/server/utils/access'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') || ''
  const { account } = requireBoardAccess(sessionActor(event), id, 'admin')
  const board = clearBoardPrivateKey(id, boardViewer(account))
  if (!board) throw createError({ statusCode: 404, statusMessage: 'Board not found.' })
  return { board }
})
