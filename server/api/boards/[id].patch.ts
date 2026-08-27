import { updateBoard } from '~~/server/utils/db'
import { boardUpdateSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const parsed = boardUpdateSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const board = updateBoard(getRouterParam(event, 'id') || '', parsed.data)
  if (!board) throw createError({ statusCode: 404, statusMessage: 'Board not found.' })
  return { board }
})
