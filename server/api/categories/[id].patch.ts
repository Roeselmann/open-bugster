import { CategoryNameTakenError, findCategory, updateCategory } from '~~/server/utils/db'
import { requireBoardAccess } from '~~/server/utils/access'
import { categoryUpdateSchema, validationError } from '~~/server/utils/validation'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || ''
  const category = findCategory(id)
  if (!category?.boardId) throw createError({ statusCode: 404, statusMessage: 'Category not found.' })
  requireBoardAccess(sessionActor(event), category.boardId, 'admin')
  const parsed = categoryUpdateSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)

  try {
    const updated = updateCategory(id, parsed.data)
    if (!updated) throw createError({ statusCode: 404, statusMessage: 'Category not found.' })
    return { category: updated }
  } catch (error) {
    if (error instanceof CategoryNameTakenError) throw createError({ statusCode: 409, statusMessage: error.message })
    throw error
  }
})
