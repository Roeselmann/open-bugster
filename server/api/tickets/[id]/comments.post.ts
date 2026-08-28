import { createComment } from '~~/server/utils/db'
import { requireTicketAccess } from '~~/server/utils/access'
import { commentSaveSchema, validationError } from '~~/server/utils/validation'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || ''
  // Viewers may join the conversation; only changing the ticket itself needs `editor`.
  const { actor } = requireTicketAccess(sessionActor(event), id)
  const parsed = commentSaveSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const comment = createComment(id, actor.principalId, parsed.data.body, actor)
  if (!comment) throw createError({ statusCode: 404, statusMessage: 'Ticket not found.' })
  setResponseStatus(event, 201)
  return { comment }
})
