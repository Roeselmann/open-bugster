import { reorderLanes } from '~~/server/utils/db'
import { laneOrderSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const boardId = getRouterParam(event, 'id') || ''
  const parsed = laneOrderSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const lanes = reorderLanes(boardId, parsed.data.laneIds)
  if (!lanes) throw createError({ statusCode: 422, statusMessage: 'The new order must list every lane of this board exactly once.' })
  return { lanes }
})
