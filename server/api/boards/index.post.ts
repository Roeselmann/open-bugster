import { createBoard } from '~~/server/utils/db'
import { requireInstanceAdmin } from '~~/server/utils/access'
import { boardCreateSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const account = requireInstanceAdmin(event)
  const parsed = boardCreateSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  setResponseStatus(event, 201)
  return { board: createBoard(parsed.data.name, account.id) }
})
