import { deleteComment } from '~~/server/utils/db'
import { requireCommentAccess } from '~~/server/utils/access'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') || ''
  requireCommentAccess(sessionActor(event), id)
  if (!deleteComment(id)) throw createError({ statusCode: 404, statusMessage: 'Comment not found.' })
  setResponseStatus(event, 204)
  return null
})
