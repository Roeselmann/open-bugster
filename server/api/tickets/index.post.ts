import { createTicket, findBoard } from '~~/server/utils/db'
import { getServerConfig } from '~~/server/utils/config'
import { ticketCreateSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const parsed = ticketCreateSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const { boardId, ...input } = parsed.data
  if (!findBoard(boardId)) throw createError({ statusCode: 404, statusMessage: 'Board not found.' })
  const config = getServerConfig()
  if (!config.adminFirstName || !config.adminLastName || !config.adminEmail) {
    throw createError({ statusCode: 500, statusMessage: 'The administrator identity is not fully configured.' })
  }
  const ticket = createTicket(boardId, input, {
    firstName: config.adminFirstName,
    lastName: config.adminLastName,
    email: config.adminEmail,
  })
  if (!ticket) throw createError({ statusCode: 409, statusMessage: 'This board has no lane to create tickets in.' })
  setResponseStatus(event, 201)
  return { ticket }
})
