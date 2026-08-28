import { deleteCategory, findCategory } from '~~/server/utils/db'
import { requireBoardAccess } from '~~/server/utils/access'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') || ''
  const category = findCategory(id)
  if (!category?.boardId) throw createError({ statusCode: 404, statusMessage: 'Category not found.' })
  requireBoardAccess(sessionActor(event), category.boardId, 'admin')
  if (!deleteCategory(id)) throw createError({ statusCode: 404, statusMessage: 'Category not found.' })
  setResponseStatus(event, 204)
  return null
})
