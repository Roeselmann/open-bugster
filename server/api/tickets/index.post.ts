import { createTicket, personById } from '~~/server/utils/db'
import { boardMemberIds, requireBoardAccess } from '~~/server/utils/access'
import { ticketCreateSchema, validationError } from '~~/server/utils/validation'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const parsed = ticketCreateSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const { boardId, ...input } = parsed.data
  const { actor, account } = requireBoardAccess(sessionActor(event), boardId, 'editor')
  if (input.assigneeId && !boardMemberIds(boardId).has(input.assigneeId)) {
    throw createError({ statusCode: 422, statusMessage: 'A ticket can only be assigned to a member of this board.' })
  }
  const ticket = createTicket(boardId, input, personById(account.id), actor)
  if (!ticket) throw createError({ statusCode: 409, statusMessage: 'This board has no lane to create tickets in.' })
  setResponseStatus(event, 201)
  return { ticket }
})
