import { CategoryNameTakenError, updateCategory } from '~~/server/utils/db'
import { categoryUpdateSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || ''
  const parsed = categoryUpdateSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)

  try {
    const category = updateCategory(id, parsed.data)
    if (!category) throw createError({ statusCode: 404, statusMessage: 'Category not found.' })
    return { category }
  } catch (error) {
    if (error instanceof CategoryNameTakenError) throw createError({ statusCode: 409, statusMessage: error.message })
    throw error
  }
})
