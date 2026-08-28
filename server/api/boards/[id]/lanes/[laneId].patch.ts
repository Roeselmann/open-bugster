import { findLane, listLanes, updateLane } from '~~/server/utils/db'
import { requireBoardAccess } from '~~/server/utils/access'
import { laneUpdateSchema, validationError } from '~~/server/utils/validation'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const boardId = getRouterParam(event, 'id') || ''
  const laneId = getRouterParam(event, 'laneId') || ''
  requireBoardAccess(sessionActor(event), boardId, 'admin')
  const existing = findLane(laneId)
  if (!existing || existing.boardId !== boardId) throw createError({ statusCode: 404, statusMessage: 'Lane not found.' })
  const parsed = laneUpdateSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  updateLane(laneId, parsed.data)
  return { lanes: listLanes(boardId) }
})
