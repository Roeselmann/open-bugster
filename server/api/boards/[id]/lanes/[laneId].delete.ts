import { deleteLane, findLane, LaneDeleteError } from '~~/server/utils/db'
import { requireBoardAccess } from '~~/server/utils/access'
import { laneDeleteSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const boardId = getRouterParam(event, 'id') || ''
  const laneId = getRouterParam(event, 'laneId') || ''
  requireBoardAccess(event, boardId, 'admin')
  const existing = findLane(laneId)
  if (!existing || existing.boardId !== boardId) throw createError({ statusCode: 404, statusMessage: 'Lane not found.' })

  const parsed = laneDeleteSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)

  try {
    return { lanes: deleteLane(laneId, parsed.data.mode, parsed.data.mode === 'move' ? parsed.data.targetLaneId : undefined) }
  } catch (error) {
    if (error instanceof LaneDeleteError) throw createError({ statusCode: error.statusCode, statusMessage: error.message })
    throw error
  }
})
