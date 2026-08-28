import { run, laneDelete } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(laneDelete, sessionActor(event), {
    ...await readBody(event),
    boardId: getRouterParam(event, 'id') || '',
    laneId: getRouterParam(event, 'laneId') || ''
  }))
