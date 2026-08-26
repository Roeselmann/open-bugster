import { deleteCategory } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') || ''
  if (!deleteCategory(id)) throw createError({ statusCode: 404, statusMessage: 'Category not found.' })
  setResponseStatus(event, 204)
  return null
})
