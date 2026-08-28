import { run, laneUpdate } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(laneUpdate, sessionActor(event), {
    ...await readBody(event),
    boardId: getRouterParam(event, 'id') || '',
    laneId: getRouterParam(event, 'laneId') || ''
  }))
