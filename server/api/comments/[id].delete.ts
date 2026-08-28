import { deleteComment } from '~~/server/utils/db'
import { requireCommentAccess } from '~~/server/utils/access'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') || ''
  requireCommentAccess(event, id)
  if (!deleteComment(id)) throw createError({ statusCode: 404, statusMessage: 'Comment not found.' })
  setResponseStatus(event, 204)
  return null
})
