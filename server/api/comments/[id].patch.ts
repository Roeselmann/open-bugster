import { findComment, updateComment } from '~~/server/utils/db'
import { requireCommentAccess } from '~~/server/utils/access'
import { commentSaveSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || ''
  requireCommentAccess(event, id)
  const parsed = commentSaveSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const comment = updateComment(id, parsed.data.body)
  if (!comment) throw createError({ statusCode: 404, statusMessage: 'Comment not found.' })
  return { comment }
})
