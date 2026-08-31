import { run, boardMove } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(boardMove, sessionActor(event), { ...await readBody(event), boardId: getRouterParam(event, 'id') || '' }))
