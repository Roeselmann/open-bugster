import { createLane, listLanes } from '~~/server/utils/db'
import { laneCreateSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const boardId = getRouterParam(event, 'id') || ''
  const parsed = laneCreateSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const lane = createLane(boardId, parsed.data.name)
  if (!lane) throw createError({ statusCode: 404, statusMessage: 'Board not found.' })
  setResponseStatus(event, 201)
  return { lanes: listLanes(boardId) }
})
