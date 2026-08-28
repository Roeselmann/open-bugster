import { run, laneReorder } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(laneReorder, sessionActor(event), { ...await readBody(event), boardId: getRouterParam(event, 'id') || '' }))
