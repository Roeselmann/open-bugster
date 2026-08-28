import { createTicket } from '~~/server/utils/db'
import { boardMemberEmails, requireBoardAccess } from '~~/server/utils/access'
import { ticketCreateSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const parsed = ticketCreateSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const { boardId, ...input } = parsed.data
  const { account } = requireBoardAccess(event, boardId, 'editor')
  if (input.assigneeEmail && !boardMemberEmails(boardId).has(input.assigneeEmail)) {
    throw createError({ statusCode: 422, statusMessage: 'A ticket can only be assigned to a member of this board.' })
  }
  const ticket = createTicket(boardId, input, {
    firstName: account.firstName,
    lastName: account.lastName,
    email: account.email,
    userId: account.id,
    status: account.status,
  })
  if (!ticket) throw createError({ statusCode: 409, statusMessage: 'This board has no lane to create tickets in.' })
  setResponseStatus(event, 201)
  return { ticket }
})
