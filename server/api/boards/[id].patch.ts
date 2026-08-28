import { updateBoard } from '~~/server/utils/db'
import { boardViewer, requireBoardAccess } from '~~/server/utils/access'
import { boardUpdateSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || ''
  const { account } = requireBoardAccess(event, id, 'admin')
  const parsed = boardUpdateSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const board = updateBoard(id, parsed.data, boardViewer(account))
  if (!board) throw createError({ statusCode: 404, statusMessage: 'Board not found.' })
  return { board }
})
